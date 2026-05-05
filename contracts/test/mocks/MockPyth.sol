// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @notice TEST ONLY — never deploy to mainnet.
///         Simulates Pyth oracle with controllable prices and timestamps.
contract MockPyth is IPyth {
    struct MockPrice {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    mapping(bytes32 => MockPrice) private _prices;
    uint256 public mockUpdateFee;

    constructor(uint256 _updateFee) {
        mockUpdateFee = _updateFee;
    }

    /// @notice Set a price for a feed. Used by test fixtures to control oracle state.
    function setPrice(bytes32 priceId, int64 price, int32 expo, uint256 publishTime) external {
        _prices[priceId] = MockPrice({price: price, conf: 0, expo: expo, publishTime: publishTime});
    }

    function setUpdateFee(uint256 fee) external {
        mockUpdateFee = fee;
    }

    // ── IPyth implementation ──────────────────────────────────────────────────

    function getPrice(bytes32 id) external view override returns (PythStructs.Price memory) {
        MockPrice memory mp = _prices[id];
        return PythStructs.Price({price: mp.price, conf: mp.conf, expo: mp.expo, publishTime: mp.publishTime});
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view override returns (PythStructs.Price memory) {
        MockPrice memory mp = _prices[id];
        require(block.timestamp - mp.publishTime <= age, "MockPyth: stale price");
        return PythStructs.Price({price: mp.price, conf: mp.conf, expo: mp.expo, publishTime: mp.publishTime});
    }

    function getPriceUnsafe(bytes32 id) external view override returns (PythStructs.Price memory) {
        MockPrice memory mp = _prices[id];
        return PythStructs.Price({price: mp.price, conf: mp.conf, expo: mp.expo, publishTime: mp.publishTime});
    }

    function getUpdateFee(bytes[] calldata) external view override returns (uint256) {
        return mockUpdateFee;
    }

    function updatePriceFeeds(bytes[] calldata) external payable override {
        // No-op in mock — prices set via setPrice()
    }

    function updatePriceFeedsIfNecessary(bytes[] calldata, bytes32[] calldata, uint64[] calldata)
        external
        payable
        override
    {}

    function getEmaPrice(bytes32 id) external view override returns (PythStructs.Price memory) {
        return this.getPrice(id);
    }

    function getEmaPriceNoOlderThan(bytes32 id, uint256 age)
        external
        view
        override
        returns (PythStructs.Price memory)
    {
        return this.getPriceNoOlderThan(id, age);
    }

    function getEmaPriceUnsafe(bytes32 id) external view override returns (PythStructs.Price memory) {
        return this.getPriceUnsafe(id);
    }

    function parsePriceFeedUpdates(
        bytes[] calldata,
        bytes32[] calldata priceIds,
        uint64,
        uint64
    ) external payable override returns (PythStructs.PriceFeed[] memory feeds) {
        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i = 0; i < priceIds.length; i++) {
            MockPrice memory mp = _prices[priceIds[i]];
            feeds[i] = PythStructs.PriceFeed({
                id: priceIds[i],
                price: PythStructs.Price({price: mp.price, conf: mp.conf, expo: mp.expo, publishTime: mp.publishTime}),
                emaPrice: PythStructs.Price({price: mp.price, conf: mp.conf, expo: mp.expo, publishTime: mp.publishTime})
            });
        }
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable override returns (PythStructs.PriceFeed[] memory) {
        return this.parsePriceFeedUpdates(updateData, priceIds, minPublishTime, maxPublishTime);
    }
}
