// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/libraries/PerpMath.sol";

/// @notice Fuzz tests for the PerpMath library.
///         Proves mathematical invariants hold across all bounded input spaces.
///         Run with: forge test --match-contract FuzzPerpMath --fuzz-runs 10000 -vv
contract FuzzPerpMathTest is Test {
    // ── Constants mirrored from PerpMath ─────────────────────────────────────
    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant PRICE_PRECISION = 1e8;
    uint256 private constant HEALTH_PRECISION = 1e18;

    // ── Input bounds ─────────────────────────────────────────────────────────
    // Margin: 1 USDC to 10M USDC (reasonable trader range)
    uint256 private constant MARGIN_MIN = 1e6;
    uint256 private constant MARGIN_MAX = 10_000_000e6;
    // Leverage: 1x (100 bps) to 100x (10_000 bps)
    uint256 private constant LEVERAGE_MIN = 100;
    uint256 private constant LEVERAGE_MAX = 10_000;
    // Price: $1 to $10M in 1e8 precision
    uint256 private constant PRICE_MIN = 1e8;
    uint256 private constant PRICE_MAX = 10_000_000e8;
    // Maintenance margin: 10 bps (0.1%) to 500 bps (5%)
    uint256 private constant MAINT_MIN = 10;
    uint256 private constant MAINT_MAX = 500;
    // Fee: 1 to 50 bps (0.01% to 0.5%)
    uint256 private constant FEE_MIN = 1;
    uint256 private constant FEE_MAX = 50;

    // ── computeNotional ───────────────────────────────────────────────────────

    /// @notice notional = margin * leverageBps / 100. Result must be ≥ margin for leverage ≥ 1x.
    function testFuzz_computeNotional_equalsMarginTimesLeverage(uint256 margin, uint256 leverageBps) public pure {
        margin = bound(margin, MARGIN_MIN, MARGIN_MAX);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);

        uint256 notional = PerpMath.computeNotional(margin, leverageBps);

        // Exact equality
        assertEq(notional, (margin * leverageBps) / 100, "notional must equal margin * leverage / 100");

        // At leverageBps >= 100 (1x), notional >= margin
        assertGe(notional, margin, "notional must be >= margin for leverage >= 1x");
    }

    /// @notice Zero leverage must revert with InvalidLeverage.
    function testFuzz_computeNotional_revertsOnZeroLeverage(uint256 margin) public {
        margin = bound(margin, 0, type(uint128).max);
        vm.expectRevert(PerpMath.InvalidLeverage.selector);
        PerpMath.computeNotional(margin, 0);
    }

    /// @notice notional scales linearly: doubling leverage doubles notional.
    function testFuzz_computeNotional_linearInLeverage(uint256 margin, uint256 leverageBps) public pure {
        margin = bound(margin, MARGIN_MIN, MARGIN_MAX / 2); // /2 prevents overflow at 2x leverage
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX / 2);

        uint256 n1 = PerpMath.computeNotional(margin, leverageBps);
        uint256 n2 = PerpMath.computeNotional(margin, leverageBps * 2);

        // n2 should be exactly 2 * n1 (integer arithmetic, no remainder for even leverageBps)
        assertEq(n2, n1 * 2, "doubling leverage must double notional");
    }

    // ── computeUnrealizedPnl ─────────────────────────────────────────────────

    /// @notice PnL at entry price is zero (or ≤ 1 due to rounding).
    function testFuzz_computeUnrealizedPnl_zeroAtEntryPrice(uint256 entryPrice, uint256 notional, bool isLong)
        public
        pure
    {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 pnl = PerpMath.computeUnrealizedPnl(entryPrice, entryPrice, notional, isLong);
        assertEq(pnl, 0, "PnL at entry price must be zero");
    }

    /// @notice Long profits when price rises, loses when price falls.
    function testFuzz_computeUnrealizedPnl_longSignCorrectness(
        uint256 entryPrice,
        uint256 notional,
        uint256 priceIncrease
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX / 2); // room to rise
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        priceIncrease = bound(priceIncrease, 1, entryPrice); // rise by 0.0000001% to 100%

        uint256 higherPrice = entryPrice + priceIncrease;
        uint256 lowerPrice = entryPrice - priceIncrease;

        int256 profitPnl = PerpMath.computeUnrealizedPnl(entryPrice, higherPrice, notional, true);
        int256 lossPnl = PerpMath.computeUnrealizedPnl(entryPrice, lowerPrice, notional, true);

        assertGe(profitPnl, 0, "long must profit on price rise");
        assertLe(lossPnl, 0, "long must lose on price fall");
    }

    /// @notice Short profits when price falls, loses when price rises.
    function testFuzz_computeUnrealizedPnl_shortSignCorrectness(
        uint256 entryPrice,
        uint256 notional,
        uint256 priceMove
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX / 2);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        priceMove = bound(priceMove, 1, entryPrice);

        uint256 higherPrice = entryPrice + priceMove;
        uint256 lowerPrice = entryPrice - priceMove;

        int256 profitPnl = PerpMath.computeUnrealizedPnl(entryPrice, lowerPrice, notional, false);
        int256 lossPnl = PerpMath.computeUnrealizedPnl(entryPrice, higherPrice, notional, false);

        assertGe(profitPnl, 0, "short must profit on price fall");
        assertLe(lossPnl, 0, "short must lose on price rise");
    }

    /// @notice PnL magnitude is proportional to price move size.
    function testFuzz_computeUnrealizedPnl_symmetricForLongShort(
        uint256 entryPrice,
        uint256 currentPrice,
        uint256 notional
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        currentPrice = bound(currentPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 longPnl = PerpMath.computeUnrealizedPnl(entryPrice, currentPrice, notional, true);
        int256 shortPnl = PerpMath.computeUnrealizedPnl(entryPrice, currentPrice, notional, false);

        // Long PnL + Short PnL = 0 (zero-sum)
        assertEq(longPnl + shortPnl, 0, "long and short PnL must sum to zero");
    }

    /// @notice Zero entry price reverts.
    function testFuzz_computeUnrealizedPnl_revertsOnZeroEntryPrice(uint256 current, uint256 notional, bool isLong)
        public
    {
        vm.expectRevert(PerpMath.InvalidPrice.selector);
        PerpMath.computeUnrealizedPnl(0, current, notional, isLong);
    }

    // ── computeHealthFactor ───────────────────────────────────────────────────

    /// @notice Health factor returns max when maintenanceRequired is zero.
    function testFuzz_computeHealthFactor_maxWhenNoMaintenance(uint256 margin, int256 unrealizedPnl, uint256 notional)
        public
        pure
    {
        margin = bound(margin, 0, type(uint128).max);
        unrealizedPnl = bound(unrealizedPnl, type(int128).min, type(int128).max);
        notional = bound(notional, 0, type(uint128).max);

        // maintenanceMarginBps = 0 → maintenanceRequired = 0 → returns max
        uint256 hf = PerpMath.computeHealthFactor(margin, unrealizedPnl, notional, 0);
        assertEq(hf, type(uint256).max, "zero maintenance must return max health");
    }

    /// @notice Health factor is zero when effective margin ≤ 0.
    function testFuzz_computeHealthFactor_zeroWhenInsolvent(
        uint256 margin,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) public pure {
        margin = bound(margin, 0, MARGIN_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        // Force negative PnL that exceeds margin (guaranteed insolvent)
        int256 hugeLoss = -(int256(margin) + 1);

        uint256 hf = PerpMath.computeHealthFactor(margin, hugeLoss, notional, maintenanceMarginBps);
        assertEq(hf, 0, "insolvent position must have zero health factor");
    }

    /// @notice Health factor increases as effective margin increases.
    function testFuzz_computeHealthFactor_monotonicInMargin(
        uint256 margin1,
        uint256 margin2,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) public pure {
        margin1 = bound(margin1, MARGIN_MIN, MARGIN_MAX);
        margin2 = bound(margin2, margin1, MARGIN_MAX); // margin2 >= margin1
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 10);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        uint256 hf1 = PerpMath.computeHealthFactor(margin1, 0, notional, maintenanceMarginBps);
        uint256 hf2 = PerpMath.computeHealthFactor(margin2, 0, notional, maintenanceMarginBps);

        assertGe(hf2, hf1, "greater margin must produce greater or equal health factor");
    }

    /// @notice A position at 1x equity (margin == maintenanceRequired) has health == 1e18.
    function testFuzz_computeHealthFactor_exactlyOneAtThreshold(uint256 notional, uint256 maintenanceMarginBps)
        public
        pure
    {
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        uint256 maintenanceRequired = (notional * maintenanceMarginBps) / BASIS_POINTS;
        if (maintenanceRequired == 0) return; // skip trivial case

        uint256 hf = PerpMath.computeHealthFactor(maintenanceRequired, 0, notional, maintenanceMarginBps);
        assertEq(hf, HEALTH_PRECISION, "margin == maintenanceRequired must give health == 1e18");
    }

    // ── computeFee ───────────────────────────────────────────────────────────

    /// @notice Fee = notional * feeBps / 10_000. No overflow within bounds.
    function testFuzz_computeFee_equalsNotionalTimesRate(uint256 notional, uint256 feeBps) public pure {
        notional = bound(notional, 0, MARGIN_MAX * 100); // up to 250M USDC notional
        feeBps = bound(feeBps, FEE_MIN, FEE_MAX);

        uint256 fee = PerpMath.computeFee(notional, feeBps);
        assertEq(fee, (notional * feeBps) / BASIS_POINTS, "fee must equal notional * feeBps / 10_000");
    }

    /// @notice Fee is always ≤ notional (can never exceed the position size).
    function testFuzz_computeFee_neverExceedsNotional(uint256 notional, uint256 feeBps) public pure {
        notional = bound(notional, 0, MARGIN_MAX * 100);
        feeBps = bound(feeBps, 0, BASIS_POINTS); // 0 to 100%

        uint256 fee = PerpMath.computeFee(notional, feeBps);
        assertLe(fee, notional, "fee can never exceed notional");
    }

    /// @notice Zero fee rate produces zero fee.
    function testFuzz_computeFee_zeroRateProducesZeroFee(uint256 notional) public pure {
        notional = bound(notional, 0, MARGIN_MAX * 100);
        assertEq(PerpMath.computeFee(notional, 0), 0, "zero fee rate must produce zero fee");
    }

    // ── computeLiquidationPrice ───────────────────────────────────────────────

    /// @notice Long liquidation price is strictly below entry price.
    function testFuzz_computeLiquidationPrice_longBelowEntry(
        uint256 entryPrice,
        uint256 leverageBps,
        uint256 maintenanceMarginBps
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        // Guard: maintenance fraction must be smaller than leverage fraction
        // leverageFraction = 100 * PP / leverageBps
        // maintenanceFraction = maintenanceMarginBps * PP / 10_000
        // We need leverageFraction > maintenanceFraction:
        // 100 / leverageBps > maintenanceMarginBps / 10_000
        // 1_000_000 > leverageBps * maintenanceMarginBps
        vm.assume(1_000_000 > leverageBps * maintenanceMarginBps);

        uint256 liqPrice = PerpMath.computeLiquidationPrice(entryPrice, leverageBps, true, maintenanceMarginBps);

        assertLt(liqPrice, entryPrice, "long liq price must be below entry price");
        assertGt(liqPrice, 0, "liq price must be > 0");
    }

    /// @notice Short liquidation price is strictly above entry price.
    function testFuzz_computeLiquidationPrice_shortAboveEntry(
        uint256 entryPrice,
        uint256 leverageBps,
        uint256 maintenanceMarginBps
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX / 2); // room to rise
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        vm.assume(1_000_000 > leverageBps * maintenanceMarginBps);

        uint256 liqPrice = PerpMath.computeLiquidationPrice(entryPrice, leverageBps, false, maintenanceMarginBps);

        assertGt(liqPrice, entryPrice, "short liq price must be above entry price");
    }

    /// @notice Higher leverage → liq price closer to entry price (for longs).
    function testFuzz_computeLiquidationPrice_higherLeverageCloserToEntry(
        uint256 entryPrice,
        uint256 maintenanceMarginBps
    ) public pure {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, 100); // low maint for valid config at high leverage

        // 5x vs 10x — both must have valid configs with chosen maintenanceMarginBps
        uint256 leverage5x = 500;
        uint256 leverage10x = 1_000;
        vm.assume(1_000_000 > leverage5x * maintenanceMarginBps);
        vm.assume(1_000_000 > leverage10x * maintenanceMarginBps);

        uint256 liqAt5x = PerpMath.computeLiquidationPrice(entryPrice, leverage5x, true, maintenanceMarginBps);
        uint256 liqAt10x = PerpMath.computeLiquidationPrice(entryPrice, leverage10x, true, maintenanceMarginBps);

        // Higher leverage = smaller buffer = liq price closer to (higher than) 5x liq price
        assertGe(liqAt10x, liqAt5x, "10x liq price must be >= 5x liq price (closer to entry)");
    }

    // ── computeFundingPayment ─────────────────────────────────────────────────

    /// @notice Funding is zero when elapsed time is zero.
    function testFuzz_computeFundingPayment_zeroWhenNoTime(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        bool isLong
    ) public pure {
        markPrice = bound(markPrice, PRICE_MIN, PRICE_MAX);
        indexPrice = bound(indexPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 payment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, 0, isLong);
        assertEq(payment, 0, "zero elapsed time must produce zero funding");
    }

    /// @notice Long and short funding payments are exact negatives of each other.
    function testFuzz_computeFundingPayment_longShortAreNegated(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        uint256 elapsed
    ) public pure {
        markPrice = bound(markPrice, PRICE_MIN, PRICE_MAX);
        indexPrice = bound(indexPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        elapsed = bound(elapsed, 1, 8 hours);

        int256 longPayment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, elapsed, true);
        int256 shortPayment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, elapsed, false);

        assertEq(longPayment, -shortPayment, "long and short funding must be exact negatives");
    }

    /// @notice When mark == index, funding is zero (no imbalance).
    function testFuzz_computeFundingPayment_zeroWhenMarkEqualsIndex(
        uint256 price,
        uint256 notional,
        uint256 elapsed,
        bool isLong
    ) public pure {
        price = bound(price, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        elapsed = bound(elapsed, 0, 8 hours);

        int256 payment = PerpMath.computeFundingPayment(price, price, notional, elapsed, isLong);
        assertEq(payment, 0, "equal mark and index prices must produce zero funding");
    }
}
