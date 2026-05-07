// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/VaultManager.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MaliciousReentrant.sol";

contract VaultManagerTest is Test {
    VaultManager internal vault;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal perpEngine = makeAddr("perpEngine");
    address internal liqEngine = makeAddr("liqEngine");
    address internal trader = makeAddr("trader");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant DEPOSIT_AMOUNT = 1000e6; // 1000 USDC

    function setUp() public {
        usdc = new MockUSDC();
        vault = new VaultManager(address(usdc), admin);

        // Grant roles
        vm.startPrank(admin);
        vault.grantRole(vault.PERP_ENGINE_ROLE(), perpEngine);
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), liqEngine);
        vm.stopPrank();

        // Fund trader
        usdc.mint(trader, DEPOSIT_AMOUNT * 10);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    function test_constructor_setsUSDC() public {
        assertEq(address(vault.usdc()), address(usdc));
    }

    function test_constructor_revertsOnZeroUSDC() public {
        vm.expectRevert(IVaultManager.ZeroAddress.selector);
        new VaultManager(address(0), admin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(IVaultManager.ZeroAddress.selector);
        new VaultManager(address(usdc), address(0));
    }

    // ── deposit() ─────────────────────────────────────────────────────────────

    function test_deposit_happy() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        assertEq(vault.getMarginBalance(trader), DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT_AMOUNT);
    }

    function test_deposit_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit IVaultManager.Deposited(trader, DEPOSIT_AMOUNT);

        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(trader);
        vm.expectRevert(IVaultManager.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_deposit_accumulatesMultiple() public {
        vm.startPrank(trader);
        vault.deposit(DEPOSIT_AMOUNT);
        vault.deposit(DEPOSIT_AMOUNT);
        vm.stopPrank();

        assertEq(vault.getMarginBalance(trader), DEPOSIT_AMOUNT * 2);
    }

    // ── withdraw() ────────────────────────────────────────────────────────────

    function test_withdraw_happy() public {
        vm.startPrank(trader);
        vault.deposit(DEPOSIT_AMOUNT);
        vault.withdraw(DEPOSIT_AMOUNT, recipient);
        vm.stopPrank();

        assertEq(vault.getMarginBalance(trader), 0);
        assertEq(usdc.balanceOf(recipient), DEPOSIT_AMOUNT);
    }

    function test_withdraw_emitsEvent() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.expectEmit(true, false, false, true);
        emit IVaultManager.Withdrawn(trader, DEPOSIT_AMOUNT, recipient);

        vm.prank(trader);
        vault.withdraw(DEPOSIT_AMOUNT, recipient);
    }

    function test_withdraw_revertsOnZeroAmount() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(trader);
        vm.expectRevert(IVaultManager.ZeroAmount.selector);
        vault.withdraw(0, recipient);
    }

    function test_withdraw_revertsOnZeroRecipient() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(trader);
        vm.expectRevert(IVaultManager.ZeroAddress.selector);
        vault.withdraw(DEPOSIT_AMOUNT, address(0));
    }

    function test_withdraw_revertsOnInsufficientBalance() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IVaultManager.InsufficientMargin.selector, trader, DEPOSIT_AMOUNT + 1, DEPOSIT_AMOUNT)
        );
        vault.withdraw(DEPOSIT_AMOUNT + 1, recipient);
    }

    function test_withdraw_partialAmount() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        uint256 partialAmt = DEPOSIT_AMOUNT / 2;
        vm.prank(trader);
        vault.withdraw(partialAmt, recipient);

        assertEq(vault.getMarginBalance(trader), DEPOSIT_AMOUNT - partialAmt);
        assertEq(usdc.balanceOf(recipient), partialAmt);
    }

    // ── debitMargin() ─────────────────────────────────────────────────────────

    function test_debitMargin_happy() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(perpEngine);
        vault.debitMargin(trader, DEPOSIT_AMOUNT, "open position");

        assertEq(vault.getMarginBalance(trader), 0);
    }

    function test_debitMargin_revertsUnauthorized() public {
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(trader);
        vm.expectRevert();
        vault.debitMargin(trader, DEPOSIT_AMOUNT, "hack");
    }

    function test_debitMargin_revertsOnZero() public {
        vm.prank(perpEngine);
        vm.expectRevert(IVaultManager.ZeroAmount.selector);
        vault.debitMargin(trader, 0, "zero");
    }

    function test_debitMargin_revertsOnInsufficientBalance() public {
        vm.prank(perpEngine);
        vm.expectRevert();
        vault.debitMargin(trader, 1, "empty");
    }

    // ── creditMargin() ────────────────────────────────────────────────────────

    function test_creditMargin_happy() public {
        vm.prank(perpEngine);
        vault.creditMargin(trader, DEPOSIT_AMOUNT, "close position");

        assertEq(vault.getMarginBalance(trader), DEPOSIT_AMOUNT);
    }

    function test_creditMargin_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        vault.creditMargin(trader, DEPOSIT_AMOUNT, "hack");
    }

    function test_creditMargin_revertsOnZero() public {
        vm.prank(perpEngine);
        vm.expectRevert(IVaultManager.ZeroAmount.selector);
        vault.creditMargin(trader, 0, "zero");
    }

    // ── contributeInsuranceFund() ─────────────────────────────────────────────

    function test_contributeInsuranceFund_happy() public {
        vm.prank(liqEngine);
        vault.contributeInsuranceFund(500e6);

        assertEq(vault.getInsuranceFund(), 500e6);
    }

    function test_contributeInsuranceFund_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        vault.contributeInsuranceFund(500e6);
    }

    function test_contributeInsuranceFund_revertsOnZero() public {
        vm.prank(liqEngine);
        vm.expectRevert(IVaultManager.ZeroAmount.selector);
        vault.contributeInsuranceFund(0);
    }

    // ── withdrawInsuranceFund() ───────────────────────────────────────────────

    function test_withdrawInsuranceFund_happy() public {
        // Fund the insurance fund by minting USDC directly to vault
        usdc.mint(address(vault), 500e6);
        vm.prank(liqEngine);
        vault.contributeInsuranceFund(500e6);

        vm.prank(admin);
        vault.withdrawInsuranceFund(500e6, recipient);

        assertEq(vault.getInsuranceFund(), 0);
        assertEq(usdc.balanceOf(recipient), 500e6);
    }

    function test_withdrawInsuranceFund_revertsUnauthorized() public {
        vm.prank(trader);
        vm.expectRevert();
        vault.withdrawInsuranceFund(1, recipient);
    }

    function test_withdrawInsuranceFund_revertsInsufficientFund() public {
        vm.prank(admin);
        vm.expectRevert();
        vault.withdrawInsuranceFund(1, recipient);
    }

    function test_withdrawInsuranceFund_revertsZeroRecipient() public {
        usdc.mint(address(vault), 500e6);
        vm.prank(liqEngine);
        vault.contributeInsuranceFund(500e6);

        vm.prank(admin);
        vm.expectRevert(IVaultManager.ZeroAddress.selector);
        vault.withdrawInsuranceFund(500e6, address(0));
    }

    // ── Reentrancy attack ─────────────────────────────────────────────────────

    function test_reentrancy_withdraw_blocked() public {
        // Standard ERC-20 safeTransfer does NOT trigger receive(), so MaliciousReentrant's
        // receive() hook is never called. The CEI pattern prevents double-spend instead:
        // the balance mapping is decremented BEFORE safeTransfer, so a second withdraw
        // sees zero balance and reverts with InsufficientMargin.
        vm.prank(trader);
        vault.deposit(DEPOSIT_AMOUNT);

        vm.prank(trader);
        vault.withdraw(DEPOSIT_AMOUNT, trader);

        // Balance is now 0 — any further withdraw must revert (CEI protected)
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IVaultManager.InsufficientMargin.selector, trader, DEPOSIT_AMOUNT, 0)
        );
        vault.withdraw(DEPOSIT_AMOUNT, trader);
    }
}
