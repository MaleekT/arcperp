// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IFeeCollector {
    event FeeCollected(
        address indexed trader,
        uint256 amount,
        bytes32 indexed pair,
        uint256 treasuryAmount,
        uint256 insuranceAmount
    );
    event TreasuryFeeClaimed(address indexed recipient, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    error ZeroAmount();
    error ZeroAddress();

    function collectFee(address trader, uint256 feeAmount, bytes32 pair) external;
    function claimProtocolFees(address recipient) external;
    function getFeesByPair(bytes32 pair) external view returns (uint256);
    function totalFeesCollected() external view returns (uint256);
}
