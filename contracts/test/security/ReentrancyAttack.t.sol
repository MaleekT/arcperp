// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/PerpEngine.sol";
import "../../src/LiquidationEngine.sol";
import "../../src/interfaces/IVaultManager.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";
import "../mocks/MaliciousReentrant.sol";

// ── Local contracts for reentrancy testing ────────────────────────────────────

/// @dev ERC20 that calls a callback on the recipient during transfer.
///      Used to simulate ERC777-style hooks and test the nonReentrant guard.
interface IReentrantCallback {
    function onTokenReceived(uint256 amount) external;
}

contract CallbackUSDC is ERC20 {
    address public callbackTarget;

    constructor() ERC20("Callback USDC", "CUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setCallbackTarget(address target) external {
        callbackTarget = target;
    }

    /// @dev After transfer, trigger callback on recipient — simulates ERC777 hook.
    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (ok && callbackTarget != address(0) && to == callbackTarget) {
            IReentrantCallback(callbackTarget).onTokenReceived(amount);
        }
        return ok;
    }
}

/// @dev Attacker contract that tries to re-enter vault.withdraw during USDC receipt.
contract ReentrantVaultAttacker is IReentrantCallback {
    IVaultManager public vault;
    uint256 public attackAmount;
    bool public inAttack;

    function setup(address _vault, uint256 _amount) external {
        vault = IVaultManager(_vault);
        attackAmount = _amount;
    }

    function attack() external {
        inAttack = true;
        vault.withdraw(attackAmount, address(this));
        inAttack = false;
    }

    function onTokenReceived(uint256) external override {
        if (inAttack) {
            vault.withdraw(attackAmount, address(this));
        }
    }
}

/// @dev Attacker that tries to re-enter FeeCollector.claimProtocolFees during claim.
contract ReentrantFeeClaimAttacker is IReentrantCallback {
    FeeCollector public feeCollector;
    bool public inClaim;

    function setup(address _fc) external {
        feeCollector = FeeCollector(_fc);
    }

    function attack() external {
        inClaim = true;
        feeCollector.claimProtocolFees(address(this));
        inClaim = false;
    }

    function onTokenReceived(uint256) external override {
        if (inClaim) {
            feeCollector.claimProtocolFees(address(this));
        }
    }
}

// ── Test contract ─────────────────────────────────────────────────────────────

contract ReentrancyAttackTest is Test {
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    int256 internal constant BTC_PRICE = 67_000e8;

    // ── Test 1: VaultManager.withdraw — nonReentrant blocks re-entry ──────────

    function test_reentrancy_vaultWithdraw_blockedByNonReentrant() public {
        CallbackUSDC callbackUsdc = new CallbackUSDC();
        VaultManager cbVault = new VaultManager(address(callbackUsdc), admin);

        ReentrantVaultAttacker attackerContract = new ReentrantVaultAttacker();
        attackerContract.setup(address(cbVault), 100e6);

        callbackUsdc.setCallbackTarget(address(attackerContract));

        // Grant roles and fund attacker's vault balance
        callbackUsdc.mint(address(attackerContract), 200e6);
        vm.prank(address(attackerContract));
        callbackUsdc.approve(address(cbVault), type(uint256).max);
        vm.prank(address(attackerContract));
        cbVault.deposit(200e6);

        // Attack attempt: callback triggers re-entry during safeTransfer
        // The re-entry should revert with ReentrancyGuardReentrantCall
        vm.expectRevert();
        attackerContract.attack();

        // Balance must still be intact (entire tx reverted)
        assertEq(cbVault.getMarginBalance(address(attackerContract)), 200e6, "Balance unchanged after failed attack");
    }

    // ── Test 2: CEI prevents double-spend even without callback ───────────────

    function test_reentrancy_vaultWithdraw_CEIpreventsDoubleSpend() public {
        MockUSDC mockUsdc = new MockUSDC();
        VaultManager regularVault = new VaultManager(address(mockUsdc), admin);

        mockUsdc.mint(attacker, 200e6);
        vm.prank(attacker);
        mockUsdc.approve(address(regularVault), type(uint256).max);
        vm.prank(attacker);
        regularVault.deposit(200e6);

        // First withdraw succeeds
        vm.prank(attacker);
        regularVault.withdraw(100e6, attacker);
        assertEq(regularVault.getMarginBalance(attacker), 100e6);

        // Second withdraw for the same amount succeeds (still has 100e6)
        vm.prank(attacker);
        regularVault.withdraw(100e6, attacker);
        assertEq(regularVault.getMarginBalance(attacker), 0);

        // Third withdraw fails — balance is 0 (CEI protected)
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IVaultManager.InsufficientMargin.selector, attacker, 1, 0));
        regularVault.withdraw(1, attacker);
    }

    // ── Test 3: FeeCollector.claimProtocolFees — nonReentrant blocks re-entry ─

    function test_reentrancy_feeCollector_claimBlockedByNonReentrant() public {
        CallbackUSDC callbackUsdc = new CallbackUSDC();
        VaultManager cbVault = new VaultManager(address(callbackUsdc), admin);
        FeeCollector cbFeeCollector = new FeeCollector(
            address(callbackUsdc), address(cbVault), address(this), admin
        );

        ReentrantFeeClaimAttacker claimAttacker = new ReentrantFeeClaimAttacker();
        claimAttacker.setup(address(cbFeeCollector));

        vm.startPrank(admin);
        // Let claimAttacker call claimProtocolFees (it needs DEFAULT_ADMIN_ROLE)
        cbFeeCollector.grantRole(cbFeeCollector.DEFAULT_ADMIN_ROLE(), address(claimAttacker));
        // Let this test contract call collectFee to populate _pendingTreasuryFees properly
        cbFeeCollector.grantRole(cbFeeCollector.PERP_ENGINE_ROLE(), address(this));
        // FeeCollector.collectFee sends 5% to vault — vault needs to accept it
        cbVault.grantRole(cbVault.LIQUIDATION_ENGINE_ROLE(), address(cbFeeCollector));
        vm.stopPrank();

        // Mint USDC to cbFeeCollector and call collectFee to properly set _pendingTreasuryFees
        // (1000e6 fee → 950e6 treasury share + 50e6 insurance share sent to vault)
        uint256 fee = 1_000e6;
        callbackUsdc.mint(address(cbFeeCollector), fee);
        // callbackTarget is address(0) here — no callback fires during fee collection
        cbFeeCollector.collectFee(address(this), fee, bytes32("test"));

        // Now arm the callback so re-entry triggers on the claim transfer
        callbackUsdc.setCallbackTarget(address(claimAttacker));

        // claimAttacker.attack() calls claimProtocolFees → safeTransfer → callback →
        // re-enters claimProtocolFees → nonReentrant blocks → entire tx reverts
        vm.expectRevert();
        claimAttacker.attack();
    }

    // ── Test 4: LiquidationEngine — position deleted before bonus (CEI) ───────

    function test_reentrancy_liquidation_positionDeletedBeforeBonus() public {
        MockUSDC mockUsdc = new MockUSDC();
        MockPyth mockPyth_ = new MockPyth(0);
        MockChainlink mockChainlink_ = new MockChainlink(8);

        VaultManager vault_ = new VaultManager(address(mockUsdc), admin);
        FeeCollector fc_ = new FeeCollector(address(mockUsdc), address(vault_), treasury, admin);
        PerpEngine engine_ = new PerpEngine(address(vault_), address(fc_), address(mockPyth_), admin);
        LiquidationEngine liqEngine_ = new LiquidationEngine(
            address(engine_), address(vault_), address(mockUsdc), address(mockPyth_), admin
        );

        vm.startPrank(admin);
        vault_.grantRole(vault_.PERP_ENGINE_ROLE(), address(engine_));
        vault_.grantRole(vault_.PERP_ENGINE_ROLE(), address(liqEngine_));
        vault_.grantRole(vault_.LIQUIDATION_ENGINE_ROLE(), address(fc_));
        vault_.grantRole(vault_.LIQUIDATION_ENGINE_ROLE(), address(liqEngine_));
        fc_.grantRole(fc_.PERP_ENGINE_ROLE(), address(engine_));
        engine_.grantRole(engine_.LIQUIDATION_ENGINE_ROLE(), address(liqEngine_));
        engine_.addPair(BTC_USDC, 2500, 5, 2, 250, PYTH_BTC_ID, address(mockChainlink_));
        vm.stopPrank();

        mockPyth_.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink_.setAnswer(BTC_PRICE);

        address trader_ = makeAddr("trader_r");
        mockUsdc.mint(trader_, 100_000e6);
        vm.prank(trader_);
        mockUsdc.approve(address(vault_), type(uint256).max);
        vm.prank(trader_);
        vault_.deposit(100_000e6);

        vm.prank(trader_);
        bytes32 posId = engine_.openPosition(BTC_USDC, true, 1_000e6, 2500, new bytes[](0));
        vm.roll(block.number + 1);

        // Crash price
        int256 crash = BTC_PRICE * 97 / 100;
        mockPyth_.setPrice(PYTH_BTC_ID, int64(crash), -8, block.timestamp);
        mockChainlink_.setAnswer(crash);

        address liq_ = makeAddr("liq_r");
        vm.prank(liq_);
        liqEngine_.liquidate(posId, new bytes[](0));

        // Position is deleted — any subsequent liquidation attempt reverts (CEI proof)
        vm.prank(liq_);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.PositionDoesNotExist.selector, posId));
        liqEngine_.liquidate(posId, new bytes[](0));
    }

    // ── Test 5: MaliciousReentrant mock — standard ERC20 doesn't trigger receive() ─

    function test_reentrancy_maliciousReentrantMock_standardERC20Safe() public {
        MockUSDC mockUsdc = new MockUSDC();
        VaultManager vault_ = new VaultManager(address(mockUsdc), admin);

        MaliciousReentrant malicious = new MaliciousReentrant(address(vault_));

        mockUsdc.mint(address(malicious), 200e6);
        vm.prank(address(malicious));
        mockUsdc.approve(address(vault_), type(uint256).max);
        vm.prank(address(malicious));
        malicious.depositToVault(200e6);

        // With standard ERC20, receive() is never triggered during safeTransfer.
        // Attack succeeds in withdrawing but does NOT re-enter (ERC20 has no callbacks).
        // This shows CEI + nonReentrant together handle both vectors.
        malicious.attack(100e6);

        // Malicious contract received 100e6 (single withdrawal, no re-entry)
        assertEq(vault_.getMarginBalance(address(malicious)), 100e6, "Only one withdrawal occurred");
        assertEq(malicious.attackCount(), 0, "receive() was never triggered by ERC20 transfer");
    }
}
