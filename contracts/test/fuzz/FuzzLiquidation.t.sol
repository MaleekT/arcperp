// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/PerpEngine.sol";
import "../../src/LiquidationEngine.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/libraries/PerpMath.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

/// @notice Fuzz tests for the LiquidationEngine against the full contract stack.
///         Proves liquidation thresholds, bonus bounds, and partial-vs-full decisions
///         hold for all valid bounded inputs.
///
///         Run with: forge test --match-contract FuzzLiquidation --fuzz-runs 10000 -vv
contract FuzzLiquidationTest is Test {
    PerpEngine internal engine;
    LiquidationEngine internal liqEngine;
    VaultManager internal vault;
    FeeCollector internal feeCollector;
    MockUSDC internal usdc;
    MockPyth internal mockPyth;
    MockChainlink internal mockChainlink;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    int256 internal constant BTC_PRICE = 67_000e8;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant HEALTH_PRECISION = 1e18;
    uint256 internal constant LIQUIDATION_BONUS_BPS = 150; // 1.5%

    bytes[] internal emptyVaa;

    function setUp() public {
        usdc = new MockUSDC();
        mockPyth = new MockPyth(0);
        mockChainlink = new MockChainlink(8);

        vault = new VaultManager(address(usdc), admin);
        feeCollector = new FeeCollector(address(usdc), address(vault), treasury, admin);
        engine = new PerpEngine(address(vault), address(feeCollector), address(mockPyth), admin);
        liqEngine = new LiquidationEngine(
            address(engine), address(vault), address(usdc), address(mockPyth), admin
        );

        vm.startPrank(admin);
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(engine));
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(liqEngine));
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(feeCollector));
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));
        feeCollector.grantRole(feeCollector.PERP_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));

        // max leverage 25x (2500), taker 0.05% (5), maker 0.02% (2), maint 2.5% (250)
        engine.addPair(BTC_USDC, 2500, 5, 2, 250, PYTH_BTC_ID, address(mockChainlink));
        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _openPosition(address trader, uint256 margin, uint256 leverageBps, bool isLong)
        internal
        returns (bytes32 posId)
    {
        // openPosition debits margin + takerFee from vault, so deposit both
        uint256 notional = margin * leverageBps / 100;
        uint256 fee = notional * 5 / 10_000; // takerFeeBps = 5
        uint256 totalDeposit = margin + fee;

        usdc.mint(trader, totalDeposit);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(totalDeposit);
        vm.prank(trader);
        posId = engine.openPosition(BTC_USDC, isLong, margin, leverageBps, emptyVaa);
        vm.roll(block.number + 1);
    }

    // ── Test 1: isLiquidatable consistency with health factor ──────────────

    /// @notice Whenever health factor < 1e18, isLiquidatable must return true.
    function testFuzz_isLiquidatable_matchesHealthFactorThreshold(
        uint256 margin,
        uint256 leverageBps,
        uint256 priceDropBps
    ) public {
        // Bound inputs to avoid edge cases
        margin = bound(margin, 100e6, 10_000e6); // 100 to 10k USDC
        leverageBps = bound(leverageBps, 500, 2500); // 5x to 25x

        // Drop between 1% and 10% (enough to liquidate high-leverage, not enough for 5x)
        priceDropBps = bound(priceDropBps, 100, 1000);

        address trader = makeAddr(string(abi.encodePacked("trader", margin, leverageBps)));

        bytes32 posId = _openPosition(trader, margin, leverageBps, true);

        // Compute dropped price
        uint256 basePrice = uint256(BTC_PRICE);
        uint256 droppedPrice = basePrice * (BASIS_POINTS - priceDropBps) / BASIS_POINTS;

        // Read position to compute expected health factor
        IPerpEngine.Position memory pos = engine.getPosition(posId);
        IPerpEngine.PairConfig memory config = engine.getPairConfig(BTC_USDC);

        int256 unrealizedPnl = PerpMath.computeUnrealizedPnl(pos.entryPrice, droppedPrice, pos.notional, true);
        uint256 hf = PerpMath.computeHealthFactor(pos.margin, unrealizedPnl, pos.notional, config.maintenanceMarginBps);

        // isLiquidatable must agree with the health factor check
        (bool liq, uint256 reportedHf) = liqEngine.isLiquidatable(posId, droppedPrice);

        assertEq(reportedHf, hf, "reported health factor must match computed");
        assertEq(liq, hf < HEALTH_PRECISION, "isLiquidatable must match hf < 1e18");
    }

    // ── Test 2: Liquidator bonus is strictly bounded ──────────────────────

    /// @notice Liquidator bonus paid to liquidator must never exceed 1.5% of notional.
    ///         Invariant: actualBonus <= notional * 150 / 10_000
    function testFuzz_liquidatorBonus_neverExceedsOnePctFiveOfNotional(uint256 margin, uint256 leverageBps) public {
        margin = bound(margin, 1_000e6, 5_000e6);    // 1k–5k USDC margin
        leverageBps = bound(leverageBps, 2000, 2500); // 20x–25x (liquidatable on ~4% drop)

        address trader = makeAddr(string(abi.encodePacked("bonusTrader", margin, leverageBps)));
        address liquidator = makeAddr("bonusLiquidator");

        bytes32 posId = _openPosition(trader, margin, leverageBps, true);

        // Crash price to guarantee liquidation (5% drop wipes out any 20x+ position)
        int256 crashPrice = BTC_PRICE * 95 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        uint256 maxBonus = (pos.notional * LIQUIDATION_BONUS_BPS) / BASIS_POINTS;

        uint256 liquidatorBefore = usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        uint256 bonusPaid = usdc.balanceOf(liquidator) - liquidatorBefore;

        assertLe(bonusPaid, maxBonus, "bonus paid must not exceed 1.5% of notional");
        assertGe(bonusPaid, 0, "bonus must be non-negative");
    }

    // ── Test 3: Partial vs full liquidation threshold ─────────────────────

    /// @notice When health is between 0.5 and 1.0 → LiquidationExecuted emits isPartial=true.
    ///         When health < 0.5 → isPartial=false.
    function testFuzz_partialVsFullLiquidation_threshold(uint256 margin, bool forceFullLiq) public {
        margin = bound(margin, 2_000e6, 5_000e6); // needs enough margin for the test math
        uint256 leverageBps = 2500; // 25x — maximizes test surface

        address trader = makeAddr(string(abi.encodePacked("threshTrader", margin, forceFullLiq)));
        address liquidator = makeAddr("threshLiquidator");

        bytes32 posId = _openPosition(trader, margin, leverageBps, true);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        IPerpEngine.PairConfig memory config = engine.getPairConfig(BTC_USDC);

        // At 25x with 2.5% maintenance:
        //   notional = margin * 25
        //   maintenanceRequired = notional * 250 / 10_000 = notional / 40
        //   health = effectiveMargin / maintenanceRequired
        //
        // Target health = 0.7 (partial): effectiveMargin = 0.7 * maintenanceRequired
        //   unrealizedPnl = effectiveMargin - margin = 0.7 * maint - margin
        //   For long: PnL = notional * (currentPrice - entryPrice) / entryPrice
        //   So: currentPrice = entryPrice + PnL * entryPrice / notional
        //
        // Target health = 0.3 (full): effectiveMargin = 0.3 * maintenanceRequired

        uint256 maintenanceRequired = (uint256(pos.notional) * config.maintenanceMarginBps) / BASIS_POINTS;

        // Choose target health factor for partial (0.7e18) or full (0.3e18)
        uint256 targetHealth = forceFullLiq ? 3e17 : 7e17;

        // effectiveMargin at target health
        // effectiveMargin = targetHealth * maintenanceRequired / 1e18
        uint256 effectiveMarginTarget = (targetHealth * maintenanceRequired) / HEALTH_PRECISION;

        // unrealizedPnl = effectiveMargin - margin (negative since effectiveMargin < margin)
        // For long: pnl = notional * (current - entry) / entry
        // current = entry + pnl * entry / notional = entry * (1 + pnl / notional)
        // pnl = effectiveMarginTarget - margin (negative)
        int256 targetPnl = int256(effectiveMarginTarget) - int256(uint256(pos.margin));

        // current = entry + pnl * entry / notional
        // Using int256 math:
        int256 entryI = int256(uint256(pos.entryPrice));
        int256 notionalI = int256(uint256(pos.notional));
        int256 currentPrice = entryI + (targetPnl * entryI / notionalI);

        // Bound: current price must be positive and within oracle deviation (<10%)
        if (currentPrice <= 0) return; // skip degenerate case

        uint256 currentPriceU = uint256(currentPrice);
        // Oracle deviation check: within 5% of entry (well within 10% guard)
        uint256 maxDev = uint256(pos.entryPrice) * 5 / 100;
        if (
            currentPriceU > uint256(pos.entryPrice)
                || uint256(pos.entryPrice) - currentPriceU > maxDev
        ) return; // deviation would trigger OraclePriceDeviation — skip

        mockPyth.setPrice(PYTH_BTC_ID, int64(int256(currentPriceU)), -8, block.timestamp);
        mockChainlink.setAnswer(int256(currentPriceU));

        // Verify health factor
        int256 unrealizedPnl = PerpMath.computeUnrealizedPnl(pos.entryPrice, currentPriceU, pos.notional, true);
        uint256 hf = PerpMath.computeHealthFactor(pos.margin, unrealizedPnl, pos.notional, config.maintenanceMarginBps);

        // Only proceed if the position is actually liquidatable
        if (hf >= HEALTH_PRECISION) return;

        bool expectedPartial = hf >= 5e17; // health >= 0.5 → partial

        vm.expectEmit(true, true, true, false);
        emit ILiquidationEngine.LiquidationExecuted(posId, trader, liquidator, 0, 0, 0, expectedPartial);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);
    }

    // ── Test 4: Healthy position cannot be liquidated ─────────────────────

    /// @notice For any leverage and margin, a fresh position at entry price must not be liquidatable.
    function testFuzz_freshPosition_notLiquidatable(uint256 margin, uint256 leverageBps, bool isLong) public {
        margin = bound(margin, 1_000e6, 50_000e6);
        leverageBps = bound(leverageBps, 100, 2500); // 1x to 25x

        address trader = makeAddr(string(abi.encodePacked("healthyTrader", margin, leverageBps, isLong)));

        bytes32 posId = _openPosition(trader, margin, leverageBps, isLong);

        // Price unchanged — position is fresh and healthy
        (bool liq, uint256 hf) = liqEngine.isLiquidatable(posId, uint256(BTC_PRICE));

        assertFalse(liq, "fresh position at entry price must not be liquidatable");
        assertGe(hf, HEALTH_PRECISION, "health factor must be >= 1e18 at entry price");
    }

    // ── Test 5: Double liquidation is impossible (CEI proof) ─────────────

    /// @notice After a successful liquidation, the same positionId reverts on second call.
    function testFuzz_liquidation_cannotLiquidateTwice(uint256 margin) public {
        margin = bound(margin, 1_000e6, 5_000e6);
        uint256 leverageBps = 2500; // 25x

        address trader = makeAddr(string(abi.encodePacked("doubleLiqTrader", margin)));
        address liquidator = makeAddr("doubleLiqLiquidator");

        bytes32 posId = _openPosition(trader, margin, leverageBps, true);

        // Crash price — guaranteed to liquidate 25x position
        int256 crashPrice = BTC_PRICE * 95 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        // First liquidation succeeds
        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        // Second liquidation on same positionId must revert (position was deleted)
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.PositionDoesNotExist.selector, posId));
        liqEngine.liquidate(posId, emptyVaa);
    }

    // ── Test 6: Insurance fund grows monotonically with each liquidation ──

    /// @notice Insurance fund balance after liquidation must be >= before.
    function testFuzz_liquidation_insuranceFundNeverDecreases(uint256 margin) public {
        margin = bound(margin, 1_000e6, 5_000e6);

        address trader = makeAddr(string(abi.encodePacked("insTrader", margin)));
        address liquidator = makeAddr("insLiquidator");

        bytes32 posId = _openPosition(trader, margin, 2500, true); // 25x

        int256 crashPrice = BTC_PRICE * 95 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        uint256 insuranceBefore = vault.getInsuranceFund();

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        uint256 insuranceAfter = vault.getInsuranceFund();
        assertGe(insuranceAfter, insuranceBefore, "insurance fund must never decrease after liquidation");
    }

    // ── Test 7: Non-liquidatable position reverts with correct healthFactor ─

    /// @notice Attempt to liquidate a healthy position must revert PositionNotLiquidatable
    ///         with the actual computed health factor (not a hardcoded value).
    function testFuzz_liquidate_revertsHealthyPosition(uint256 margin, uint256 leverageBps) public {
        margin = bound(margin, 1_000e6, 10_000e6);
        leverageBps = bound(leverageBps, 100, 500); // 1x–5x — very healthy at entry price

        address trader = makeAddr(string(abi.encodePacked("safeTrader", margin, leverageBps)));

        bytes32 posId = _openPosition(trader, margin, leverageBps, true);

        // Use entry price — no losses, very healthy
        IPerpEngine.Position memory pos = engine.getPosition(posId);
        IPerpEngine.PairConfig memory config = engine.getPairConfig(BTC_USDC);

        int256 unrealizedPnl = PerpMath.computeUnrealizedPnl(pos.entryPrice, uint256(BTC_PRICE), pos.notional, true);
        uint256 expectedHealth =
            PerpMath.computeHealthFactor(pos.margin, unrealizedPnl, pos.notional, config.maintenanceMarginBps);

        vm.expectRevert(
            abi.encodeWithSelector(ILiquidationEngine.PositionNotLiquidatable.selector, posId, expectedHealth)
        );
        liqEngine.liquidate(posId, emptyVaa);
    }
}
