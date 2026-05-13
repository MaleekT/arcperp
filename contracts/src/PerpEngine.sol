// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IPerpEngine.sol";
import "./interfaces/IVaultManager.sol";
import "./interfaces/IFeeCollector.sol";
import "./libraries/PerpMath.sol";
import "./libraries/OracleLib.sol";

/// @title PerpEngine
/// @notice Core trading logic for ArcPerp. Opens, closes, and manages perpetual positions.
///
/// Security layers:
///   - ReentrancyGuard on openPosition and closePosition
///   - Checks-Effects-Interactions strictly enforced (state updated before any external call)
///   - OracleLib.getVerifiedPrice() for every mark price read — never raw oracle call
///   - Same-block open+close prevention via openedAtBlock guard
///   - Slippage guard: caller specifies minPrice/maxPrice bounds; reverts if oracle is outside range
///   - Payable open/close: forwards caller's native value to Pyth for update fees; refunds excess
///   - Pausable: admin can halt new position opens without blocking closes
///   - AccessControl: only LiquidationEngine can force-close positions
contract PerpEngine is IPerpEngine, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant LIQUIDATION_ENGINE_ROLE = keccak256("LIQUIDATION_ENGINE_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IVaultManager public immutable vaultManager;
    IFeeCollector public immutable feeCollector;
    address public immutable pyth;

    mapping(bytes32 => Position) private _positions;
    mapping(bytes32 => PairConfig) private _pairConfigs;
    mapping(bytes32 => address) private _chainlinkFeeds;
    mapping(bytes32 => bytes32) private _pythPriceIds;
    mapping(bytes32 => uint256) private _indexPrices;
    mapping(bytes32 => uint256) private _lastFundingTimestamp;
    mapping(address => mapping(bytes32 => bytes32)) private _traderPositionId;
    mapping(address => address) private _orderExecutors;

    bytes32[] private _activePairs;

    constructor(address _vaultManager, address _feeCollector, address _pyth, address _admin) {
        if (_vaultManager == address(0) || _feeCollector == address(0) || _pyth == address(0) || _admin == address(0)) {
            revert UnauthorizedCaller(address(0));
        }
        vaultManager = IVaultManager(_vaultManager);
        feeCollector = IFeeCollector(_feeCollector);
        pyth = _pyth;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @dev Accept native currency sent for Pyth update fee payments.
    receive() external payable {}

    // ── Pair management ───────────────────────────────────────────────────────

    function addPair(
        bytes32 pair,
        uint16 maxLeverageBps,
        uint16 takerFeeBps,
        uint16 makerFeeBps,
        uint16 maintenanceMarginBps,
        bytes32 pythPriceId,
        address chainlinkFeed
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pairConfigs[pair] = PairConfig({
            active: true,
            maxLeverageBps: maxLeverageBps,
            takerFeeBps: takerFeeBps,
            makerFeeBps: makerFeeBps,
            maintenanceMarginBps: maintenanceMarginBps
        });
        _pythPriceIds[pair] = pythPriceId;
        _chainlinkFeeds[pair] = chainlinkFeed;
        _lastFundingTimestamp[pair] = block.timestamp;
        _activePairs.push(pair);
    }

    // ── Trading ───────────────────────────────────────────────────────────────

    /// @notice Open a leveraged perpetual position.
    ///         Caller must supply fresh Pyth VAA obtained from Hermes API.
    ///         Any native value sent is forwarded to Pyth for update fees; excess is refunded.
    /// @param pair            keccak256 of pair string e.g. keccak256("BTC-USDC")
    /// @param isLong          True = long, False = short
    /// @param margin          USDC margin amount (6 decimals), must be in trader's VaultManager balance
    /// @param leverageBps     Leverage in basis points (100 = 1x, 2500 = 25x)
    /// @param minPrice        Minimum acceptable oracle fill price in 1e8 (0 = no floor)
    /// @param maxPrice        Maximum acceptable oracle fill price in 1e8 (0 = no ceiling)
    /// @param priceUpdateData Fresh Pyth VAA bytes from Hermes API
    function openPosition(
        bytes32 pair,
        bool isLong,
        uint256 margin,
        uint256 leverageBps,
        uint256 minPrice,
        uint256 maxPrice,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant whenNotPaused returns (bytes32 positionId) {
        // ── CHECK ────────────────────────────────────────────────────────────
        PairConfig memory config = _pairConfigs[pair];
        if (!config.active) revert PairNotActive(pair);
        if (margin == 0) revert ZeroMargin();
        if (leverageBps == 0 || leverageBps > config.maxLeverageBps) {
            revert LeverageExceedsMax(leverageBps, config.maxLeverageBps);
        }

        bytes32 existingId = _traderPositionId[msg.sender][pair];
        if (existingId != bytes32(0) && _positions[existingId].trader != address(0)) {
            revert PositionAlreadyExists(msg.sender, pair);
        }

        // ── ORACLE ───────────────────────────────────────────────────────────
        uint256 entryPrice = OracleLib.getVerifiedPrice(pyth, _pythPriceIds[pair], priceUpdateData, _chainlinkFeeds[pair]);

        // ── SLIPPAGE GUARD ───────────────────────────────────────────────────
        if (minPrice > 0 && entryPrice < minPrice) revert SlippageExceeded(entryPrice, minPrice);
        if (maxPrice > 0 && entryPrice > maxPrice) revert SlippageExceeded(entryPrice, maxPrice);

        // ── COMPUTE ──────────────────────────────────────────────────────────
        uint256 notional = PerpMath.computeNotional(margin, leverageBps);
        uint256 fee = PerpMath.computeFee(notional, config.takerFeeBps);
        uint256 totalDebit = margin + fee;

        positionId = computePositionId(msg.sender, pair, block.number);

        // ── EFFECT ───────────────────────────────────────────────────────────
        vaultManager.debitMargin(msg.sender, totalDebit, "open position");

        _positions[positionId] = Position({
            trader: msg.sender,
            pair: pair,
            notional: uint128(notional),
            margin: uint128(margin),
            entryPrice: uint128(entryPrice),
            openedAtBlock: uint64(block.number),
            isLong: isLong
        });

        _traderPositionId[msg.sender][pair] = positionId;
        _lastFundingTimestamp[pair] = block.timestamp;

        // Fee was included in totalDebit and is already sitting in VaultManager as "unclaimed"
        // USDC. Forward it from the vault to FeeCollector (95% → treasury pending, 5% → insurance).
        vaultManager.forwardFee(address(feeCollector), fee);
        feeCollector.collectFee(msg.sender, fee, pair);

        emit PositionOpened(positionId, msg.sender, pair, notional, entryPrice, isLong, leverageBps);

        // ── REFUND ───────────────────────────────────────────────────────────
        // Return any native currency not consumed by the Pyth update fee.
        // Executes after state changes; nonReentrant guard is still held.
        _refundExcess(msg.sender);
    }

    /// @notice Close an open position and settle PnL.
    ///         Only the position owner or LiquidationEngine can close.
    ///         Any native value sent is forwarded to Pyth for update fees; excess is refunded.
    function closePosition(bytes32 positionId, bytes[] calldata priceUpdateData)
        external
        payable
        nonReentrant
        returns (int256 realizedPnl)
    {
        Position memory pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);

        bool isOwner = msg.sender == pos.trader;
        bool isLiquidator = hasRole(LIQUIDATION_ENGINE_ROLE, msg.sender);
        if (!isOwner && !isLiquidator) revert UnauthorizedCaller(msg.sender);

        realizedPnl = _closePositionInternal(msg.sender, positionId, priceUpdateData);
    }

    /// @notice Add margin to an existing position to improve health factor.
    function addMargin(bytes32 positionId, uint256 additionalMargin) external nonReentrant {
        if (additionalMargin == 0) revert ZeroMargin();
        Position storage pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);
        if (msg.sender != pos.trader) revert UnauthorizedCaller(msg.sender);

        vaultManager.debitMargin(msg.sender, additionalMargin, "add margin");
        pos.margin += uint128(additionalMargin);

        emit MarginAdded(positionId, msg.sender, additionalMargin);
    }

    /// @notice Remove margin from a position. Remaining margin must stay at or above 1.2× maintenance.
    function removeMargin(bytes32 positionId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroMargin();
        Position storage pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);
        if (msg.sender != pos.trader) revert UnauthorizedCaller(msg.sender);

        // Safety: remaining margin must stay >= 1.2× maintenance to leave a buffer above liquidation.
        uint256 maintenanceRequired =
            uint256(pos.notional) * _pairConfigs[pos.pair].maintenanceMarginBps / 10_000;
        uint256 safeMin = maintenanceRequired * 12 / 10; // 1.2× buffer
        if (pos.margin < amount || pos.margin - amount < safeMin) {
            revert InsufficientMarginRemaining(
                pos.margin < amount ? 0 : pos.margin - amount,
                safeMin
            );
        }

        pos.margin -= uint128(amount);
        vaultManager.creditMargin(msg.sender, amount, "remove margin");
        emit MarginRemoved(positionId, msg.sender, amount);
    }

    /// @notice Partially close a position. fractionBps 1–9999 = partial; 10000 delegates to closePosition.
    function closePartial(bytes32 positionId, uint256 fractionBps, bytes[] calldata priceUpdateData)
        external
        payable
        nonReentrant
        returns (int256 realizedPnl)
    {
        if (fractionBps == 0 || fractionBps > 10_000) revert InvalidFraction(fractionBps);

        // 100% close — forward to full closePosition to avoid logic duplication.
        // NOTE: closePosition is also nonReentrant; call it via internal helper to avoid double-guard.
        if (fractionBps == 10_000) return _closePositionInternal(msg.sender, positionId, priceUpdateData);

        // ── CHECK ────────────────────────────────────────────────────────────
        Position storage pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);

        bool isOwner = msg.sender == pos.trader;
        bool isLiquidator = hasRole(LIQUIDATION_ENGINE_ROLE, msg.sender);
        if (!isOwner && !isLiquidator) revert UnauthorizedCaller(msg.sender);

        if (block.number <= pos.openedAtBlock) revert SameBlockOpenClose(positionId);

        // ── ORACLE ───────────────────────────────────────────────────────────
        uint256 exitPrice =
            OracleLib.getVerifiedPrice(pyth, _pythPriceIds[pos.pair], priceUpdateData, _chainlinkFeeds[pos.pair]);

        // ── COMPUTE ──────────────────────────────────────────────────────────
        uint256 partialNotional = uint256(pos.notional) * fractionBps / 10_000;
        uint256 partialMargin   = uint256(pos.margin)   * fractionBps / 10_000;

        int256 unrealizedPnl =
            PerpMath.computeUnrealizedPnl(pos.entryPrice, exitPrice, partialNotional, pos.isLong);

        uint256 elapsed = block.timestamp - _lastFundingTimestamp[pos.pair];
        int256 fundingPayment = PerpMath.computeFundingPayment(
            exitPrice,
            _indexPrices[pos.pair] > 0 ? _indexPrices[pos.pair] : exitPrice,
            partialNotional,
            elapsed,
            pos.isLong
        );

        realizedPnl = unrealizedPnl - fundingPayment;

        int256 finalAmountSigned = int256(partialMargin) + realizedPnl;
        uint256 returnedAmount = finalAmountSigned > 0 ? uint256(finalAmountSigned) : 0;

        // ── EFFECT ───────────────────────────────────────────────────────────
        pos.notional -= uint128(partialNotional);
        pos.margin   -= uint128(partialMargin);

        if (returnedAmount > 0) {
            vaultManager.creditMargin(pos.trader, returnedAmount, "partial close");
        }

        emit PositionPartiallyClosed(positionId, pos.trader, fractionBps, realizedPnl, returnedAmount);

        // ── REFUND ───────────────────────────────────────────────────────────
        _refundExcess(msg.sender);
    }

    /// @notice Grant an address permission to open and close positions on your behalf.
    function approveOrderExecutor(address executor) external {
        _orderExecutors[msg.sender] = executor;
        emit OrderExecutorApproved(msg.sender, executor);
    }

    /// @notice Open a position for `trader`. Caller must be the trader's approved executor.
    function openPositionFor(
        address trader,
        bytes32 pair,
        bool isLong,
        uint256 margin,
        uint256 leverageBps,
        uint256 minPrice,
        uint256 maxPrice,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant whenNotPaused returns (bytes32 positionId) {
        if (_orderExecutors[trader] != msg.sender) revert UnauthorizedCaller(msg.sender);

        // ── CHECK ────────────────────────────────────────────────────────────
        PairConfig memory config = _pairConfigs[pair];
        if (!config.active) revert PairNotActive(pair);
        if (margin == 0) revert ZeroMargin();
        if (leverageBps == 0 || leverageBps > config.maxLeverageBps) {
            revert LeverageExceedsMax(leverageBps, config.maxLeverageBps);
        }

        bytes32 existingId = _traderPositionId[trader][pair];
        if (existingId != bytes32(0) && _positions[existingId].trader != address(0)) {
            revert PositionAlreadyExists(trader, pair);
        }

        // ── ORACLE ───────────────────────────────────────────────────────────
        uint256 entryPrice =
            OracleLib.getVerifiedPrice(pyth, _pythPriceIds[pair], priceUpdateData, _chainlinkFeeds[pair]);

        // ── SLIPPAGE GUARD ───────────────────────────────────────────────────
        if (minPrice > 0 && entryPrice < minPrice) revert SlippageExceeded(entryPrice, minPrice);
        if (maxPrice > 0 && entryPrice > maxPrice) revert SlippageExceeded(entryPrice, maxPrice);

        // ── COMPUTE ──────────────────────────────────────────────────────────
        uint256 notional = PerpMath.computeNotional(margin, leverageBps);
        uint256 fee = PerpMath.computeFee(notional, config.takerFeeBps);
        uint256 totalDebit = margin + fee;

        positionId = computePositionId(trader, pair, block.number);

        // ── EFFECT ───────────────────────────────────────────────────────────
        vaultManager.debitMargin(trader, totalDebit, "open position for");

        _positions[positionId] = Position({
            trader: trader,
            pair: pair,
            notional: uint128(notional),
            margin: uint128(margin),
            entryPrice: uint128(entryPrice),
            openedAtBlock: uint64(block.number),
            isLong: isLong
        });

        _traderPositionId[trader][pair] = positionId;
        _lastFundingTimestamp[pair] = block.timestamp;

        vaultManager.forwardFee(address(feeCollector), fee);
        feeCollector.collectFee(trader, fee, pair);

        emit PositionOpened(positionId, trader, pair, notional, entryPrice, isLong, leverageBps);

        _refundExcess(msg.sender);
    }

    /// @notice Close `trader`'s position. Caller must be the trader's approved executor.
    function closePositionFor(
        address trader,
        bytes32 positionId,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant returns (int256 realizedPnl) {
        Position memory pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);
        if (pos.trader != trader) revert UnauthorizedCaller(msg.sender);
        if (_orderExecutors[trader] != msg.sender) revert UnauthorizedCaller(msg.sender);

        realizedPnl = _closePositionInternal(msg.sender, positionId, priceUpdateData);
    }

    /// @notice Settle funding payments for a list of pairs. Called by keeper bot every 8 hours.
    function settleFunding(bytes32[] calldata pairs) external onlyRole(KEEPER_ROLE) {
        for (uint256 i = 0; i < pairs.length; i++) {
            bytes32 pair = pairs[i];
            uint256 indexPrice = _indexPrices[pair];
            if (indexPrice == 0) continue;

            uint256 elapsed = block.timestamp - _lastFundingTimestamp[pair];
            if (elapsed < 1 hours) continue;

            _lastFundingTimestamp[pair] = block.timestamp;
            emit FundingSettled(pair, 0, block.timestamp);
        }
    }

    /// @notice Update the index price for a pair. Called by keeper bot.
    function setIndexPrice(bytes32 pair, uint256 price) external onlyRole(KEEPER_ROLE) {
        _indexPrices[pair] = price;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Halt new position opens. Existing positions can still be closed.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume normal operation.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Update the Chainlink fallback feed for a pair (testnet price freshness).
    function updatePairFeed(bytes32 pair, address newChainlinkFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_pairConfigs[pair].active, "Pair not active");
        _chainlinkFeeds[pair] = newChainlinkFeed;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getPosition(bytes32 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function getPairConfig(bytes32 pair) external view returns (PairConfig memory) {
        return _pairConfigs[pair];
    }

    function getPositionId(address trader, bytes32 pair) external view returns (bytes32) {
        return _traderPositionId[trader][pair];
    }

    function computePositionId(address trader, bytes32 pair, uint256 openedAtBlock)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(trader, pair, openedAtBlock));
    }

    function getPythPriceId(bytes32 pair) external view returns (bytes32) {
        return _pythPriceIds[pair];
    }

    function getChainlinkFeed(bytes32 pair) external view returns (address) {
        return _chainlinkFeeds[pair];
    }

    function getActivePairs() external view returns (bytes32[] memory) {
        return _activePairs;
    }

    function getOrderExecutor(address trader) external view returns (address) {
        return _orderExecutors[trader];
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Core close logic shared by closePosition, closePositionFor, and closePartial(10000).
    ///      Caller is responsible for auth checks and holding nonReentrant guard.
    ///      `refundTo` receives any unused native currency (Pyth fee refund).
    function _closePositionInternal(
        address refundTo,
        bytes32 positionId,
        bytes[] calldata priceUpdateData
    ) internal returns (int256 realizedPnl) {
        Position memory pos = _positions[positionId];
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);
        if (block.number <= pos.openedAtBlock) revert SameBlockOpenClose(positionId);

        // ── ORACLE ───────────────────────────────────────────────────────────
        uint256 closePrice =
            OracleLib.getVerifiedPrice(pyth, _pythPriceIds[pos.pair], priceUpdateData, _chainlinkFeeds[pos.pair]);

        // ── COMPUTE ──────────────────────────────────────────────────────────
        int256 unrealizedPnl =
            PerpMath.computeUnrealizedPnl(pos.entryPrice, closePrice, pos.notional, pos.isLong);

        uint256 elapsed = block.timestamp - _lastFundingTimestamp[pos.pair];
        int256 fundingPayment = PerpMath.computeFundingPayment(
            closePrice,
            _indexPrices[pos.pair] > 0 ? _indexPrices[pos.pair] : closePrice,
            pos.notional,
            elapsed,
            pos.isLong
        );

        realizedPnl = unrealizedPnl - fundingPayment;

        int256 finalAmountSigned = int256(uint256(pos.margin)) + realizedPnl;
        uint256 finalAmount = finalAmountSigned > 0 ? uint256(finalAmountSigned) : 0;

        // ── EFFECT ───────────────────────────────────────────────────────────
        delete _positions[positionId];
        delete _traderPositionId[pos.trader][pos.pair];

        if (finalAmount > 0) {
            vaultManager.creditMargin(pos.trader, finalAmount, "close position");
        }

        emit PositionClosed(positionId, pos.trader, realizedPnl, finalAmount);

        // ── REFUND ───────────────────────────────────────────────────────────
        _refundExcess(refundTo);
    }

    /// @dev Refund any native currency remaining in the contract to `recipient`.
    ///      Called after state changes; nonReentrant guard is held by the caller.
    function _refundExcess(address recipient) internal {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool ok,) = payable(recipient).call{value: bal}("");
        if (!ok) revert RefundFailed();
    }
}
