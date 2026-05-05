// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/VaultManager.sol";
import "../src/FeeCollector.sol";
import "../src/PerpEngine.sol";
import "../src/LiquidationEngine.sol";

/// @title DeployAll
/// @notice One-command deploy for ArcPerp on Arc Network (Chain ID 5042002).
///
/// Deploy order:
///   1. VaultManager
///   2. FeeCollector
///   3. PerpEngine
///   4. LiquidationEngine
///   5. Grant roles
///   6. Register trading pairs (BTC-USDC, ETH-USDC, EURC-USDC)
///   7. Save addresses to deployments/arc_testnet.json
///
/// Usage:
///   forge script script/DeployAll.s.sol \
///     --rpc-url arc_testnet \
///     --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
///
/// Required env vars (set in .env):
///   DEPLOYER_PRIVATE_KEY  — deployer wallet private key
///   ADMIN_ADDRESS         — multisig or EOA to receive DEFAULT_ADMIN_ROLE
///   TREASURY_ADDRESS      — receives 95% of protocol fees
///   ARC_RPC_URL           — Arc testnet RPC endpoint
///   ARC_ETHERSCAN_KEY     — for contract verification on ArcScan
///   CHAINLINK_BTC_FEED    — BTC/USD Chainlink aggregator on Arc testnet
///   CHAINLINK_ETH_FEED    — ETH/USD Chainlink aggregator on Arc testnet
///   CHAINLINK_EURC_FEED   — EURC/USD Chainlink aggregator on Arc testnet
contract DeployAll is Script {
    // ── Arc Network constants ─────────────────────────────────────────────────

    /// @dev Native USDC on Arc (Circle's official deployment)
    address private constant USDC = 0x3600000000000000000000000000000000000000;

    /// @dev Pyth oracle contract on Arc testnet
    address private constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;

    // ── Pyth price feed IDs ───────────────────────────────────────────────────

    bytes32 private constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 private constant PYTH_ETH_ID = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 private constant PYTH_EURC_ID = 0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb;

    // ── Pair identifiers ──────────────────────────────────────────────────────

    bytes32 private constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 private constant ETH_USDC = keccak256("ETH-USDC");
    bytes32 private constant EURC_USDC = keccak256("EURC-USDC");

    // ── Pair parameters ───────────────────────────────────────────────────────
    //
    // maxLeverageBps: 2500 = 25x
    // takerFeeBps:       5 = 0.05%
    // makerFeeBps:       2 = 0.02%
    // maintenanceMarginBps: 250 = 2.5%

    uint16 private constant MAX_LEVERAGE_BPS = 2500;
    uint16 private constant TAKER_FEE_BPS = 5;
    uint16 private constant MAKER_FEE_BPS = 2;
    uint16 private constant MAINTENANCE_MARGIN_BPS = 250;

    // ── Deployed addresses (populated during run()) ───────────────────────────

    VaultManager private vault;
    FeeCollector private feeCollector;
    PerpEngine private engine;
    LiquidationEngine private liqEngine;

    function run() external {
        // ── Read env vars ─────────────────────────────────────────────────────
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address chainlinkBtc = vm.envAddress("CHAINLINK_BTC_FEED");
        address chainlinkEth = vm.envAddress("CHAINLINK_ETH_FEED");
        address chainlinkEurc = vm.envAddress("CHAINLINK_EURC_FEED");

        address deployer = vm.addr(deployerKey);
        console2.log("Deploying from:", deployer);
        console2.log("Admin:", admin);
        console2.log("Treasury:", treasury);

        vm.startBroadcast(deployerKey);

        // ── Step 1: VaultManager ──────────────────────────────────────────────
        vault = new VaultManager(USDC, admin);
        console2.log("VaultManager:", address(vault));

        // ── Step 2: FeeCollector ──────────────────────────────────────────────
        feeCollector = new FeeCollector(USDC, address(vault), treasury, admin);
        console2.log("FeeCollector:", address(feeCollector));

        // ── Step 3: PerpEngine ────────────────────────────────────────────────
        engine = new PerpEngine(address(vault), address(feeCollector), PYTH, admin);
        console2.log("PerpEngine:", address(engine));

        // ── Step 4: LiquidationEngine ─────────────────────────────────────────
        liqEngine = new LiquidationEngine(address(engine), address(vault), USDC, PYTH, admin);
        console2.log("LiquidationEngine:", address(liqEngine));

        // ── Step 5a: VaultManager role grants ─────────────────────────────────
        // PerpEngine needs PERP_ENGINE_ROLE to debit/credit margin and forward fees
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(engine));
        // LiquidationEngine needs PERP_ENGINE_ROLE to interact with vault on liquidation close
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(liqEngine));
        // FeeCollector needs LIQUIDATION_ENGINE_ROLE to contribute insurance fund
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(feeCollector));
        // LiquidationEngine needs LIQUIDATION_ENGINE_ROLE for liquidationWithdraw + debitToInsuranceFund
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));

        // ── Step 5b: FeeCollector role grants ─────────────────────────────────
        // PerpEngine needs PERP_ENGINE_ROLE to call collectFee after forwarding USDC
        feeCollector.grantRole(feeCollector.PERP_ENGINE_ROLE(), address(engine));

        // ── Step 5c: PerpEngine role grants ───────────────────────────────────
        // LiquidationEngine needs LIQUIDATION_ENGINE_ROLE to call closePosition on behalf of liquidated traders
        engine.grantRole(engine.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));

        // ── Step 6: Register trading pairs ────────────────────────────────────
        engine.addPair(
            BTC_USDC,
            MAX_LEVERAGE_BPS,
            TAKER_FEE_BPS,
            MAKER_FEE_BPS,
            MAINTENANCE_MARGIN_BPS,
            PYTH_BTC_ID,
            chainlinkBtc
        );
        console2.log("Added pair: BTC-USDC");

        engine.addPair(
            ETH_USDC,
            MAX_LEVERAGE_BPS,
            TAKER_FEE_BPS,
            MAKER_FEE_BPS,
            MAINTENANCE_MARGIN_BPS,
            PYTH_ETH_ID,
            chainlinkEth
        );
        console2.log("Added pair: ETH-USDC");

        engine.addPair(
            EURC_USDC,
            MAX_LEVERAGE_BPS,
            TAKER_FEE_BPS,
            MAKER_FEE_BPS,
            MAINTENANCE_MARGIN_BPS,
            PYTH_EURC_ID,
            chainlinkEurc
        );
        console2.log("Added pair: EURC-USDC");

        vm.stopBroadcast();

        // ── Step 7: Save deployment addresses ────────────────────────────────
        _saveDeployment(admin, treasury, chainlinkBtc, chainlinkEth, chainlinkEurc);

        // ── Summary ───────────────────────────────────────────────────────────
        console2.log("\n=== ArcPerp Deployment Complete ===");
        console2.log("VaultManager:      ", address(vault));
        console2.log("FeeCollector:      ", address(feeCollector));
        console2.log("PerpEngine:        ", address(engine));
        console2.log("LiquidationEngine: ", address(liqEngine));
        console2.log("Pairs registered:   BTC-USDC, ETH-USDC, EURC-USDC");
        console2.log("Verify on ArcScan:  https://testnet.arcscan.app");
    }

    /// @dev Writes all deployment addresses to deployments/arc_testnet.json for
    ///      consumption by the frontend, backend, and Envio indexer.
    function _saveDeployment(
        address admin,
        address treasury,
        address chainlinkBtc,
        address chainlinkEth,
        address chainlinkEurc
    ) internal {
        string memory json = _buildDeploymentJson(admin, treasury, chainlinkBtc, chainlinkEth, chainlinkEurc);

        // forge-std vm.writeFile writes relative to project root
        vm.writeFile("deployments/arc_testnet.json", json);
        console2.log("Deployment saved to: deployments/arc_testnet.json");
    }

    function _buildDeploymentJson(
        address admin,
        address treasury,
        address chainlinkBtc,
        address chainlinkEth,
        address chainlinkEurc
    ) internal view returns (string memory) {
        return string.concat(
            "{\n",
            '  "network": "arc_testnet",\n',
            '  "chainId": 5042002,\n',
            '  "deployedAt": ',
            vm.toString(block.timestamp),
            ",\n",
            '  "deployer": "',
            vm.toString(msg.sender),
            '",\n',
            '  "admin": "',
            vm.toString(admin),
            '",\n',
            '  "treasury": "',
            vm.toString(treasury),
            '",\n',
            '  "contracts": {\n',
            '    "usdc": "',
            vm.toString(USDC),
            '",\n',
            '    "pyth": "',
            vm.toString(PYTH),
            '",\n',
            '    "vaultManager": "',
            vm.toString(address(vault)),
            '",\n',
            '    "feeCollector": "',
            vm.toString(address(feeCollector)),
            '",\n',
            '    "perpEngine": "',
            vm.toString(address(engine)),
            '",\n',
            '    "liquidationEngine": "',
            vm.toString(address(liqEngine)),
            '"\n',
            "  },\n",
            '  "pairs": {\n',
            '    "BTC-USDC": {\n',
            '      "id": "',
            vm.toString(BTC_USDC),
            '",\n',
            '      "pythPriceId": "',
            vm.toString(PYTH_BTC_ID),
            '",\n',
            '      "chainlinkFeed": "',
            vm.toString(chainlinkBtc),
            '"\n',
            "    },\n",
            '    "ETH-USDC": {\n',
            '      "id": "',
            vm.toString(ETH_USDC),
            '",\n',
            '      "pythPriceId": "',
            vm.toString(PYTH_ETH_ID),
            '",\n',
            '      "chainlinkFeed": "',
            vm.toString(chainlinkEth),
            '"\n',
            "    },\n",
            '    "EURC-USDC": {\n',
            '      "id": "',
            vm.toString(EURC_USDC),
            '",\n',
            '      "pythPriceId": "',
            vm.toString(PYTH_EURC_ID),
            '",\n',
            '      "chainlinkFeed": "',
            vm.toString(chainlinkEurc),
            '"\n',
            "    }\n",
            "  }\n",
            "}"
        );
    }
}
