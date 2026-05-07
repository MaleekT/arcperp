// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/libraries/PerpMath.sol";

/// @notice External harness so vm.expectRevert can intercept library reverts.
///         Internal library calls are JUMPs not CALLs — vm.expectRevert can't
///         intercept them. Wrapping in an external call makes the cheatcode work.
contract PerpMathHarness {
    function computeNotional(uint256 margin, uint256 leverageBps) external pure returns (uint256) {
        return PerpMath.computeNotional(margin, leverageBps);
    }

    function computeUnrealizedPnl(uint256 entry, uint256 current, uint256 notional, bool isLong)
        external
        pure
        returns (int256)
    {
        return PerpMath.computeUnrealizedPnl(entry, current, notional, isLong);
    }
}

/// @notice Fuzz tests for the PerpMath library.
///         Proves mathematical invariants hold across all bounded input spaces.
///         Run with: forge test --match-contract FuzzPerpMath --fuzz-runs 10000 -vv
contract FuzzPerpMathTest is Test {
    // ── Constants mirrored from PerpMath ─────────────────────────────────────
    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant PRICE_PRECISION = 1e8;
    uint256 private constant HEALTH_PRECISION = 1e18;

    // ── Input bounds ─────────────────────────────────────────────────────────
    uint256 private constant MARGIN_MIN = 1e6;
    uint256 private constant MARGIN_MAX = 10_000_000e6;
    uint256 private constant LEVERAGE_MIN = 100;
    uint256 private constant LEVERAGE_MAX = 10_000;
    uint256 private constant PRICE_MIN = 1e8;
    uint256 private constant PRICE_MAX = 10_000_000e8;
    uint256 private constant MAINT_MIN = 10;
    uint256 private constant MAINT_MAX = 500;
    uint256 private constant FEE_MIN = 1;
    uint256 private constant FEE_MAX = 50;

    PerpMathHarness internal harness;

    function setUp() public {
        harness = new PerpMathHarness();
    }

    // ── computeNotional ───────────────────────────────────────────────────────

    function testFuzz_computeNotional_equalsMarginTimesLeverage(uint256 margin, uint256 leverageBps) public {
        margin = bound(margin, MARGIN_MIN, MARGIN_MAX);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);

        uint256 notional = PerpMath.computeNotional(margin, leverageBps);

        assertEq(notional, (margin * leverageBps) / 100, "notional must equal margin * leverage / 100");
        assertGe(notional, margin, "notional must be >= margin for leverage >= 1x");
    }

    function testFuzz_computeNotional_revertsOnZeroLeverage(uint256 margin) public {
        margin = bound(margin, 0, type(uint128).max);
        vm.expectRevert(PerpMath.InvalidLeverage.selector);
        harness.computeNotional(margin, 0);
    }

    function testFuzz_computeNotional_linearInLeverage(uint256 margin, uint256 leverageBps) public {
        margin = bound(margin, MARGIN_MIN, MARGIN_MAX / 2);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX / 2);

        uint256 n1 = PerpMath.computeNotional(margin, leverageBps);
        uint256 n2 = PerpMath.computeNotional(margin, leverageBps * 2);

        // Integer division can cause a rounding difference of at most 1
        assertApproxEqAbs(n2, n1 * 2, 1, "doubling leverage must approximately double notional");
    }

    // ── computeUnrealizedPnl ─────────────────────────────────────────────────

    function testFuzz_computeUnrealizedPnl_zeroAtEntryPrice(uint256 entryPrice, uint256 notional, bool isLong)
        public
    {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 pnl = PerpMath.computeUnrealizedPnl(entryPrice, entryPrice, notional, isLong);
        assertEq(pnl, 0, "PnL at entry price must be zero");
    }

    function testFuzz_computeUnrealizedPnl_longSignCorrectness(
        uint256 entryPrice,
        uint256 notional,
        uint256 priceIncrease
    ) public {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX / 2);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        priceIncrease = bound(priceIncrease, 1, entryPrice);

        uint256 higherPrice = entryPrice + priceIncrease;
        uint256 lowerPrice = entryPrice - priceIncrease;

        int256 profitPnl = PerpMath.computeUnrealizedPnl(entryPrice, higherPrice, notional, true);
        int256 lossPnl = PerpMath.computeUnrealizedPnl(entryPrice, lowerPrice, notional, true);

        assertGe(profitPnl, 0, "long must profit on price rise");
        assertLe(lossPnl, 0, "long must lose on price fall");
    }

    function testFuzz_computeUnrealizedPnl_shortSignCorrectness(
        uint256 entryPrice,
        uint256 notional,
        uint256 priceMove
    ) public {
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

    function testFuzz_computeUnrealizedPnl_symmetricForLongShort(
        uint256 entryPrice,
        uint256 currentPrice,
        uint256 notional
    ) public {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        currentPrice = bound(currentPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 longPnl = PerpMath.computeUnrealizedPnl(entryPrice, currentPrice, notional, true);
        int256 shortPnl = PerpMath.computeUnrealizedPnl(entryPrice, currentPrice, notional, false);

        assertEq(longPnl + shortPnl, 0, "long and short PnL must sum to zero");
    }

    function testFuzz_computeUnrealizedPnl_revertsOnZeroEntryPrice(uint256 current, uint256 notional, bool isLong)
        public
    {
        vm.expectRevert(PerpMath.InvalidPrice.selector);
        harness.computeUnrealizedPnl(0, current, notional, isLong);
    }

    // ── computeHealthFactor ───────────────────────────────────────────────────

    function testFuzz_computeHealthFactor_maxWhenNoMaintenance(uint256 margin, int256 unrealizedPnl, uint256 notional)
        public
    {
        margin = bound(margin, 0, type(uint128).max);
        unrealizedPnl = bound(unrealizedPnl, type(int128).min, type(int128).max);
        notional = bound(notional, 0, type(uint128).max);

        uint256 hf = PerpMath.computeHealthFactor(margin, unrealizedPnl, notional, 0);
        assertEq(hf, type(uint256).max, "zero maintenance must return max health");
    }

    function testFuzz_computeHealthFactor_zeroWhenInsolvent(
        uint256 margin,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) public {
        margin = bound(margin, 0, MARGIN_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        int256 hugeLoss = -(int256(margin) + 1);

        uint256 hf = PerpMath.computeHealthFactor(margin, hugeLoss, notional, maintenanceMarginBps);
        assertEq(hf, 0, "insolvent position must have zero health factor");
    }

    function testFuzz_computeHealthFactor_monotonicInMargin(
        uint256 margin1,
        uint256 margin2,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) public {
        margin1 = bound(margin1, MARGIN_MIN, MARGIN_MAX);
        margin2 = bound(margin2, margin1, MARGIN_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 10);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        uint256 hf1 = PerpMath.computeHealthFactor(margin1, 0, notional, maintenanceMarginBps);
        uint256 hf2 = PerpMath.computeHealthFactor(margin2, 0, notional, maintenanceMarginBps);

        assertGe(hf2, hf1, "greater margin must produce greater or equal health factor");
    }

    function testFuzz_computeHealthFactor_exactlyOneAtThreshold(uint256 notional, uint256 maintenanceMarginBps)
        public
    {
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        uint256 maintenanceRequired = (notional * maintenanceMarginBps) / BASIS_POINTS;
        if (maintenanceRequired == 0) return;

        uint256 hf = PerpMath.computeHealthFactor(maintenanceRequired, 0, notional, maintenanceMarginBps);
        assertEq(hf, HEALTH_PRECISION, "margin == maintenanceRequired must give health == 1e18");
    }

    // ── computeFee ───────────────────────────────────────────────────────────

    function testFuzz_computeFee_equalsNotionalTimesRate(uint256 notional, uint256 feeBps) public {
        notional = bound(notional, 0, MARGIN_MAX * 100);
        feeBps = bound(feeBps, FEE_MIN, FEE_MAX);

        uint256 fee = PerpMath.computeFee(notional, feeBps);
        assertEq(fee, (notional * feeBps) / BASIS_POINTS, "fee must equal notional * feeBps / 10_000");
    }

    function testFuzz_computeFee_neverExceedsNotional(uint256 notional, uint256 feeBps) public {
        notional = bound(notional, 0, MARGIN_MAX * 100);
        feeBps = bound(feeBps, 0, BASIS_POINTS);

        uint256 fee = PerpMath.computeFee(notional, feeBps);
        assertLe(fee, notional, "fee can never exceed notional");
    }

    function testFuzz_computeFee_zeroRateProducesZeroFee(uint256 notional) public {
        notional = bound(notional, 0, MARGIN_MAX * 100);
        assertEq(PerpMath.computeFee(notional, 0), 0, "zero fee rate must produce zero fee");
    }

    // ── computeLiquidationPrice ───────────────────────────────────────────────

    function testFuzz_computeLiquidationPrice_longBelowEntry(
        uint256 entryPrice,
        uint256 leverageBps,
        uint256 maintenanceMarginBps
    ) public {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        vm.assume(1_000_000 > leverageBps * maintenanceMarginBps);

        uint256 liqPrice = PerpMath.computeLiquidationPrice(entryPrice, leverageBps, true, maintenanceMarginBps);

        assertLt(liqPrice, entryPrice, "long liq price must be below entry price");
        assertGt(liqPrice, 0, "liq price must be > 0");
    }

    function testFuzz_computeLiquidationPrice_shortAboveEntry(
        uint256 entryPrice,
        uint256 leverageBps,
        uint256 maintenanceMarginBps
    ) public {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX / 2);
        leverageBps = bound(leverageBps, LEVERAGE_MIN, LEVERAGE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, MAINT_MAX);

        vm.assume(1_000_000 > leverageBps * maintenanceMarginBps);

        uint256 liqPrice = PerpMath.computeLiquidationPrice(entryPrice, leverageBps, false, maintenanceMarginBps);

        assertGt(liqPrice, entryPrice, "short liq price must be above entry price");
    }

    function testFuzz_computeLiquidationPrice_higherLeverageCloserToEntry(
        uint256 entryPrice,
        uint256 maintenanceMarginBps
    ) public {
        entryPrice = bound(entryPrice, PRICE_MIN, PRICE_MAX);
        maintenanceMarginBps = bound(maintenanceMarginBps, MAINT_MIN, 100);

        uint256 leverage5x = 500;
        uint256 leverage10x = 1_000;
        vm.assume(1_000_000 > leverage5x * maintenanceMarginBps);
        vm.assume(1_000_000 > leverage10x * maintenanceMarginBps);

        uint256 liqAt5x = PerpMath.computeLiquidationPrice(entryPrice, leverage5x, true, maintenanceMarginBps);
        uint256 liqAt10x = PerpMath.computeLiquidationPrice(entryPrice, leverage10x, true, maintenanceMarginBps);

        assertGe(liqAt10x, liqAt5x, "10x liq price must be >= 5x liq price (closer to entry)");
    }

    // ── computeFundingPayment ─────────────────────────────────────────────────

    function testFuzz_computeFundingPayment_zeroWhenNoTime(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        bool isLong
    ) public {
        markPrice = bound(markPrice, PRICE_MIN, PRICE_MAX);
        indexPrice = bound(indexPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);

        int256 payment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, 0, isLong);
        assertEq(payment, 0, "zero elapsed time must produce zero funding");
    }

    function testFuzz_computeFundingPayment_longShortAreNegated(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        uint256 elapsed
    ) public {
        markPrice = bound(markPrice, PRICE_MIN, PRICE_MAX);
        indexPrice = bound(indexPrice, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        elapsed = bound(elapsed, 1, 8 hours);

        int256 longPayment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, elapsed, true);
        int256 shortPayment = PerpMath.computeFundingPayment(markPrice, indexPrice, notional, elapsed, false);

        assertEq(longPayment, -shortPayment, "long and short funding must be exact negatives");
    }

    function testFuzz_computeFundingPayment_zeroWhenMarkEqualsIndex(
        uint256 price,
        uint256 notional,
        uint256 elapsed,
        bool isLong
    ) public {
        price = bound(price, PRICE_MIN, PRICE_MAX);
        notional = bound(notional, MARGIN_MIN, MARGIN_MAX * 25);
        elapsed = bound(elapsed, 0, 8 hours);

        int256 payment = PerpMath.computeFundingPayment(price, price, notional, elapsed, isLong);
        assertEq(payment, 0, "equal mark and index prices must produce zero funding");
    }
}
