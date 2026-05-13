import "dotenv/config";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { PYTH_IDS } from "../lib/arc.js";

// Render injects PORT automatically; fall back to PRICE_SERVER_PORT for local dev
const PORT = parseInt(process.env.PORT ?? process.env.PRICE_SERVER_PORT ?? "8081", 10);
const POLL_INTERVAL_MS = 1_000;
const FETCH_TIMEOUT_MS = 8_000;
const HERMES = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";

// Build PAIRS from shared PYTH_IDS (strip 0x prefix — Hermes expects bare hex)
const PAIRS: Record<string, string> = {
  "BTC-USDC": PYTH_IDS.BTC.slice(2),
  "ETH-USDC": PYTH_IDS.ETH.slice(2),
  "EURC-USDC": PYTH_IDS.EURC.slice(2),
};

interface PriceMessage {
  pair: string;
  price: string;
  priceRaw: string;
  timestamp: number;
  source: "pyth";
}

interface HermesParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface HermesResponse {
  parsed: HermesParsedPrice[];
}

// ── HTTP server with /health + WebSocket upgrade ──────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: wss.clients.size, timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[priceServer] Client connected (total: ${clients.size})`);
  ws.on("close", () => { clients.delete(ws); });
  ws.on("error", () => clients.delete(ws));
});

httpServer.listen(PORT, () => {
  console.log(`[priceServer] Listening on :${PORT}`);
});

function broadcast(msg: PriceMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ── Price math ────────────────────────────────────────────────────────────────

function toDecimal(price: string, expo: number): string {
  const p = BigInt(price);
  if (expo >= 0) return `${p * 10n ** BigInt(expo)}.00000000`;
  const absExpo = -expo;
  const div = 10n ** BigInt(absExpo);
  const whole = p / div;
  const frac = p % div;
  return `${whole}.${frac.toString().padStart(absExpo, "0")}`;
}

function toRaw(price: string, expo: number): string {
  const p = BigInt(price);
  // Normalise to 1e8 precision
  if (expo >= -8) return (p * 10n ** BigInt(8 + expo)).toString();   // scale up
  return (p / 10n ** BigInt(-expo - 8)).toString();                    // scale down
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

const feedIds = Object.values(PAIRS);
const idQuery = feedIds.map((id) => `ids[]=${id}`).join("&");
const url = `${HERMES}/v2/updates/price/latest?${idQuery}&parsed=true`;

const idToPair: Record<string, string> = {};
for (const [pair, id] of Object.entries(PAIRS)) idToPair[id.toLowerCase()] = pair;

async function pollOnce(): Promise<void> {
  // AbortController gives us a hard timeout on the fetch
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.error(`[priceServer] Hermes HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  const data = await res.json() as HermesResponse;
  if (!data.parsed?.length) return;

  let logged = false;
  for (const feed of data.parsed) {
    const pair = idToPair[feed.id.toLowerCase()];
    if (!pair) continue;
    const decimal = toDecimal(feed.price.price, feed.price.expo);
    const raw = toRaw(feed.price.price, feed.price.expo);
    broadcast({ pair, price: decimal, priceRaw: raw, timestamp: feed.price.publish_time, source: "pyth" });
    if (!logged) { console.log(`[priceServer] ${pair} $${decimal.slice(0, 10)}`); logged = true; }
  }
}

// Exponential backoff state
let backoffMs = POLL_INTERVAL_MS;
const MAX_BACKOFF_MS = 30_000;

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      await pollOnce();
      backoffMs = POLL_INTERVAL_MS; // reset on success
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork = msg.includes("fetch failed") || msg.includes("aborted") || msg.includes("network");
      console.error(`[priceServer] Error (backoff ${backoffMs}ms): ${msg}`);
      await new Promise((r) => setTimeout(r, backoffMs));
      if (isNetwork) {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      } else {
        backoffMs = POLL_INTERVAL_MS;
      }
    }
  }
}

pollLoop().catch((err) => { console.error("[priceServer] Fatal:", err); process.exit(1); });
