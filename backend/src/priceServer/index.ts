import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";

const PORT = parseInt(process.env.PRICE_SERVER_PORT ?? "8081", 10);
const POLL_INTERVAL_MS = 1_000;
const HERMES = "https://hermes.pyth.network";

// EUR/USD used as EURC/USD proxy (EURC is a EUR-pegged stablecoin)
const PAIRS: Record<string, string> = {
  "BTC-USDC": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
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

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[priceServer] Client connected (total: ${clients.size})`);
  ws.on("close", () => { clients.delete(ws); });
  ws.on("error", () => clients.delete(ws));
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
  const res = await fetch(url);
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

async function pollLoop(): Promise<void> {
  while (true) {
    try { await pollOnce(); } catch (err) { console.error("[priceServer] Error:", (err as Error).message); }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log(`[priceServer] Listening on ws://localhost:${PORT}`);
pollLoop().catch((err) => { console.error("[priceServer] Fatal:", err); process.exit(1); });
