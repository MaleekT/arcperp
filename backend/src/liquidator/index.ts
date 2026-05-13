/**
 * ArcPerp Liquidation Bot
 *
 * Monitors all open positions every 5 seconds and liquidates any that have
 * fallen below the maintenance margin threshold. Earns 1.5% bonus per liquidation.
 *
 * Flow:
 *   1. On startup: replay PositionOpened events from deployment block to rebuild position map
 *   2. Subscribe to new PositionOpened / PositionClosed events in real time
 *   3. Every 5s: fetch Pyth prices via HermesClient, compute health, liquidate the unhealthy
 */

import "dotenv/config";
import { HermesClient } from "@pythnetwork/hermes-client";
import { parseAbi, decodeEventLog, type Hex } from "viem";
import {
  createArcPublicClient,
  createArcWsClient,
  createArcWalletClient,
  CONTRACTS,
  PAIRS,
  PYTH_IDS,
  withRetry,
  validateEnv,
} from "../lib/arc.js";

validateEnv([
  "ARC_RPC_URL",
  "ARC_WS_URL",
  "BOT_PRIVATE_KEY",
  "PERP_ENGINE_ADDRESS",
  "LIQUIDATION_ENGINE_ADDRESS",
  "DEPLOYMENT_BLOCK",
]);

// ── ABIs (minimal — only what this bot needs) ─────────────────────────────────

const PERP_ENGINE_ABI = parseAbi([
  "event PositionOpened(bytes32 indexed positionId, address indexed trader, bytes32 indexed pair, uint256 notional, uint256 entryPrice, bool isLong, uint256 leverageBps)",
  "event PositionClosed(bytes32 indexed positionId, address indexed trader, int256 realizedPnl, uint256 finalAmount)",
  "function getPosition(bytes32 positionId) view returns (address trader, bytes32 pair, uint128 notional, uint128 margin, uint128 entryPrice, uint64 openedAtBlock, bool isLong)",
]);

const LIQ_ENGINE_ABI = parseAbi([
  "function liquidate(bytes32 positionId, bytes[] calldata priceUpdateData) external",
  "function isLiquidatable(bytes32 positionId, uint256 currentPrice) view returns (bool liquidatable, uint256 healthFactor)",
]);

// ── State ─────────────────────────────────────────────────────────────────────

/** Live set of open position IDs */
const openPositions = new Set<Hex>();

// ── Clients ───────────────────────────────────────────────────────────────────

const publicClient = createArcPublicClient();
const wsClient = createArcWsClient();
const walletClient = createArcWalletClient();
const hermesClient = new HermesClient("https://hermes.pyth.network");

const PYTH_FEED_IDS = [PYTH_IDS.BTC, PYTH_IDS.ETH, PYTH_IDS.EURC];

const DEPLOYMENT_BLOCK = BigInt(process.env.DEPLOYMENT_BLOCK ?? "0");

// ── Event replay ──────────────────────────────────────────────────────────────

async function replayHistory(): Promise<void> {
  console.log(`[liquidator] Replaying PositionOpened events from block ${DEPLOYMENT_BLOCK}...`);

  const latestBlock = await publicClient.getBlockNumber();
  const CHUNK = 2000n;

  for (let from = DEPLOYMENT_BLOCK; from <= latestBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < latestBlock ? from + CHUNK - 1n : latestBlock;

    const openedLogs = await publicClient.getLogs({
      address: CONTRACTS.perpEngine,
      event: parseAbi(["event PositionOpened(bytes32 indexed positionId, address indexed trader, bytes32 indexed pair, uint256 notional, uint256 entryPrice, bool isLong, uint256 leverageBps)"])[0],
      fromBlock: from,
      toBlock: to,
    });

    const closedLogs = await publicClient.getLogs({
      address: CONTRACTS.perpEngine,
      event: parseAbi(["event PositionClosed(bytes32 indexed positionId, address indexed trader, int256 realizedPnl, uint256 finalAmount)"])[0],
      fromBlock: from,
      toBlock: to,
    });

    for (const log of openedLogs) {
      const posId = log.topics[1] as Hex;
      openPositions.add(posId);
    }
    for (const log of closedLogs) {
      const posId = log.topics[1] as Hex;
      openPositions.delete(posId);
    }
  }

  console.log(`[liquidator] Replay complete — ${openPositions.size} open positions tracked`);
}

// ── Real-time event subscription ──────────────────────────────────────────────

function subscribeToEvents(): void {
  wsClient.watchContractEvent({
    address: CONTRACTS.perpEngine,
    abi: PERP_ENGINE_ABI,
    eventName: "PositionOpened",
    onLogs: (logs) => {
      for (const log of logs) {
        const posId = log.topics?.[1] as Hex | undefined;
        if (posId) {
          openPositions.add(posId);
          console.log(`[liquidator] New position: ${posId} (total: ${openPositions.size})`);
        }
      }
    },
  });

  wsClient.watchContractEvent({
    address: CONTRACTS.perpEngine,
    abi: PERP_ENGINE_ABI,
    eventName: "PositionClosed",
    onLogs: (logs) => {
      for (const log of logs) {
        const posId = log.topics?.[1] as Hex | undefined;
        if (posId) {
          openPositions.delete(posId);
        }
      }
    },
  });
}

// ── Price fetching via Pyth Hermes ────────────────────────────────────────────

interface PriceMap {
  BTC: bigint;
  ETH: bigint;
  EURC: bigint;
  vaa: `0x${string}`[];
}

async function fetchPrices(): Promise<PriceMap> {
  const priceUpdates = await hermesClient.getLatestPriceUpdates(PYTH_FEED_IDS as string[]);

  const getPrice = (id: string): bigint => {
    const feed = priceUpdates.parsed?.find((p) => `0x${p.id}` === id.toLowerCase());
    if (!feed) throw new Error(`Pyth price not found for feed ${id}`);
    const { price, expo } = feed.price;
    // Normalize to 1e8: if expo is -8 the price is already correct
    const normalized = BigInt(price) * 10n ** BigInt(8 + expo);
    return normalized;
  };

  const vaa = (priceUpdates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);

  return {
    BTC: getPrice(PYTH_IDS.BTC),
    ETH: getPrice(PYTH_IDS.ETH),
    EURC: getPrice(PYTH_IDS.EURC),
    vaa,
  };
}

// ── Liquidation scan ──────────────────────────────────────────────────────────

async function scanAndLiquidate(): Promise<void> {
  if (openPositions.size === 0) return;

  let prices: PriceMap;
  try {
    prices = await fetchPrices();
  } catch (err) {
    console.error("[liquidator] Failed to fetch Pyth prices:", err);
    return;
  }

  const positionIds = Array.from(openPositions);

  // Step 1: fetch position data to determine the pair for each positionId
  const positionData = await publicClient.multicall({
    contracts: positionIds.map((posId) => ({
      address: CONTRACTS.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "getPosition" as const,
      args: [posId] as const,
    })),
    allowFailure: true,
  });

  // Map pair ID → mark price
  const pairToPrice = new Map<string, bigint>([
    [PAIRS.BTC_USDC, prices.BTC],
    [PAIRS.ETH_USDC, prices.ETH],
    [PAIRS.EURC_USDC, prices.EURC],
  ]);

  // Step 2: isLiquidatable checks using the correct mark price per pair
  const checks = await publicClient.multicall({
    contracts: positionIds.map((posId, i) => {
      const res = positionData[i];
      let price = prices.BTC; // fallback for unknown pairs
      if (res?.status === "success") {
        const pos = res.result as { pair: `0x${string}` } | readonly unknown[];
        const pair = (Array.isArray(pos) ? (pos as readonly unknown[])[1] : (pos as { pair: `0x${string}` }).pair) as string;
        price = pairToPrice.get(pair) ?? prices.BTC;
      }
      return {
        address: CONTRACTS.liquidationEngine,
        abi: LIQ_ENGINE_ABI,
        functionName: "isLiquidatable" as const,
        args: [posId, price] as const,
      };
    }),
    allowFailure: true,
  });

  const toLiquidate: Hex[] = [];
  for (let i = 0; i < positionIds.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = checks[i]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const posId = positionIds[i]!;
    if (result.status === "success") {
      const [liquidatable] = result.result as [boolean, bigint];
      if (liquidatable) toLiquidate.push(posId);
    }
  }

  console.log(`[liquidator] Scanned ${positionIds.length} position(s) — ${toLiquidate.length} liquidatable`);

  if (toLiquidate.length === 0) return;

  console.log(`[liquidator] Found ${toLiquidate.length} liquidatable position(s)`);

  for (const posId of toLiquidate) {
    try {
      await withRetry(async () => {
        const hash = await walletClient.writeContract({
          address: CONTRACTS.liquidationEngine,
          abi: LIQ_ENGINE_ABI,
          functionName: "liquidate",
          args: [posId, prices.vaa],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`[liquidator] Liquidated ${posId} in tx ${receipt.transactionHash}`);
        openPositions.delete(posId);
      });
    } catch (err) {
      // Position may have been liquidated by another bot or closed by trader
      console.warn(`[liquidator] Failed to liquidate ${posId}:`, (err as Error).message);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[liquidator] Starting ArcPerp liquidation bot...");

  await replayHistory();
  subscribeToEvents();

  // Scan every 5 seconds
  const SCAN_INTERVAL_MS = 5_000;
  console.log(`[liquidator] Scanning every ${SCAN_INTERVAL_MS / 1000}s for liquidatable positions`);

  const scan = async () => {
    try {
      await scanAndLiquidate();
    } catch (err) {
      console.error("[liquidator] Scan error:", err);
    }
    setTimeout(scan, SCAN_INTERVAL_MS);
  };

  await scan();
}

main().catch((err) => {
  console.error("[liquidator] Fatal error:", err);
  process.exit(1);
});
