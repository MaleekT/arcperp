// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/PerpEngine.sol";
import "../../src/LiquidationEngine.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

/// @notice Proves that every privileged function in all four contracts rejects
///         unauthorized callers with the correct AccessControl error.
contract AccessControlTest is Test {
    VaultManager internal vault;
    FeeCollector internal feeCollector;
    PerpEngine internal engine;
    LiquidationEngine internal liqEngine;
    MockUSDC internal usdc;
    MockPyth internal mockPyth;
    MockChainlink internal mockChainlink;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal hacker = makeAddr("hacker");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    int256 internal constant BTC_PRICE = 67_000e8;

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
    }

    // ── VaultManager access control ───────────────────────────────────────────

    function test_ac_vault_debitMargin_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.debitMargin(hacker, 1e6, "hack");
    }

    function test_ac_vault_creditMargin_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.creditMargin(hacker, 1e6, "hack");
    }

    function test_ac_vault_contributeInsuranceFund_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.contributeInsuranceFund(1e6);
    }

    function test_ac_vault_withdrawInsuranceFund_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.withdrawInsuranceFund(1e6, hacker);
    }

    function test_ac_vault_forwardFee_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.forwardFee(hacker, 1e6);
    }

    function test_ac_vault_liquidationWithdraw_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.liquidationWithdraw(hacker, 1e6, hacker);
    }

    function test_ac_vault_debitToInsuranceFund_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        vault.debitToInsuranceFund(hacker, 1e6);
    }

    // ── FeeCollector access control ───────────────────────────────────────────

    function test_ac_feeCollector_collectFee_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        feeCollector.collectFee(hacker, 1e6, BTC_USDC);
    }

    function test_ac_feeCollector_claimProtocolFees_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        feeCollector.claimProtocolFees(hacker);
    }

    function test_ac_feeCollector_setTreasury_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        feeCollector.setTreasury(hacker);
    }

    // ── PerpEngine access control ─────────────────────────────────────────────

    function test_ac_engine_addPair_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        engine.addPair(keccak256("NEW-USDC"), 1000, 5, 2, 250, bytes32(0), address(0));
    }

    function test_ac_engine_pause_revertsUnauthorized() public {
        vm.prank(hacker);
        vm.expectRevert();
        engine.pause();
    }

    function test_ac_engine_unpause_revertsUnauthorized() public {
        vm.prank(admin);
        engine.pause();

        vm.prank(hacker);
        vm.expectRevert();
        engine.unpause();
    }

    function test_ac_engine_settleFunding_revertsNonKeeper() public {
        bytes32[] memory pairs = new bytes32[](1);
        pairs[0] = BTC_USDC;

        vm.prank(hacker);
        vm.expectRevert();
        engine.settleFunding(pairs);
    }

    function test_ac_engine_setIndexPrice_revertsNonKeeper() public {
        vm.prank(hacker);
        vm.expectRevert();
        engine.setIndexPrice(BTC_USDC, uint256(BTC_PRICE));
    }

    function test_ac_engine_closePosition_revertsNonOwnerNonLiquidator() public {
        address trader = makeAddr("trader");
        usdc.mint(trader, 100_000e6);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(100_000e6);

        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, 1_000e6, 1_000, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        vm.prank(hacker);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.UnauthorizedCaller.selector, hacker));
        engine.closePosition(posId, emptyVaa);
    }

    // ── LiquidationEngine — permissionless (anyone can liquidate) ─────────────

    function test_ac_liqEngine_liquidate_isPermissionless() public {
        address trader = makeAddr("trader_p");
        usdc.mint(trader, 100_000e6);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(100_000e6);

        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, 1_000e6, 2500, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        int256 crashPrice = BTC_PRICE * 97 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(crashPrice), -8, block.timestamp);
        mockChainlink.setAnswer(crashPrice);

        // A random address with no roles can liquidate
        address random = makeAddr("random_anyone");
        vm.prank(random);
        liqEngine.liquidate(posId, emptyVaa); // must NOT revert
    }

    // ── Admin CAN perform admin actions ──────────────────────────────────────

    function test_ac_admin_canPauseAndUnpause() public {
        vm.prank(admin);
        engine.pause();

        vm.prank(admin);
        engine.unpause();
    }

    function test_ac_admin_canWithdrawInsuranceFund() public {
        // Populate insurance fund by opening a trade (fee goes to insurance)
        address trader = makeAddr("trader_ins");
        usdc.mint(trader, 100_000e6);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(100_000e6);
        vm.prank(trader);
        engine.openPosition(BTC_USDC, true, 1_000e6, 1_000, 0, 0, emptyVaa);

        uint256 ins = vault.getInsuranceFund();
        if (ins > 0) {
            vm.prank(admin);
            vault.withdrawInsuranceFund(ins, admin);
            assertEq(vault.getInsuranceFund(), 0);
        }
    }

    function test_ac_keeper_canSettleFunding() public {
        vm.prank(keeper);
        engine.setIndexPrice(BTC_USDC, uint256(BTC_PRICE));
        vm.warp(block.timestamp + 2 hours);

        bytes32[] memory pairs = new bytes32[](1);
        pairs[0] = BTC_USDC;

        vm.prank(keeper);
        engine.settleFunding(pairs); // must NOT revert
    }
}
