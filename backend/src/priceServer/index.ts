/**
 * ArcPerp WebSocket Price Server
 *
 * Subscribes to Pyth Hermes for BTC, ETH, and EURC prices (sub-100ms updates)
 * and broadcasts them to all connected frontend clients on port 8080.
 *
 * Message format: { pair: "BTC-USDC", price: "67000.12345678", timestamp: 1234567890 }
 */

import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { HermesClient } from "@pythnetwork/hermes-client";
import { validateEnv } from "../lib/arc.js";

validateEnv(["ARC_RPC_URL"]);

const PORT = parseInt(process.env.PRICE_SERVER_PORT ?? "8080", 10);

const PYTH_IDS = {
  "BTC-USDC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
} as const;

const FEED_IDS = Object.values(PYTH_IDS);

// ── Message types ─────────────────────────────────────────────────────────────

interface PriceMessage {
  pair: string;
  price: string;       // decimal string, 8 decimal places
  priceRaw: string;    // integer string in 1e8 precision
  timestamp: number;
  source: "pyth";
}

// ── Server ────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[priceServer] Client connected (total: ${clients.size})`);

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[priceServer] Client disconnected (total: ${clients.size})`);
  });

  ws.on("error", (err) => {
    console.error("[priceServer] Client error:", err.message);
    clients.delete(ws);
  });
});

function broadcast(msg: PriceMessage): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ── Pyth streaming ────────────────────────────────────────────────────────────

/** Normalizes a Pyth price (with expo) to a decimal string */
function normalizePrice(price: string | number, expo: number): { decimal: string; raw: string } {
  const priceInt = BigInt(price);
  // expo is typically negative (e.g. -8): price * 10^expo = human price
  if (expo >= 0) {
    const raw = (priceInt * 10n ** BigInt(expo)).toString();
    const decimal = raw + ".00000000";
    return { decimal, raw };
  }
  const absExpo = -expo;
  const divisor = 10n ** BigInt(absExpo);
  const whole = priceInt / divisor;
  const frac = priceInt % divisor;
  const decimal = `${whole}.${frac.toString().padStart(absExpo, "0")}`;
  // Normalize to 1e8
  const normalized = absExpo === 8 ? priceInt : priceInt * 10n ** BigInt(absExpo - 8);
  return { decimal, raw: normalized.toString() };
}

function findPairForFeedId(feedId: string): string | undefined {
  for (const [pair, id] of Object.entries(PYTH_IDS)) {
    if (id.toLowerCase() === `0x${feedId}`.toLowerCase() || id.toLowerCase() === feedId.toLowerCase()) {
      return pair;
    }
  }
  return undefined;
}

async function startPythStream(): Promise<void> {
  const hermes = new HermesClient("https://hermes.pyth.network");

  const eventSource = await hermes.getPriceUpdatesStream(FEED_IDS, {
    parsed: true,
    allowUnordered: false,
    benchmarksOnly: false,
  });

  eventSource.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as {
        parsed?: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
      };
      if (!data.parsed) return;

      for (const feed of data.parsed) {
        const pair = findPairForFeedId(feed.id);
        if (!pair) continue;

        const { decimal, raw } = normalizePrice(feed.price.price, feed.price.expo);

        broadcast({
          pair,
          price: decimal,
          priceRaw: raw,
          timestamp: feed.price.publish_time,
          source: "pyth",
        });
      }
    } catch (err) {
      console.error("[priceServer] Parse error:", (err as Error).message);
    }
  };

  eventSource.onerror = (err: Event) => {
    console.error("[priceServer] Pyth stream error — reconnecting in 5s...", err);
    setTimeout(() => startPythStream().catch(console.error), 5_000);
  };

  console.log("[priceServer] Pyth price stream active");
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[priceServer] WebSocket server listening on ws://localhost:${PORT}`);

  await startPythStream();
}

main().catch((err) => {
  console.error("[priceServer] Fatal error:", err);
  process.exit(1);
});
