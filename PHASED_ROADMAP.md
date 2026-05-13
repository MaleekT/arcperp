# ArcPerp Phased Build Roadmap

This is the agreed planning document for improving ArcPerp in controlled phases.
Do not treat this as an implementation checklist to complete all at once. Each phase
should be designed, implemented, tested, reviewed, committed, and deployed before the
next phase begins.

## Phase 1: Trading Correctness

Goal: make trade execution honest and predictable before adding more features.

- Fix oracle settlement so Pyth is the canonical execution price.
- Remove silent fallback to seeded mock prices for trade execution.
- Handle Pyth update fees correctly in contract calls.
- Add contract-level slippage guards for market orders.
- Fix Solidity/frontend/backend ABI and event mismatches.
- Generate or synchronize ABIs from compiled contract artifacts.
- Add tests for open, close, stale oracle, bad oracle, slippage reverts, duplicate positions, and mocked fallback attempts.

Acceptance gate:

- The UI preview price and on-chain entry price are within the user-approved tolerance.
- A hardcoded/mock price cannot become the fill price.
- `forge test`, frontend typecheck/build, and backend typecheck pass.

## Phase 2: Backend, Bots, and Config

Goal: make the live testnet system operational and consistent.

- Centralize chain IDs, pair IDs, Pyth IDs, contract addresses, and deployment block.
- Fix duplicated or inconsistent pair/feed config across contracts, frontend, and backend.
- Fix liquidator screening so each pair uses its own price.
- Make Render service layout explicit for price server, liquidator, keeper, and oracle updater.
- Add operational logs/status for price server, liquidator, keeper, and oracle freshness.

Acceptance gate:

- All backend services can run with documented env vars.
- Liquidator handles BTC, ETH, and EURC positions correctly.
- Deployment config matches Vercel and Render production env vars.

## Phase 3: Reliable Order Features

Goal: add useful perp DEX order controls without pretending browser-only automation is reliable.

- Add backend-backed limit orders.
- Add take-profit and stop-loss orders.
- Add reduce-only orders.
- Add partial close controls: 25%, 50%, 75%, 100%.
- Add add/remove margin flows.
- Add order history and trade history.

Acceptance gate:

- Orders execute or fail with clear reasons.
- Orders survive page refresh and closed browser tabs.
- Position history and order state match on-chain events.

## Phase 4: Pro Trading Features

Goal: move toward a Hyperliquid/Aster-style testnet trading experience.

- Add stop market and stop limit orders.
- Add trailing stops.
- Add TWAP orders.
- Add scale orders.
- Add time-in-force controls: GTC, IOC, FOK.
- Add post-only mode where applicable.
- Add advanced chart controls and a better positions/orders workspace.
- Add portfolio/risk analytics: open interest, skew, funding, insurance fund, liquidations, oracle age.

Acceptance gate:

- Advanced order types have tests or simulations.
- UI clearly shows order type, trigger condition, execution price rules, and failure states.

## Phase 5: Deploy, Verify, and Polish

Goal: ship the improved system and verify it live.

- Deploy contracts to Arc testnet if Phase 1 requires a migration.
- Update Vercel environment variables.
- Update Render environment variables and services.
- Push GitHub commits in small phase branches or commits.
- Verify live market orders, limit orders, positions, closing, liquidation status, and price display.
- Improve UI polish after the core trading path is proven correct.

Acceptance gate:

- Live site matches the deployed contract addresses.
- Price server and bots are healthy.
- A fresh wallet can deposit, open, view, close, and review history without hidden state.

## Access and Inputs Needed

- GitHub repository access or confirmation that local Git is authenticated to push.
- Vercel project access, or confirmation that Vercel CLI is authenticated locally.
- Render account/service access, or confirmation that Render CLI/API access is available.
- Current production environment variables from Vercel and Render, with secrets shared only through the dashboards or local ignored `.env` files.
- Arc testnet deployer wallet address and funded balance.
- Keeper/liquidator bot wallet addresses and funded balances.
- Decision on whether old testnet positions can be abandoned after contract migration.
- Confirmation of preferred deployment style: migrate contracts in place where possible, or redeploy a clean testnet stack.

## Working Rule

For each phase:

1. Inspect current code and deployed state.
2. Propose the exact implementation plan.
3. Make scoped changes.
4. Run tests and builds.
5. Commit and push.
6. Deploy if needed.
7. Verify live behavior before moving to the next phase.
