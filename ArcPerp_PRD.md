# ARCPERP
## Stablecoin Perpetual Futures DEX
### Built on Arc Network — The Financial Operating System of the Internet

---

| Field | Value | Field | Value |
|-------|-------|-------|-------|
| **Document Type** | Product Requirements Document | **Version** | 2.0 — Security Update |
| **Project Name** | ArcPerp | **Status** | Ready for Build |
| **Hackathon** | Arc Hackathon 2026 | **Chain** | Arc Testnet (Chain ID: 5042002) |
| **Category** | DeFi — Derivatives | **Lead Author** | Senior Blockchain Developer |
| **Prepared** | May 2026 | **Stack** | Solidity + TypeScript + React |

---

> **Executive Summary**
>
> ArcPerp is the first front-run-proof, stablecoin-settled perpetual futures DEX on Arc Network. By exploiting Arc's deterministic transaction ordering, sub-second finality, $0.01 USDC gas fees, and native Pyth/Stork oracle integrations, ArcPerp delivers institutional-grade derivatives trading accessible to any user in the world — with no MetaMask required, no ETH gas shocks, and no sandwich attacks. Traders deposit USDC margin from any chain via Circle's CCTP and App Kit Bridge, trade up to 25x leverage on stablecoin FX pairs, crypto perps, and tokenized asset perps, and receive settlement in USDC in under one second. This is the missing derivative layer for the Arc ecosystem and a credible challenger to Hyperliquid — built entirely on Circle's infrastructure.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Problem Statement](#2-problem-statement)
3. [Why Arc Network is the Only Chain That Makes This Work](#3-why-arc-network-is-the-only-chain-that-makes-this-work)
4. [Product Requirements](#4-product-requirements)
5. [Technical Architecture](#5-technical-architecture)
6. [Build Plan — Phase-by-Phase Execution](#6-build-plan--phase-by-phase-execution)
7. [Complete Technology Stack](#7-complete-technology-stack)
8. [Market Potential and Business Model](#8-market-potential-and-business-model)
9. [Hackathon Winning Strategy](#9-hackathon-winning-strategy)
10. [Security Architecture](#10-security-architecture)
11. [Risk Analysis and Mitigation](#11-risk-analysis-and-mitigation)
12. [Success Metrics](#12-success-metrics)
- [Appendix A: Key Contract Addresses](#appendix-a-key-contract-addresses-arc-testnet)
- [Appendix B: Glossary](#appendix-b-glossary)

---

## 1. Project Overview

### 1.1 What We Are Building

ArcPerp is a non-custodial, on-chain perpetual futures exchange deployed on Arc Network — Circle's purpose-built Layer-1 blockchain. A perpetual futures contract ("perp") is a derivative instrument that lets traders speculate on the price of an asset without expiry. Traders go Long if they believe the price will rise, or Short if they believe it will fall, using leverage up to 25x. Positions are held indefinitely, with a funding rate mechanism that anchors the perpetual price to the underlying spot price.

ArcPerp offers three initial trading pairs at launch:

- **EURC/USDC** — Euro stablecoin vs. USD stablecoin. The first on-chain stablecoin FX perp. Hedge euro exposure without a Bloomberg terminal.
- **BTC-USDC** — Bitcoin perpetual, USDC-settled. Familiar to crypto traders, now without ETH gas risk.
- **ETH-USDC** — Ethereum perpetual, USDC-settled. Completes the standard DeFi trader toolkit.

Everything is denominated, margined, and settled in USDC. Fees are USDC. Gas is USDC. There is no secondary token to manage. This is the cleanest, most intuitive derivatives trading experience on any blockchain.

### 1.2 The Core Innovation

> **Why Arc makes this possible where Ethereum cannot**
>
> Perpetual DEXes on Ethereum suffer three fatal problems: (1) MEV/sandwich attacks front-run every position open and close; (2) Gas fees spike to $50–$200 during liquidation cascades — the exact moment traders are most desperate; (3) 12-second block times mean liquidation engines are always stale. Arc's deterministic transaction ordering eliminates front-running at the protocol level. $0.01 USDC gas fees are fixed regardless of volatility. Sub-second finality means liquidation engines operate on fresh mark prices. ArcPerp is not Ethereum DeFi ported to a cheaper chain. It is a derivatives exchange designed from the ground up for the Arc architecture.

### 1.3 Project Vision

Our vision is to become the dominant derivatives layer of the Arc ecosystem and a benchmark for what stablecoin-native DeFi can achieve. Hyperliquid proved that traders will migrate to a purpose-built derivatives chain when the UX is superior. ArcPerp makes the same bet on Arc — but with Circle's $77B USDC ecosystem, compliance infrastructure, and enterprise partnerships already in place. ArcPerp becomes the gateway through which institutional and retail traders alike access leveraged exposure to stablecoins, crypto, and eventually tokenized real-world assets — all settled in USDC, all on Arc.

---

## 2. Problem Statement

### 2.1 The $7.5 Trillion Market No DeFi Protocol Serves Properly

Traditional FX options and derivatives are a $7.5 trillion daily market. Crypto perpetuals alone hit $3 trillion in annualized volume in 2025 on Hyperliquid alone. Despite this, existing DeFi derivatives protocols fail traders in three specific ways:

#### Problem 1: MEV and Front-Running Destroys Trader P&L

On every EVM chain with a public mempool, miners and searchers observe a trader's position open transaction before it lands on-chain. They insert their own transaction first ("front-run"), move the price against the trader, pocket the difference, and then let the trader's transaction execute at a worse price. This is called Maximal Extractable Value (MEV). Research from 2024 estimates MEV extraction costs DeFi traders over $1.3 billion annually. No existing perp DEX solves this — they either use commit-reveal schemes that are complex and slow, or rely on centralized sequencers that create counterparty risk.

#### Problem 2: Gas Volatility Makes Liquidations Catastrophic

On Ethereum, gas prices spike precisely when market volatility is highest — during liquidation cascades. A liquidator who needs to pay $180 in ETH gas to execute a $500 liquidation simply will not bother, leaving the protocol with bad debt. In the March 2020 ETH crash, $8 million in bad debt accumulated in MakerDAO because liquidators could not afford gas. The same dynamic played out in the Terra collapse, the FTX contagion, and every major crypto crash since. Protocols have spent years trying to solve this with keeper incentives, gas subsidies, and Dutch auction liquidations — none of which work reliably at scale.

#### Problem 3: Stablecoin FX Has No Derivatives Layer

With USDC, EURC, BRLA, MXNB, and PHPC now live on Arc, there is a multi-currency stablecoin ecosystem with genuine FX exposure. A business with EURC revenue needs to hedge EUR/USD exposure. An importer with USDC income needs to hedge against a strengthening Euro. TradFi FX options require a bank account, a Bloomberg terminal, and a minimum notional of $1 million. There is no on-chain derivative instrument for stablecoin FX. ArcPerp creates it.

### 2.2 Who Is Affected

| User Type | Current Pain | ArcPerp Solution |
|-----------|-------------|-----------------|
| Crypto trader | MEV front-running on GMX, dYdX costs 0.3–0.8% per trade implicitly | Deterministic ordering = zero front-running. Every trade executes at the shown price |
| DeFi protocol | Cannot hedge protocol treasury FX exposure without CEX dependency | EURC/USDC perp provides on-chain FX hedge natively in USDC |
| Institutional trader | No compliant, auditable, on-chain perp with USDC settlement | Arc's TRM/Elliptic compliance + USDC settlement + sub-second finality |
| Retail user | Intimidated by gas wallets, bridging, and DeFi complexity | Privy email login + Pimlico gas sponsorship = zero crypto knowledge required to start |
| Liquidation keeper | Unprofitable to liquidate on Ethereum when gas > liquidation bonus | $0.01 gas makes every liquidation above $20 profitable |

---

## 3. Why Arc Network is the Only Chain That Makes This Work

### 3.1 Deterministic Transaction Ordering — The Anti-MEV Architecture

Arc's Malachite BFT consensus engine uses deterministic, validator-ordered transaction processing. Unlike Ethereum's public mempool where searchers can observe and front-run pending transactions, Arc processes transactions in a fixed, predictable order determined by the validator set. This architectural difference is not a feature — it is a fundamental property of the chain that cannot be replicated by an application-level solution on another chain. For a perpetual DEX, this means:

- Every position open executes at the oracle mark price shown to the user. No slippage from front-running.
- Every liquidation executes at fair value. No sandwich attacks during cascades.
- Funding rate settlements are processed in deterministic order. No manipulation.

### 3.2 Predictable $0.01 USDC Gas Fees

Arc's EIP-1559-inspired EWMA fee smoothing mechanism targets a base fee of $0.01 per transaction. Fees are paid in USDC — not a volatile asset. This means:

- A liquidation keeper's cost is always $0.01 regardless of market volatility. Keeps the protocol solvent.
- A trader adding margin during a liquidation emergency pays $0.01. No ETH panic buy required.
- A new user's first transaction costs $0.01. Pimlico paymaster can sponsor this for zero-friction onboarding.

### 3.3 Sub-Second Deterministic Finality

Arc's consensus finalizes blocks in under one second with cryptographic certainty — no chain reorganizations possible. For a perp DEX this means mark price updates are reflected instantly, liquidation triggers execute before positions go deeply underwater, and cross-chain USDC deposits via CCTP settle in seconds rather than minutes.

### 3.4 Circle Native Infrastructure

Arc is built by Circle — the issuer of USDC. This gives ArcPerp access to infrastructure no other blockchain can offer natively:

- **USDC ERC-20** (`0x3600000000000000000000000000000000000000`): Native gas token. Margin currency. Settlement currency. All the same asset.
- **EURC** (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`): Euro stablecoin for the EURC/USDC pair. First on-chain euro FX perp.
- **CCTP TokenMessengerV2** (`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`): Accept USDC margin deposits from Ethereum, Base, Arbitrum, Solana — any chain CCTP supports.
- **Circle Gateway** (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`): Chain-abstracted USDC balance. A trader with USDC on 5 chains can fund one margin account in one step.
- **App Kit SDK**: `kit.bridge()`, `kit.swap()`, `kit.send()`, `kit.unifiedBalance()` — pre-built cross-chain payment flows in 5 lines of TypeScript.
- **TRM Labs + Elliptic**: Compliance screening natively integrated. ArcPerp can screen traders without building custom KYC.

### 3.5 Oracle Coverage — Pyth + Stork + Chainlink

Arc is the only testnet chain where all three oracle providers — Chainlink (battle-tested, decentralized), Pyth (pull-based, sub-second, equity/FX coverage), and Stork (ultra-low-latency, push-based) — are simultaneously deployed. ArcPerp uses all three in a tiered oracle architecture: Stork for real-time frontend price display (sub-100ms), Pyth for mark price settlement in contracts (sub-second, cryptographically verified), and Chainlink as a staleness fallback.

---

## 4. Product Requirements

### 4.1 Functional Requirements

#### 4.1.1 Trading Core

- Traders can open Long or Short positions on supported pairs
- Leverage range: 1x to 25x in 0.5x increments
- Minimum position size: 10 USDC notional
- Maximum position size per trader: 100,000 USDC notional (Phase 1)
- Positions are perpetual — no expiry date
- Funding rate settled every 8 hours between longs and shorts
- Traders can add margin, reduce margin, and partially close positions
- One-click full position close at current mark price

#### 4.1.2 Margin and Collateral

- Single collateral: USDC (6 decimals, ERC-20 interface)
- Cross-chain deposits via CCTP from Ethereum, Base, Arbitrum, Solana
- Multi-chain unified balance via Circle Gateway
- Auto-swap: deposit ETH, EURC, or any token — auto-converts to USDC via App Kit Swap
- Initial margin requirement: 4% of notional (25x max leverage)
- Maintenance margin requirement: 2.5% of notional
- Liquidation threshold: health factor below 1.0 (margin + unrealized PnL < maintenance margin)

#### 4.1.3 Oracle System

- Primary mark price: Pyth Network — caller must pass fresh VAA (Price Update Data) with every trade
- Real-time display: Stork WebSocket feed (sub-100ms) for frontend chart and ticker
- Index price: Pyth Data Streams aggregate of top 5 CEX prices, updated every 8 hours for funding rate
- Stale price guard: reject any transaction where Pyth price timestamp is > 30 seconds old
- Chainlink fallback: if Pyth price is stale, use Chainlink Data Feed — never use no price

#### 4.1.4 Liquidation Engine

- Permissionless: any address can call `liquidate()` on an underwater position
- Liquidation bonus: 1.5% of position notional paid to liquidator
- Insurance fund: receives remaining margin after liquidation bonus
- Partial liquidation: if position is only slightly underwater, close 50% first
- Socialized loss: if insurance fund is insufficient, losses are pro-rated across LPs
- Liquidation event: emits structured event indexed by Envio for monitoring

#### 4.1.5 Fees

- Taker fee: 0.05% of notional per trade (market orders)
- Maker fee: 0.02% of notional per trade (limit orders, Phase 2)
- Fee distribution: 95% to protocol treasury, 5% to insurance fund
- Funding rate: paid between longs and shorts — protocol takes 0% cut
- No withdrawal fee. No deposit fee. No hidden fees.

#### 4.1.6 User Onboarding

- Privy integration: sign up with email, Google, Apple, or MetaMask
- Pimlico paymaster: first 5 transactions gas-sponsored by protocol
- Circle Wallets: embedded wallet created automatically on signup
- Fiat on-ramp: Crossmint integration for credit card USDC purchase (Phase 2)

### 4.2 Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Transaction finality | < 1 second | Arc Malachite BFT guarantees deterministic sub-second finality |
| Gas cost per trade | < $0.02 USDC | Arc $0.01 base fee; complex trades may use 2 transactions |
| Oracle freshness | < 30 seconds | Pyth VAA staleness check in `PerpEngine.openPosition()` |
| Frontend price latency | < 100ms | Stork WebSocket feed directly to React state |
| Liquidation latency | < 5 seconds | TypeScript bot polls health factors every 5 seconds |
| Smart contract test coverage | > 95% | Foundry test suite — required for hackathon judges |
| Cross-chain deposit time | < 60 seconds | CCTP V2 burn-mint latency on Arc testnet |

---

## 5. Technical Architecture

### 5.1 Smart Contract Layer — Four Core Contracts

#### 5.1.1 VaultManager.sol

The financial foundation. Holds all USDC collateral. No business logic — just custody and accounting.

- Accepts USDC deposits via direct transfer, CCTP cross-chain (TokenMessengerV2: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`), and Gateway unified balance (`GatewayWallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9`)
- Tracks per-trader margin balance in `mapping(address => uint256)`
- Only callable by PerpEngine and LiquidationEngine — never by users directly
- Maintains `insuranceFund` balance — receives 5% of all fees and liquidation remainders
- Key functions: `deposit()`, `withdraw()`, `creditMargin()`, `debitMargin()`, `getMarginBalance()`, `getInsuranceFund()`
- Emits: `Deposited`, `Withdrawn`, `MarginCredited`, `MarginDebited`, `InsuranceFundUpdated`

#### 5.1.2 PerpEngine.sol

The business logic core. Manages every position from open to close.

- Position struct: `{ address trader, bytes32 pair, uint256 notional, uint256 entryPrice, uint256 margin, bool isLong, uint256 lastFundingTimestamp, int256 fundingAccrued }`
- `openPosition(bytes32 pair, bool isLong, uint256 margin, uint256 leverage, bytes[] calldata priceUpdateData)`: validates Pyth price freshness, computes notional, calls VaultManager.debitMargin(), stores position, calls FeeCollector.collectFee(), emits PositionOpened
- `closePosition(bytes32 positionId, bytes[] calldata priceUpdateData)`: computes realized PnL, settles funding, calls VaultManager.creditMargin() with PnL-adjusted amount, emits PositionClosed
- Funding rate computed as: `fundingRate = (markPrice - indexPrice) / indexPrice * fundingPeriodFactor`. Longs pay shorts if mark > index; shorts pay longs if index > mark.
- Calls `IPyth(pythAddress).updatePriceFeeds{value: fee}(priceUpdateData)` then `IPyth.getPrice(priceId)` for settlement price
- Stale price guard: `require(block.timestamp - price.publishTime <= 30 seconds)`

#### 5.1.3 LiquidationEngine.sol

Keeps the protocol solvent. Permissionless — anyone can call it.

- `liquidate(bytes32 positionId, bytes[] calldata priceUpdateData)`: callable by any address
- Health factor = `(margin + unrealizedPnL) / maintenanceMarginRequired`. Liquidation if < 1.0
- Partial liquidation: if health factor between 0.5 and 1.0, close 50% of position
- Full liquidation: if health factor < 0.5, close 100% of position
- Liquidation bonus: 1.5% of notional sent to `msg.sender` (the liquidator)
- Remaining margin (after bonus) sent to `VaultManager.insuranceFund`
- Emits `LiquidationExecuted(positionId, trader, liquidator, notional, bonus, type)`

#### 5.1.4 FeeCollector.sol

Protocol revenue management. Clean separation of concerns.

- `collectFee(address trader, uint256 notional, bytes32 pair)`: called by PerpEngine on every trade
- Fee = `notional * takerFeeRate (0.05%)`. Routes 95% to treasury, 5% to `VaultManager.insuranceFund()`
- `claimProtocolFees(address recipient)`: `onlyOwner`, withdraws accumulated treasury fees
- `getFeesByPair(bytes32 pair)`: returns cumulative fees per pair — used by analytics dashboard

### 5.2 Oracle Architecture — Tiered for Speed and Security

| Oracle | Purpose |
|--------|---------|
| **Stork (primary display)** | Ultra-low-latency WebSocket feed — < 100ms. Used only for frontend price chart, ticker, and estimated PnL calculation. Never used for settlement. |
| **Pyth Network (settlement)** | Pull-based, cryptographically-verified VAA. Callers fetch fresh price proof from Pyth Hermes API and pass it to every trade transaction. The contract verifies the proof on-chain. The only price used for position settlement, liquidation, and funding. |
| **Chainlink (fallback)** | Push-based, battle-tested data feeds. Used as fallback if Pyth price is stale (> 30 seconds). Ensures liquidation engine is never blocked by oracle downtime. |

### 5.3 Cross-Chain Deposit Flow — App Kit Integration

1. User connects via Privy (email or MetaMask). Embedded wallet created automatically.
2. User selects chain and deposit token (USDC on Ethereum, EURC on Arc, ETH on Base, etc.)
3. If same-chain USDC: `kit.send()` — direct transfer to VaultManager, credited immediately.
4. If cross-chain USDC: `kit.bridge()` — CCTP burn-and-mint. USDC arrives on Arc in < 60 seconds. VaultManager listens for CCTP MessageTransmitterV2 events and credits margin automatically.
5. If non-USDC token: `kit.swap()` — token auto-swapped to USDC on source chain, then bridged. Or swapped to USDC on Arc via StableFX.
6. If multi-chain USDC: `kit.unifiedBalance.deposit()` from each chain. `kit.unifiedBalance.spend()` routes aggregate to VaultManager.

### 5.4 Backend Services

**Liquidation Bot:** TypeScript process using viem `watchContractEvent()` subscribed to all PositionOpened/PositionClosed events. Maintains an in-memory sorted list of positions by health factor. Every 5 seconds, fetches Pyth mark prices for all active pairs (via Hermes HTTP API), computes health factors for all positions, and calls `LiquidationEngine.liquidate()` for any position below threshold. Bot operator earns 1.5% liquidation bonus — self-sustaining incentive.

**Funding Rate Keeper:** TypeScript cron running every 8 hours. Fetches current mark price from Pyth and computes aggregated index price from 5 CEX APIs (Binance, Coinbase, Kraken, OKX, Bybit). Calls `PerpEngine.settleFunding(bytes32[] pairs)` to distribute funding payments. Logs settlement amounts to database for analytics.

**Envio Data Indexer:** Envio configured to index all four contract event streams. Exposes GraphQL API consumed by the frontend for: open interest by pair, 24h volume, liquidation history, funding rate history, fee accumulation, and per-trader PnL history.

---

## 6. Build Plan — Phase-by-Phase Execution

### 6.1 Complete Timeline

| Phase | Description | Key Deliverables | Duration |
|-------|-------------|-----------------|----------|
| 1 | Environment setup | Arc testnet connected, wallets funded, toolchain installed | 1 day |
| 2 | Smart contracts | All 4 contracts written, tested (>95% coverage), deployed to Arc testnet | 4 days |
| 3 | Oracle wiring | Pyth settlement, Stork display, Chainlink fallback, funding index | 1 day |
| 4 | App Kit integration | Bridge, Swap, Send, Unified Balance all wired to VaultManager | 1 day |
| 5 | Backend services | Liquidation bot, funding cron, Envio indexer, price WebSocket server | 2 days |
| 6 | React frontend | Full trading terminal, live charts, margin panel, analytics dashboard | 4 days |
| 7 | Testing + polish | E2E tests, Foundry audit pass, demo video, judging pitch deck | 1 day |

> **Total build time:** 14 days from kickoff to hackathon submission — achievable with one senior developer. Smart contracts are the critical path. Frontend can overlap with backend services. Testing and polish happens continuously, with a dedicated final day for submission preparation.

### 6.2 Phase 1: Environment Setup (Day 1)

- Install: Node.js v22+, Foundry (forge + cast + anvil), viem v2, TypeScript 5
- Install: `npm install @circle-fin/app-kit @circle-fin/adapter-viem-v2 viem @circle-fin/developer-controlled-wallets`
- Configure `foundry.toml`: `[rpc_endpoints] arc_testnet = "https://rpc.testnet.arc.network"`
- Create Circle developer account at `console.circle.com` → API Key → Entity Secret
- Fund deployer wallet from `faucet.circle.com` (select Arc Testnet, request USDC + EURC)
- Create dev-controlled SCA wallet via Circle Wallets SDK for gas-sponsored contract deployment
- Verify connection: read USDC balance on Chain ID 5042002 via viem

### 6.3 Phase 2: Smart Contract Development (Days 2–5)

Build order is sequential — each contract depends on the previous one.

1. `VaultManager.sol`: USDC custody, margin accounting, insurance fund, CCTP event listener
2. `PerpEngine.sol`: Position management, Pyth oracle integration, funding rate, fee routing
3. `LiquidationEngine.sol`: Health factor computation, liquidation execution, bonus distribution
4. `FeeCollector.sol`: Fee collection, treasury routing, insurance fund contribution
5. Foundry test suite: >95% branch coverage. Critical paths: open→move→close, liquidation at threshold, cross-chain deposit
6. Deploy to Arc testnet using Circle Contracts SDK (Gas Station sponsors deployment gas)
7. Verify contracts on `testnet.arcscan.app`

### 6.4 Phase 3: Oracle Integration (Day 6)

- Import `IPyth.sol` interface from `pyth-sdk-solidity`
- Implement `updatePriceFeeds()` + `getPrice()` pattern in PerpEngine — caller provides VAA bytes
- Configure Stork WebSocket client in TypeScript — subscribe to EURC-USD, BTC-USD, ETH-USD
- Set up Chainlink fallback: if Pyth `publishTime` > 30 seconds, fallback to `AggregatorV3Interface`
- Write funding rate index fetcher: average 5 CEX REST APIs, update `PerpEngine.indexPrice()`

### 6.5 Phase 4: App Kit Integration (Day 7)

- Initialize App Kit: `const kit = new AppKit(); const adapter = new ViemV2Adapter(walletClient)`
- Implement bridge deposit: `kit.bridge({ from: Ethereum_Sepolia, to: Arc_Testnet, amount: X })`
- Implement swap deposit: `kit.swap({ tokenIn: ETH, tokenOut: USDC, amountIn: X })`
- Implement unified balance: `kit.unifiedBalance.deposit()` + `.spend()` → VaultManager
- Wire CCTP `MessageTransmitterV2` event listener to auto-credit margin on USDC arrival

### 6.6 Phase 5: Backend Services (Days 8–9)

- Liquidation bot: viem `watchContractEvent`, in-memory position store, 5-second health check loop
- Funding rate keeper: Node.js cron every 8 hours, Pyth + CEX aggregate, `settleFunding()` call
- Envio indexer: configure handler for all 4 contract events, expose GraphQL
- Price WebSocket server: Stork subscription → broadcast to frontend clients

### 6.7 Phase 6: React Frontend (Days 10–13)

- Privy wallet connect (email + social + MetaMask)
- Pimlico paymaster: sponsor first 5 transactions via ERC-4337
- TradingView Lightweight Charts: candlestick + volume + funding rate annotation
- Order panel: Long/Short toggle, size input, leverage slider, liquidation price calculator
- Positions panel: open positions with live unrealized PnL from Stork feed
- Margin panel: deposit/withdraw with all App Kit flows surfaced as UI modals
- Analytics: protocol stats from Envio — OI, volume, fees, insurance fund, top traders

### 6.8 Phase 7: Testing and Submission (Day 14)

- End-to-end test: new user, email sign-up, bridge deposit, open BTC-USDC long, close, withdraw
- Liquidation test: open highly leveraged position, move Pyth mock price, trigger liquidation bot
- Funding rate test: run 8-hour cron manually, verify settlement events on Envio
- Record 3-minute demo video: cover the full user journey and highlight Arc-specific advantages
- Prepare judging pitch: problem, solution, Arc advantages, technical depth, market potential

---

## 7. Complete Technology Stack

| Layer | Technology / Library / Contract |
|-------|--------------------------------|
| Blockchain | Arc Testnet — Chain ID 5042002, RPC: https://rpc.testnet.arc.network, Explorer: testnet.arcscan.app |
| Smart contract language | Solidity 0.8.26 — latest stable, includes custom error types, packed structs for gas optimization |
| Dev framework | Foundry — forge (compile/test/deploy), cast (contract interaction), anvil (local Arc fork for CI) |
| Deployment | Circle Contracts SDK (`@circle-fin/smart-contract-platform`) with Circle Dev-Controlled Wallet + Gas Station |
| Chain client (backend) | viem v2 with `@circle-fin/adapter-viem-v2` — typed, tree-shakeable, native Arc support |
| Cross-chain payments | `@circle-fin/app-kit` — Bridge (CCTP), Swap (StableFX), Send (direct), Unified Balance (Gateway) |
| Oracle: settlement | Pyth Network — `IPyth.sol`, pull-based VAA pattern, EVM contract addresses from pyth.network/price-feeds |
| Oracle: display | Stork — ultra-low-latency WebSocket, EVM contract on Arc from docs.stork.network |
| Oracle: fallback | Chainlink Data Feeds — `AggregatorV3Interface`, feed addresses from data.chain.link |
| Data indexing | Envio — event-driven, GraphQL API, configured for all 4 ArcPerp contract event streams |
| Account abstraction | ZeroDev (session keys for liquidation bot), Pimlico (paymaster for user gas sponsorship), ERC-4337 |
| User wallets | Privy (`@privy-io/react-auth`) — email, Google, Apple, MetaMask onboarding. Embedded wallet auto-created. |
| Frontend framework | React 18 + Vite + TypeScript — fast HMR, type-safe, easy Arc wallet integration |
| Charts | TradingView Lightweight Charts — professional candlestick, volume, and indicator support |
| Compliance | TRM Labs + Elliptic — wallet screening, integrated at deposit layer via Circle compliance partners |
| Testing | Foundry test suite + Anvil fork testing + Playwright E2E for frontend |
| USDC contract | `0x3600000000000000000000000000000000000000` (ERC-20, 6 decimals) |
| EURC contract | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (ERC-20, 6 decimals) |
| CCTP Messenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` (TokenMessengerV2, Domain 26) |
| Gateway | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` (GatewayWallet) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (signature-based approvals) |
| Multicall | `0xEb7cc06E3D3b5F9F9a5fA2B31B477ff72bB9c8b6` (Multicall3From, preserves msg.sender) |

---

## 8. Market Potential and Business Model

### 8.1 Total Addressable Market

| Market Segment | Size | ArcPerp Opportunity |
|---------------|------|-------------------|
| Crypto perpetuals (global) | $3T annualized (2025) | First MEV-free, USDC-settled perp DEX on a Circle-native chain |
| FX derivatives (traditional) | $7.5T daily notional | EURC/USDC perp — first on-chain stablecoin FX hedge instrument |
| DeFi derivatives TVL | $8.2B (2025 peak) | Position ArcPerp as primary derivatives venue for Arc ecosystem |
| Arc ecosystem (launch) | 100+ partners, $77B USDC | Protocol revenue from every USDC position opened by Arc ecosystem users |

### 8.2 Revenue Model

> **Protocol Fee Structure**
>
> Taker fee: 0.05% of notional per trade. Maker fee: 0.02% of notional (Phase 2, limit orders). Fee split: 95% to protocol treasury, 5% to insurance fund. At $10M daily volume: $5,000/day in taker fees alone = $1.825M annualized. At $100M daily volume (comparable to mid-tier perp DEX): $18.25M annualized. The insurance fund compounds over time, reducing protocol risk as TVL grows.

### 8.3 Hyperliquid Comparable Analysis

Hyperliquid launched as a purpose-built perp chain in 2023 with no token incentives and grew to $3T annualized volume by 2025. The thesis was simple: if the UX is categorically better (no MetaMask complexity, no ETH gas, no front-running), traders will come. ArcPerp makes the identical bet on Arc — but with three structural advantages Hyperliquid never had: Circle's $77B USDC native to the chain, enterprise compliance infrastructure already integrated, and BlackRock/Visa/Goldman already as network partners at launch.

### 8.4 Growth Path

- **Phase 1 (Hackathon):** 3 pairs (EURC/USDC, BTC-USDC, ETH-USDC), 25x max leverage, testnet
- **Phase 2 (Mainnet Launch):** Add commodity perps (Gold-USDC, Oil-USDC via Pyth), limit orders, LP vaults
- **Phase 3 (Scale):** Tokenized equity perps (AAPL-USDC, TSLA-USDC via Pyth), institutional API, governance
- **Phase 4 (Ecosystem):** ArcPerp as settlement layer for other Arc DeFi protocols — margin shared across protocols

---

## 9. Hackathon Winning Strategy

### 9.1 What Judges Look For

Arc hackathon judges evaluate on five dimensions: technical depth and use of Arc primitives, novelty and originality of the idea, real-world utility and market potential, code quality and completeness, and quality of the demo. ArcPerp is designed to excel on all five.

### 9.2 Technical Depth — Arc Primitive Usage

> **We use more Arc-native infrastructure than any competing submission**
>
> USDC native gas token + EURC trading pair + CCTP cross-chain deposits + Gateway unified balance + App Kit Bridge + App Kit Swap + App Kit Send + StableFX for EURC pricing + Pyth oracle + Stork oracle + Chainlink oracle + Pimlico paymaster + ZeroDev session keys + Privy onboarding + Envio indexer + TRM/Elliptic compliance. Every Arc primitive is used. This is not a DeFi protocol that happens to be on Arc — it is a protocol that only makes sense on Arc.

### 9.3 Novelty — What Has Never Been Built Before

- First on-chain stablecoin FX perpetual (EURC/USDC perp) — no existing protocol offers this
- First front-run-proof perp DEX using Arc's deterministic ordering as a core value prop
- First perp DEX where gas is always exactly $0.01 USDC — not a promise, a blockchain property
- First perp DEX built entirely on Circle infrastructure (USDC, CCTP, Gateway, App Kit)
- First perp DEX with Stork ultra-low-latency oracle for real-time display + Pyth for settlement

### 9.4 Demo Strategy — Show, Don't Tell

The demo must be a live, working product — not slides. The 3-minute demo flow:

1. Open browser. Go to `arcperp.app` (deployed testnet frontend).
2. Click 'Connect' → enter email → embedded wallet created in 10 seconds. No MetaMask. No seed phrase. No ETH.
3. Click 'Deposit' → bridge 100 USDC from Ethereum Sepolia via App Kit Bridge. Show CCTP transaction on `testnet.arcscan.app` settling in < 60 seconds.
4. Open a 10x Long position on BTC-USDC for 50 USDC margin. Show Pyth price proof being passed in the transaction. Show transaction confirmed in < 1 second on the explorer.
5. Open another position at high leverage. Show the liquidation bot triggering on a mock price move. Show the `LiquidationExecuted` event on Envio GraphQL. Show the liquidation keeper earning 1.5%.
6. Show the analytics dashboard: open interest, volume, fees collected, insurance fund, all live from Envio.
7. Show the Foundry test output: 100+ tests, 100% pass, >95% coverage.

### 9.5 Code Quality Standards

- All contracts use Solidity custom errors instead of string reverts — lower gas, better debuggability
- All storage variables packed into 32-byte slots where possible — reduces SLOAD costs by 50%
- Events emitted for every state change — enables comprehensive Envio indexing
- Foundry test coverage: unit tests for every function, integration tests for every user flow, fuzz tests for PnL computation and liquidation threshold
- NatSpec documentation on all public functions — judges should be able to read contract intent without external docs
- README with one-command deployment: `forge script DeployAll --rpc-url arc_testnet --broadcast`

### 9.6 Pitch Narrative

> **The one-paragraph pitch**
>
> Hyperliquid proved that if you build a derivatives exchange purpose-built for a chain, traders will come — $3 trillion in annual volume from a standing start. We built ArcPerp for Arc the same way: not a port of an Ethereum DEX, but a protocol that exploits every unique property of Arc. Deterministic ordering means zero front-running — the first time that's ever been architecturally guaranteed on a perp DEX. $0.01 USDC gas means liquidators never abandon the protocol during a crash. Sub-second finality means mark prices are always fresh. CCTP means any USDC holder on any chain can fund a margin account in 60 seconds. And the EURC/USDC perpetual is the first on-chain stablecoin FX derivative in history — a product that has no equivalent anywhere in DeFi. ArcPerp is what derivatives trading looks like when you build on the right foundation.

---

## 10. Security Architecture

Security is not a feature added at the end — it is the skeleton the entire protocol is built on. ArcPerp operates on testnet for the hackathon, meaning no real money is at risk today. However, the security model is designed exactly as it would be for a mainnet deployment carrying real funds. Every judge who is a senior blockchain engineer will review the security architecture before anything else.

> **Security principle: defence in depth**
>
> No single security measure is sufficient. ArcPerp uses layered defences — language-level protections (Solidity 0.8.26), pattern-level protections (Checks-Effects-Interactions), library-level protections (OpenZeppelin), architecture-level protections (access control, time-locks), and oracle-level protections (multi-source with staleness guards). An attacker must defeat all layers simultaneously. That is not achievable.

### 10.1 Reentrancy Attacks

#### What it is

The most famous smart contract exploit in history. The DAO hack of 2016 lost $60 million to a reentrancy attack. A malicious contract calls our withdraw function, and before our contract finishes updating the caller's balance to zero, the malicious contract calls withdraw again from inside the same transaction. It keeps re-entering, draining funds before the balance update ever completes.

#### Our prevention

- **Checks-Effects-Interactions (CEI) pattern** enforced on every function that moves funds. Step 1: check all preconditions. Step 2: update all internal state. Step 3: only then interact with external contracts or send funds. If the external call re-enters, all state is already updated — there is nothing left to exploit.
- **OpenZeppelin `ReentrancyGuard`** modifier applied to every external function in VaultManager.sol and PerpEngine.sol that touches funds. The `nonReentrant` modifier sets a lock flag at function entry and clears it at exit. Any re-entrant call during execution reverts immediately.
- Two independent layers: CEI as architectural discipline, ReentrancyGuard as automated enforcement. A developer mistake in one layer is caught by the other.

| Contract | Vulnerable Functions | Protection Applied |
|----------|---------------------|-------------------|
| VaultManager.sol | `withdraw()`, `deposit()` | `nonReentrant` + CEI: balance set to 0 before transfer |
| PerpEngine.sol | `closePosition()`, `addMargin()` | `nonReentrant` + CEI: position deleted before USDC sent |
| LiquidationEngine.sol | `liquidate()` | `nonReentrant` + CEI: position marked liquidated before bonus paid |
| FeeCollector.sol | `claimProtocolFees()` | `nonReentrant` + `onlyOwner` + CEI: balance zeroed before transfer |

### 10.2 Oracle Price Manipulation

#### What it is

If an attacker can feed our contract a fake price, they can open a position, manipulate the oracle to show a fake profit, and drain the vault. On Uniswap-style DEX oracles, a flash loan of $100M can move a spot price 1000% within a single block — enough to trigger fraudulent liquidations or fake profitable positions. This attack has drained hundreds of millions from DeFi protocols that relied on simple on-chain spot prices.

#### Our prevention

- We **never use DEX spot prices** or any on-chain single-source price. Every settlement price must come from Pyth Network's Verifiable Action Approval (VAA) — a cryptographically signed price proof aggregated from 15+ independent data sources. Forging a Pyth VAA requires breaking elliptic curve cryptography. It is computationally infeasible.
- **Staleness guard:** every function that reads a price asserts `block.timestamp - price.publishTime <= 30 seconds`. A price older than 30 seconds is rejected — the transaction reverts. No stale price is ever used for settlement.
- **Chainlink fallback:** if Pyth is genuinely unavailable (publisher outage), the contract falls back to Chainlink Data Feeds — an entirely independent oracle network. Two independent oracles must both fail simultaneously for price data to be unavailable.
- **Minimum price deviation guard:** if the Pyth price deviates more than 10% from the Chainlink price in the same block, the transaction is rejected. This detects oracle manipulation attempts even if an attacker somehow compromises one source.

### 10.3 Integer Overflow and Underflow

#### What it is

Old smart contracts had arithmetic bugs where numbers could wrap around. If a `uint256` variable at zero has 1 subtracted from it, it wraps to 2^256 - 1 — an astronomically large number. The batchOverflow bug in 2018 allowed attackers to generate essentially unlimited tokens from an ERC-20 contract.

#### Our prevention

- **Solidity 0.8.26** enforces automatic overflow and underflow checking at the language level. Any arithmetic operation that would overflow or underflow causes the entire transaction to revert automatically. No additional SafeMath library is required.
- All financial variables use `uint256` (non-negative) where appropriate. Signed integers (`int256`) are used only for PnL calculations where negative values are valid, and these are always bounded by the total margin deposited.

### 10.4 Unauthorised Access — Access Control

#### What it is

If any wallet can call the functions that move money, the protocol is worthless. A malicious actor calling `creditMargin()` directly to give themselves unlimited funds, or calling `claimProtocolFees()` to drain the treasury, would destroy the protocol instantly.

#### Our prevention

- **OpenZeppelin `AccessControl`** library manages all role-based permissions. Three roles defined: `VAULT_MANAGER_ROLE` (only PerpEngine and LiquidationEngine may call VaultManager fund-movement functions), `KEEPER_ROLE` (only authorised addresses may call `settleFunding()`), and `DEFAULT_ADMIN_ROLE` (only the protocol deployer may change roles or call admin functions).
- Every sensitive function has an explicit role check as its first operation. If the caller does not have the required role, the transaction reverts before any state is read or modified.
- The `liquidate()` function in LiquidationEngine is intentionally permissionless — any address can call it. However, `liquidate()` can only close positions and distribute funds according to the fixed formula — it cannot drain the vault, modify other positions, or access the insurance fund directly.
- **Constructor-time role assignment:** all roles are assigned in contract constructors at deployment. No role can be assigned after deployment without the `DEFAULT_ADMIN_ROLE`, which is held by a time-locked multisig.

### 10.5 Flash Loan Attacks

#### What it is

Flash loans let an attacker borrow unlimited funds within a single transaction — free of charge — as long as they repay within the same transaction. Attackers use this borrowed capital to manipulate prices on DEXes and exploit protocols that read those prices. Pancake Bunny ($45M), Harvest Finance ($34M), and Cheese Bank ($3.3M) were all drained this way.

#### Our prevention

- ArcPerp **never reads any price that can be moved by a flash loan**. Pyth VAA prices are aggregated off-chain across 15+ sources and signed by Pyth's guardian network. A flash loan cannot move a Pyth price feed — the price would need to move simultaneously across Binance, Coinbase, Kraken, OKX, Bybit, and a dozen other venues simultaneously.
- **Position lifecycle spans multiple transactions:** `openPosition()` is one transaction, `closePosition()` is a separate transaction. There is no single-transaction exploit path.
- **Minimum position hold time:** positions cannot be opened and closed within the same block. This eliminates any theoretical single-block arbitrage path.

### 10.6 Liquidation Manipulation

#### What it is

A sophisticated attacker could attempt to trigger premature liquidation of a healthy position — profiting from the 1.5% liquidation bonus on positions that should not have been liquidated. Alternatively, an attacker could attempt to prevent legitimate liquidations of their own underwater position to avoid losing their margin.

#### Our prevention

- Liquidation health factor is computed entirely inside the smart contract using a Pyth VAA that the liquidator must provide and the contract verifies cryptographically. The liquidator cannot influence the calculation — the math is deterministic and transparent on-chain.
- The same 30-second staleness guard applies to liquidation price reads. If the VAA is stale, the liquidation reverts.
- **Minimum deviation guard:** if the liquidation price deviates more than 10% from Chainlink's price in the same block, the liquidation is rejected.
- **Partial liquidation before full liquidation:** positions that are only slightly underwater are partially liquidated first, giving traders a chance to add margin before full liquidation.

### 10.7 Centralisation Risk — Admin Key Compromise

#### What it is

Many DeFi protocols have been rugged or exploited through compromised admin wallets. The Poly Network hack ($610M) and Ronin Bridge hack ($625M) were both caused by compromised admin keys.

#### Our prevention

- All admin functions are controlled by a **2-of-3 multisig wallet** — three independent hardware wallets, any two of which must sign to execute an admin action. No single compromised key can execute any admin function.
- **Time-lock on all parameter changes:** any change to fee rates, leverage limits, liquidation thresholds, or oracle addresses is queued for a 48-hour delay before taking effect. Users have time to exit if they disagree.
- **Minimal admin surface:** admin functions are limited to four operations only — `updateFeeRate()`, `updateLeverageLimit()`, `addTradingPair()`, and `upgradeOracleAddress()`. Every other system parameter is immutable after deployment.
- **Emergency pause:** a `pause()` function can halt all new position opens in case of a detected exploit. Existing positions can still be closed during a pause — traders are never locked in. Pause can be triggered by any one multisig signer. Unpause requires 2-of-3.

### 10.8 Testnet-Specific Security Considerations

> **Why testnet security still matters for the hackathon**
>
> On testnet, no real money exists. Faucet USDC has no real-world value. However, the security architecture must be identical to a mainnet deployment for two reasons. First, hackathon judges — who are senior blockchain engineers — will audit the contracts and specifically look for the vulnerabilities above. A missing `ReentrancyGuard` or unchecked oracle is an automatic disqualifier. Second, the entire point of testnet is to validate that the code is safe BEFORE real money goes in. Cutting corners on testnet security means the code can never safely go to mainnet.

- All testnet USDC obtained from `faucet.circle.com` — zero cost, no real value
- All testnet EURC obtained from the same faucet — select Arc Testnet and EURC token
- Gas for all testnet transactions is also testnet USDC from the faucet — zero real cost
- Contract deployments use Circle's Gas Station — gas fees sponsored automatically on Arc Testnet for dev-controlled wallets
- Security tests run against Anvil local fork of Arc Testnet — attack scenarios simulated safely before testnet deployment
- Every vulnerability above is tested with a specific Foundry attack test — the test attempts the attack and asserts it fails

### 10.9 Smart Contract Testing Requirements

| Test Category | Count Target | What It Proves |
|--------------|-------------|----------------|
| Unit tests | 40+ tests | Every public function behaves correctly for valid inputs |
| Revert tests | 20+ tests | Every function correctly rejects invalid inputs and unauthorised callers |
| Integration tests | 10+ tests | Full user flows work end-to-end: deposit → open → price move → close → withdraw |
| Reentrancy attack tests | 4 tests | Malicious contracts attempting re-entry are blocked on all four contracts |
| Oracle manipulation tests | 6 tests | Stale prices rejected, zero prices rejected, deviation guard triggers correctly |
| Access control tests | 12 tests | Every restricted function reverts when called by unauthorised addresses |
| Fuzz tests | 4 tests | PnL calculation, health factor, fee calculation, liquidation threshold — random inputs never produce impossible results |
| Liquidation scenario tests | 6 tests | Positions liquidated at correct threshold, bonus paid correctly, insurance fund credited |

> **Security summary for hackathon judges**
>
> ArcPerp implements seven distinct security layers: (1) Checks-Effects-Interactions pattern on all fund-movement functions; (2) OpenZeppelin `ReentrancyGuard` on all external functions; (3) Pyth VAA cryptographic price verification with 30-second staleness guard; (4) Chainlink fallback oracle with cross-source deviation guard; (5) OpenZeppelin `AccessControl` with minimum-privilege role assignments; (6) Flash loan immunity through multi-transaction position lifecycle and non-manipulable oracle sources; (7) 2-of-3 multisig admin with 48-hour time-lock on all parameter changes. Foundry test suite includes 100+ tests including explicit attack simulations for every vulnerability category above. Security is the architecture — not an afterthought.

---

## 11. Risk Analysis and Mitigation

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| Oracle failure (Pyth down) | High | Low | Chainlink fallback. Stale price guard. All trades rejected if no fresh price after 30s. |
| Insurance fund depletion | High | Low | Insurance fund = 5% of all fees + liquidation remainders. Socialized loss mechanism as final backstop. |
| Smart contract bug | Critical | Low | 95%+ Foundry test coverage. Fuzz testing. Deploy with time-lock admin functions. |
| CCTP deposit delay | Medium | Medium | User UI shows estimated arrival time. Bot monitors for stuck deposits with retry logic. |
| Low liquidation keeper interest | High | Low | $0.01 gas makes every position > $0.67 notional profitable to liquidate at 1.5% bonus. No keeper will skip. |
| Testnet instability | Medium | Medium | Use primary + 3 alternative RPC endpoints from docs. Fallback to QuickNode or Blockdaemon. |
| EURC/USDC pair low volatility | Medium | High | Stablecoin pairs have very low volatility — funding rates near zero, liquidations rare. Safe pair for v1. |

---

## 12. Success Metrics

### 12.1 Hackathon Submission Metrics

- Smart contracts: 4 contracts deployed to Arc testnet, all addresses verified on `testnet.arcscan.app`
- Test coverage: >95% branch coverage in Foundry test suite, output screenshot included in submission
- Pairs live: EURC/USDC, BTC-USDC, ETH-USDC all tradeable on frontend
- Cross-chain: at least one successful CCTP bridge deposit demonstrated in demo video
- Liquidation: liquidation bot triggered and `LiquidationExecuted` event shown in Envio
- Frontend: all 6 panels (chart, order, positions, margin, analytics, wallet) fully functional

### 12.2 Post-Hackathon Mainnet Targets (90 days)

| Metric | 60-Day Target | 90-Day Target |
|--------|--------------|--------------|
| Daily trading volume | $500K USDC | $5M USDC |
| Open interest | $1M USDC | $10M USDC |
| Registered traders | 500 wallets | 5,000 wallets |
| Protocol fee revenue | $250/day | $2,500/day |
| Insurance fund | $50K USDC | $200K USDC |
| Uptime | 99.5% | 99.9% |

---

## Appendix A: Key Contract Addresses (Arc Testnet)

| Contract / Protocol | Address |
|-------------------|---------|
| USDC (native gas + ERC-20) | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| USYC (tokenized treasury) | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| CCTP TokenMessengerV2 (Domain 26) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Gateway GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| StableFX FxEscrow | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3From | `0xEb7cc06E3D3b5F9F9a5fA2B31B477ff72bB9c8b6` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Arc Testnet RPC | `https://rpc.testnet.arc.network` |
| Arc Testnet Chain ID | `5042002` |
| Block Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Perpetual futures** | A derivative contract with no expiry date. Tracks the spot price via a funding rate paid between longs and shorts. |
| **Funding rate** | Periodic payment between long and short position holders. Positive rate = longs pay shorts. Anchors perp price to spot. |
| **Mark price** | The current fair market price used for PnL calculation and liquidation decisions. Sourced from Pyth oracle in ArcPerp. |
| **Index price** | The aggregated spot price from top CEX venues. Used to compute the funding rate direction and magnitude. |
| **Health factor** | Ratio of (margin + unrealized PnL) to maintenance margin required. Below 1.0 triggers liquidation. |
| **Insurance fund** | Protocol-owned USDC reserve. Covers bad debt when liquidation proceeds are insufficient to cover losses. |
| **MEV** | Maximal Extractable Value. Value extracted by miners/validators by reordering, inserting, or censoring transactions. |
| **Deterministic ordering** | Arc's property where transaction order is fixed by the validator set — eliminating MEV front-running. |
| **CCTP** | Cross-Chain Transfer Protocol. Circle's burn-and-mint mechanism for moving USDC natively across blockchains. |
| **VAA** | Verifiable Action Approval. Pyth Network's cryptographically-signed price proof, passed by callers to on-chain contracts. |
| **Paymaster** | ERC-4337 account abstraction component that sponsors gas fees on behalf of users. ArcPerp uses Pimlico. |
| **Session key** | ERC-4337 sub-key with limited permissions. ArcPerp's liquidation bot uses ZeroDev session keys. |
| **SCA** | Smart Contract Account. An ERC-4337 wallet with programmable transaction logic. |
| **Reentrancy attack** | An exploit where a malicious contract calls back into a vulnerable function before its state updates complete, draining funds repeatedly in a single transaction. |
| **Checks-Effects-Interactions (CEI)** | A Solidity security pattern: always check conditions first, update internal state second, and only then call external contracts. Prevents reentrancy. |
| **ReentrancyGuard** | OpenZeppelin library that sets a mutex lock on a function — any re-entrant call during execution reverts automatically. |
| **Flash loan attack** | An exploit using uncollateralised loans borrowed and repaid within one transaction to manipulate prices or drain protocols that use on-chain spot prices as oracles. |
| **Oracle manipulation** | An exploit where an attacker moves a price feed to trick a protocol into accepting a fraudulent price for settlement or liquidation. |
| **Staleness guard** | A smart contract check that rejects any oracle price whose timestamp is older than a defined threshold (30 seconds in ArcPerp). |
| **Integer overflow/underflow** | An arithmetic bug where a number exceeds its maximum or minimum value and wraps around. Solidity 0.8+ prevents this automatically. |
| **Access control** | Smart contract permission system that restricts which addresses can call which functions. ArcPerp uses OpenZeppelin AccessControl. |
| **Multisig** | A wallet requiring multiple independent signatures to execute a transaction. ArcPerp admin uses 2-of-3 multisig. |
| **Time-lock** | A smart contract mechanism that queues admin actions and enforces a waiting period (48 hours in ArcPerp) before they execute. |
| **Partial liquidation** | Closing only a portion of an underwater position (50%) when the health factor is between 0.5 and 1.0, before resorting to full liquidation. |
| **Socialized loss** | A mechanism where, if the insurance fund cannot cover bad debt, the remaining loss is distributed proportionally across all liquidity providers. |
| **Deviation guard** | A check that rejects a price if it differs by more than a defined percentage (10% in ArcPerp) from a second independent oracle source in the same block. |
| **Testnet** | A blockchain environment that mirrors mainnet exactly but uses tokens with no real-world value. Used for development, testing, and hackathons before mainnet launch. |
| **Fuzz testing** | An automated testing technique that feeds random, unexpected inputs into functions to discover edge cases and unexpected behaviour that hand-written tests might miss. |

---

*ArcPerp — Arc Hackathon 2026*
*Product Requirements Document v2.0 — Final (Security Update)*
*Confidential — For Hackathon Submission Only*
