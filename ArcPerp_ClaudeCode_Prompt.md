# ArcPerp — Claude Code Build Prompt
# Stablecoin Perpetual Futures DEX on Arc Network
# Hackathon Build — Full Stack

---

## CONTEXT AND MISSION

You are a senior blockchain engineer with deep expertise in Solidity, DeFi protocol design, and TypeScript. You are building **ArcPerp** — a stablecoin-settled perpetual futures DEX deployed on Arc Network (Circle's purpose-built L1 blockchain). This project is being submitted to the **Arc Hackathon 2026**.

This is a **testnet build**. All tokens (USDC, EURC) are free testnet tokens obtained from `faucet.circle.com`. No real money is involved. However, the security architecture must be **identical to a mainnet-ready deployment** — hackathon judges are senior blockchain engineers who will audit the contracts specifically for the vulnerabilities listed in the security section below.

Read this entire prompt before writing a single line of code. The build order matters. The security requirements are non-negotiable. Every contract address listed is a real, deployed testnet address — use them exactly as written.

---

## WHAT YOU ARE BUILDING

ArcPerp is a non-custodial perpetual futures exchange where:
- Traders deposit **USDC** as margin (from any chain via CCTP)
- They go **Long or Short** on supported trading pairs with up to **25x leverage**
- Positions are perpetual (no expiry) with an **8-hour funding rate** between longs and shorts
- Settlement, fees, and gas are all paid in **USDC**
- Liquidations are permissionless — any address can liquidate underwater positions and earn a **1.5% bonus**
- The protocol earns **0.05% taker fee** on every trade, split 95% treasury / 5% insurance fund

### Launch Trading Pairs
| Pair | Oracle Source | Description |
|------|--------------|-------------|
| EURC/USDC | Pyth (FX) + StableFX | First on-chain stablecoin FX perp |
| BTC-USDC | Pyth (Crypto) | Bitcoin perpetual, USDC-settled |
| ETH-USDC | Pyth (Crypto) | Ethereum perpetual, USDC-settled |

### Why Arc Makes This Possible
- **Deterministic transaction ordering** — zero MEV front-running, architecturally guaranteed
- **$0.01 USDC gas fees** — fixed, stable, makes every liquidation profitable for keepers
- **Sub-second finality** — mark prices are never stale, liquidations execute immediately
- **Native USDC + EURC + CCTP** — margin deposits from any chain, no bridge hacks
- **Pyth + Stork + Chainlink** — all three oracles deployed on Arc testnet simultaneously

---

## NETWORK CONFIGURATION

```
Chain Name:     Arc Testnet
Chain ID:       5042002
RPC URL:        https://rpc.testnet.arc.network
Block Explorer: https://testnet.arcscan.app
Faucet:         https://faucet.circle.com (select Arc Testnet)
Currency:       USDC (used for gas AND margin AND settlement)
```

### Deployed Contract Addresses (Arc Testnet — use exactly as written)
```
USDC ERC-20:              0x3600000000000000000000000000000000000000
EURC ERC-20:              0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
USYC (tokenized treasury):0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
CCTP TokenMessengerV2:    0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
CCTP MessageTransmitterV2:0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
Gateway GatewayWallet:    0x0077777d7EBA4688BDeF3E311b846F25870A19B9
StableFX FxEscrow:        0x867650F5eAe8df91445971f14d89fd84F0C9a9f8
Permit2:                  0x000000000022D473030F116dDEE9F6B43aC78BA3
Multicall3From:           0xEb7cc06E3D3b5F9F9a5fA2B31B477ff72bB9c8b6
CREATE2 Factory:          0x4e59b44847b379578588920cA78FbF26c0B4956C
```

---

## PROJECT STRUCTURE

Scaffold this exact directory structure before writing any code:

```
arcperp/
├── contracts/                          # Foundry project root
│   ├── foundry.toml
│   ├── .env.example
│   ├── src/
│   │   ├── VaultManager.sol
│   │   ├── PerpEngine.sol
│   │   ├── LiquidationEngine.sol
│   │   ├── FeeCollector.sol
│   │   ├── interfaces/
│   │   │   ├── IVaultManager.sol
│   │   │   ├── IPerpEngine.sol
│   │   │   ├── ILiquidationEngine.sol
│   │   │   └── IFeeCollector.sol
│   │   └── libraries/
│   │       ├── PerpMath.sol
│   │       └── OracleLib.sol
│   ├── test/
│   │   ├── unit/
│   │   │   ├── VaultManager.t.sol
│   │   │   ├── PerpEngine.t.sol
│   │   │   ├── LiquidationEngine.t.sol
│   │   │   └── FeeCollector.t.sol
│   │   ├── integration/
│   │   │   ├── FullTradeFlow.t.sol
│   │   │   └── CrossChainDeposit.t.sol
│   │   ├── security/
│   │   │   ├── ReentrancyAttack.t.sol
│   │   │   ├── OracleManipulation.t.sol
│   │   │   ├── AccessControl.t.sol
│   │   │   └── FlashLoanAttack.t.sol
│   │   ├── fuzz/
│   │   │   ├── FuzzPerpMath.t.sol
│   │   │   └── FuzzLiquidation.t.sol
│   │   └── mocks/
│   │       ├── MockPyth.sol
│   │       ├── MockChainlink.sol
│   │       ├── MockUSDC.sol
│   │       └── MaliciousReentrant.sol
│   └── script/
│       ├── Deploy.s.sol
│       └── DeployAll.s.sol
│
├── backend/                            # TypeScript backend services
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── liquidator/
│   │   │   ├── index.ts                # Liquidation bot entry point
│   │   │   ├── HealthMonitor.ts        # Monitors all open positions
│   │   │   └── LiquidationExecutor.ts  # Executes liquidations via viem
│   │   ├── keeper/
│   │   │   ├── index.ts                # Funding rate keeper entry point
│   │   │   └── FundingRateCalculator.ts
│   │   ├── priceServer/
│   │   │   ├── index.ts                # WebSocket price server
│   │   │   ├── StorkClient.ts          # Stork ultra-low-latency feed
│   │   │   └── PythClient.ts           # Pyth Hermes HTTP client
│   │   ├── indexer/
│   │   │   └── envio.config.ts         # Envio indexer configuration
│   │   └── lib/
│   │       ├── arc.ts                  # viem Arc testnet client
│   │       ├── contracts.ts            # Contract ABIs + addresses
│   │       └── appkit.ts               # Circle App Kit initialization
│
├── frontend/                           # React frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── TradingChart.tsx        # TradingView Lightweight Charts
│       │   ├── OrderPanel.tsx          # Long/Short order entry
│       │   ├── PositionsPanel.tsx      # Open positions with live PnL
│       │   ├── MarginPanel.tsx         # Deposit/withdraw modal
│       │   ├── AnalyticsDashboard.tsx  # Protocol stats from Envio
│       │   └── WalletButton.tsx        # Privy connect button
│       ├── hooks/
│       │   ├── usePositions.ts         # Fetch open positions from Envio
│       │   ├── usePrices.ts            # Subscribe to WebSocket price server
│       │   ├── useMarginBalance.ts     # Read VaultManager balance
│       │   └── useContracts.ts         # viem contract instances
│       ├── lib/
│       │   ├── arc.ts                  # viem public + wallet client for Arc
│       │   ├── appkit.ts               # App Kit (Bridge, Swap, Send)
│       │   └── pyth.ts                 # Fetch Pyth VAA for transactions
│       └── styles/
│           └── global.css
│
└── README.md
```

---

## PHASE 1: ENVIRONMENT SETUP

Before writing contracts, set up the environment completely.

### 1.1 foundry.toml
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.26"
optimizer = true
optimizer_runs = 200
via_ir = false

[rpc_endpoints]
arc_testnet = "${ARC_RPC_URL}"

[etherscan]
arc_testnet = { key = "placeholder", url = "https://testnet.arcscan.app/api" }
```

### 1.2 .env.example
```bash
# Arc Network
ARC_RPC_URL=https://rpc.testnet.arc.network
CHAIN_ID=5042002

# Deployer
PRIVATE_KEY=                          # Funded Arc testnet wallet

# Circle
CIRCLE_API_KEY=                       # From console.circle.com
CIRCLE_ENTITY_SECRET=                 # From console.circle.com

# Oracle endpoints
PYTH_HERMES_URL=https://hermes.pyth.network
STORK_WS_URL=                         # From docs.stork.network

# Pyth Price Feed IDs (mainnet IDs work on testnet)
PYTH_FEED_EURC_USD=0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb
PYTH_FEED_BTC_USD=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
PYTH_FEED_ETH_USD=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace

# Pimlico (gas sponsorship)
PIMLICO_API_KEY=

# Privy (wallet auth)
PRIVY_APP_ID=

# Envio
ENVIO_API_URL=
```

### 1.3 Install Dependencies

**Contracts:**
```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable
forge install pyth-network/pyth-sdk-solidity
forge install smartcontractkit/chainlink
```

**Backend:**
```bash
cd backend
npm install viem @circle-fin/app-kit @circle-fin/adapter-viem-v2 \
  @circle-fin/developer-controlled-wallets \
  @pythnetwork/hermes-client \
  ws typescript tsx dotenv
```

**Frontend:**
```bash
cd frontend
npm install viem @circle-fin/app-kit @circle-fin/adapter-viem-v2 \
  @privy-io/react-auth \
  lightweight-charts \
  @apollo/client graphql \
  react react-dom
npm install -D vite @vitejs/plugin-react typescript tailwindcss
```

---

## PHASE 2: SMART CONTRACTS

Build contracts in this exact order. Each contract depends on the one before it.

---

### CONTRACT 1: VaultManager.sol

**Purpose:** Custody of all USDC collateral. Pure accounting — no trading logic.

**Critical security requirements:**
- Every function that moves funds MUST use `nonReentrant` modifier from OpenZeppelin
- MUST follow Checks-Effects-Interactions: update all mappings BEFORE calling IERC20.transfer
- MUST use `AccessControl` — only `PERP_ENGINE_ROLE` and `LIQUIDATION_ENGINE_ROLE` can call `creditMargin` and `debitMargin`
- MUST emit events for every state change

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract VaultManager is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Roles
    bytes32 public constant PERP_ENGINE_ROLE = keccak256("PERP_ENGINE_ROLE");
    bytes32 public constant LIQUIDATION_ENGINE_ROLE = keccak256("LIQUIDATION_ENGINE_ROLE");

    // State
    IERC20 public immutable usdc;                          // 0x3600...0000
    mapping(address => uint256) private marginBalances;    // trader => USDC balance (6 decimals)
    uint256 public insuranceFund;                          // accumulated in USDC

    // Events — emit ALL of these
    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount, address recipient);
    event MarginCredited(address indexed trader, uint256 amount, string reason);
    event MarginDebited(address indexed trader, uint256 amount, string reason);
    event InsuranceFundContributed(uint256 amount);
    event InsuranceFundWithdrawn(uint256 amount, address recipient);

    // Custom errors (cheaper than string reverts)
    error InsufficientMargin(address trader, uint256 requested, uint256 available);
    error InsufficientInsuranceFund(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc, address _admin) {
        if (_usdc == address(0) || _admin == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── External: called by traders directly ──────────────────────────────

    /// @notice Deposit USDC margin. Trader must approve VaultManager first.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // CEI: Effects before Interactions
        marginBalances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
        // Interaction last
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw USDC margin. Only callable by the trader themselves.
    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 balance = marginBalances[msg.sender];
        if (balance < amount) revert InsufficientMargin(msg.sender, amount, balance);
        // CEI: Effects before Interactions
        marginBalances[msg.sender] = balance - amount;
        emit Withdrawn(msg.sender, amount, recipient);
        // Interaction last
        usdc.safeTransfer(recipient, amount);
    }

    // ── Internal: called by PerpEngine and LiquidationEngine only ─────────

    function debitMargin(address trader, uint256 amount, string calldata reason)
        external
        nonReentrant
        onlyRole(PERP_ENGINE_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = marginBalances[trader];
        if (balance < amount) revert InsufficientMargin(trader, amount, balance);
        // CEI
        marginBalances[trader] = balance - amount;
        emit MarginDebited(trader, amount, reason);
    }

    function creditMargin(address trader, uint256 amount, string calldata reason)
        external
        nonReentrant
        onlyRole(PERP_ENGINE_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        marginBalances[trader] += amount;
        emit MarginCredited(trader, amount, reason);
    }

    function contributeInsuranceFund(uint256 amount)
        external
        onlyRole(LIQUIDATION_ENGINE_ROLE)
    {
        insuranceFund += amount;
        emit InsuranceFundContributed(amount);
    }

    function withdrawInsuranceFund(uint256 amount, address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (insuranceFund < amount) revert InsufficientInsuranceFund(amount, insuranceFund);
        insuranceFund -= amount;
        emit InsuranceFundWithdrawn(amount, recipient);
        usdc.safeTransfer(recipient, amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getMarginBalance(address trader) external view returns (uint256) {
        return marginBalances[trader];
    }

    function getInsuranceFund() external view returns (uint256) {
        return insuranceFund;
    }
}
```

---

### CONTRACT 2: PerpMath.sol (library — build this before PerpEngine)

**Purpose:** All financial math in one auditable, testable library. Keep math out of the engine contract.

Build a library `PerpMath` with these pure functions:

```solidity
library PerpMath {
    uint256 constant PRICE_PRECISION = 1e8;      // Pyth prices have 8 decimals
    uint256 constant USDC_PRECISION  = 1e6;      // USDC has 6 decimals
    uint256 constant BASIS_POINTS    = 10_000;   // 100% = 10000 bps

    /// @return notional in USDC (6 decimals)
    function computeNotional(uint256 margin, uint256 leverage) pure returns (uint256);

    /// @return liquidationPrice in price precision (1e8)
    /// @param isLong true if long position
    function computeLiquidationPrice(
        uint256 entryPrice,
        uint256 leverage,
        bool isLong,
        uint256 maintenanceMarginBps  // e.g. 250 = 2.5%
    ) pure returns (uint256);

    /// @return unrealizedPnl — can be negative (int256)
    function computeUnrealizedPnl(
        uint256 entryPrice,
        uint256 currentPrice,
        uint256 notional,
        bool isLong
    ) pure returns (int256);

    /// @return healthFactor in 1e18 precision. < 1e18 = liquidatable
    function computeHealthFactor(
        uint256 margin,
        int256 unrealizedPnl,
        uint256 notional,
        uint256 maintenanceMarginBps
    ) pure returns (uint256);

    /// @return fundingPayment — positive means longs pay shorts
    function computeFundingPayment(
        uint256 markPrice,
        uint256 indexPrice,
        uint256 notional,
        uint256 fundingPeriodSeconds,
        bool isLong
    ) pure returns (int256);
}
```

Add overflow guards: every multiplication should check result > 0 and use unchecked{} blocks only where you have proved overflow is impossible. Add NatSpec documentation on every function.

---

### CONTRACT 3: OracleLib.sol (library — build before PerpEngine)

**Purpose:** Tiered oracle reads with staleness guards and cross-source deviation check.

```solidity
library OracleLib {
    uint256 constant STALENESS_THRESHOLD = 30 seconds;
    uint256 constant DEVIATION_THRESHOLD_BPS = 1000; // 10% max deviation between Pyth and Chainlink

    error StaleOraclePrice(uint256 publishTime, uint256 currentTime);
    error OraclePriceDeviation(uint256 pythPrice, uint256 chainlinkPrice, uint256 deviationBps);
    error ZeroOraclePrice();

    /// @notice Get verified mark price from Pyth
    /// @param pyth IPyth contract address
    /// @param priceId Pyth price feed ID
    /// @param priceUpdateData Fresh VAA bytes from Pyth Hermes
    /// @return price in 1e8 precision
    function getPythPrice(
        address pyth,
        bytes32 priceId,
        bytes[] calldata priceUpdateData
    ) internal returns (uint256 price);

    /// @notice Get Chainlink price as fallback
    /// @return price in 1e8 precision
    function getChainlinkPrice(address priceFeed) internal view returns (uint256 price);

    /// @notice Primary: try Pyth. If stale, try Chainlink. If both stale, revert.
    /// @notice Also check deviation between sources — revert if > 10%
    function getVerifiedPrice(
        address pyth,
        bytes32 pythPriceId,
        bytes[] calldata priceUpdateData,
        address chainlinkFeed
    ) internal returns (uint256 price);
}
```

---

### CONTRACT 4: PerpEngine.sol

**Purpose:** Core trading logic. Opens and closes positions. Computes PnL. Enforces leverage limits.

**Critical security requirements:**
- MUST use `nonReentrant` on `openPosition` and `closePosition`
- MUST call `OracleLib.getVerifiedPrice()` — never read price directly from Pyth without staleness check
- MUST use CEI pattern: debit margin THEN update position storage THEN emit event — never the other way
- MUST prevent same-block open+close (minimum hold = 1 block)
- MUST use PerpMath library for ALL financial calculations — no inline math

```solidity
contract PerpEngine is AccessControl, ReentrancyGuard {

    // Position struct — packed for gas efficiency
    struct Position {
        address trader;          // 20 bytes
        bytes32 pair;            // 32 bytes  (keccak256 of "BTC-USDC" etc.)
        uint128 notional;        // 16 bytes  (USDC, 6 decimals)
        uint128 margin;          // 16 bytes  (USDC, 6 decimals)
        uint128 entryPrice;      // 16 bytes  (1e8 precision)
        uint64  openedAtBlock;   // 8 bytes   (block number — for same-block guard)
        bool    isLong;          // 1 byte
    }

    // Storage
    mapping(bytes32 => Position) public positions;           // positionId => Position
    mapping(bytes32 => PairConfig) public pairConfigs;       // pair => config
    mapping(bytes32 => address) public chainlinkFeeds;       // pair => Chainlink feed address
    mapping(bytes32 => bytes32) public pythPriceIds;         // pair => Pyth price feed ID

    struct PairConfig {
        bool    active;
        uint16  maxLeverageBps;          // e.g. 2500 = 25x
        uint16  takerFeeBps;             // e.g. 5 = 0.05%
        uint16  makerFeeBps;             // e.g. 2 = 0.02%
        uint16  maintenanceMarginBps;    // e.g. 250 = 2.5%
    }

    // Key functions to implement:

    function openPosition(
        bytes32 pair,
        bool isLong,
        uint256 margin,           // USDC amount trader puts up
        uint256 leverageBps,      // e.g. 1000 = 10x
        bytes[] calldata priceUpdateData   // Fresh Pyth VAA — caller fetches from Hermes
    ) external nonReentrant returns (bytes32 positionId);

    function closePosition(
        bytes32 positionId,
        bytes[] calldata priceUpdateData
    ) external nonReentrant returns (int256 realizedPnl);

    function addMargin(
        bytes32 positionId,
        uint256 additionalMargin
    ) external nonReentrant;

    function settleFunding(bytes32[] calldata pairs) external;  // Called by keeper bot

    function getPosition(bytes32 positionId) external view returns (Position memory);

    function computePositionId(address trader, bytes32 pair, uint256 openedAtBlock)
        pure external returns (bytes32);
}
```

**Position ID:** `keccak256(abi.encodePacked(trader, pair, block.number))` — unique per trader per pair per block.

**openPosition flow (strict order):**
1. CHECK: pair active, leverage <= max, margin > 0, no existing position for this trader+pair
2. CHECK: oracle price valid (OracleLib.getVerifiedPrice — verifies Pyth VAA, checks staleness, checks Chainlink deviation)
3. COMPUTE: notional = PerpMath.computeNotional(margin, leverage)
4. COMPUTE: fee = notional * takerFeeBps / BASIS_POINTS
5. COMPUTE: liquidationPrice = PerpMath.computeLiquidationPrice(entryPrice, leverage, isLong, maintenanceMarginBps)
6. EFFECT: debit margin + fee from VaultManager
7. EFFECT: store Position in mapping
8. EFFECT: call FeeCollector.collectFee(trader, fee, pair)
9. EMIT: PositionOpened(positionId, trader, pair, notional, entryPrice, isLong, leverage)

**closePosition flow (strict order):**
1. CHECK: position exists, caller == position.trader OR caller has LIQUIDATION_ENGINE_ROLE
2. CHECK: block.number > position.openedAtBlock (same-block prevention)
3. CHECK: oracle price valid
4. COMPUTE: unrealizedPnl = PerpMath.computeUnrealizedPnl(entryPrice, currentPrice, notional, isLong)
5. COMPUTE: fundingAccrued (settle any outstanding funding)
6. COMPUTE: netPnl = unrealizedPnl - fundingAccrued
7. COMPUTE: finalAmount = margin + netPnl (if negative, cap at 0)
8. EFFECT: delete position from mapping
9. EFFECT: credit trader finalAmount via VaultManager.creditMargin
10. EMIT: PositionClosed(positionId, trader, realizedPnl, finalAmount)

---

### CONTRACT 5: LiquidationEngine.sol

**Purpose:** Keeps protocol solvent. Permissionless liquidations with bonuses.

**Critical security requirements:**
- `liquidate()` is intentionally `public` — no role restriction on who can call it
- BUT the price verification is mandatory and internal — liquidator provides proof but cannot influence calculation
- MUST prevent double-liquidation: check position exists FIRST, delete it BEFORE paying bonus
- Partial liquidation (50%) when health factor is 0.5–1.0; full liquidation when < 0.5

```solidity
contract LiquidationEngine is AccessControl, ReentrancyGuard {

    uint256 constant LIQUIDATION_BONUS_BPS = 150;       // 1.5%
    uint256 constant PARTIAL_LIQ_THRESHOLD = 0.5e18;    // health factor 0.5 in 1e18
    uint256 constant FULL_LIQ_THRESHOLD    = 1.0e18;    // health factor 1.0 in 1e18

    event LiquidationExecuted(
        bytes32 indexed positionId,
        address indexed trader,
        address indexed liquidator,
        uint256 notional,
        uint256 liquidatorBonus,
        uint256 insuranceFundContribution,
        bool isPartial
    );

    error PositionNotLiquidatable(bytes32 positionId, uint256 healthFactor);
    error PositionDoesNotExist(bytes32 positionId);

    function liquidate(
        bytes32 positionId,
        bytes[] calldata priceUpdateData
    ) external nonReentrant {
        // 1. CHECK: position exists
        // 2. CHECK: oracle price — same OracleLib.getVerifiedPrice as PerpEngine
        // 3. COMPUTE: healthFactor via PerpMath.computeHealthFactor
        // 4. CHECK: healthFactor < FULL_LIQ_THRESHOLD (else revert PositionNotLiquidatable)
        // 5. DETERMINE: partial or full liquidation
        // 6. COMPUTE: liquidatorBonus = notionalToClose * LIQUIDATION_BONUS_BPS / BASIS_POINTS
        // 7. EFFECT: close position (call PerpEngine.closePosition with LIQUIDATION_ENGINE_ROLE)
        // 8. EFFECT: send bonus to msg.sender (liquidator)
        // 9. EFFECT: send remainder to VaultManager.contributeInsuranceFund
        // 10. EMIT: LiquidationExecuted
    }

    function isLiquidatable(bytes32 positionId, uint256 currentPrice)
        external view returns (bool, uint256 healthFactor);
}
```

---

### CONTRACT 6: FeeCollector.sol

**Purpose:** Protocol revenue management. Collect fees, route to treasury and insurance fund.

```solidity
contract FeeCollector is AccessControl, ReentrancyGuard {

    bytes32 public constant PERP_ENGINE_ROLE = keccak256("PERP_ENGINE_ROLE");

    IERC20 public immutable usdc;
    address public treasury;
    IVaultManager public vaultManager;

    uint256 constant TREASURY_SHARE_BPS     = 9500; // 95%
    uint256 constant INSURANCE_FUND_BPS     = 500;  // 5%

    mapping(bytes32 => uint256) public cumulativeFeesByPair;
    uint256 public totalFeesCollected;

    event FeeCollected(address indexed trader, uint256 amount, bytes32 pair, uint256 treasuryAmount, uint256 insuranceAmount);
    event TreasuryFeeClaimed(address indexed recipient, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    function collectFee(address trader, uint256 feeAmount, bytes32 pair)
        external
        onlyRole(PERP_ENGINE_ROLE)
        nonReentrant;

    function claimProtocolFees(address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant;

    function getFeesByPair(bytes32 pair) external view returns (uint256);
}
```

---

### CONTRACT 7: Deploy.s.sol

Write a Foundry deploy script that:
1. Deploys VaultManager with USDC address `0x3600000000000000000000000000000000000000`
2. Deploys FeeCollector with VaultManager address
3. Deploys PerpEngine with VaultManager, FeeCollector, and IPyth addresses
4. Deploys LiquidationEngine with PerpEngine, VaultManager addresses
5. Grants `PERP_ENGINE_ROLE` to PerpEngine on VaultManager
6. Grants `LIQUIDATION_ENGINE_ROLE` to LiquidationEngine on VaultManager
7. Grants `PERP_ENGINE_ROLE` to PerpEngine on FeeCollector
8. Adds trading pairs: BTC-USDC, ETH-USDC, EURC-USDC with correct Pyth price IDs
9. Logs all deployed addresses to console
10. Saves deployed addresses to `deployments/arc_testnet.json`

Run with: `forge script script/DeployAll.s.sol --rpc-url arc_testnet --broadcast`

---

## PHASE 3: TEST SUITE

### Required test coverage: >95% branches, >100 total tests

#### Unit Tests (VaultManager.t.sol)
Test every public and external function:
- `deposit()`: happy path, zero amount revert, correct balance update, event emitted
- `withdraw()`: happy path, insufficient balance revert, CEI verified (use reentrancy mock), event emitted
- `debitMargin()`: only PERP_ENGINE_ROLE can call, correct amount deducted, revert on insufficient balance
- `creditMargin()`: only PERP_ENGINE_ROLE can call, correct amount added
- `contributeInsuranceFund()`: only LIQUIDATION_ENGINE_ROLE
- Access control: every restricted function reverts with `AccessControlUnauthorizedAccount` for unauthorized callers

#### Security Tests (ReentrancyAttack.t.sol)
Deploy `MaliciousReentrant.sol` — a contract that attempts to call `withdraw()` again from within its `receive()` function. Assert the attack transaction reverts with `ReentrancyGuardReentrantCall`.

```solidity
// MaliciousReentrant.sol
contract MaliciousReentrant {
    VaultManager vault;
    uint256 attackCount;

    function attack() external {
        vault.withdraw(10e6, address(this)); // attempt first withdraw
    }

    receive() external payable {
        if (attackCount < 3) {
            attackCount++;
            vault.withdraw(10e6, address(this)); // re-enter — must revert
        }
    }
}
```

#### Security Tests (OracleManipulation.t.sol)
- Assert `getVerifiedPrice` reverts when Pyth price timestamp > 30 seconds old
- Assert `getVerifiedPrice` reverts when Pyth price is 0
- Assert `getVerifiedPrice` reverts when Pyth and Chainlink prices deviate > 10%
- Assert `openPosition` reverts when priceUpdateData contains a stale VAA
- Assert `liquidate()` reverts when priceUpdateData is stale

#### Fuzz Tests (FuzzPerpMath.t.sol)
```solidity
function testFuzz_liquidationPriceNeverNegative(
    uint256 entryPrice,
    uint256 leverage,
    bool isLong
) public {
    // bound inputs to realistic ranges
    entryPrice = bound(entryPrice, 1e8, 1_000_000e8);
    leverage   = bound(leverage, 100, 2500); // 1x to 25x in bps
    uint256 liqPrice = PerpMath.computeLiquidationPrice(entryPrice, leverage, isLong, 250);
    assertGt(liqPrice, 0);
}

function testFuzz_healthFactorConsistency(...) ...
function testFuzz_pnlNeverExceedsNotional(...) ...
function testFuzz_feesNeverExceedMargin(...) ...
```

#### Integration Tests (FullTradeFlow.t.sol)
Full end-to-end scenarios on Anvil fork:
1. Trader deposits 1000 USDC → opens 10x BTC long → price rises 10% → closes → verify PnL = ~+1000 USDC minus fees
2. Trader deposits 100 USDC → opens 25x ETH long → price drops 4% → health factor < 1.0 → liquidation bot calls liquidate() → verify liquidator receives 1.5% bonus → verify insurance fund credited
3. Two traders on opposite sides → funding rate settlement → verify longs paid shorts
4. Attempt same-block open+close → verify revert

---

## PHASE 4: BACKEND SERVICES

### 4.1 arc.ts — viem Arc Testnet Client

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.ARC_RPC_URL),
});

export const walletClient = createWalletClient({
  chain: arcTestnet,
  transport: http(process.env.ARC_RPC_URL),
  account: privateKeyToAccount(`0x${process.env.PRIVATE_KEY}`),
});
```

### 4.2 Liquidation Bot (liquidator/index.ts)

The bot must:
1. On startup: fetch all `PositionOpened` events from PerpEngine since deployment using `publicClient.getLogs()`
2. On each new block (via `publicClient.watchBlocks()`): fetch any new `PositionOpened` or `PositionClosed` events and update in-memory position map
3. Every 5 seconds: for each open position, fetch fresh Pyth mark price via `HermesClient.getLatestPriceUpdates([feedId])`, compute health factor via `PerpMath` logic in TypeScript, if health factor < 1.0 → execute liquidation
4. Execute liquidation: call `liquidationEngine.write.liquidate([positionId, priceUpdateData])` using walletClient
5. Log all liquidations with position ID, trader, bonus earned, timestamp
6. Error handling: wrap every on-chain call in try/catch, retry failed liquidations up to 3 times with exponential backoff

```typescript
// Key imports
import { HermesClient } from "@pythnetwork/hermes-client";

const hermesClient = new HermesClient(process.env.PYTH_HERMES_URL);

async function fetchPythUpdateData(feedIds: string[]): Promise<`0x${string}`[]> {
  const updates = await hermesClient.getLatestPriceUpdates(feedIds);
  return updates.binary.data.map(d => `0x${d}` as `0x${string}`);
}
```

### 4.3 Funding Rate Keeper (keeper/index.ts)

Runs on a cron every 8 hours (use `node-cron`):
1. Fetch current Pyth mark prices for all active pairs
2. Fetch CEX index prices (Binance REST API: `/api/v3/ticker/price`) for BTC, ETH, EUR/USD
3. Compute funding rate: `(markPrice - indexPrice) / indexPrice * fundingPeriodFactor`
4. Call `perpEngine.write.settleFunding([activePairs])` with fresh Pyth VAA data
5. Log settlement amounts per pair

### 4.4 Price WebSocket Server (priceServer/index.ts)

```typescript
import { WebSocketServer } from "ws";

// Connect to Stork for ultra-low-latency prices (< 100ms)
// Subscribe to: BTCUSD, ETHUSD, EURCUSD
// On each price update → broadcast to all connected frontend clients:
// { pair: "BTC-USDC", price: "67432.18", timestamp: 1234567890, source: "stork" }

const wss = new WebSocketServer({ port: 8080 });
```

---

## PHASE 5: CIRCLE APP KIT INTEGRATION (appkit.ts)

```typescript
import AppKit from "@circle-fin/app-kit";
import { ViemV2Adapter } from "@circle-fin/adapter-viem-v2";

export const kit = new AppKit();

// Cross-chain USDC deposit from Ethereum Sepolia to Arc Testnet
export async function bridgeDeposit(walletClient: any, amountUsdc: string) {
  const adapter = new ViemV2Adapter(walletClient);
  return kit.bridge({
    from: { adapter, chain: "ETH-SEPOLIA" },
    to:   { adapter, chain: "ARC-TESTNET" },
    amount: amountUsdc,       // e.g. "100.00"
    token: "USDC",
  });
}

// Swap any token to USDC on Arc then deposit to vault
export async function swapAndDeposit(walletClient: any, tokenSymbol: string, amount: string) {
  const adapter = new ViemV2Adapter(walletClient);
  return kit.swap({
    from:     { adapter, chain: "ARC-TESTNET" },
    tokenIn:  tokenSymbol,
    tokenOut: "USDC",
    amountIn: amount,
  });
}

// Withdraw USDC from margin account to any wallet
export async function withdrawToWallet(walletClient: any, amount: string, recipient: string) {
  const adapter = new ViemV2Adapter(walletClient);
  return kit.send({
    from:      { adapter, chain: "ARC-TESTNET" },
    to:        recipient,
    amount,
    token:     "USDC",
  });
}
```

---

## PHASE 6: REACT FRONTEND

### Design Aesthetic
Dark theme. Professional trading terminal feel. Think Bloomberg meets Hyperliquid. Deep navy background (#0A0F1E), cyan/teal accents (#00D4C8), clean data-dense layouts. Typography: Space Mono for numbers and prices (monospace is essential for trading UIs), Inter for labels. Micro-animations on price changes (flash green on up, red on down).

### Core Components

#### App.tsx
```typescript
// Wrap with PrivyProvider (auth), ApolloProvider (Envio GraphQL), viem WagmiProvider
// Layout: top nav bar + left sidebar (pairs list) + main chart area + right panel (order entry)
// Bottom panel: open positions table
```

#### TradingChart.tsx
```typescript
import { createChart, CandlestickSeries } from "lightweight-charts";
// Subscribe to WebSocket price server for real-time OHLCV data
// Show: candlestick chart + volume histogram + funding rate countdown timer
// On price update: flash price in navbar (green/red based on direction)
```

#### OrderPanel.tsx
```typescript
// State: selectedPair, direction (long/short), marginAmount, leverageMultiple
// Real-time computed: notional, entryPrice (from Stork), liquidationPrice, fee amount
// On submit:
//   1. Fetch fresh Pyth VAA via HermesClient.getLatestPriceUpdates([feedId])
//   2. Call viem: perpEngine.write.openPosition([pair, isLong, margin, leverage, priceUpdateData])
//   3. Show transaction hash with arcscan.app link
//   4. Update positions panel
```

#### PositionsPanel.tsx
```typescript
// Query Envio GraphQL for open positions by trader address
// Subscribe to WebSocket price server for live unrealized PnL
// For each position: show pair, direction (LONG/SHORT badge), size, entry price,
//   mark price, unrealized PnL (green/red), liquidation price,
//   health factor bar (red when < 1.2), close button
// Close button: fetch Pyth VAA → call perpEngine.write.closePosition([positionId, priceUpdateData])
```

#### MarginPanel.tsx
```typescript
// Tabs: Deposit | Withdraw
// Deposit sub-tabs: Direct (same-chain USDC) | Bridge (cross-chain) | Swap (any token)
// Direct: USDC approve + VaultManager.deposit()
// Bridge: kit.bridge() flow with progress indicator (pending → confirming → credited)
// Swap: kit.swap() → auto-deposit on completion
// Withdraw: VaultManager.withdraw() with address input
// Show current margin balance + insurance fund size (read-only)
```

#### WalletButton.tsx
```typescript
import { usePrivy } from "@privy-io/react-auth";
// Show: "Connect" if not authenticated
// Show: truncated address + USDC balance if authenticated
// Privy config: loginMethods: ["email", "google", "wallet"]
// Pimlico paymaster: sponsor gas for first 5 transactions per new wallet
```

#### AnalyticsDashboard.tsx
```typescript
// Query Envio GraphQL:
// - Total open interest (sum of all position notionals)
// - 24h trading volume
// - Total protocol fees collected
// - Insurance fund balance
// - Top 10 traders by volume
// - Funding rate history chart (line chart per pair)
// - Liquidation history (last 20, with bonus earned)
```

### Envio GraphQL Schema (key queries)
```graphql
query OpenPositions($trader: String!) {
  positions(where: { trader: $trader, status: OPEN }) {
    id pair isLong notional margin entryPrice openedAt
  }
}

query ProtocolStats {
  protocolStats(id: "singleton") {
    totalVolume24h openInterest totalFeesCollected insuranceFund
  }
}

query RecentLiquidations {
  liquidations(orderBy: timestamp, orderDirection: desc, first: 20) {
    positionId trader liquidator bonus timestamp
  }
}
```

---

## PHASE 7: ENVIO INDEXER CONFIGURATION

Configure Envio to index all four contracts. Create `backend/src/indexer/envio.config.ts`:

Index these events:
- `VaultManager`: Deposited, Withdrawn, MarginCredited, MarginDebited, InsuranceFundContributed
- `PerpEngine`: PositionOpened, PositionClosed, FundingSettled, MarginAdded
- `LiquidationEngine`: LiquidationExecuted
- `FeeCollector`: FeeCollected

Build entity types: Position, Trade, Liquidation, FundingEvent, ProtocolStats (singleton with running totals).

ProtocolStats singleton must update on every FeeCollected event (add to totalVolume, totalFees) and every LiquidationExecuted event (add to totalLiquidations).

---

## SECURITY REQUIREMENTS CHECKLIST

Before submitting, verify every item:

### Smart Contract Security
- [ ] `ReentrancyGuard` applied to ALL functions in VaultManager, PerpEngine, LiquidationEngine, FeeCollector that touch funds or state
- [ ] CEI pattern followed in every function (check → state update → external call, in that order)
- [ ] OpenZeppelin `AccessControl` on all admin and protocol-internal functions
- [ ] `OracleLib.getVerifiedPrice()` called for every price read in PerpEngine and LiquidationEngine
- [ ] 30-second staleness guard enforced via `OracleLib`
- [ ] 10% cross-source deviation guard between Pyth and Chainlink in `OracleLib`
- [ ] Same-block open+close prevention in `PerpEngine.closePosition()`
- [ ] All custom errors defined — no `require(condition, "string")` — use `if (!condition) revert CustomError()`
- [ ] `SafeERC20.safeTransfer()` used for all USDC transfers — never raw `.transfer()` or `.call{value}`
- [ ] All structs packed to minimize storage slots (uint128/uint64 where uint256 is overkill)
- [ ] No `tx.origin` used anywhere — always `msg.sender`
- [ ] No `block.timestamp` used for randomness — only for staleness comparisons
- [ ] Emergency pause implemented in PerpEngine with `Pausable` from OpenZeppelin

### Test Coverage
- [ ] `forge coverage` shows >95% branch coverage
- [ ] Reentrancy attack test confirms MaliciousReentrant is blocked
- [ ] All oracle manipulation scenarios tested (stale, zero, deviated)
- [ ] All access control violations tested
- [ ] Fuzz tests run with 10,000 iterations minimum (`forge test --fuzz-runs 10000`)
- [ ] Integration test covers full trade lifecycle from deposit to withdrawal

### Architecture
- [ ] All four contract addresses saved to `deployments/arc_testnet.json` after deploy
- [ ] ABI files exported to `frontend/src/lib/abis/` for frontend use
- [ ] Liquidation bot tested manually: open underwater position → confirm bot liquidates within 10 seconds
- [ ] Funding rate keeper tested: call `settleFunding()` manually and verify events on Envio
- [ ] All three deposit paths tested: direct USDC, cross-chain bridge, swap-to-USDC

---

## BUILD ORDER SUMMARY

Follow this exact order — skipping steps will break the build:

```
1.  Environment: foundry.toml + .env + npm install (all three packages)
2.  Interfaces: IVaultManager, IPerpEngine, ILiquidationEngine, IFeeCollector
3.  Libraries: PerpMath.sol, OracleLib.sol
4.  Mocks: MockPyth.sol, MockChainlink.sol, MockUSDC.sol, MaliciousReentrant.sol
5.  VaultManager.sol + VaultManager.t.sol (unit + reentrancy tests pass before moving on)
6.  FeeCollector.sol + FeeCollector.t.sol
7.  PerpEngine.sol + PerpEngine.t.sol
8.  LiquidationEngine.sol + LiquidationEngine.t.sol
9.  Integration tests: FullTradeFlow.t.sol + CrossChainDeposit.t.sol
10. Security tests: ReentrancyAttack.t.sol + OracleManipulation.t.sol + AccessControl.t.sol + FlashLoanAttack.t.sol
11. Fuzz tests: FuzzPerpMath.t.sol + FuzzLiquidation.t.sol
12. forge coverage → must be >95% before deployment
13. Deploy: forge script DeployAll.s.sol --rpc-url arc_testnet --broadcast
14. Backend: arc.ts → contracts.ts → liquidator → keeper → priceServer
15. App Kit: appkit.ts integration + test all three deposit flows
16. Envio: configure indexer, verify GraphQL queries return data
17. Frontend: App.tsx → WalletButton → TradingChart → OrderPanel → PositionsPanel → MarginPanel → AnalyticsDashboard
18. E2E test: full user journey (connect → deposit → trade → liquidation → withdraw)
19. README: one-command setup, architecture diagram, deployed addresses, test output screenshot
```

---

## README REQUIREMENTS

The README must include:
1. One-paragraph project description
2. Architecture diagram (ASCII is fine)
3. Deployed contract addresses on Arc Testnet with arcscan.app links
4. Setup instructions: three commands to run locally (install, configure env, start)
5. Test output: `forge test --gas-report` screenshot or paste
6. Coverage output: `forge coverage` screenshot or paste showing >95%
7. Demo video link (3 minutes, covers full user journey)
8. Arc primitives used: list every Circle/Arc integration with explanation of why it was chosen
9. Security section: brief summary of all seven vulnerability categories and how each is addressed

---

## FINAL NOTES FOR CLAUDE CODE

- When writing Solidity: prefer `custom errors` over `require strings`. Prefer `immutable` over mutable state for addresses set in constructor. Prefer `calldata` over `memory` for function parameters that are not modified.
- When writing TypeScript: use strict TypeScript (`"strict": true` in tsconfig). Use `BigInt` for all on-chain numeric values — never JavaScript `number` for amounts. Type all viem contract interactions with generated ABI types.
- When writing React: no `any` types. All contract reads via `useContractRead` hook pattern. All writes with loading/error/success states surfaced to the UI.
- Do NOT use placeholder comments like `// TODO implement`. If a function needs to be built, build it completely.
- Do NOT skip error handling. Every `await` must have a try/catch. Every smart contract call must check the return value.
- After each phase, run `forge build` (contracts) or `tsc --noEmit` (TypeScript) and fix all errors before proceeding to the next phase.

This is a hackathon submission. The code must be complete, deployable, and impressive. Build it like you are shipping to production.
