// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/PerpEngine.sol";
import "../../src/VaultManager.sol";
import "../../src/FeeCollector.sol";
import "../../src/libraries/OracleLib.sol";
import "../mocks/MockUSDC.sol";
import "../mocks/MockPyth.sol";
import "../mocks/MockChainlink.sol";

contract PerpEngineTest is Test {
    PerpEngine internal engine;
    VaultManager internal vault;
    FeeCollector internal feeCollector;
    MockUSDC internal usdc;
    MockPyth internal mockPyth;
    MockChainlink internal mockChainlink;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal trader = makeAddr("trader");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant BTC_USDC = keccak256("BTC-USDC");
    bytes32 internal constant PYTH_BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    // BTC_PRICE stored as int256 to prevent int64 overflow during arithmetic before casting.
    // 67_000e8 = 6_700_000_000_000 — fits in int64, but intermediate products (e.g. *110) may not.
    int256 internal constant BTC_PRICE = 67_000e8; // $67,000 in 1e8 precision
    uint256 internal constant MARGIN = 1_000e6; // 1000 USDC
    uint256 internal constant LEVERAGE_10X = 1_000; // 1000 bps = 10x
    // OracleLib.STALENESS_THRESHOLD is 30 seconds — kept in sync here.
    uint256 internal constant STALENESS_THRESHOLD = 30;

    // MockPyth ignores VAA bytes and returns prices set via setPrice() — empty array is valid for tests.
    bytes[] internal emptyVaa;

    function setUp() public {
        // Advance timestamp so block.timestamp - STALENESS_THRESHOLD - 1 doesn't underflow (default is 1)
        vm.warp(4 hours);

        usdc = new MockUSDC();
        mockPyth = new MockPyth(0);
        mockChainlink = new MockChainlink(8);

        vault = new VaultManager(address(usdc), admin);
        feeCollector = new FeeCollector(address(usdc), address(vault), treasury, admin);
        engine = new PerpEngine(address(vault), address(feeCollector), address(mockPyth), admin);

        // Set up roles
        vm.startPrank(admin);
        vault.grantRole(vault.PERP_ENGINE_ROLE(), address(engine));
        vault.grantRole(vault.LIQUIDATION_ENGINE_ROLE(), address(feeCollector));
        feeCollector.grantRole(feeCollector.PERP_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.KEEPER_ROLE(), keeper);

        // Add BTC-USDC pair
        engine.addPair(
            BTC_USDC,
            2500, // 25x max
            5, // 0.05% taker fee
            2, // 0.02% maker fee
            250, // 2.5% maintenance margin
            PYTH_BTC_ID,
            address(mockChainlink)
        );
        vm.stopPrank();

        // Set oracle prices — cast int256 BTC_PRICE to int64 only at the setPrice call boundary
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp);
        mockChainlink.setAnswer(BTC_PRICE);

        // Fund trader
        usdc.mint(trader, MARGIN * 100);
        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        vault.deposit(MARGIN * 100);
    }

    // ── openPosition() ────────────────────────────────────────────────────────

    function test_openPosition_happy() public {
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        assertEq(pos.trader, trader);
        assertEq(pos.pair, BTC_USDC);
        assertTrue(pos.isLong);
        assertEq(pos.margin, MARGIN);
        assertEq(pos.openedAtBlock, block.number);
    }

    function test_openPosition_emitsEvent() public {
        uint256 notional = PerpMath.computeNotional(MARGIN, LEVERAGE_10X);

        vm.expectEmit(false, true, true, false);
        emit IPerpEngine.PositionOpened(bytes32(0), trader, BTC_USDC, notional, 0, true, LEVERAGE_10X);

        vm.prank(trader);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
    }

    function test_openPosition_revertsInactivePair() public {
        bytes32 fakePair = keccak256("FAKE-USDC");
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.PairNotActive.selector, fakePair));
        engine.openPosition(fakePair, true, MARGIN, LEVERAGE_10X, emptyVaa);
    }

    function test_openPosition_revertsZeroMargin() public {
        vm.prank(trader);
        vm.expectRevert(IPerpEngine.ZeroMargin.selector);
        engine.openPosition(BTC_USDC, true, 0, LEVERAGE_10X, emptyVaa);
    }

    function test_openPosition_revertsExcessiveLeverage() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.LeverageExceedsMax.selector, 3000, 2500));
        engine.openPosition(BTC_USDC, true, MARGIN, 3000, emptyVaa);
    }

    function test_openPosition_revertsStaleOracle() public {
        // Both oracles stale — OracleLib cannot fall back to Chainlink when Pyth is stale
        mockPyth.setPrice(PYTH_BTC_ID, int64(BTC_PRICE), -8, block.timestamp - STALENESS_THRESHOLD - 1);
        mockChainlink.setUpdatedAt(block.timestamp - 1 hours - 1);

        vm.prank(trader);
        vm.expectRevert(OracleLib.BothOraclesUnavailable.selector);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
    }

    function test_openPosition_revertsWhenPaused() public {
        vm.prank(admin);
        engine.pause();

        vm.prank(trader);
        vm.expectRevert();
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
    }

    function test_openPosition_revertsDoubleOpen() public {
        vm.startPrank(trader);
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);

        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.PositionAlreadyExists.selector, trader, BTC_USDC));
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
        vm.stopPrank();
    }

    // ── closePosition() ───────────────────────────────────────────────────────

    function _openPosition() internal returns (bytes32 posId) {
        vm.prank(trader);
        posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
        // Advance block to satisfy same-block guard
        vm.roll(block.number + 1);
    }

    function test_closePosition_profitableLong() public {
        bytes32 posId = _openPosition();

        // Price rises 10% — arithmetic in int256 to avoid overflow, cast to int64 at boundary
        int256 newPriceUp = BTC_PRICE * 110 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(newPriceUp), -8, block.timestamp);
        mockChainlink.setAnswer(newPriceUp);

        uint256 balanceBefore = vault.getMarginBalance(trader);
        vm.prank(trader);
        int256 pnl = engine.closePosition(posId, emptyVaa);

        assertTrue(pnl > 0, "Long should profit on price rise");
        assertTrue(vault.getMarginBalance(trader) > balanceBefore, "Balance should increase");
    }

    function test_closePosition_lossLong() public {
        bytes32 posId = _openPosition();

        // Price falls 5% — arithmetic in int256, cast to int64 at boundary
        int256 newPriceDown = BTC_PRICE * 95 / 100;
        mockPyth.setPrice(PYTH_BTC_ID, int64(newPriceDown), -8, block.timestamp);
        mockChainlink.setAnswer(newPriceDown);

        vm.prank(trader);
        int256 pnl = engine.closePosition(posId, emptyVaa);

        assertTrue(pnl < 0, "Long should lose on price drop");
    }

    function test_closePosition_revertsNonExistent() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.PositionDoesNotExist.selector, bytes32(0)));
        engine.closePosition(bytes32(0), emptyVaa);
    }

    function test_closePosition_revertsUnauthorized() public {
        bytes32 posId = _openPosition();
        address hacker = makeAddr("hacker");

        vm.prank(hacker);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.UnauthorizedCaller.selector, hacker));
        engine.closePosition(posId, emptyVaa);
    }

    function test_closePosition_revertsSameBlock() public {
        vm.prank(trader);
        bytes32 posId = engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);

        // Do NOT advance block
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.SameBlockOpenClose.selector, posId));
        engine.closePosition(posId, emptyVaa);
    }

    function test_closePosition_clearsPosition() public {
        bytes32 posId = _openPosition();

        vm.prank(trader);
        engine.closePosition(posId, emptyVaa);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        assertEq(pos.trader, address(0), "Position should be deleted");
    }

    // ── addMargin() ───────────────────────────────────────────────────────────

    function test_addMargin_happy() public {
        bytes32 posId = _openPosition();
        uint256 extra = 500e6;

        vm.prank(trader);
        engine.addMargin(posId, extra);

        IPerpEngine.Position memory pos = engine.getPosition(posId);
        assertEq(pos.margin, MARGIN + extra);
    }

    function test_addMargin_revertsUnauthorized() public {
        bytes32 posId = _openPosition();
        address hacker = makeAddr("hacker");

        vm.prank(hacker);
        vm.expectRevert(abi.encodeWithSelector(IPerpEngine.UnauthorizedCaller.selector, hacker));
        engine.addMargin(posId, 100e6);
    }

    // ── pause/unpause ─────────────────────────────────────────────────────────

    function test_pause_blocksOpenButAllowsClose() public {
        bytes32 posId = _openPosition();

        vm.prank(admin);
        engine.pause();

        // Close still works while paused
        vm.prank(trader);
        engine.closePosition(posId, emptyVaa);

        // Open is blocked
        vm.prank(trader);
        vm.expectRevert();
        engine.openPosition(BTC_USDC, true, MARGIN, LEVERAGE_10X, emptyVaa);
    }
}
