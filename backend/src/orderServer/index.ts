import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocket } from "ws";
import { HermesClient } from "@pythnetwork/hermes-client";
import { parseAbi, parseUnits } from "viem";
import {
  createArcPublicClient,
  createArcWalletClient,
  CONTRACTS,
  PAIRS,
  PYTH_IDS,
  validateEnv,
} from "../lib/arc.js";
import {
  addOrder,
  cancelOrder,
  getOrdersByTrader,
  getPendingOrders,
  markOrderResult,
  updateTrailingPeak,
  advanceTwapSlice,
  type StoredOrder,
} from "./store.js";
import { conditionMet } from "./conditions.js";

validateEnv(["ARC_RPC_URL", "BOT_PRIVATE_KEY", "PERP_ENGINE_ADDRESS", "PRICE_SERVER_WS_URL"]);

const PORT = parseInt(process.env.ORDER_SERVER_PORT ?? "8082", 10);
const PRICE_SERVER_WS = process.env.PRICE_SERVER_WS_URL!;
const SCAN_INTERVAL_MS = 5_000;
const HERMES_URL = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";

// ── ABIs ─────────────────────────────────────────────────────────────────────

const PERP_ENGINE_ABI = parseAbi([
  "function openPositionFor(address trader, bytes32 pair, bool isLong, uint256 margin, uint256 leverageBps, uint256 minPrice, uint256 maxPrice, bytes[] calldata priceUpdateData) external payable returns (bytes32 positionId)",
  "function closePositionFor(address trader, bytes32 positionId, bytes[] calldata priceUpdateData) external payable returns (int256 realizedPnl)",
]);

// ── Clients ───────────────────────────────────────────────────────────────────

const publicClient = createArcPublicClient();
const walletClient = createArcWalletClient();
const hermesClient = new HermesClient(HERMES_URL);

// ── Price tracking ────────────────────────────────────────────────────────────

const lastPrices = new Map<string, number>();
const triggeringIds = new Set<string>();

const PYTH_FEED_IDS: string[] = [PYTH_IDS.BTC, PYTH_IDS.ETH, PYTH_IDS.EURC];

function connectPriceServer(): void {
  const ws = new WebSocket(PRICE_SERVER_WS);

  ws.on("open", () => console.log("[orderServer] Connected to priceServer"));

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { pair: string; price: string };
      lastPrices.set(msg.pair, parseFloat(msg.price));
    } catch { /* ignore malformed */ }
  });

  ws.on("close", () => {
    console.warn("[orderServer] priceServer disconnected — reconnecting in 5s");
    setTimeout(connectPriceServer, 5_000);
  });

  ws.on("error", (err) => {
    console.error("[orderServer] priceServer WS error:", err.message);
    ws.close();
  });
}

// ── Execution ─────────────────────────────────────────────────────────────────

async function executeOrder(order: StoredOrder): Promise<void> {
  triggeringIds.add(order.id);
  try {
    const updates = await hermesClient.getLatestPriceUpdates(PYTH_FEED_IDS);
    const vaa = (updates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);

    let txHash: `0x${string}`;

    if (order.type === "limit" || order.type === "stop_market") {
      const margin = parseUnits(order.marginUsdc!.toFixed(6), 6);
      txHash = await walletClient.writeContract({
        address: CONTRACTS.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "openPositionFor",
        args: [
          order.trader,
          order.pairId,
          order.isLong,
          margin,
          BigInt(Math.round(order.leverage! * 100)),
          0n,
          0n,
          vaa,
        ],
        value: 0n,
      });
    } else if (order.type === "stop_limit") {
      const margin = parseUnits(order.marginUsdc!.toFixed(6), 6);
      const limitBig = BigInt(Math.round(order.limitPrice! * 1e8));
      const [minP, maxP] = order.isLong ? [0n, limitBig] : [limitBig, 0n];
      txHash = await walletClient.writeContract({
        address: CONTRACTS.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "openPositionFor",
        args: [
          order.trader,
          order.pairId,
          order.isLong,
          margin,
          BigInt(Math.round(order.leverage! * 100)),
          minP,
          maxP,
          vaa,
        ],
        value: 0n,
      });
    } else if (order.type === "twap") {
      // Execute one slice
      const sliceMargin = parseUnits(
        (order.marginUsdc! / order.numSlices!).toFixed(6),
        6
      );
      txHash = await walletClient.writeContract({
        address: CONTRACTS.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "openPositionFor",
        args: [
          order.trader,
          order.pairId,
          order.isLong,
          sliceMargin,
          BigInt(Math.round(order.leverage! * 100)),
          0n,
          0n,
          vaa,
        ],
        value: 0n,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
      const done = advanceTwapSlice(order.id);
      if (done) {
        markOrderResult(order.id, { status: "triggered", txHash });
        console.log(`[orderServer] TWAP ${order.id} fully executed — tx ${txHash}`);
      } else {
        console.log(`[orderServer] TWAP ${order.id} slice ${order.executedSlices ?? 0} executed — ${order.numSlices! - (order.executedSlices ?? 0)} remaining`);
      }
      return; // Early return — result already handled above
    } else {
      // tp, sl, trailing_stop — all close an existing position
      txHash = await walletClient.writeContract({
        address: CONTRACTS.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "closePositionFor",
        args: [order.trader, order.positionId!, vaa],
        value: 0n,
      });
    }

    await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    markOrderResult(order.id, { status: "triggered", txHash });
    console.log(`[orderServer] Order ${order.id} (${order.type}) triggered — tx ${txHash}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 120) : "Unknown error";
    markOrderResult(order.id, { status: "failed", failReason: reason });
    console.error(`[orderServer] Order ${order.id} failed: ${reason}`);
  } finally {
    triggeringIds.delete(order.id);
  }
}

// ── Scan loop ─────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  const pending = getPendingOrders().filter((o) => !triggeringIds.has(o.id));
  if (pending.length === 0) return;

  // Pass 1: cancel expired orders
  for (const o of pending) {
    if (o.expiresAt && Date.now() > o.expiresAt) {
      markOrderResult(o.id, { status: "failed", failReason: "Order expired" });
      console.log(`[orderServer] Order ${o.id} (${o.type}) expired`);
    }
  }

  // Pass 2: update trailing stop peaks (track best price for long/short)
  const afterExpiry = getPendingOrders().filter((o) => !triggeringIds.has(o.id));
  for (const o of afterExpiry) {
    if (o.type !== "trailing_stop") continue;
    const price = lastPrices.get(o.pair);
    if (price === undefined) continue;
    const shouldUpdate = o.isLong
      ? !o.peakPrice || price > o.peakPrice
      : !o.peakPrice || price < o.peakPrice;
    if (shouldUpdate) updateTrailingPeak(o.id, price);
  }

  // Pass 3: check trigger conditions
  const toCheck = getPendingOrders().filter((o) => !triggeringIds.has(o.id));
  for (const order of toCheck) {
    const price = lastPrices.get(order.pair);
    if (price === undefined) continue;
    if (conditionMet(order, price)) {
      void executeOrder(order);
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 64_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseTraderParam(url: string): string | null {
  try {
    const u = new URL(url, "http://localhost");
    const t = u.searchParams.get("trader");
    return t && /^0x[0-9a-fA-F]{40}$/.test(t) ? t.toLowerCase() : null;
  } catch {
    return null;
  }
}

interface ScaleOrderBody {
  trader: `0x${string}`;
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  totalMarginUsdc: number;
  leverage: number;
  priceFrom: number;
  priceTo: number;
  numOrders: number;
  expiresAt?: number;
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?")[0] ?? "/";

  try {
    if (method === "GET" && path === "/health") {
      return jsonResponse(res, 200, {
        status: "ok",
        pending: getPendingOrders().length,
        pricesFresh: lastPrices.size > 0,
        timestamp: Date.now(),
      });
    }

    if (method === "GET" && path === "/orders") {
      const trader = parseTraderParam(url);
      if (!trader) return jsonResponse(res, 400, { error: "Missing or invalid ?trader= address" });
      return jsonResponse(res, 200, getOrdersByTrader(trader));
    }

    if (method === "POST" && path === "/orders") {
      const body = await readBody(req);
      const data = JSON.parse(body) as Omit<StoredOrder, "id" | "createdAt" | "status">;
      const order = addOrder(data);
      console.log(`[orderServer] Order placed: ${order.id} (${order.type}) for ${order.trader}`);
      return jsonResponse(res, 201, order);
    }

    // Scale orders: create N evenly-spaced limit orders atomically
    if (method === "POST" && path === "/orders/scale") {
      const body = await readBody(req);
      const data = JSON.parse(body) as ScaleOrderBody;

      if (typeof data.numOrders !== "number" || data.numOrders < 2 || data.numOrders > 20)
        return jsonResponse(res, 400, { error: "numOrders must be between 2 and 20" });
      if (typeof data.priceFrom !== "number" || typeof data.priceTo !== "number" || data.priceFrom === data.priceTo)
        return jsonResponse(res, 400, { error: "priceFrom and priceTo must be different numbers" });
      if (typeof data.totalMarginUsdc !== "number" || data.totalMarginUsdc <= 0)
        return jsonResponse(res, 400, { error: "totalMarginUsdc must be a positive number" });

      const priceStep = (data.priceTo - data.priceFrom) / (data.numOrders - 1);
      const perOrderMargin = data.totalMarginUsdc / data.numOrders;
      const orders: StoredOrder[] = [];

      for (let i = 0; i < data.numOrders; i++) {
        const order = addOrder({
          type: "limit",
          trader: data.trader,
          pair: data.pair,
          pairId: data.pairId,
          isLong: data.isLong,
          marginUsdc: perOrderMargin,
          leverage: data.leverage,
          triggerPrice: data.priceFrom + priceStep * i,
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
        });
        orders.push(order);
      }

      console.log(`[orderServer] Scale order: ${data.numOrders} orders for ${data.trader}`);
      return jsonResponse(res, 201, orders);
    }

    if (method === "DELETE" && /^\/orders\/[0-9a-f-]{36}$/.test(path)) {
      const id = path.split("/")[2]!;
      const trader = parseTraderParam(url);
      if (!trader) return jsonResponse(res, 400, { error: "Missing or invalid ?trader= address" });
      const ok = cancelOrder(id, trader);
      return jsonResponse(res, ok ? 200 : 404, { success: ok });
    }

    jsonResponse(res, 404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[orderServer] Request error:", message);
    jsonResponse(res, 400, { error: message });
  }
});

// ── Entry point ───────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[orderServer] Listening on :${PORT}`);
});

connectPriceServer();

const loop = async (): Promise<void> => {
  try { await scan(); } catch (err) { console.error("[orderServer] Scan error:", err); }
  setTimeout(() => void loop(), SCAN_INTERVAL_MS);
};

void loop();

export { PAIRS };
