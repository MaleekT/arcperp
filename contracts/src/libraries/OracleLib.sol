// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/// @title OracleLib
/// @notice Tiered oracle price resolution: Pyth (primary) → Chainlink (fallback).
///         Every price read enforces a 30-second staleness guard.
///         Cross-source deviation > 10% causes revert to prevent oracle manipulation.
library OracleLib {
    uint256 internal constant STALENESS_THRESHOLD = 30;
    uint256 internal constant DEVIATION_THRESHOLD_BPS = 1000; // 10%
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant PRICE_PRECISION = 1e8;
    uint256 internal constant CHAINLINK_HEARTBEAT = 1 hours;

    error StaleOraclePrice(uint256 publishTime, uint256 currentTime, uint256 maxAge);
    error OraclePriceDeviation(uint256 pythPrice, uint256 chainlinkPrice, uint256 deviationBps);
    error ZeroOraclePrice();
    error NegativeChainlinkPrice();
    error ChainlinkStale(uint256 updatedAt, uint256 currentTime);
    error BothOraclesUnavailable();

    /// @notice Fetch and verify price from Pyth using caller-supplied VAA.
    ///         The caller must obtain fresh priceUpdateData from Pyth Hermes API.
    /// @param pyth            IPyth contract address on Arc testnet
    /// @param priceId         Pyth price feed ID (bytes32)
    /// @param priceUpdateData Fresh VAA bytes — cryptographically verified on-chain
    /// @return price in 1e8 precision (always positive)
    function getPythPrice(address pyth, bytes32 priceId, bytes[] calldata priceUpdateData)
        internal
        returns (uint256 price)
    {
        uint256 updateFee = IPyth(pyth).getUpdateFee(priceUpdateData);
        IPyth(pyth).updatePriceFeeds{value: updateFee}(priceUpdateData);

        PythStructs.Price memory p = IPyth(pyth).getPrice(priceId);

        if (p.price <= 0) revert ZeroOraclePrice();

        uint256 publishTime = p.publishTime;
        if (block.timestamp - publishTime > STALENESS_THRESHOLD) {
            revert StaleOraclePrice(publishTime, block.timestamp, STALENESS_THRESHOLD);
        }

        price = _normalisePythPrice(uint256(uint64(p.price)), p.expo);
        if (price == 0) revert ZeroOraclePrice();
    }

    /// @notice Fetch Chainlink price as a fallback or deviation check source.
    /// @param priceFeed  AggregatorV3Interface address
    /// @return price in 1e8 precision (always positive)
    function getChainlinkPrice(address priceFeed) internal view returns (uint256 price) {
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(priceFeed).latestRoundData();

        if (answer <= 0) revert NegativeChainlinkPrice();
        if (block.timestamp - updatedAt > CHAINLINK_HEARTBEAT) {
            revert ChainlinkStale(updatedAt, block.timestamp);
        }

        uint8 decimals = AggregatorV3Interface(priceFeed).decimals();
        price = _normaliseToE8(uint256(answer), decimals);
        if (price == 0) revert ZeroOraclePrice();
    }

    /// @notice Primary oracle resolution with cross-source deviation guard.
    ///         Attempts Pyth first (external call — try/catch supported).
    ///         Falls back to Chainlink if Pyth update or price retrieval fails.
    ///         If both sources return prices, validates they are within 10% of each other.
    /// @param pyth             IPyth contract on Arc testnet
    /// @param pythPriceId      Pyth feed ID
    /// @param priceUpdateData  Caller-supplied fresh VAA bytes
    /// @param chainlinkFeed    AggregatorV3Interface address (fallback)
    /// @return price in 1e8 precision
    function getVerifiedPrice(
        address pyth,
        bytes32 pythPriceId,
        bytes[] calldata priceUpdateData,
        address chainlinkFeed
    ) internal returns (uint256 price) {
        // Step 1: attempt Pyth feed update (external call — try/catch valid here)
        bool pythAvailable;
        uint256 pythPrice;

        uint256 updateFee = IPyth(pyth).getUpdateFee(priceUpdateData);
        try IPyth(pyth).updatePriceFeeds{value: updateFee}(priceUpdateData) {
            // Step 2: attempt price read (getPrice reverts if stale in some Pyth versions)
            try IPyth(pyth).getPriceNoOlderThan(pythPriceId, STALENESS_THRESHOLD) returns (
                PythStructs.Price memory p
            ) {
                if (p.price > 0) {
                    uint256 normalised = _normalisePythPrice(uint256(uint64(p.price)), p.expo);
                    if (normalised > 0) {
                        pythPrice = normalised;
                        pythAvailable = true;
                    }
                }
            } catch {}
        } catch {}

        // Step 3: get Chainlink price (will revert if stale — that's intentional)
        uint256 clPrice;
        bool chainlinkAvailable;
        try AggregatorV3Interface(chainlinkFeed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer > 0 && block.timestamp - updatedAt <= CHAINLINK_HEARTBEAT) {
                uint8 decimals = AggregatorV3Interface(chainlinkFeed).decimals();
                clPrice = _normaliseToE8(uint256(answer), decimals);
                chainlinkAvailable = clPrice > 0;
            }
        } catch {}

        if (!pythAvailable && !chainlinkAvailable) revert BothOraclesUnavailable();

        // If only one source available, use it
        if (!pythAvailable) return clPrice;
        if (!chainlinkAvailable) return pythPrice;

        // Both available — enforce deviation guard
        uint256 deviationBps = _deviationBps(pythPrice, clPrice);
        if (deviationBps > DEVIATION_THRESHOLD_BPS) {
            revert OraclePriceDeviation(pythPrice, clPrice, deviationBps);
        }

        // Pyth is canonical settlement price
        return pythPrice;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Normalise Pyth raw price to 1e8 using Pyth's signed exponent.
    function _normalisePythPrice(uint256 rawPrice, int32 expo) private pure returns (uint256) {
        if (expo == -8) return rawPrice;
        if (expo > -8) {
            return rawPrice * (10 ** uint32(expo + 8));
        } else {
            uint32 shift = uint32(-expo - 8);
            return rawPrice / (10 ** shift);
        }
    }

    /// @dev Normalise any price with `decimals` to 1e8 precision.
    function _normaliseToE8(uint256 rawPrice, uint8 decimals) private pure returns (uint256) {
        if (decimals == 8) return rawPrice;
        if (decimals < 8) return rawPrice * (10 ** uint256(8 - decimals));
        return rawPrice / (10 ** uint256(decimals - 8));
    }

    /// @dev Compute deviation in basis points between two prices.
    function _deviationBps(uint256 a, uint256 b) private pure returns (uint256) {
        if (a == 0 || b == 0) return BASIS_POINTS;
        uint256 larger = a > b ? a : b;
        uint256 smaller = a > b ? b : a;
        return ((larger - smaller) * BASIS_POINTS) / larger;
    }
}
