/**
 * ArcPerp Funding Rate Keeper
 *
 * Settles funding rates every 8 hours for all active pairs.
 * Fetches CEX aggregate index prices (Binance, Coinbase, Kraken),
 * computes the median, and calls PerpEngine.setIndexPrice + settleFunding.
 */

import "dotenv/config";
import cron from "node-cron";
import { keccak256, parseAbi, toBytes } from "viem";
import {
  createArcPublicClient,
  createArcWalletClient,
  CONTRACTS,
  withRetry,
  validateEnv,
} from "../lib/arc.js";

validateEnv(["ARC_RPC_URL", "BOT_PRIVATE_KEY", "PERP_ENGINE_ADDRESS"]);

// ── ABIs ──────────────────────────────────────────────────────────────────────

const PERP_ENGINE_ABI = parseAbi([
  "function settleFunding(bytes32[] calldata pairs) external",
  "function setIndexPrice(bytes32 pair, uint256 price) external",
]);

// ── Pair IDs — mirrors Solidity: keccak256(abi.encodePacked("BTC-USDC")) ─────

const PAIR_ID = {
  BTC_USDC: keccak256(toBytes("BTC-USDC")) as `0x${string}`,
  ETH_USDC: keccak256(toBytes("ETH-USDC")) as `0x${string}`,
  EURC_USDC: keccak256(toBytes("EURC-USDC")) as `0x${string}`,
} as const;

const ALL_PAIRS = [PAIR_ID.BTC_USDC, PAIR_ID.ETH_USDC, PAIR_ID.EURC_USDC];

// ── CEX price fetching ────────────────────────────────────────────────────────

async function fetchBinancePrice(symbol: string): Promise<number> {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status} for ${symbol}`);
  const data = (await r.json()) as { price: string };
  return parseFloat(data.price);
}

async function fetchCoinbasePrice(pair: string): Promise<number> {
  const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  if (!r.ok) throw new Error(`Coinbase HTTP ${r.status} for ${pair}`);
  const data = (await r.json()) as { data: { amount: string } };
  return parseFloat(data.data.amount);
}

async function fetchKrakenPrice(pair: string): Promise<number> {
  const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status} for ${pair}`);
  const data = (await r.json()) as { result: Record<string, { c: string[] }> };
  const key = Object.keys(data.result)[0];
  if (!key) throw new Error(`Kraken: no result for ${pair}`);
  return parseFloat(data.result[key].c[0]);
}

type PairSymbol = "BTC" | "ETH" | "EURC";

const CEX_FETCHERS: Record<PairSymbol, Array<() => Promise<number>>> = {
  BTC: [
    () => fetchBinancePrice("BTCUSDT"),
    () => fetchCoinbasePrice("BTC-USD"),
    () => fetchKrakenPrice("XBTUSD"),
  ],
  ETH: [
    () => fetchBinancePrice("ETHUSDT"),
    () => fetchCoinbasePrice("ETH-USD"),
    () => fetchKrakenPrice("ETHUSD"),
  ],
  EURC: [
    () => fetchBinancePrice("EURCUSDT"),
    () => fetchCoinbasePrice("EURC-USD"),
  ],
};

/** Returns median of available CEX prices in 1e8 precision. Requires ≥1 source. */
async function getAggregateIndexPrice(symbol: PairSymbol): Promise<bigint> {
  const results = await Promise.allSettled(CEX_FETCHERS[symbol].map((fn) => fn()));
  const prices = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled" && Number.isFinite(r.value))
    .map((r) => r.value);

  if (prices.length === 0) throw new Error(`No CEX prices available for ${symbol}`);

  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return BigInt(Math.round(median * 1e8));
}

// ── Keeper logic ──────────────────────────────────────────────────────────────

const publicClient = createArcPublicClient();
const walletClient = createArcWalletClient();

const PAIR_SYMBOLS: Array<{ id: `0x${string}`; symbol: PairSymbol; label: string }> = [
  { id: PAIR_ID.BTC_USDC, symbol: "BTC", label: "BTC-USDC" },
  { id: PAIR_ID.ETH_USDC, symbol: "ETH", label: "ETH-USDC" },
  { id: PAIR_ID.EURC_USDC, symbol: "EURC", label: "EURC-USDC" },
];

async function settleFunding(): Promise<void> {
  console.log("[keeper] Starting funding settlement...");

  for (const { id, symbol, label } of PAIR_SYMBOLS) {
    let price: bigint;
    try {
      price = await getAggregateIndexPrice(symbol);
    } catch (err) {
      console.error(`[keeper] Cannot fetch index price for ${label}:`, (err as Error).message);
      continue;
    }

    console.log(`[keeper] ${label} index price: $${Number(price) / 1e8}`);

    try {
      await withRetry(() =>
        walletClient.writeContract({
          address: CONTRACTS.perpEngine,
          abi: PERP_ENGINE_ABI,
          functionName: "setIndexPrice",
          args: [id, price],
        })
      );
    } catch (err) {
      console.error(`[keeper] setIndexPrice failed for ${label}:`, (err as Error).message);
    }
  }

  const hash = await withRetry(() =>
    walletClient.writeContract({
      address: CONTRACTS.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "settleFunding",
      args: [ALL_PAIRS],
    })
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[keeper] Funding settled in tx ${receipt.transactionHash}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[keeper] Starting ArcPerp funding rate keeper...");

  try {
    await settleFunding();
  } catch (err) {
    console.error("[keeper] Initial settlement failed:", err);
  }

  cron.schedule("0 */8 * * *", async () => {
    try {
      await settleFunding();
    } catch (err) {
      console.error("[keeper] Scheduled settlement failed:", err);
    }
  });

  console.log("[keeper] Scheduled: every 8 hours");
}

main().catch((err) => {
  console.error("[keeper] Fatal error:", err);
  process.exit(1);
});
