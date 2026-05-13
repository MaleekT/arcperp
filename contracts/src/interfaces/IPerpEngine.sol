// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPerpEngine {
    struct Position {
        address trader;
        bytes32 pair;
        uint128 notional;
        uint128 margin;
        uint128 entryPrice;
        uint64 openedAtBlock;
        bool isLong;
    }

    struct PairConfig {
        bool active;
        uint16 maxLeverageBps;
        uint16 takerFeeBps;
        uint16 makerFeeBps;
        uint16 maintenanceMarginBps;
    }

    event PositionOpened(
        bytes32 indexed positionId,
        address indexed trader,
        bytes32 indexed pair,
        uint256 notional,
        uint256 entryPrice,
        bool isLong,
        uint256 leverageBps
    );
    event PositionClosed(
        bytes32 indexed positionId,
        address indexed trader,
        int256 realizedPnl,
        uint256 finalAmount
    );
    event MarginAdded(bytes32 indexed positionId, address indexed trader, uint256 amount);
    event MarginRemoved(bytes32 indexed positionId, address indexed trader, uint256 amount);
    event PositionPartiallyClosed(
        bytes32 indexed positionId,
        address indexed trader,
        uint256 fractionBps,
        int256 realizedPnl,
        uint256 returnedAmount
    );
    event OrderExecutorApproved(address indexed trader, address indexed executor);
    event FundingSettled(bytes32 indexed pair, int256 fundingRate, uint256 timestamp);

    error PairNotActive(bytes32 pair);
    error LeverageExceedsMax(uint256 requested, uint256 max);
    error PositionAlreadyExists(address trader, bytes32 pair);
    error PositionDoesNotExist(bytes32 positionId);
    error SameBlockOpenClose(bytes32 positionId);
    error UnauthorizedCaller(address caller);
    error ZeroMargin();
    error SlippageExceeded(uint256 price, uint256 bound);
    error RefundFailed();
    error InsufficientMarginRemaining(uint256 remaining, uint256 required);
    error InvalidFraction(uint256 fractionBps);

    /// @notice Open a leveraged perpetual position.
    /// @param pair            keccak256 pair ID e.g. keccak256("BTC-USDC")
    /// @param isLong          True = long, False = short
    /// @param margin          USDC margin (6 decimals) already in trader's vault balance
    /// @param leverageBps     Leverage in basis points (100 = 1x, 2500 = 25x)
    /// @param minPrice        Minimum acceptable oracle price (0 = no floor)
    /// @param maxPrice        Maximum acceptable oracle price (0 = no ceiling)
    /// @param priceUpdateData Fresh Pyth VAA bytes from Hermes API
    function openPosition(
        bytes32 pair,
        bool isLong,
        uint256 margin,
        uint256 leverageBps,
        uint256 minPrice,
        uint256 maxPrice,
        bytes[] calldata priceUpdateData
    ) external payable returns (bytes32 positionId);

    /// @notice Close an open position and settle PnL.
    function closePosition(bytes32 positionId, bytes[] calldata priceUpdateData)
        external
        payable
        returns (int256 realizedPnl);

    function addMargin(bytes32 positionId, uint256 additionalMargin) external;

    /// @notice Remove margin from a position. Remaining margin must stay >= 1.2x maintenance.
    function removeMargin(bytes32 positionId, uint256 amount) external;

    /// @notice Partially close a position. fractionBps 1–9999 = partial; 10000 = full close.
    function closePartial(bytes32 positionId, uint256 fractionBps, bytes[] calldata priceUpdateData)
        external
        payable
        returns (int256 realizedPnl);

    /// @notice Grant an executor address permission to open/close positions on your behalf.
    function approveOrderExecutor(address executor) external;

    /// @notice Open a position for `trader`. Caller must be trader's approved executor.
    function openPositionFor(
        address trader,
        bytes32 pair,
        bool isLong,
        uint256 margin,
        uint256 leverageBps,
        uint256 minPrice,
        uint256 maxPrice,
        bytes[] calldata priceUpdateData
    ) external payable returns (bytes32 positionId);

    /// @notice Close `trader`'s position. Caller must be trader's approved executor.
    function closePositionFor(
        address trader,
        bytes32 positionId,
        bytes[] calldata priceUpdateData
    ) external payable returns (int256 realizedPnl);

    function settleFunding(bytes32[] calldata pairs) external;

    function getPosition(bytes32 positionId) external view returns (Position memory);

    function getPairConfig(bytes32 pair) external view returns (PairConfig memory);

    function getOrderExecutor(address trader) external view returns (address executor);

    function getPythPriceId(bytes32 pair) external view returns (bytes32);

    function getChainlinkFeed(bytes32 pair) external view returns (address);

    function computePositionId(address trader, bytes32 pair, uint256 openedAtBlock)
        external
        pure
        returns (bytes32);
}
