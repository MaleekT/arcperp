// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

/// @dev Updatable Chainlink-compatible feed for testnet.
contract UpdatableMockFeed {
    int256 private _answer;
    uint8 public constant decimals = 8;
    address public immutable owner;

    constructor(int256 initialAnswer) {
        _answer = initialAnswer;
        owner = msg.sender;
    }

    function updateAnswer(int256 newAnswer) external {
        require(msg.sender == owner, "Not owner");
        _answer = newAnswer;
    }

    function latestRoundData() external view returns (
        uint80, int256 answer, uint256, uint256 updatedAt, uint80
    ) {
        return (1, _answer, block.timestamp, block.timestamp, 1);
    }
}

interface IPerpEngineAdmin {
    function updatePairFeed(bytes32 pair, address newChainlinkFeed) external;
}

/// @title UpdateFeeds
/// @notice Deploys 3 fresh UpdatableMockFeed contracts and wires them into
///         the existing PerpEngine via updatePairFeed(). Does NOT redeploy
///         PerpEngine or LiquidationEngine — existing positions are preserved.
///
/// Usage:
///   forge script script/UpdateFeeds.s.sol \
///     --rpc-url https://rpc.quicknode.testnet.arc.network \
///     --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
contract UpdateFeeds is Script {
    address private constant PERP_ENGINE = 0xdC07CBe108AaE0b83356CCc5a8FDB1e728418D4F;

    bytes32 private constant BTC_USDC  = keccak256("BTC-USDC");
    bytes32 private constant ETH_USDC  = keccak256("ETH-USDC");
    bytes32 private constant EURC_USDC = keccak256("EURC-USDC");

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // Seed prices at deploy time (8-decimal int, updated every 60s by oracle-updater bot)
        int256 btcSeed  = vm.envOr("SEED_BTC_PRICE",  int256(8000000000000));  // $80,000
        int256 ethSeed  = vm.envOr("SEED_ETH_PRICE",  int256(230000000000));   // $2,300
        int256 eurcSeed = vm.envOr("SEED_EURC_PRICE", int256(108000000));      // $1.08

        console2.log("Deployer:", deployer);
        console2.log("Targeting PerpEngine:", PERP_ENGINE);

        vm.startBroadcast(deployerKey);

        // 1. Deploy fresh mock feeds
        address mockBtc  = address(new UpdatableMockFeed(btcSeed));
        address mockEth  = address(new UpdatableMockFeed(ethSeed));
        address mockEurc = address(new UpdatableMockFeed(eurcSeed));
        console2.log("BTC  feed:", mockBtc);
        console2.log("ETH  feed:", mockEth);
        console2.log("EURC feed:", mockEurc);

        // 2. Point existing PerpEngine at the new feeds
        IPerpEngineAdmin engine = IPerpEngineAdmin(PERP_ENGINE);
        engine.updatePairFeed(BTC_USDC,  mockBtc);
        engine.updatePairFeed(ETH_USDC,  mockEth);
        engine.updatePairFeed(EURC_USDC, mockEurc);
        console2.log("PerpEngine feeds updated");

        vm.stopBroadcast();

        console2.log("\nDone! Set these env vars on Render (oracle-updater + order-server):");
        console2.log("  MOCK_BTC_FEED  =", mockBtc);
        console2.log("  MOCK_ETH_FEED  =", mockEth);
        console2.log("  MOCK_EURC_FEED =", mockEurc);
    }
}
