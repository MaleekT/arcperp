// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../../src/interfaces/IVaultManager.sol";

/// @notice TEST ONLY — simulates a reentrancy attack on VaultManager.withdraw().
///         Deployed in ReentrancyAttack.t.sol to prove the nonReentrant guard blocks re-entry.
///         The attack() function initiates a withdraw; receive() attempts to re-enter immediately.
///         The test asserts this entire flow reverts with ReentrancyGuardReentrantCall.
contract MaliciousReentrant {
    IVaultManager public immutable vault;
    uint256 public attackCount;
    bool public attackActive;

    error AttackFailed();

    constructor(address _vault) {
        vault = IVaultManager(_vault);
    }

    /// @notice Entry point: caller deposits first, then triggers re-entrant withdraw.
    function attack(uint256 amount) external {
        attackActive = true;
        attackCount = 0;
        vault.withdraw(amount, address(this));
    }

    /// @notice Re-entry point — called by ERC-20 transfer during withdraw().
    ///         nonReentrant on VaultManager must cause this to revert.
    receive() external payable {
        if (attackActive && attackCount < 3) {
            attackCount++;
            vault.withdraw(10e6, address(this));
        }
    }

    /// @notice Allow test to fund this contract via VaultManager.deposit().
    function depositToVault(uint256 amount) external {
        vault.deposit(amount);
    }
}
