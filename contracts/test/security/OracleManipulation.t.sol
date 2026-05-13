// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/PerpEngine.sol";
import "../../src/LiquidationEngine.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/libraries/OracleLib.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

/// @notice Security tests proving oracle manipulation is blocked at every vector:
///         stale prices, zero prices, and cross-source deviation > 10%.
contract OracleManipulationTest is Test {
    PerpEngine internal engine;
    LiquidationEngine internal liqEngine;
    VaultManager internal vault;
    FeeCollector internal feeCollector;
    MockUSDC internal usdc;
    MockPyth internal mockPyth;
    MockChainlink internal mockChainlink;

    address internal admin = makeAddr("admin");
    address internal trader = makeAddr("trader");
    address internal liquidator = makeAddr("liquidator");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    int256 internal constant BTC_PRICE = 67_000e8;
    uint256 internal constant MARGIN = 1_000e6;
    uint256 internal constant LEVERAGE_10X = 1_000;
    uint256 internal constant STALENESS = 30; // OracleLib.STALENESS_THRESHOLD

    bytes[] internal emptyVaa;

    function setUp() public {
        // Advance timestamp so block.timestamp - STALENESS - 1 doesn't underflow (default is 1)
        vm.warp(4 hours);

        usdc = new MockUSDC();
        mockPyth = new MockPyth(0);
        mockChainlink = new MockChainlink(8);

        vault = new VaultManager(address(usdc), admin);
        feeCollector = new FeeCollector(address(usdc), address(vault), treasury, admin);
        engine = new PerpEngine(address(vault), address(feeCollector), address(mockPyth), admin);
        liqEngine = new LiquidationEngine(
            address(engine), address(vault), address(usdc), address(mockPyth), admin
        );

        vm.startPrank(admin);
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(engine));
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(liqEngine));
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(feeCollector));
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));
        feeCollector.grantRole(feeCollector.PERP_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.LIQUIDATION_ENGINE_ROLE(), address(liqEngine));
        engine.addPair(BTC_USDC, 2500, 5, 2, 250, PYTH_BTC_ID, address(mockChainlink));
        vm.stopPrank();

        // Default: both oracles agree, fresh prices
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);

        usdc.mint(trader, MARGIN * 100);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(MARGIN * 100);
    }

    // ── Stale Pyth, fresh Chainlink — falls back to Chainlink ─────────────────

    function test_oracle_stalePyth_fallsBackToChainlink() public {
        // Pyth publishTime > STALENESS_THRESHOLD seconds ago → getPriceNoOlderThan reverts
        // OracleLib catches the revert and falls back to Chainlink which is fresh
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp - STALENESS - 1);
        // Chainlink is fresh (setAnswer updates _updatedAt to block.timestamp)
        mockChainlink.setAnswer(BTC_PRICE);

        // Should succeed using Chainlink fallback
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        assertNe(posId, bytes32(0), "Position opened using Chainlink fallback");
    }

    // ── Stale Pyth + stale Chainlink — BothOraclesUnavailable ─────────────────

    function test_oracle_bothStale_reverts() public {
        // Pyth stale
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp - STALENESS - 1);
        // Chainlink stale (updatedAt > 1 hour ago)
        mockChainlink.setUpdatedAt(block.timestamp - 1 hours - 1);

        vm.prank(trader);
        vm.expectRevert(OracleLib.BothOraclesUnavailable.selector);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
    }

    // ── Fresh Pyth, stale Chainlink — uses Pyth only ──────────────────────────

    function test_oracle_freshPyth_staleChainlink_usesPyth() public {
        // Pyth fresh
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        // Chainlink stale — OracleLib try/catch catches this, chainlinkAvailable = false
        mockChainlink.setUpdatedAt(block.timestamp - 1 hours - 1);

        // Should succeed using Pyth only
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        assertNe(posId, bytes32(0), "Position opened using Pyth when Chainlink is stale");
    }

    // ── Pyth/Chainlink deviation > 10% — OraclePriceDeviation ────────────────

    function test_oracle_deviationTooLarge_reverts() public {
        // Pyth: $67,000, Chainlink: $60,000
        // deviation = (67000 - 60000) * 10000 / 67000 = 1044 bps > 1000 bps (10%)
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(60_000e8); // ~10.4% below Pyth

        // OraclePriceDeviation carries (pythPrice, chainlinkPrice, deviationBps) — use full encoding
        uint256 pythPrice = uint256(BTC_PRICE);
        uint256 chainlinkPrice = uint256(60_000e8);
        uint256 deviationBps = (pythPrice - chainlinkPrice) * 10_000 / pythPrice; // 1044

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(OracleLib.OraclePriceDeviation.selector, pythPrice, chainlinkPrice, deviationBps)
        );
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
    }

    // ── Exactly 10% deviation — should succeed (boundary) ────────────────────

    function test_oracle_deviationExactlyTen_succeeds() public {
        // 10% of 67000 = 6700; 67000 - 6700 = 60300
        // deviation = 6700/67000 * 10000 = 1000 bps = exactly 10%
        // OracleLib reverts if deviationBps > DEVIATION_THRESHOLD_BPS (strictly greater)
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(int256(uint256(BTC_PRICE) * 90 / 100)); // exactly 10% below

        // deviationBps = (67000 - 60300) / 67000 * 10000 = 6700/67000 * 10000 = 1000 bps
        // 1000 > 1000 is false, so no revert
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        assertNe(posId, bytes32(0));
    }

    // ── Stale price blocks liquidation too ────────────────────────────────────

    function test_oracle_stalePricePreventsLiquidation() public {
        // Open healthy position
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        vm.roll(block.number + 1);

        // Make BOTH oracles stale — liquidation must be blocked
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE * 97 / 100), -8, block.timestamp - STALENESS - 1);
        mockChainlink.setUpdatedAt(block.timestamp - 1 hours - 1);

        vm.prank(liquidator);
        vm.expectRevert(OracleLib.BothOraclesUnavailable.selector);
        liqEngine.liquidate(posId, emptyVaa);
    }

    // ── Normal operation: both agree within 1% ────────────────────────────────

    function test_oracle_bothAgreeFreshPrices_succeeds() public {
        // 1% deviation — well within the 10% guard
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE * 99 / 100);

        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        assertNe(posId, bytes32(0), "Normal operation should succeed");
    }

    // ── Pyth zero price — falls back to Chainlink ────────────────────────────

    function test_oracle_zeroPythPrice_usesChainlink() public {
        // p.price = 0 → OracleLib checks `if (p.price > 0)` — pythAvailable stays false
        mockPyth.setPrice(PYTH_BTC_ID, 0, -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);

        // Falls back to Chainlink only — should succeed
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, 0, 0, emptyVaa);
        assertNe(posId, bytes32(0), "Chainlink fallback used when Pyth returns zero price");
    }

    // Helper
    function assertNe(bytes32 a, bytes32 b, string memory reason) internal {
        assertFalse(a == b, reason);
    }

    function assertNe(bytes32 a, bytes32 b) internal {
        assertFalse(a == b);
    }
}
