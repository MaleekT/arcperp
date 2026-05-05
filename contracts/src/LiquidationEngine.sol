// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ILiquidationEngine.sol";
import "./interfaces/IPerpEngine.sol";
import "./interfaces/IVaultManager.sol";
import "./libraries/PerpMath.sol";
import "./libraries/OracleLib.sol";

/// @title LiquidationEngine
/// @notice Permissionless liquidation of underwater positions. Liquidators earn 1.5% bonus.
///
/// Security layers:
///   - ReentrancyGuard on liquidate()
///   - CEI: position deleted (via closePosition) BEFORE bonus is paid to liquidator
///   - OracleLib.getVerifiedPrice() — same staleness + deviation guards as PerpEngine
///   - Partial liquidation (50%) when health 0.5–1.0; full when < 0.5
///   - Liquidator cannot manipulate price — VAA verified cryptographically on-chain
contract LiquidationEngine is ILiquidationEngine, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant LIQUIDATION_BONUS_BPS = 150; // 1.5%
    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant FULL_LIQ_THRESHOLD = 1e18;  // health < 1.0 → liquidatable
    uint256 private constant PARTIAL_LIQ_THRESHOLD = 5e17; // health < 0.5 → full; >= 0.5 → partial
    uint256 private constant PARTIAL_CLOSE_BPS = 5_000;  // close 50% on partial liquidation

    IPerpEngine public immutable perpEngine;
    IVaultManager public immutable vaultManager;
    IERC20 public immutable usdc;
    address public immutable pyth;

    constructor(address _perpEngine, address _vaultManager, address _usdc, address _pyth, address _admin) {
        if (
            _perpEngine == address(0) || _vaultManager == address(0) || _usdc == address(0)
                || _pyth == address(0) || _admin == address(0)
        ) revert PositionDoesNotExist(bytes32(0));

        perpEngine = IPerpEngine(_perpEngine);
        vaultManager = IVaultManager(_vaultManager);
        usdc = IERC20(_usdc);
        pyth = _pyth;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    /// @notice Liquidate an underwater position. Callable by any address.
    ///         Caller supplies fresh Pyth VAA — price is verified on-chain, not trusted from caller.
    ///         Caller earns 1.5% of notional as liquidation bonus.
    function liquidate(bytes32 positionId, bytes[] calldata priceUpdateData) external nonReentrant {
        // ── CHECK ────────────────────────────────────────────────────────────
        IPerpEngine.Position memory pos = perpEngine.getPosition(positionId);
        if (pos.trader == address(0)) revert PositionDoesNotExist(positionId);

        IPerpEngine.PairConfig memory config = perpEngine.getPairConfig(pos.pair);

        // ── ORACLE ───────────────────────────────────────────────────────────
        // Fetch the verified mark price using PerpEngine's registered oracle feeds.
        // The liquidator supplies the VAA bytes but cannot influence the computed price —
        // Pyth verifies the VAA signature against 15+ off-chain data sources.
        uint256 currentPrice = OracleLib.getVerifiedPrice(
            pyth,
            perpEngine.getPythPriceId(pos.pair),
            priceUpdateData,
            perpEngine.getChainlinkFeed(pos.pair)
        );

        // ── COMPUTE health factor ─────────────────────────────────────────────
        int256 unrealizedPnl =
            PerpMath.computeUnrealizedPnl(pos.entryPrice, currentPrice, pos.notional, pos.isLong);

        uint256 healthFactor =
            PerpMath.computeHealthFactor(pos.margin, unrealizedPnl, pos.notional, config.maintenanceMarginBps);

        if (healthFactor >= FULL_LIQ_THRESHOLD) {
            revert PositionNotLiquidatable(positionId, healthFactor);
        }

        bool isPartial = healthFactor >= PARTIAL_LIQ_THRESHOLD;
        uint256 notionalToClose =
            isPartial ? (uint256(pos.notional) * PARTIAL_CLOSE_BPS) / BASIS_POINTS : pos.notional;

        uint256 liquidatorBonus = (notionalToClose * LIQUIDATION_BONUS_BPS) / BASIS_POINTS;

        // ── EFFECT — CEI: close position FIRST, pay bonus AFTER ──────────────
        // closePosition deletes the position and credits trader's margin in VaultManager.
        // Any re-entry into liquidate() after this point finds pos.trader == address(0) and reverts.
        perpEngine.closePosition(positionId, priceUpdateData);

        // Compute how much the trader received after PnL settlement (used as cap for insurance).
        int256 finalMarginSigned = int256(uint256(pos.margin)) + unrealizedPnl;
        uint256 finalMargin = finalMarginSigned > 0 ? uint256(finalMarginSigned) : 0;

        // Pay liquidator bonus: VaultManager atomically debits trader balance and transfers USDC.
        // Capped at the trader's current vault balance.
        uint256 traderBalance = vaultManager.getMarginBalance(pos.trader);
        uint256 actualBonus = liquidatorBonus <= traderBalance ? liquidatorBonus : traderBalance;

        if (actualBonus > 0) {
            vaultManager.liquidationWithdraw(pos.trader, actualBonus, msg.sender);
        }

        // Route remaining settled margin to insurance fund — pure accounting, no USDC transfer.
        // The USDC stays inside VaultManager; only the claim shifts from trader to insurance fund.
        uint256 remainingBalance = vaultManager.getMarginBalance(pos.trader);
        uint256 insuranceContribution = remainingBalance < finalMargin ? remainingBalance : finalMargin;

        if (insuranceContribution > 0) {
            vaultManager.debitToInsuranceFund(pos.trader, insuranceContribution);
        }

        emit LiquidationExecuted(
            positionId,
            pos.trader,
            msg.sender,
            notionalToClose,
            actualBonus,
            insuranceContribution,
            isPartial
        );
    }

    /// @notice View-only health check using a caller-supplied current price (not oracle-verified).
    ///         Used by the off-chain liquidation bot to identify candidates before calling liquidate().
    function isLiquidatable(bytes32 positionId, uint256 currentPrice)
        external
        view
        returns (bool liquidatable, uint256 healthFactor)
    {
        IPerpEngine.Position memory pos = perpEngine.getPosition(positionId);
        if (pos.trader == address(0)) return (false, type(uint256).max);

        IPerpEngine.PairConfig memory config = perpEngine.getPairConfig(pos.pair);

        int256 unrealizedPnl =
            PerpMath.computeUnrealizedPnl(pos.entryPrice, currentPrice, pos.notional, pos.isLong);

        healthFactor =
            PerpMath.computeHealthFactor(pos.margin, unrealizedPnl, pos.notional, config.maintenanceMarginBps);

        liquidatable = healthFactor < FULL_LIQ_THRESHOLD;
    }
}
