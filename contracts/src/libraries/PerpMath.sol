// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PerpMath
/// @notice Pure math library for all ArcPerp financial calculations.
///         All values are unsigned unless marked int256 (PnL, funding).
///         Price precision: 1e8 (Pyth format). USDC precision: 1e6.
library PerpMath {
    uint256 internal constant PRICE_PRECISION = 1e8;
    uint256 internal constant USDC_PRECISION = 1e6;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant HEALTH_PRECISION = 1e18;
    /// @dev 8-hour funding period in seconds
    uint256 internal constant FUNDING_PERIOD = 8 hours;

    error InvalidLeverage();
    error InvalidPrice();

    /// @notice Compute position notional in USDC (6 decimals).
    /// @param margin      Margin deposited in USDC (6 decimals)
    /// @param leverageBps Leverage in basis points where 100 bps = 1x (e.g. 1000 = 10x, 2500 = 25x)
    function computeNotional(uint256 margin, uint256 leverageBps) internal pure returns (uint256) {
        if (leverageBps == 0) revert InvalidLeverage();
        // leverageBps / 100 = actual multiplier, so notional = margin * (leverageBps / 100)
        return (margin * leverageBps) / 100;
    }

    /// @notice Compute the price at which a position is liquidated.
    /// @param entryPrice          Entry price in 1e8 precision
    /// @param leverageBps         Leverage in basis points
    /// @param isLong              True for long, false for short
    /// @param maintenanceMarginBps Maintenance margin in basis points (e.g. 250 = 2.5%)
    /// @return liquidationPrice in 1e8 precision (always > 0)
    function computeLiquidationPrice(
        uint256 entryPrice,
        uint256 leverageBps,
        bool isLong,
        uint256 maintenanceMarginBps
    ) internal pure returns (uint256) {
        if (entryPrice == 0) revert InvalidPrice();
        if (leverageBps == 0) revert InvalidLeverage();

        // Liq price = entryPrice * (1 - maintenanceMarginBps/leverageBps) for longs
        // Liq price = entryPrice * (1 + maintenanceMarginBps/leverageBps) for shorts
        // Expressed as: entryPrice * (leverageBps ± maintenanceMarginBps) / leverageBps
        // Net liq distance = 1/leverage - maintenanceMarginBps%
        // With leverageBps convention (100 = 1x):
        //   leverageFraction = 100 * PP / leverageBps   (1/leverage expressed in PP units)
        //   maintenanceFraction = maintenanceMarginBps * PP / BASIS_POINTS
        //   netDistance = leverageFraction - maintenanceFraction (must be positive for valid config)
        uint256 leverageFraction = (PRICE_PRECISION * 100) / leverageBps;
        uint256 maintenanceFraction = (maintenanceMarginBps * PRICE_PRECISION) / BASIS_POINTS;
        // Guard: maintenance fraction must be less than leverage fraction
        uint256 netDistance = leverageFraction > maintenanceFraction
            ? leverageFraction - maintenanceFraction
            : 0;

        if (isLong) {
            uint256 liqPrice = entryPrice - (entryPrice * netDistance) / PRICE_PRECISION;
            return liqPrice == 0 ? 1 : liqPrice;
        } else {
            return entryPrice + (entryPrice * netDistance) / PRICE_PRECISION;
        }
    }

    /// @notice Compute unrealized PnL for an open position.
    /// @param entryPrice   Entry price in 1e8 precision
    /// @param currentPrice Current mark price in 1e8 precision
    /// @param notional     Position notional in USDC (6 decimals)
    /// @param isLong       True for long, false for short
    /// @return unrealizedPnl in USDC (6 decimals), can be negative
    function computeUnrealizedPnl(
        uint256 entryPrice,
        uint256 currentPrice,
        uint256 notional,
        bool isLong
    ) internal pure returns (int256) {
        if (entryPrice == 0) revert InvalidPrice();

        // PnL = notional * (currentPrice - entryPrice) / entryPrice  [long]
        //     = notional * (entryPrice - currentPrice) / entryPrice  [short]
        int256 priceDelta = int256(currentPrice) - int256(entryPrice);
        if (!isLong) priceDelta = -priceDelta;

        // Result in USDC precision: notional (1e6) * priceDelta (1e8) / entryPrice (1e8)
        return (int256(notional) * priceDelta) / int256(entryPrice);
    }

    /// @notice Compute position health factor.
    ///         Health factor >= 1e18 means healthy. < 1e18 means liquidatable.
    /// @param margin               Current margin in USDC (6 decimals)
    /// @param unrealizedPnl        Unrealized PnL in USDC (6 decimals), can be negative
    /// @param notional             Position notional in USDC (6 decimals)
    /// @param maintenanceMarginBps Maintenance margin in basis points
    /// @return healthFactor in 1e18 precision
    function computeHealthFactor(
        uint256 margin,
        int256 unrealizedPnl,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) internal pure returns (uint256) {
        uint256 maintenanceRequired = (notional * maintenanceMarginBps) / BASIS_POINTS;
        if (maintenanceRequired == 0) return type(uint256).max;

        int256 effectiveMargin = int256(margin) + unrealizedPnl;
        if (effectiveMargin <= 0) return 0;

        return (uint256(effectiveMargin) * HEALTH_PRECISION) / maintenanceRequired;
    }

    /// @notice Compute funding payment for a position over a period.
    ///         Positive return = longs pay shorts. Negative = shorts pay longs.
    /// @param markPrice            Current mark price (1e8)
    /// @param indexPrice           CEX aggregate index price (1e8)
    /// @param notional             Position notional in USDC (6 decimals)
    /// @param elapsedSeconds       Time elapsed since last funding settlement
    /// @param isLong               True for long position
    /// @return fundingPayment in USDC (6 decimals), positive = payment owed
    function computeFundingPayment(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        uint256 elapsedSeconds,
        bool isLong
    ) internal pure returns (int256) {
        if (indexPrice == 0) revert InvalidPrice();
        if (elapsedSeconds == 0) return 0;

        // fundingRate = (markPrice - indexPrice) / indexPrice, pro-rated by elapsed time
        int256 priceDiff = int256(markPrice) - int256(indexPrice);
        // fundingRate in 1e18: priceDiff * 1e18 / indexPrice * (elapsed / FUNDING_PERIOD)
        int256 rateScaled = (priceDiff * int256(HEALTH_PRECISION)) / int256(indexPrice);
        int256 proRatedRate = (rateScaled * int256(elapsedSeconds)) / int256(FUNDING_PERIOD);

        // fundingPayment = notional * proRatedRate / 1e18
        int256 payment = (int256(notional) * proRatedRate) / int256(HEALTH_PRECISION);

        // Long pays when mark > index (positive funding), short pays when mark < index
        return isLong ? payment : -payment;
    }

    /// @notice Compute taker fee for a trade.
    /// @param notional    Position notional in USDC (6 decimals)
    /// @param feeBps      Fee rate in basis points (e.g. 5 = 0.05%)
    function computeFee(uint256 notional, uint256 feeBps) internal pure returns (uint256) {
        return (notional * feeBps) / BASIS_POINTS;
    }
}
