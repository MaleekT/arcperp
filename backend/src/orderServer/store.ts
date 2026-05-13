import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../../data");
const ORDERS_FILE = join(DATA_DIR, "orders.json");

export type OrderType = "limit" | "tp" | "sl" | "stop_market" | "stop_limit" | "trailing_stop" | "twap";
export type OrderStatus = "pending" | "triggered" | "failed" | "cancelled";

export interface StoredOrder {
  id: string;
  type: OrderType;
  trader: `0x${string}`;
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  // ── Opening order fields ───────────────────────────────────────────────────
  marginUsdc?: number;         // limit, stop_market, stop_limit, twap
  leverage?: number;           // limit, stop_market, stop_limit, twap
  // ── Closing order fields ──────────────────────────────────────────────────
  positionId?: `0x${string}`; // tp, sl, trailing_stop
  // ── Advanced type fields ──────────────────────────────────────────────────
  triggerPrice: number;
  limitPrice?: number;         // stop_limit: execution ceiling (long) / floor (short)
  trailPercent?: number;       // trailing_stop: retrace threshold e.g. 1.5 = 1.5%
  peakPrice?: number;          // trailing_stop: best price seen since placed, set by scan
  expiresAt?: number;          // TIF: ms epoch; undefined = GTC
  numSlices?: number;          // twap: total slices to execute
  executedSlices?: number;     // twap: slices executed so far
  sliceIntervalMs?: number;    // twap: ms between slice executions
  nextExecutionAt?: number;    // twap: epoch ms when next slice should fire
  // ── Result fields ─────────────────────────────────────────────────────────
  createdAt: number;
  status: OrderStatus;
  txHash?: string;
  failReason?: string;
}

// ── In-memory store (single source of truth) ─────────────────────────────────
let _orders: StoredOrder[] = [];
let _loaded = false;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(): void {
  ensureDataDir();
  try {
    const raw = readFileSync(ORDERS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("orders.json is not an array");
    _orders = parsed as StoredOrder[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("ENOENT")) {
      console.error("[store] Could not read orders.json, starting fresh:", message);
    }
    _orders = [];
  }
  _loaded = true;
}

function getOrders(): StoredOrder[] {
  if (!_loaded) loadFromDisk();
  return _orders;
}

function flushToDisk(): void {
  ensureDataDir();
  try {
    writeFileSync(ORDERS_FILE, JSON.stringify(_orders, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] Failed to persist orders.json:", err instanceof Error ? err.message : err);
  }
}

// ── Input validation ──────────────────────────────────────────────────────────

function isHex(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
}

function isValidOrderType(t: unknown): t is OrderType {
  return (
    t === "limit" || t === "tp" || t === "sl" ||
    t === "stop_market" || t === "stop_limit" ||
    t === "trailing_stop" || t === "twap"
  );
}

export function validateNewOrder(order: Omit<StoredOrder, "id" | "createdAt" | "status">): void {
  if (!isValidOrderType(order.type)) throw new Error("Invalid order type");
  if (!isHex(order.trader)) throw new Error("Invalid trader address");
  if (typeof order.pair !== "string" || !order.pair) throw new Error("Invalid pair");
  if (!isHex(order.pairId)) throw new Error("Invalid pairId");
  if (typeof order.isLong !== "boolean") throw new Error("isLong must be boolean");
  if (typeof order.triggerPrice !== "number" || order.triggerPrice <= 0) {
    throw new Error("triggerPrice must be a positive number");
  }

  switch (order.type) {
    case "limit":
    case "stop_market":
      if (typeof order.marginUsdc !== "number" || order.marginUsdc <= 0)
        throw new Error("marginUsdc required for limit/stop_market orders");
      if (typeof order.leverage !== "number" || order.leverage <= 0)
        throw new Error("leverage required for limit/stop_market orders");
      break;

    case "stop_limit":
      if (typeof order.marginUsdc !== "number" || order.marginUsdc <= 0)
        throw new Error("marginUsdc required for stop_limit orders");
      if (typeof order.leverage !== "number" || order.leverage <= 0)
        throw new Error("leverage required for stop_limit orders");
      if (typeof order.limitPrice !== "number" || order.limitPrice <= 0)
        throw new Error("limitPrice required for stop_limit orders");
      break;

    case "tp":
    case "sl":
      if (!isHex(order.positionId))
        throw new Error("positionId required for tp/sl orders");
      break;

    case "trailing_stop":
      if (!isHex(order.positionId))
        throw new Error("positionId required for trailing_stop orders");
      if (typeof order.trailPercent !== "number" || order.trailPercent <= 0)
        throw new Error("trailPercent must be a positive number for trailing_stop orders");
      break;

    case "twap":
      if (typeof order.marginUsdc !== "number" || order.marginUsdc <= 0)
        throw new Error("marginUsdc required for twap orders");
      if (typeof order.leverage !== "number" || order.leverage <= 0)
        throw new Error("leverage required for twap orders");
      if (typeof order.numSlices !== "number" || order.numSlices < 2)
        throw new Error("numSlices must be >= 2 for twap orders");
      if (typeof order.sliceIntervalMs !== "number" || order.sliceIntervalMs < 60_000)
        throw new Error("sliceIntervalMs must be >= 60000 for twap orders");
      break;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addOrder(order: Omit<StoredOrder, "id" | "createdAt" | "status">): StoredOrder {
  validateNewOrder(order);
  const now = Date.now();
  const newOrder: StoredOrder = {
    ...order,
    id: crypto.randomUUID(),
    createdAt: now,
    status: "pending",
    // For twap: first slice fires at triggerPrice condition, subsequent slices use nextExecutionAt
    ...(order.type === "twap" ? { executedSlices: 0 } : {}),
  };
  getOrders().push(newOrder);
  flushToDisk();
  return newOrder;
}

/** Internal use only — updates execution status set by the order watcher loop. */
export function markOrderResult(
  id: string,
  result: { status: "triggered" | "failed" | "cancelled"; txHash?: string; failReason?: string }
): void {
  const orders = getOrders();
  const order = orders.find((o) => o.id === id);
  if (!order) return;
  Object.assign(order, result);
  flushToDisk();
}

/** Updates trailing stop peak price without changing order status. Called by scan loop. */
export function updateTrailingPeak(id: string, peakPrice: number): void {
  const orders = getOrders();
  const order = orders.find((o) => o.id === id);
  if (!order || order.type !== "trailing_stop") return;
  order.peakPrice = peakPrice;
  flushToDisk();
}

/**
 * Advances a TWAP order by one executed slice.
 * Sets nextExecutionAt = now + sliceIntervalMs.
 * Returns true if all slices are now complete (caller should mark triggered).
 */
export function advanceTwapSlice(id: string): boolean {
  const orders = getOrders();
  const order = orders.find((o) => o.id === id);
  if (!order || order.type !== "twap" || !order.numSlices || !order.sliceIntervalMs) return false;

  const executed = (order.executedSlices ?? 0) + 1;
  order.executedSlices = executed;

  if (executed >= order.numSlices) {
    flushToDisk();
    return true;
  }

  order.nextExecutionAt = Date.now() + order.sliceIntervalMs;
  flushToDisk();
  return false;
}

export function cancelOrder(id: string, trader: string): boolean {
  const orders = getOrders();
  const order = orders.find(
    (o) => o.id === id && o.trader.toLowerCase() === trader.toLowerCase()
  );
  if (!order) return false;
  if (order.status !== "pending") return false;
  order.status = "cancelled";
  flushToDisk();
  return true;
}

export function getOrdersByTrader(trader: string): StoredOrder[] {
  return getOrders().filter((o) => o.trader.toLowerCase() === trader.toLowerCase());
}

export function getPendingOrders(): StoredOrder[] {
  return getOrders().filter((o) => o.status === "pending");
}
