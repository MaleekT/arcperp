// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice TEST ONLY — never deploy to mainnet.
///         Simulates Chainlink AggregatorV3Interface with controllable answers.
contract MockChainlink {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _decimals;
    uint80 private _roundId;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
        _updatedAt = block.timestamp;
        _roundId = 1;
    }

    /// @notice Set the price returned by latestRoundData. Used by test fixtures.
    function setAnswer(int256 answer) external {
        _answer = answer;
        _updatedAt = block.timestamp;
        _roundId++;
    }

    /// @notice Manually set updatedAt to simulate staleness in tests.
    function setUpdatedAt(uint256 updatedAt) external {
        _updatedAt = updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
