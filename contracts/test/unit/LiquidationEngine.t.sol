// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/LiquidationEngine.sol";
import "../../src/PerpEngine.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

contract LiquidationEngineTest is Test {
    LiquidationEngine internal liqEngine;
    PerpEngine internal engine;
    VaultManager internal vault;
    FeeCollector internal feeCollector;
    MockUSDC internal usdc;
    MockPyth internal mockPyth;
    MockChainlink internal mockChainlink;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal trader = makeAddr("trader");
    address internal liquidator = makeAddr("liquidator");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    int256 internal constant BTC_PRICE = 67_000e8;
    uint256 internal constant MARGIN = 1_000e6;
    uint256 internal constant LEVERAGE_25X = 2_500; // 25x — easier to liquidate for tests

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
        engine.grantRole(engine.KEEPER_ROLE(), keeper);
        engine.grantRole(engine.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));

        engine.addPair(
            BTC_USDC, 2500, 5, 2, 250, // 2.5% maintenance margin
            PYTH_BTC_ID, address(mockChainlink)
        );
        vm.stopPrank();

        // Set oracle prices (both Pyth and Chainlink agree — no deviation)
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);

        // Fund trader and open a 25x long position
        usdc.mint(trader, MARGIN * 100);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(MARGIN * 100);
    }

    // ── Helper: open position then advance block ───────────────────────────────

    function _openAndAdvance() internal returns (bytes32 posId) {
        vm.prank(trader);
        posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_25X, emptyVaa);
        vm.roll(block.number + 1);
    }

    // ── isLiquidatable() ──────────────────────────────────────────────────────

    function test_isLiquidatable_healthyPosition() public {
        bytes32 posId = _openAndAdvance();
        (bool liq, uint256 hf) = liqEngine.isLiquidatable(posId, uint256(BTC_PRICE));
        assertFalse(liq, "Healthy position should not be liquidatable");
        assertGe(hf, 1e18, "Health factor should be >= 1e18");
    }

    function test_isLiquidatable_underwaterPosition() public {
        bytes32 posId = _openAndAdvance();

        // At 25x leverage, maintenance margin = 2.5%, so liquidation triggers at ~4% price drop
        // Drop price 5% to guarantee liquidation
        uint256 liquidationPrice = uint256(BTC_PRICE) * 95 / 100;
        (bool liq, uint256 hf) = liqEngine.isLiquidatable(posId, liquidationPrice);

        assertTrue(liq, "Position should be liquidatable after price drop");
        assertLt(hf, 1e18, "Health factor should be < 1e18");
    }

    function test_isLiquidatable_nonExistentPosition() public {
        (bool liq, uint256 hf) = liqEngine.isLiquidatable(bytes32(0), uint256(BTC_PRICE));
        assertFalse(liq);
        assertEq(hf, type(uint256).max);
    }

    // ── liquidate() ───────────────────────────────────────────────────────────

    function test_liquidate_revertsHealthyPosition() public {
        bytes32 posId = _openAndAdvance();

        // At entry price: notional=25_000e6, maintenance=625e6, health=1_000e6*1e18/625e6 = 1.6e18
        // Compute expected health factor: MARGIN * 1e18 / (notional * maintenanceBps / BASIS_POINTS)
        uint256 notional = uint256(MARGIN) * uint256(LEVERAGE_25X) / 100;   // 25_000e6
        uint256 maintenance = notional * 250 / 10_000;                       // 625e6
        uint256 expectedHealth = uint256(MARGIN) * 1e18 / maintenance;       // 1_600_000_000_000_000_000

        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(ILiquidationEngine.PositionNotLiquidatable.selector, posId, expectedHealth)
        );
        liqEngine.liquidate(posId, emptyVaa);
    }

    function test_liquidate_revertsNonExistentPosition() public {
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.PositionDoesNotExist.selector, bytes32(0)));
        liqEngine.liquidate(bytes32(0), emptyVaa);
    }

    function test_liquidate_fullLiquidation_liquidatorEarnsBonus() public {
        bytes32 posId = _openAndAdvance();

        // Drop price enough to make health < 0.5 (full liquidation)
        // At 25x, a 3% drop pushes health to ~0.25
        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        uint256 liquidatorBalanceBefore = usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        uint256 liquidatorBalanceAfter = usdc.balanceOf(liquidator);
        assertGt(liquidatorBalanceAfter, liquidatorBalanceBefore, "Liquidator should receive bonus");
    }

    function test_liquidate_emitsEvent() public {
        bytes32 posId = _openAndAdvance();

        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        vm.expectEmit(true, true, true, false);
        emit ILiquidationEngine.LiquidationExecuted(posId, trader, liquidator, 0, 0, 0, false);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);
    }

    function test_liquidate_clearsPosition() public {
        bytes32 posId = _openAndAdvance();

        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        assertEq(pos.trader, address(0), "Position should be cleared after liquidation");
    }

    function test_liquidate_cannotLiquidateTwice() public {
        bytes32 posId = _openAndAdvance();

        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        // Second liquidation attempt must fail — position is deleted
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.PositionDoesNotExist.selector, posId));
        liqEngine.liquidate(posId, emptyVaa);
    }

    function test_liquidate_anyAddressCanLiquidate() public {
        bytes32 posId = _openAndAdvance();

        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        // A random address — not keeper, not admin — can liquidate
        address randomUser = makeAddr("random");
        vm.prank(randomUser);
        liqEngine.liquidate(posId, emptyVaa);
    }

    function test_liquidate_staleOracleReverts() public {
        bytes32 posId = _openAndAdvance();

        // Make the oracle price stale
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE * 97 / 100), -8, block.timestamp - 31);

        vm.prank(liquidator);
        vm.expectRevert();
        liqEngine.liquidate(posId, emptyVaa);
    }
}
