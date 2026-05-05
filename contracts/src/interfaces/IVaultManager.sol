// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVaultManager {
    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount, address recipient);
    event MarginCredited(address indexed trader, uint256 amount, string reason);
    event MarginDebited(address indexed trader, uint256 amount, string reason);
    event InsuranceFundContributed(uint256 amount);
    event InsuranceFundWithdrawn(uint256 amount, address recipient);

    error InsufficientMargin(address trader, uint256 requested, uint256 available);
    error InsufficientInsuranceFund(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address recipient) external;
    function debitMargin(address trader, uint256 amount, string calldata reason) external;
    function creditMargin(address trader, uint256 amount, string calldata reason) external;
    function contributeInsuranceFund(uint256 amount) external;
    function withdrawInsuranceFund(uint256 amount, address recipient) external;
    /// @notice Forward fee USDC (already debited from trader) to FeeCollector. PerpEngine only.
    function forwardFee(address recipient, uint256 amount) external;
    /// @notice Atomically debit trader margin and transfer USDC to recipient. LiquidationEngine only.
    function liquidationWithdraw(address trader, uint256 amount, address recipient) external;
    /// @notice Move trader margin balance directly into insurance fund (no USDC transfer). LiquidationEngine only.
    function debitToInsuranceFund(address trader, uint256 amount) external;
    function getMarginBalance(address trader) external view returns (uint256);
    function getInsuranceFund() external view returns (uint256);
}
