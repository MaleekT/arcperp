/**
 * Oracle Feed Updater
 *
 * Keeps the testnet UpdatableMockFeed contracts in sync with real market prices.
 * Fetches from Pyth Hermes every 60 seconds and calls updateAnswer() on each feed.
 * This ensures the Chainlink fallback in OracleLib.getVerifiedPrice() is always fresh.
 */

import "dotenv/config";
import { HermesClient } from "@pythnetwork/hermes-client";
import { parseAbi } from "viem";
import {
  createArcPublicClient,
  createArcWalletClient,
  withRetry,
  validateEnv,
} from "../lib/arc.js";

validateEnv(["ARC_RPC_URL", "BOT_PRIVATE_KEY", "MOCK_BTC_FEED", "MOCK_ETH_FEED", "MOCK_EURC_FEED"]);

const MOCK_FEED_ABI = parseAbi([
  "function updateAnswer(int256 newAnswer) external",
]);

// Maximum age of a Pyth price we're willing to push on-chain (90 seconds)
const MAX_PRICE_AGE_S = 90;

const FEEDS: ReadonlyArray<{ symbol: string; pythId: string; envKey: string }> = [
  { symbol: "BTC",  pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", envKey: "MOCK_BTC_FEED"  },
  { symbol: "ETH",  pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", envKey: "MOCK_ETH_FEED"  },
  { symbol: "EURC", pythId: "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb", envKey: "MOCK_EURC_FEED" },
];

const hermes       = new HermesClient("https://hermes.pyth.network");
const publicClient = createArcPublicClient();
const walletClient = createArcWalletClient();

/** Convert Pyth raw price to a 1e8 int256 bigint without floating-point loss. */
function pythToE8(rawPrice: string, expo: number): bigint {
  const raw = BigInt(rawPrice);
  if (expo === -8) return raw;
  if (expo > -8) return raw * 10n ** BigInt(expo + 8);
  return raw / 10n ** BigInt(-expo - 8);
}

async function updateFeeds(): Promise<void> {
  const ids = FEEDS.map((f) => f.pythId);

  let updates;
  try {
    updates = await hermes.getLatestPriceUpdates(ids);
  } catch (err) {
    console.error("[oracle-updater] Failed to fetch Pyth prices:", (err as Error).message);
    return;
  }

  // Build a map by feed ID so array order from Hermes can't cause mismatches
  const priceById = new Map<string, { price: string; expo: number; publishTime: number }>();
  for (const p of updates.parsed ?? []) {
    priceById.set("0x" + p.id, {
      price:       p.price.price,
      expo:        p.price.expo,
      publishTime: p.price.publish_time,
    });
  }

  const nowS = Math.floor(Date.now() / 1000);

  for (const { symbol, pythId, envKey } of FEEDS) {
    const entry = priceById.get(pythId);
    if (!entry) { console.warn(`[oracle-updater] No price data for ${symbol}`); continue; }

    const ageS = nowS - entry.publishTime;
    if (ageS > MAX_PRICE_AGE_S) {
      console.warn(`[oracle-updater] ${symbol} price is ${ageS}s old — skipping stale update`);
      continue;
    }

    const feedAddr = process.env[envKey] as `0x${string}` | undefined;
    if (!feedAddr?.startsWith("0x")) { console.warn(`[oracle-updater] ${envKey} not set`); continue; }

    const answer  = pythToE8(entry.price, entry.expo);
    const usdDisp = (Number(answer) / 1e8).toFixed(2);

    try {
      const hash = await withRetry(() =>
        walletClient.writeContract({
          address: feedAddr,
          abi: MOCK_FEED_ABI,
          functionName: "updateAnswer",
          args: [answer],
        })
      );
      await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      console.log(`[oracle-updater] ${symbol} = $${usdDisp} (age ${ageS}s, tx ${hash.slice(0, 12)}…)`);
    } catch (err) {
      console.error(`[oracle-updater] ${symbol} updateAnswer failed:`, (err as Error).message);
    }
  }
}

async function main(): Promise<void> {
  console.log("[oracle-updater] Starting testnet oracle feed updater");
  console.log("[oracle-updater] BTC  feed:", process.env.MOCK_BTC_FEED);
  console.log("[oracle-updater] ETH  feed:", process.env.MOCK_ETH_FEED);
  console.log("[oracle-updater] EURC feed:", process.env.MOCK_EURC_FEED);

  await updateFeeds();

  const handle = setInterval(async () => {
    try {
      await updateFeeds();
    } catch (err) {
      console.error("[oracle-updater] Interval error:", (err as Error).message);
    }
  }, 60_000);

  // Clean shutdown on SIGTERM / SIGINT (Render sends SIGTERM before stopping)
  const shutdown = () => { clearInterval(handle); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT",  shutdown);
}

main().catch((err) => {
  console.error("[oracle-updater] Fatal:", err);
  process.exit(1);
});
