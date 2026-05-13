// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/PerpEngine.sol";
import "../src/LiquidationEngine.sol";

/// @dev Updatable Chainlink-compatible feed for testnet.
///      Owner can push fresh prices via updateAnswer().
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

/// @title MigratePerpEngine
/// @notice Redeploys PerpEngine + LiquidationEngine with fresh mock feeds and
///         `updatePairFeed` / `updateAnswer` support.
///         VaultManager and FeeCollector are reused to preserve vault balances.
///
/// Usage:
///   forge script script/MigratePerpEngine.s.sol \
///     --rpc-url arc_testnet \
///     --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
contract MigratePerpEngine is Script {
    // ── Existing contracts (unchanged) ───────────────────────────────────────
    address private constant VAULT_MANAGER  = 0x5Fa17b9d90C5bC74Ec9Ef42ca149Fb9c5c096899;
    address private constant FEE_COLLECTOR  = 0xF4d264943637CAEd0812c9B61a9060623ba5Fb9a;
    address private constant PYTH           = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    address private constant USDC           = 0x3600000000000000000000000000000000000000;

    // ── Pyth feed IDs ─────────────────────────────────────────────────────────
    bytes32 private constant PYTH_BTC_ID  = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 private constant PYTH_ETH_ID  = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 private constant PYTH_EURC_ID = 0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb;

    // ── Pair IDs ──────────────────────────────────────────────────────────────
    bytes32 private constant BTC_USDC  = keccak256("BTC-USDC");
    bytes32 private constant ETH_USDC  = keccak256("ETH-USDC");
    bytes32 private constant EURC_USDC = keccak256("EURC-USDC");

    // ── Pair parameters (unchanged from original deploy) ──────────────────────
    uint16 private constant MAX_LEVERAGE_BPS      = 2500;
    uint16 private constant TAKER_FEE_BPS         = 5;
    uint16 private constant MAKER_FEE_BPS         = 2;
    uint16 private constant MAINTENANCE_MARGIN_BPS = 250;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address admin       = vm.envOr("ADMIN_ADDRESS", deployer);
        address treasury    = vm.envOr("TREASURY_ADDRESS", deployer);

        // Current market prices seeded at deploy time (8-decimal int)
        // BTC  ~$80,377  →  8037700000000
        // ETH  ~$2,313   →  231300000000
        // EURC ~$1.08    →  108000000
        int256 btcSeed  = vm.envOr("SEED_BTC_PRICE",  int256(8037700000000));
        int256 ethSeed  = vm.envOr("SEED_ETH_PRICE",  int256(231300000000));
        int256 eurcSeed = vm.envOr("SEED_EURC_PRICE", int256(108000000));

        console2.log("Migrating from deployer:", deployer);
        console2.log("Reusing VaultManager:   ", VAULT_MANAGER);
        console2.log("Reusing FeeCollector:   ", FEE_COLLECTOR);

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy fresh updatable mock feeds ──────────────────────────────
        address mockBtc  = address(new UpdatableMockFeed(btcSeed));
        address mockEth  = address(new UpdatableMockFeed(ethSeed));
        address mockEurc = address(new UpdatableMockFeed(eurcSeed));
        console2.log("BTC  mock feed:", mockBtc);
        console2.log("ETH  mock feed:", mockEth);
        console2.log("EURC mock feed:", mockEurc);

        // ── 2. Deploy new PerpEngine ──────────────────────────────────────────
        PerpEngine engine = new PerpEngine(VAULT_MANAGER, FEE_COLLECTOR, PYTH, admin);
        console2.log("New PerpEngine:", address(engine));

        // ── 3. Deploy new LiquidationEngine ──────────────────────────────────
        LiquidationEngine liqEngine = new LiquidationEngine(address(engine), VAULT_MANAGER, USDC, PYTH, admin);
        console2.log("New LiqEngine: ", address(liqEngine));

        // ── 4. Grant roles on VaultManager ────────────────────────────────────
        IAccessControl vault = IAccessControl(VAULT_MANAGER);
        bytes32 perpRole = keccak256("PERP_ENGINE_ROLE");
        bytes32 liqRole  = keccak256("LIQUIDATION_ENGINE_ROLE");

        vault.grantRole(perpRole, address(engine));
        vault.grantRole(perpRole, address(liqEngine));
        vault.grantRole(liqRole,  address(liqEngine));
        console2.log("VaultManager roles granted");

        // ── 5. Grant roles on FeeCollector ────────────────────────────────────
        IAccessControl fee = IAccessControl(FEE_COLLECTOR);
        fee.grantRole(perpRole, address(engine));
        console2.log("FeeCollector PERP_ENGINE_ROLE granted");

        // ── 6. Grant LIQUIDATION_ENGINE_ROLE on new PerpEngine ────────────────
        engine.grantRole(engine.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));

        // ── 7. Register pairs on new PerpEngine ───────────────────────────────
        engine.addPair(BTC_USDC,  MAX_LEVERAGE_BPS, TAKER_FEE_BPS, MAKER_FEE_BPS, MAINTENANCE_MARGIN_BPS, PYTH_BTC_ID,  mockBtc);
        engine.addPair(ETH_USDC,  MAX_LEVERAGE_BPS, TAKER_FEE_BPS, MAKER_FEE_BPS, MAINTENANCE_MARGIN_BPS, PYTH_ETH_ID,  mockEth);
        engine.addPair(EURC_USDC, MAX_LEVERAGE_BPS, TAKER_FEE_BPS, MAKER_FEE_BPS, MAINTENANCE_MARGIN_BPS, PYTH_EURC_ID, mockEurc);
        console2.log("Pairs registered: BTC-USDC, ETH-USDC, EURC-USDC");

        vm.stopBroadcast();

        // ── 8. Write updated deployment JSON ──────────────────────────────────
        string memory json = string.concat(
            "{\n",
            '  "network": "arc_testnet",\n',
            '  "chainId": 5042002,\n',
            '  "deployedAt": ', vm.toString(block.timestamp), ",\n",
            '  "deployer": "', vm.toString(deployer), '",\n',
            '  "admin": "', vm.toString(admin), '",\n',
            '  "treasury": "', vm.toString(treasury), '",\n',
            '  "contracts": {\n',
            '    "usdc": "', vm.toString(USDC), '",\n',
            '    "pyth": "', vm.toString(PYTH), '",\n',
            '    "vaultManager": "', vm.toString(VAULT_MANAGER), '",\n',
            '    "feeCollector": "', vm.toString(FEE_COLLECTOR), '",\n',
            '    "perpEngine": "', vm.toString(address(engine)), '",\n',
            '    "liquidationEngine": "', vm.toString(address(liqEngine)), '"\n',
            "  },\n",
            '  "pairs": {\n',
            '    "BTC-USDC": {\n',
            '      "id": "', vm.toString(BTC_USDC), '",\n',
            '      "pythPriceId": "', vm.toString(PYTH_BTC_ID), '",\n',
            '      "chainlinkFeed": "', vm.toString(mockBtc), '"\n',
            "    },\n",
            '    "ETH-USDC": {\n',
            '      "id": "', vm.toString(ETH_USDC), '",\n',
            '      "pythPriceId": "', vm.toString(PYTH_ETH_ID), '",\n',
            '      "chainlinkFeed": "', vm.toString(mockEth), '"\n',
            "    },\n",
            '    "EURC-USDC": {\n',
            '      "id": "', vm.toString(EURC_USDC), '",\n',
            '      "pythPriceId": "', vm.toString(PYTH_EURC_ID), '",\n',
            '      "chainlinkFeed": "', vm.toString(mockEurc), '"\n',
            "    }\n",
            "  }\n",
            "}"
        );
        vm.writeFile("deployments/arc_testnet.json", json);
        console2.log("\nDeployment saved to deployments/arc_testnet.json");
        console2.log("Update frontend VITE_PERP_ENGINE_ADDRESS and VITE_LIQUIDATION_ENGINE_ADDRESS");
        console2.log("Update backend PERP_ENGINE_ADDRESS and LIQUIDATION_ENGINE_ADDRESS");
        console2.log("Add MOCK_BTC_FEED, MOCK_ETH_FEED, MOCK_EURC_FEED to backend .env");
    }
}
