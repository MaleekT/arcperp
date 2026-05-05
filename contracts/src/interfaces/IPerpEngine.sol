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
    event FundingSettled(bytes32 indexed pair, int256 fundingRate, uint256 timestamp);

    error PairNotActive(bytes32 pair);
    error LeverageExceedsMax(uint256 requested, uint256 max);
    error PositionAlreadyExists(address trader, bytes32 pair);
    error PositionDoesNotExist(bytes32 positionId);
    error SameBlockOpenClose(bytes32 positionId);
    error UnauthorizedCaller(address caller);
    error ZeroMargin();

    function openPosition(
        bytes32 pair,
        bool isLong,
        uint256 margin,
        uint256 leverageBps,
        bytes[] calldata priceUpdateData
    ) external returns (bytes32 positionId);

    function closePosition(bytes32 positionId, bytes[] calldata priceUpdateData)
        external
        returns (int256 realizedPnl);

    function addMargin(bytes32 positionId, uint256 additionalMargin) external;

    function settleFunding(bytes32[] calldata pairs) external;

    function getPosition(bytes32 positionId) external view returns (Position memory);

    function getPairConfig(bytes32 pair) external view returns (PairConfig memory);

    function getPythPriceId(bytes32 pair) external view returns (bytes32);

    function getChainlinkFeed(bytes32 pair) external view returns (address);

    function computePositionId(address trader, bytes32 pair, uint256 openedAtBlock)
        external
        pure
        returns (bytes32);
}
