import { describe, it, expect, beforeEach } from "vitest";
import {
  addOrder,
  cancelOrder,
  validateNewOrder,
  updateTrailingPeak,
  advanceTwapSlice,
  getPendingOrders,
  getOrdersByTrader,
  type StoredOrder,
} from "../store.js";

const TRADER = "0xabcdef1234567890abcdef1234567890abcdef12" as `0x${string}`;
const PAIR_ID = "0xdeadbeef" as `0x${string}`;
const POSITION_ID = "0xcafebabe1234" as `0x${string}`;

function baseOrder(): Omit<StoredOrder, "id" | "createdAt" | "status"> {
  return {
    type: "limit",
    trader: TRADER,
    pair: "BTC-USDC",
    pairId: PAIR_ID,
    isLong: true,
    triggerPrice: 100,
    marginUsdc: 100,
    leverage: 10,
  };
}

// ── validateNewOrder ──────────────────────────────────────────────────────────

describe("validateNewOrder — new Phase 4 types", () => {
  it("accepts valid stop_market", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "stop_market" })
    ).not.toThrow();
  });

  it("accepts valid stop_limit with limitPrice", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "stop_limit", limitPrice: 105 })
    ).not.toThrow();
  });

  it("rejects stop_limit without limitPrice", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "stop_limit" })
    ).toThrow("limitPrice required");
  });

  it("rejects stop_limit with limitPrice = 0", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "stop_limit", limitPrice: 0 })
    ).toThrow("limitPrice required");
  });

  it("accepts valid trailing_stop", () => {
    expect(() =>
      validateNewOrder({
        ...baseOrder(),
        type: "trailing_stop",
        positionId: POSITION_ID,
        trailPercent: 1.5,
      })
    ).not.toThrow();
  });

  it("rejects trailing_stop without positionId", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "trailing_stop", trailPercent: 1.5 })
    ).toThrow("positionId required");
  });

  it("rejects trailing_stop without trailPercent", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "trailing_stop", positionId: POSITION_ID })
    ).toThrow("trailPercent");
  });

  it("accepts valid twap", () => {
    expect(() =>
      validateNewOrder({
        ...baseOrder(),
        type: "twap",
        numSlices: 4,
        sliceIntervalMs: 60_000,
      })
    ).not.toThrow();
  });

  it("rejects twap with numSlices < 2", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "twap", numSlices: 1, sliceIntervalMs: 60_000 })
    ).toThrow("numSlices must be >= 2");
  });

  it("rejects twap with sliceIntervalMs < 60_000", () => {
    expect(() =>
      validateNewOrder({ ...baseOrder(), type: "twap", numSlices: 3, sliceIntervalMs: 59_999 })
    ).toThrow("sliceIntervalMs must be >= 60000");
  });

  it("rejects unknown order type", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateNewOrder({ ...baseOrder(), type: "mystery" as any })
    ).toThrow("Invalid order type");
  });
});

// ── updateTrailingPeak ────────────────────────────────────────────────────────

describe("updateTrailingPeak", () => {
  it("sets peakPrice on a pending trailing_stop order", () => {
    const order = addOrder({
      type: "trailing_stop",
      trader: TRADER,
      pair: "BTC-USDC",
      pairId: PAIR_ID,
      isLong: true,
      triggerPrice: 1,
      positionId: POSITION_ID,
      trailPercent: 2,
    });

    updateTrailingPeak(order.id, 112.5);

    const updated = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(updated?.peakPrice).toBe(112.5);
  });

  it("updates peakPrice to a new value", () => {
    const order = addOrder({
      type: "trailing_stop",
      trader: TRADER,
      pair: "BTC-USDC",
      pairId: PAIR_ID,
      isLong: true,
      triggerPrice: 1,
      positionId: "0xcafe0001" as `0x${string}`,
      trailPercent: 1,
    });

    updateTrailingPeak(order.id, 100);
    updateTrailingPeak(order.id, 115);

    const updated = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(updated?.peakPrice).toBe(115);
  });

  it("does nothing for a non-trailing_stop order", () => {
    const order = addOrder(baseOrder());
    updateTrailingPeak(order.id, 999);
    const updated = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(updated?.peakPrice).toBeUndefined();
  });
});

// ── advanceTwapSlice ─────────────────────────────────────────────────────────

describe("advanceTwapSlice", () => {
  it("returns false for non-twap orders", () => {
    const order = addOrder(baseOrder());
    expect(advanceTwapSlice(order.id)).toBe(false);
  });

  it("returns false for unknown ids", () => {
    expect(advanceTwapSlice("does-not-exist")).toBe(false);
  });

  it("increments executedSlices and returns false on intermediate slices", () => {
    const order = addOrder({
      ...baseOrder(),
      type: "twap",
      numSlices: 4,
      sliceIntervalMs: 60_000,
    });

    const done1 = advanceTwapSlice(order.id);
    expect(done1).toBe(false);

    const after1 = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(after1?.executedSlices).toBe(1);

    advanceTwapSlice(order.id);
    advanceTwapSlice(order.id);

    const after3 = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(after3?.executedSlices).toBe(3);
  });

  it("returns true on the final slice", () => {
    const order = addOrder({
      ...baseOrder(),
      type: "twap",
      numSlices: 2,
      sliceIntervalMs: 60_000,
    });

    expect(advanceTwapSlice(order.id)).toBe(false);
    expect(advanceTwapSlice(order.id)).toBe(true);
  });

  it("sets nextExecutionAt on non-final slices", () => {
    const before = Date.now();
    const order = addOrder({
      ...baseOrder(),
      type: "twap",
      numSlices: 3,
      sliceIntervalMs: 120_000,
    });

    advanceTwapSlice(order.id);

    const updated = getOrdersByTrader(TRADER).find((o) => o.id === order.id);
    expect(updated?.nextExecutionAt).toBeGreaterThanOrEqual(before + 120_000);
  });
});
