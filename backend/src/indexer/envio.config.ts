/**
 * Envio Indexer configuration for ArcPerp.
 *
 * Indexes all four contract event streams and maintains these entities:
 *   - Position       (open/close lifecycle)
 *   - Trade          (every open/close event)
 *   - Liquidation    (every LiquidationExecuted event)
 *   - FundingEvent   (every FundingSettled event)
 *   - ProtocolStats  (singleton — total volume, fees, OI)
 *
 * Run: envio dev  (local)  |  envio deploy  (hosted)
 */

import { createConfig } from "@envio-dev/hyperindex";

// Deployment addresses — consumed from environment at index time
const PERP_ENGINE = (process.env.PERP_ENGINE_ADDRESS ?? "") as `0x${string}`;
const LIQ_ENGINE = (process.env.LIQUIDATION_ENGINE_ADDRESS ?? "") as `0x${string}`;
const FEE_COLLECTOR = (process.env.FEE_COLLECTOR_ADDRESS ?? "") as `0x${string}`;
const VAULT_MANAGER = (process.env.VAULT_MANAGER_ADDRESS ?? "") as `0x${string}`;
const DEPLOYMENT_BLOCK = parseInt(process.env.DEPLOYMENT_BLOCK ?? "0", 10);

// ── Event ABIs (minimal subset — only events we index) ───────────────────────

const PERP_ENGINE_EVENTS = [
  "event PositionOpened(bytes32 indexed positionId, address indexed trader, bytes32 indexed pair, uint256 notional, uint256 margin, uint256 entryPrice, bool isLong)",
  "event PositionClosed(bytes32 indexed positionId, address indexed trader, int256 pnl)",
  "event FundingSettled(bytes32 indexed pair, int256 fundingRate, uint256 timestamp)",
] as const;

const LIQ_ENGINE_EVENTS = [
  "event LiquidationExecuted(bytes32 indexed positionId, address indexed trader, address indexed liquidator, uint256 notional, uint256 liquidatorBonus, uint256 insuranceFundContribution, bool isPartial)",
] as const;

const FEE_COLLECTOR_EVENTS = [
  "event FeeCollected(address indexed trader, uint256 fee, bytes32 indexed pair)",
] as const;

// ── Envio config ──────────────────────────────────────────────────────────────

export default createConfig({
  networks: [
    {
      id: 5042002,
      rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.arc.testnet",
      startBlock: DEPLOYMENT_BLOCK,
    },
  ],

  contracts: [
    {
      name: "PerpEngine",
      abi: PERP_ENGINE_EVENTS,
      addresses: [{ network: 5042002, address: PERP_ENGINE }],
      events: [
        { name: "PositionOpened" },
        { name: "PositionClosed" },
        { name: "FundingSettled" },
      ],
    },
    {
      name: "LiquidationEngine",
      abi: LIQ_ENGINE_EVENTS,
      addresses: [{ network: 5042002, address: LIQ_ENGINE }],
      events: [{ name: "LiquidationExecuted" }],
    },
    {
      name: "FeeCollector",
      abi: FEE_COLLECTOR_EVENTS,
      addresses: [{ network: 5042002, address: FEE_COLLECTOR }],
      events: [{ name: "FeeCollected" }],
    },
  ],

  // ── Entity schema ───────────────────────────────────────────────────────────

  schema: `
    type Position @entity {
      id: ID!                   # positionId (bytes32 hex)
      trader: String!           # trader address
      pair: String!             # pair identifier
      notional: BigInt!         # USDC in 1e6
      margin: BigInt!
      entryPrice: BigInt!       # 1e8 precision
      isLong: Boolean!
      openedAt: Int!            # block timestamp
      closedAt: Int             # null if open
      pnl: BigInt               # null if open; signed int in 1e6
      isLiquidated: Boolean!
    }

    type Trade @entity {
      id: ID!                   # txHash-logIndex
      positionId: String!
      trader: String!
      pair: String!
      action: String!           # "OPEN" | "CLOSE"
      notional: BigInt!
      price: BigInt!
      pnl: BigInt               # null for opens
      timestamp: Int!
      blockNumber: Int!
    }

    type Liquidation @entity {
      id: ID!                   # positionId
      positionId: String!
      trader: String!
      liquidator: String!
      notional: BigInt!
      liquidatorBonus: BigInt!
      insuranceFundContribution: BigInt!
      isPartial: Boolean!
      timestamp: Int!
    }

    type FundingEvent @entity {
      id: ID!                   # pair-timestamp
      pair: String!
      fundingRate: BigInt!      # signed, 1e18 precision
      timestamp: Int!
    }

    type ProtocolStats @entity {
      id: ID!                   # singleton: "global"
      totalVolumeUsdc: BigInt!
      totalFeesUsdc: BigInt!
      totalLiquidations: Int!
      openInterestLong: BigInt!
      openInterestShort: BigInt!
      insuranceFund: BigInt!
      lastUpdated: Int!
    }
  `,

  // ── Event handlers ──────────────────────────────────────────────────────────

  eventHandlers: {
    "PerpEngine.PositionOpened": async ({ event, context }) => {
      const { positionId, trader, pair, notional, margin, entryPrice, isLong } = event.params;

      await context.Position.set({
        id: positionId,
        trader,
        pair,
        notional,
        margin,
        entryPrice,
        isLong,
        openedAt: event.block.timestamp,
        closedAt: null,
        pnl: null,
        isLiquidated: false,
      });

      await context.Trade.set({
        id: `${event.transaction.hash}-${event.logIndex}`,
        positionId,
        trader,
        pair,
        action: "OPEN",
        notional,
        price: entryPrice,
        pnl: null,
        timestamp: event.block.timestamp,
        blockNumber: event.block.number,
      });

      // Update protocol stats
      const stats = (await context.ProtocolStats.get("global")) ?? {
        id: "global",
        totalVolumeUsdc: 0n,
        totalFeesUsdc: 0n,
        totalLiquidations: 0,
        openInterestLong: 0n,
        openInterestShort: 0n,
        insuranceFund: 0n,
        lastUpdated: 0,
      };

      await context.ProtocolStats.set({
        ...stats,
        totalVolumeUsdc: stats.totalVolumeUsdc + notional,
        openInterestLong: isLong ? stats.openInterestLong + notional : stats.openInterestLong,
        openInterestShort: !isLong ? stats.openInterestShort + notional : stats.openInterestShort,
        lastUpdated: event.block.timestamp,
      });
    },

    "PerpEngine.PositionClosed": async ({ event, context }) => {
      const { positionId, trader, pnl } = event.params;

      const position = await context.Position.get(positionId);
      if (position) {
        await context.Position.set({
          ...position,
          closedAt: event.block.timestamp,
          pnl,
        });

        await context.Trade.set({
          id: `${event.transaction.hash}-${event.logIndex}`,
          positionId,
          trader,
          pair: position.pair,
          action: "CLOSE",
          notional: position.notional,
          price: 0n, // close price not in event — derive from PnL if needed
          pnl,
          timestamp: event.block.timestamp,
          blockNumber: event.block.number,
        });

        const stats = await context.ProtocolStats.get("global");
        if (stats) {
          await context.ProtocolStats.set({
            ...stats,
            openInterestLong: position.isLong
              ? stats.openInterestLong - position.notional
              : stats.openInterestLong,
            openInterestShort: !position.isLong
              ? stats.openInterestShort - position.notional
              : stats.openInterestShort,
            lastUpdated: event.block.timestamp,
          });
        }
      }
    },

    "LiquidationEngine.LiquidationExecuted": async ({ event, context }) => {
      const { positionId, trader, liquidator, notional, liquidatorBonus, insuranceFundContribution, isPartial } =
        event.params;

      await context.Liquidation.set({
        id: positionId,
        positionId,
        trader,
        liquidator,
        notional,
        liquidatorBonus,
        insuranceFundContribution,
        isPartial,
        timestamp: event.block.timestamp,
      });

      // Mark position as liquidated
      const position = await context.Position.get(positionId);
      if (position) {
        await context.Position.set({ ...position, isLiquidated: true });
      }

      const stats = await context.ProtocolStats.get("global");
      if (stats) {
        await context.ProtocolStats.set({
          ...stats,
          totalLiquidations: stats.totalLiquidations + 1,
          insuranceFund: stats.insuranceFund + insuranceFundContribution,
          lastUpdated: event.block.timestamp,
        });
      }
    },

    "PerpEngine.FundingSettled": async ({ event, context }) => {
      const { pair, fundingRate, timestamp } = event.params;

      await context.FundingEvent.set({
        id: `${pair}-${timestamp}`,
        pair,
        fundingRate,
        timestamp: Number(timestamp),
      });
    },

    "FeeCollector.FeeCollected": async ({ event, context }) => {
      const { fee } = event.params;

      const stats = await context.ProtocolStats.get("global");
      if (stats) {
        await context.ProtocolStats.set({
          ...stats,
          totalFeesUsdc: stats.totalFeesUsdc + fee,
          lastUpdated: event.block.timestamp,
        });
      }
    },
  },
});
