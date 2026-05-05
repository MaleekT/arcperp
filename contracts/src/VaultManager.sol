// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVaultManager.sol";

/// @title VaultManager
/// @notice Custody of all USDC collateral for ArcPerp. Pure accounting — no trading logic.
///         Only PerpEngine and LiquidationEngine may move funds; traders interact via deposit/withdraw.
///
/// Security layers:
///   - ReentrancyGuard on every fund-moving function
///   - Checks-Effects-Interactions: state updated BEFORE any external token transfer
///   - AccessControl: PERP_ENGINE_ROLE and LIQUIDATION_ENGINE_ROLE gated internal functions
///   - SafeERC20: no raw .transfer() calls
contract VaultManager is IVaultManager, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PERP_ENGINE_ROLE = keccak256("PERP_ENGINE_ROLE");
    bytes32 public constant LIQUIDATION_ENGINE_ROLE = keccak256("LIQUIDATION_ENGINE_ROLE");

    IERC20 public immutable usdc;

    mapping(address => uint256) private marginBalances;
    uint256 public insuranceFund;

    constructor(address _usdc, address _admin) {
        if (_usdc == address(0) || _admin == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── Trader-facing ─────────────────────────────────────────────────────────

    /// @notice Deposit USDC margin. Trader must approve VaultManager first.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // CEI: effect before interaction
        marginBalances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw available margin. Only the depositor can withdraw their own funds.
    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 balance = marginBalances[msg.sender];
        if (balance < amount) revert InsufficientMargin(msg.sender, amount, balance);
        // CEI: zero out before transfer
        marginBalances[msg.sender] = balance - amount;
        emit Withdrawn(msg.sender, amount, recipient);
        usdc.safeTransfer(recipient, amount);
    }

    // ── Protocol-internal (PerpEngine only) ───────────────────────────────────

    /// @notice Debit margin when a position is opened or fee is taken.
    function debitMargin(address trader, uint256 amount, string calldata reason)
        external
        nonReentrant
        onlyRole(PERP_ENGINE_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = marginBalances[trader];
        if (balance < amount) revert InsufficientMargin(trader, amount, balance);
        marginBalances[trader] = balance - amount;
        emit MarginDebited(trader, amount, reason);
    }

    /// @notice Credit margin when a position is closed or PnL is positive.
    function creditMargin(address trader, uint256 amount, string calldata reason)
        external
        nonReentrant
        onlyRole(PERP_ENGINE_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        marginBalances[trader] += amount;
        emit MarginCredited(trader, amount, reason);
    }

    // ── Protocol-internal (PerpEngine only) — fee forwarding ─────────────────

    /// @notice Forward fee USDC that was already debited from the trader to FeeCollector.
    ///         No accounting change — trader's balance was reduced by debitMargin for the fee.
    ///         The "excess" USDC now leaves the vault to FeeCollector for distribution.
    function forwardFee(address recipient, uint256 amount) external nonReentrant onlyRole(PERP_ENGINE_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransfer(recipient, amount);
    }

    // ── Protocol-internal (LiquidationEngine only) ────────────────────────────

    /// @notice Atomically reduce trader margin balance and send USDC to recipient.
    ///         Used by LiquidationEngine to pay the liquidation bonus without the engine
    ///         needing to hold USDC directly.
    function liquidationWithdraw(address trader, uint256 amount, address recipient)
        external
        nonReentrant
        onlyRole(LIQUIDATION_ENGINE_ROLE)
    {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 balance = marginBalances[trader];
        if (balance == 0) return;
        uint256 actual = amount <= balance ? amount : balance;
        marginBalances[trader] = balance - actual;
        emit MarginDebited(trader, actual, "liquidation bonus");
        usdc.safeTransfer(recipient, actual);
    }

    /// @notice Move trader margin balance into the insurance fund (pure accounting, no USDC transfer).
    ///         The USDC stays inside the vault; only the ownership claim changes.
    function debitToInsuranceFund(address trader, uint256 amount)
        external
        nonReentrant
        onlyRole(LIQUIDATION_ENGINE_ROLE)
    {
        uint256 balance = marginBalances[trader];
        if (balance == 0) return;
        uint256 actual = amount <= balance ? amount : balance;
        marginBalances[trader] = balance - actual;
        insuranceFund += actual;
        emit MarginDebited(trader, actual, "insurance contribution");
        emit InsuranceFundContributed(actual);
    }

    /// @notice Add USDC to the insurance fund after a liquidation.
    function contributeInsuranceFund(uint256 amount) external onlyRole(LIQUIDATION_ENGINE_ROLE) {
        if (amount == 0) revert ZeroAmount();
        insuranceFund += amount;
        emit InsuranceFundContributed(amount);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Emergency withdrawal from the insurance fund. 48h time-lock enforced at governance layer.
    function withdrawInsuranceFund(uint256 amount, address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (insuranceFund < amount) revert InsufficientInsuranceFund(amount, insuranceFund);
        // CEI
        insuranceFund -= amount;
        emit InsuranceFundWithdrawn(amount, recipient);
        usdc.safeTransfer(recipient, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getMarginBalance(address trader) external view returns (uint256) {
        return marginBalances[trader];
    }

    function getInsuranceFund() external view returns (uint256) {
        return insuranceFund;
    }
}
