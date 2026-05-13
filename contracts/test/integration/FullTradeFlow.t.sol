// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/LiquidationEngine.sol";
import "../../src/PerpEngine.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/libraries/PerpMath.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

/// @notice End-to-end integration tests that exercise the full ArcPerp trading lifecycle
///         across all four contracts working together.
contract FullTradeFlowTest is Test {
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
    address internal trader2 = makeAddr("trader2");
    address internal liquidator = makeAddr("liquidator");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    int256 internal constant BTC_PRICE = 67_000e8;
    uint256 internal constant MARGIN = 1_000e6;
    uint256 internal constant LEVERAGE_10X = 1_000;
    uint256 internal constant LEVERAGE_25X = 2_500;

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

        engine.addPair(BTC_USDC, 2500, 5, 2, 250, PYTH_BTC_ID, address(mockChainlink));
        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);

        _fundAndDeposit(trader, MARGIN * 100);
        _fundAndDeposit(trader2, MARGIN * 100);
    }

    function _fundAndDeposit(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(who);
        vault.deposit(amount);
    }

    // ── Test 1: Full profitable long cycle ────────────────────────────────────

    function test_fullFlow_profitableLong_depositOpenClosWithdraw() public {
        uint256 vaultBalanceBefore = vault.getMarginBalance(trader);

        // Open 10x long
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        // Price rises 10%
        int256 newPrice = BTC_PRICE * 110 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(newPrice), -8, block.timestamp);
        mockChainlink.setAnswer(newPrice);

        // Close position
        vm.prank(trader);
        int256 pnl = engine.closePosition(posId, emptyVaa);

        assertTrue(pnl > 0, "Long profits on 10% price rise");

        // Withdraw remaining vault balance to wallet
        uint256 vaultBalance = vault.getMarginBalance(trader);
        assertGt(vaultBalance, 0, "Vault balance should be > 0 after profitable close");

        uint256 walletBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        vault.withdraw(vaultBalance, trader);
        uint256 walletAfter = usdc.balanceOf(trader);

        assertEq(walletAfter - walletBefore, vaultBalance, "Withdrawal amount matches");
        // Net PnL: started with MARGIN*100 USDC, ended with more
        assertGt(walletAfter + (vaultBalanceBefore - MARGIN), walletBefore, "Net profitable");
    }

    // ── Test 2: 25x position liquidated after 4% price drop ──────────────────

    function test_fullFlow_25x_liquidatedAfterPriceDrop() public {
        // Open 25x long — with 2.5% maintenance margin, health = 1 at ~4% drop
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_25X, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        // Drop 4% — health < 1.0 (liquidatable)
        int256 crashPrice = BTC_PRICE * 96 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        (bool liq,) = liqEngine.isLiquidatable(posId, uint256(crashPrice));
        assertTrue(liq, "Position should be liquidatable at 4% drop with 25x leverage");

        uint256 liquidatorBefore = usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        liqEngine.liquidate(posId, emptyVaa);

        assertGt(usdc.balanceOf(liquidator), liquidatorBefore, "Liquidator earns bonus");

        // Position is deleted
        IPerpEngine.Position memory pos = engine.getPosition(posId);
        assertEq(pos.trader, address(0), "Position cleared after liquidation");
    }

    // ── Test 3: Same-block open+close is blocked ──────────────────────────────

    function test_fullFlow_sameBlockOpenCloseReverts() public {
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);

        // Do NOT advance block — attempt same-block close
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.SameBlockOpenClose.selector, posId));
        engine.closePosition(posId, emptyVaa);
    }

    // ── Test 4: Two traders on opposite sides ────────────────────────────────

    function test_fullFlow_oppositePositions_correctPnLSigns() public {
        uint256 startBlock = block.number;

        // Trader 1: 10x long BTC — opened at startBlock
        vm.prank(trader);
        bytes32 longId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);

        // Advance so shortId gets a different block-based position ID
        vm.roll(startBlock + 1);

        // Trader 2: 10x short BTC — opened at startBlock + 1
        vm.prank(trader2);
        bytes32 shortId = engine.openPosition(BTC_USDC, false, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);

        // Price moves up 5%
        int256 newPrice = BTC_PRICE * 105 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(newPrice), -8, block.timestamp);
        mockChainlink.setAnswer(newPrice);

        // Roll well past both openedAtBlock values before closing
        vm.roll(startBlock + 10);

        vm.prank(trader);
        int256 longPnl = engine.closePosition(longId, emptyVaa);

        vm.prank(trader2);
        int256 shortPnl = engine.closePosition(shortId, emptyVaa);

        assertTrue(longPnl > 0, "Long profits when price rises");
        assertTrue(shortPnl < 0, "Short loses when price rises");
    }

    // ── Test 5: Keeper funding settlement ────────────────────────────────────

    function test_fullFlow_keeperSettlesFunding() public {
        // Set index price so funding has something to compute
        vm.prank(keeper);
        engine.setIndexPrice(BTC_USDC, uint256(BTC_PRICE));

        // Advance 8+ hours
        vm.warp(block.timestamp + 8 hours + 1);

        bytes32[] memory pairs = new bytes32[](1);
        pairs[0] = BTC_USDC;

        // Keeper settles — should not revert
        vm.prank(keeper);
        engine.settleFunding(pairs);
    }

    // ── Test 6: Fee routing — insurance fund grows on each trade ─────────────

    function test_fullFlow_feeRoutingToInsuranceFund() public {
        uint256 insuranceBefore = vault.getInsuranceFund();

        vm.prank(trader);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);

        uint256 insuranceAfter = vault.getInsuranceFund();
        assertGt(insuranceAfter, insuranceBefore, "Insurance fund grows with each trade fee");
    }

    // ── Test 7: Partial liquidation when health between 0.5 and 1.0 ──────────

    function test_fullFlow_partialLiquidation() public {
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_25X, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        // Drop 2% — health between 0.5 and 1.0 → partial (50%) liquidation
        // At 25x: notional=25_000e6, maint=625e6
        // PnL at 2%: -25_000e6 * 2% = -500e6
        // effectiveMargin = 1000e6 - 500e6 = 500e6
        // health = 500/625 * 1e18 = 0.8e18  (between 0.5 and 1.0)
        int256 partialCrashPrice = BTC_PRICE * 98 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(partialCrashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(partialCrashPrice);

        (bool liq, uint256 hf) = liqEngine.isLiquidatable(posId, uint256(partialCrashPrice));
        assertTrue(liq, "Position liquidatable");
        assertGt(hf, 5e17, "Health > 0.5 means partial");
        assertLt(hf, 1e18, "Health < 1.0 means liquidatable");

        vm.prank(liquidator);
        vm.expectEmit(true, true, true, false);
        emit ILiquidationEngine.LiquidationExecuted(posId, trader, liquidator, 0, 0, 0, true);
        liqEngine.liquidate(posId, emptyVaa);
    }

    // ── Test 8: Admin can withdraw insurance fund ─────────────────────────────

    function test_fullFlow_adminWithdrawsInsuranceFund() public {
        // Generate some fees to populate insurance fund
        vm.prank(trader);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);

        uint256 insurance = vault.getInsuranceFund();
        assertGt(insurance, 0, "Insurance fund should have funds after a trade");

        address recipient = makeAddr("insuranceRecipient");
        vm.prank(admin);
        vault.withdrawInsuranceFund(insurance, recipient);

        assertEq(usdc.balanceOf(recipient), insurance, "Admin receives insurance fund USDC");
        assertEq(vault.getInsuranceFund(), 0, "Insurance fund cleared");
    }
}
