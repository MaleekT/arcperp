# ArcPerp

**Stablecoin Perpetual Futures DEX on Arc Network**  
Arc Hackathon 2026 — Built entirely on Circle infrastructure.

---

## What Is ArcPerp

ArcPerp is the first front-run-proof, stablecoin-settled perpetual futures DEX on Arc Network. Traders deposit USDC from any chain, go Long or Short on EURC/USDC, BTC-USDC, and ETH-USDC with up to 25x leverage, and receive settlement in USDC in under one second.

**Why Arc makes this possible:**
- Deterministic transaction ordering → zero MEV front-running, architecturally guaranteed
- $0.01 USDC gas → every liquidation is profitable for keepers regardless of volatility
- Sub-second finality → mark prices are always fresh, liquidations execute immediately
- Native USDC + EURC + CCTP → margin from any chain, no bridge hacks

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     React Frontend (Vite)                    │
│  TradingChart │ OrderPanel │ PositionsPanel │ MarginPanel    │
└──────────────────────┬──────────────────────────────────────┘
                       │ viem + Privy + App Kit
┌──────────────────────▼──────────────────────────────────────┐
│                  Arc Testnet (Chain ID 5042002)              │
│                                                              │
│  VaultManager ──► PerpEngine ──► LiquidationEngine          │
│       │               │                   │                 │
│       └───────────────▼───────────────────┘                 │
│                  FeeCollector                                │
│                                                              │
│  Oracles: Pyth (settlement) │ Stork (display) │ Chainlink   │
└──────────────────────┬──────────────────────────────────────┘
                       │ events
┌──────────────────────▼──────────────────────────────────────┐
│            Backend Services (TypeScript)                     │
│  Liquidation Bot │ Funding Keeper │ Price WS Server          │
│  Envio Indexer (GraphQL)                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Deployed Contracts (Arc Testnet)

| Contract | Address |
|----------|---------|
| VaultManager | _after deployment_ |
| PerpEngine | _after deployment_ |
| LiquidationEngine | _after deployment_ |
| FeeCollector | _after deployment_ |

See `contracts/deployments/arc_testnet.json` after running deploy script.

**Arc-native contracts used:**
| Contract | Address |
|----------|---------|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CCTP TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| Gateway GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |

---

## Quick Start

```bash
# 1. Install
cd contracts && forge install
cd ../backend && npm install
cd ../frontend && npm install

# 2. Configure
cp contracts/.env.example contracts/.env
# Fill in PRIVATE_KEY, CIRCLE_API_KEY, PRIVY_APP_ID, PIMLICO_API_KEY

# 3. Run
forge test --fuzz-runs 10000          # Run full test suite
forge script script/DeployAll.s.sol --rpc-url arc_testnet --broadcast
cd backend && npm run liquidator      # Start liquidation bot
cd frontend && npm run dev            # Start frontend
```

---

## Test Coverage

```
# Run after: forge test --gas-report
# Coverage: forge coverage
# Target: >95% branch coverage
```

---

## Arc Primitives Used

| Primitive | Purpose |
|-----------|---------|
| USDC native gas token | All fees and gas in one asset — no ETH required |
| EURC | First on-chain stablecoin FX perpetual (EURC/USDC pair) |
| CCTP TokenMessengerV2 | Cross-chain USDC margin deposits from any chain |
| Gateway GatewayWallet | Unified multi-chain USDC balance for deposits |
| App Kit Bridge/Swap/Send | Pre-built cross-chain deposit flows in the UI |
| Pyth Network | Pull-based settlement oracle with VAA verification |
| Stork | Sub-100ms real-time price display on frontend |
| Chainlink | Fallback oracle + deviation guard |
| Privy | Email/social/MetaMask onboarding — no seed phrase |
| Pimlico | ERC-4337 paymaster — first 5 txs gas-free for new users |
| ZeroDev | Session keys for liquidation bot |
| Envio | Event indexer — GraphQL API for all protocol analytics |
| TRM/Elliptic | Compliance screening at deposit layer |

---

## Security

Seven defence-in-depth layers:
1. Checks-Effects-Interactions on all fund-movement functions
2. OpenZeppelin `ReentrancyGuard` on all external fund functions
3. Pyth VAA cryptographic price verification + 30s staleness guard
4. Chainlink fallback + 10% cross-source deviation guard
5. OpenZeppelin `AccessControl` with minimum-privilege roles
6. Flash loan immunity (multi-transaction lifecycle + non-manipulable oracle)
7. Emergency pause on PerpEngine (new opens halt; existing positions can still close)

---

## Demo Video

_Link added before submission_

---

*ArcPerp — Arc Hackathon 2026*
