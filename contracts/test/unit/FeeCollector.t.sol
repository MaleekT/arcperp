// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/FeeCollector.sol";
import "../../src/VaultManager.sol";
import "../mocks/MockUSDC.sol";

contract FeeCollectorTest is Test {
    FeeCollector internal feeCollector;
    VaultManager internal vault;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal perpEngine = makeAddr("perpEngine");
    address internal liqEngine = makeAddr("liqEngine");
    address internal trader = makeAddr("trader");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    uint256 internal constant FEE_AMOUNT = 50e6; // 50 USDC fee

    function setUp() public {
        usdc = new MockUSDC();
        vault = new VaultManager(address(usdc), admin);
        feeCollector = new FeeCollector(address(usdc), address(vault), treasury, admin);

        vm.startPrank(admin);
        vault.grantRole(vault.PERP_ENGINE_ROLE(), perpEngine);
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(feeCollector));
        feeCollector.grantRole(feeCollector.PERP_ENGINE_ROLE(), perpEngine);
        vm.stopPrank();

        // Pre-fund FeeCollector with USDC to simulate fee collection
        usdc.mint(address(feeCollector), FEE_AMOUNT * 10);
    }

    // ── collectFee() ──────────────────────────────────────────────────────────

    function test_collectFee_happy() public {
        vm.prank(perpEngine);
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);

        uint256 expectedInsurance = (FEE_AMOUNT * 500) / 10_000; // 5%
        uint256 expectedTreasury = FEE_AMOUNT - expectedInsurance;

        assertEq(feeCollector.getFeesByPair(BTC_USDC), FEE_AMOUNT);
        assertEq(feeCollector.totalFeesCollected(), FEE_AMOUNT);
        assertEq(feeCollector.pendingTreasuryFees(), expectedTreasury);
        assertEq(vault.getInsuranceFund(), expectedInsurance);
    }

    function test_collectFee_emitsEvent() public {
        uint256 expectedInsurance = (FEE_AMOUNT * 500) / 10_000;
        uint256 expectedTreasury = FEE_AMOUNT - expectedInsurance;

        vm.expectEmit(true, true, false, true);
        emit IFeeCollector.FeeCollected(trader, FEE_AMOUNT, BTC_USDC, expectedTreasury, expectedInsurance);

        vm.prank(perpEngine);
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);
    }

    function test_collectFee_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);
    }

    function test_collectFee_revertsOnZero() public {
        vm.prank(perpEngine);
        vm.expectRevert(IFeeCollector.ZeroAmount.selector);
        feeCollector.collectFee(trader, 0, BTC_USDC);
    }

    function test_collectFee_accumulatesAcrossPairs() public {
        bytes32 ethUsdc = keccak256("ETH-USDC");
        usdc.mint(address(feeCollector), FEE_AMOUNT * 10);

        vm.startPrank(perpEngine);
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);
        feeCollector.collectFee(trader, FEE_AMOUNT, ethUsdc);
        vm.stopPrank();

        assertEq(feeCollector.getFeesByPair(BTC_USDC), FEE_AMOUNT);
        assertEq(feeCollector.getFeesByPair(ethUsdc), FEE_AMOUNT);
        assertEq(feeCollector.totalFeesCollected(), FEE_AMOUNT * 2);
    }

    // ── claimProtocolFees() ───────────────────────────────────────────────────

    function test_claimProtocolFees_happy() public {
        vm.prank(perpEngine);
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);

        uint256 pending = feeCollector.pendingTreasuryFees();
        address claimRecipient = makeAddr("claimRecipient");

        vm.prank(admin);
        feeCollector.claimProtocolFees(claimRecipient);

        assertEq(usdc.balanceOf(claimRecipient), pending);
        assertEq(feeCollector.pendingTreasuryFees(), 0);
    }

    function test_claimProtocolFees_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        feeCollector.claimProtocolFees(trader);
    }

    function test_claimProtocolFees_revertsZeroRecipient() public {
        vm.prank(perpEngine);
        feeCollector.collectFee(trader, FEE_AMOUNT, BTC_USDC);

        vm.prank(admin);
        vm.expectRevert(IFeeCollector.ZeroAddress.selector);
        feeCollector.claimProtocolFees(address(0));
    }

    function test_claimProtocolFees_revertsWhenNoPending() public {
        vm.prank(admin);
        vm.expectRevert(IFeeCollector.ZeroAmount.selector);
        feeCollector.claimProtocolFees(treasury);
    }

    // ── setTreasury() ─────────────────────────────────────────────────────────

    function test_setTreasury_happy() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(admin);
        feeCollector.setTreasury(newTreasury);
        assertEq(feeCollector.treasury(), newTreasury);
    }

    function test_setTreasury_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        feeCollector.setTreasury(makeAddr("x"));
    }

    function test_setTreasury_revertsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(IFeeCollector.ZeroAddress.selector);
        feeCollector.setTreasury(address(0));
    }
}
