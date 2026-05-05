// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IFeeCollector.sol";
import "./interfaces/IVaultManager.sol";

/// @title FeeCollector
/// @notice Protocol revenue management. Routes taker fees: 95% to treasury, 5% to insurance fund.
///         Only PerpEngine may call collectFee(). Only admin may claim treasury fees.
contract FeeCollector is IFeeCollector, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PERP_ENGINE_ROLE = keccak256("PERP_ENGINE_ROLE");

    uint256 private constant TREASURY_SHARE_BPS = 9_500; // 95%
    uint256 private constant INSURANCE_SHARE_BPS = 500; // 5%
    uint256 private constant BASIS_POINTS = 10_000;

    IERC20 public immutable usdc;
    IVaultManager public immutable vaultManager;
    address public treasury;

    mapping(bytes32 => uint256) private _feesByPair;
    uint256 private _totalFeesCollected;
    uint256 private _pendingTreasuryFees;

    constructor(address _usdc, address _vaultManager, address _treasury, address _admin) {
        if (_usdc == address(0) || _vaultManager == address(0) || _treasury == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(_usdc);
        vaultManager = IVaultManager(_vaultManager);
        treasury = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── Protocol-internal ─────────────────────────────────────────────────────

    /// @notice Called by PerpEngine on every trade to collect taker fee.
    ///         feeAmount must already be debited from trader's margin by PerpEngine.
    function collectFee(address trader, uint256 feeAmount, bytes32 pair)
        external
        onlyRole(PERP_ENGINE_ROLE)
        nonReentrant
    {
        if (feeAmount == 0) revert ZeroAmount();

        uint256 insuranceAmount = (feeAmount * INSURANCE_SHARE_BPS) / BASIS_POINTS;
        uint256 treasuryAmount = feeAmount - insuranceAmount;

        // CEI: update state before any transfer
        _feesByPair[pair] += feeAmount;
        _totalFeesCollected += feeAmount;
        _pendingTreasuryFees += treasuryAmount;

        emit FeeCollected(trader, feeAmount, pair, treasuryAmount, insuranceAmount);

        // Route insurance share to VaultManager insurance fund
        usdc.safeTransfer(address(vaultManager), insuranceAmount);
        vaultManager.contributeInsuranceFund(insuranceAmount);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Withdraw accumulated treasury fees to a recipient address.
    function claimProtocolFees(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = _pendingTreasuryFees;
        if (amount == 0) revert ZeroAmount();
        // CEI: zero before transfer
        _pendingTreasuryFees = 0;
        emit TreasuryFeeClaimed(recipient, amount);
        usdc.safeTransfer(recipient, amount);
    }

    /// @notice Update protocol treasury address.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getFeesByPair(bytes32 pair) external view returns (uint256) {
        return _feesByPair[pair];
    }

    function totalFeesCollected() external view returns (uint256) {
        return _totalFeesCollected;
    }

    function pendingTreasuryFees() external view returns (uint256) {
        return _pendingTreasuryFees;
    }
}
