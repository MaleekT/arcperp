import { describe, it, expect } from "vitest";
import { conditionMet } from "../conditions.js";
import type { StoredOrder } from "../store.js";

function makeOrder(overrides: Partial<StoredOrder>): StoredOrder {
  return {
    id: "test-id",
    type: "limit",
    trader: "0xabcdef1234567890abcdef1234567890abcdef12",
    pair: "BTC-USDC",
    pairId: "0xabc",
    isLong: true,
    triggerPrice: 100,
    createdAt: Date.now(),
    status: "pending",
    ...overrides,
  };
}

// ── limit ────────────────────────────────────────────────────────────────────

describe("limit — long", () => {
  it("fires when price < trigger", () => {
    expect(conditionMet(makeOrder({ isLong: true, triggerPrice: 100 }), 99)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ isLong: true, triggerPrice: 100 }), 100)).toBe(true);
  });
  it("does not fire when price > trigger", () => {
    expect(conditionMet(makeOrder({ isLong: true, triggerPrice: 100 }), 101)).toBe(false);
  });
});

describe("limit — short", () => {
  it("fires when price > trigger", () => {
    expect(conditionMet(makeOrder({ isLong: false, triggerPrice: 100 }), 101)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ isLong: false, triggerPrice: 100 }), 100)).toBe(true);
  });
  it("does not fire when price < trigger", () => {
    expect(conditionMet(makeOrder({ isLong: false, triggerPrice: 100 }), 99)).toBe(false);
  });
});

// ── tp ───────────────────────────────────────────────────────────────────────

describe("tp — long", () => {
  it("fires when price > trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: true, triggerPrice: 110 }), 111)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: true, triggerPrice: 110 }), 110)).toBe(true);
  });
  it("does not fire when price < trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: true, triggerPrice: 110 }), 109)).toBe(false);
  });
});

describe("tp — short", () => {
  it("fires when price < trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: false, triggerPrice: 90 }), 89)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: false, triggerPrice: 90 }), 90)).toBe(true);
  });
  it("does not fire when price > trigger", () => {
    expect(conditionMet(makeOrder({ type: "tp", isLong: false, triggerPrice: 90 }), 91)).toBe(false);
  });
});

// ── sl ───────────────────────────────────────────────────────────────────────

describe("sl — long", () => {
  it("fires when price < trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: true, triggerPrice: 90 }), 89)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: true, triggerPrice: 90 }), 90)).toBe(true);
  });
  it("does not fire when price > trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: true, triggerPrice: 90 }), 91)).toBe(false);
  });
});

describe("sl — short", () => {
  it("fires when price > trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: false, triggerPrice: 110 }), 111)).toBe(true);
  });
  it("fires when price === trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: false, triggerPrice: 110 }), 110)).toBe(true);
  });
  it("does not fire when price < trigger", () => {
    expect(conditionMet(makeOrder({ type: "sl", isLong: false, triggerPrice: 110 }), 109)).toBe(false);
  });
});

// ── stop_market ──────────────────────────────────────────────────────────────

describe("stop_market — long (breakout buy)", () => {
  it("does not fire below trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: true, triggerPrice: 105 }), 104)).toBe(false);
  });
  it("fires at trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: true, triggerPrice: 105 }), 105)).toBe(true);
  });
  it("fires above trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: true, triggerPrice: 105 }), 106)).toBe(true);
  });
});

describe("stop_market — short (breakdown sell)", () => {
  it("does not fire above trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: false, triggerPrice: 95 }), 96)).toBe(false);
  });
  it("fires at trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: false, triggerPrice: 95 }), 95)).toBe(true);
  });
  it("fires below trigger", () => {
    expect(conditionMet(makeOrder({ type: "stop_market", isLong: false, triggerPrice: 95 }), 94)).toBe(true);
  });
});

// ── stop_limit ───────────────────────────────────────────────────────────────

describe("stop_limit — trigger same as stop_market, limitPrice irrelevant to condition", () => {
  it("long: fires at or above trigger", () => {
    const order = makeOrder({ type: "stop_limit", isLong: true, triggerPrice: 105, limitPrice: 108 });
    expect(conditionMet(order, 105)).toBe(true);
    expect(conditionMet(order, 104)).toBe(false);
  });
  it("short: fires at or below trigger", () => {
    const order = makeOrder({ type: "stop_limit", isLong: false, triggerPrice: 95, limitPrice: 92 });
    expect(conditionMet(order, 95)).toBe(true);
    expect(conditionMet(order, 96)).toBe(false);
  });
});

// ── trailing_stop ────────────────────────────────────────────────────────────

describe("trailing_stop — long", () => {
  it("does not fire if peakPrice is not set", () => {
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: true, trailPercent: 2 }), 95)).toBe(false);
  });
  it("does not fire when price is at peak (no retrace)", () => {
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: true, triggerPrice: 0, peakPrice: 110, trailPercent: 2 }), 110)).toBe(false);
  });
  it("fires when price retraces past trailPercent from peak", () => {
    // peak=110, trail=2% → threshold=110 - 2.2 = 107.8; price=107 → fire
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: true, triggerPrice: 0, peakPrice: 110, trailPercent: 2 }), 107)).toBe(true);
  });
  it("fires when retrace is exactly at trail boundary (≤ is inclusive)", () => {
    // threshold=107.8; price=107.8 → currentPrice <= 107.8 → true
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: true, triggerPrice: 0, peakPrice: 110, trailPercent: 2 }), 107.8)).toBe(true);
  });
  it("does not fire when price is just above trail boundary", () => {
    // threshold=107.8; price=108 → not at or below threshold → false
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: true, triggerPrice: 0, peakPrice: 110, trailPercent: 2 }), 108)).toBe(false);
  });
});

describe("trailing_stop — short", () => {
  it("does not fire if peakPrice is not set", () => {
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: false, trailPercent: 2 }), 105)).toBe(false);
  });
  it("fires when price bounces past trailPercent above peak (for short)", () => {
    // peak=90 (lowest seen for short), trail=2% → threshold=90 + 1.8 = 91.8; price=92 → fire
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: false, triggerPrice: 0, peakPrice: 90, trailPercent: 2 }), 92)).toBe(true);
  });
  it("does not fire when bounce is within trail", () => {
    expect(conditionMet(makeOrder({ type: "trailing_stop", isLong: false, triggerPrice: 0, peakPrice: 90, trailPercent: 2 }), 91)).toBe(false);
  });
});

// ── twap ─────────────────────────────────────────────────────────────────────

describe("twap", () => {
  it("does not fire when nextExecutionAt is undefined", () => {
    expect(conditionMet(makeOrder({ type: "twap" }), 100)).toBe(false);
  });
  it("does not fire when nextExecutionAt is in the future", () => {
    expect(conditionMet(makeOrder({ type: "twap", nextExecutionAt: Date.now() + 60_000 }), 100)).toBe(false);
  });
  it("fires when nextExecutionAt is in the past", () => {
    expect(conditionMet(makeOrder({ type: "twap", nextExecutionAt: Date.now() - 1 }), 100)).toBe(true);
  });
  it("fires when nextExecutionAt is exactly now (≤ Date.now())", () => {
    const now = Date.now();
    expect(conditionMet(makeOrder({ type: "twap", nextExecutionAt: now - 0 }), 100)).toBe(true);
  });
});
