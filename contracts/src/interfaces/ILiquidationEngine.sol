// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ILiquidationEngine {
    event LiquidationExecuted(
        bytes32 indexed positionId,
        address indexed trader,
        address indexed liquidator,
        uint256 notional,
        uint256 liquidatorBonus,
        uint256 insuranceFundContribution,
        bool isPartial
    );

    error PositionNotLiquidatable(bytes32 positionId, uint256 healthFactor);
    error PositionDoesNotExist(bytes32 positionId);

    function liquidate(bytes32 positionId, bytes[] calldata priceUpdateData) external;

    function isLiquidatable(bytes32 positionId, uint256 currentPrice)
        external
        view
        returns (bool liquidatable, uint256 healthFactor);
}
