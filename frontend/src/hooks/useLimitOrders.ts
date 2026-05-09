import { useState, useEffect, useCallback, useRef } from "react";
import { createWalletClient, custom, parseUnits } from "viem";
import { HermesClient } from "@pythnetwork/hermes-client";
import { arcTestnet, perpContract } from "../lib/contracts.js";
import type { PriceData } from "./usePrices.js";

const HERMES = new HermesClient("https://hermes.pyth.network");

export const PYTH_IDS: Record<string, string> = {
  "BTC-USDC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
};

export interface LimitOrder {
  id: string;
  trader: string;
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  limitPrice: number;
  createdAt: number;
  status: "pending" | "triggered" | "failed";
  txHash?: string;
  failReason?: string;
}

function lsKey(trader: string) {
  return `arcperp:limitorders:${trader.toLowerCase()}`;
}

function loadOrders(trader: string): LimitOrder[] {
  try {
    return JSON.parse(localStorage.getItem(lsKey(trader)) ?? "[]") as LimitOrder[];
  } catch {
    return [];
  }
}

function saveOrders(trader: string, orders: LimitOrder[]) {
  try {
    localStorage.setItem(lsKey(trader), JSON.stringify(orders));
  } catch { /* storage unavailable */ }
}

export async function fetchOraclePrice(pair: string): Promise<{
  price: number;
  vaa: `0x${string}`[];
}> {
  const feedId = PYTH_IDS[pair];
  if (!feedId) throw new Error(`No Pyth feed for ${pair}`);
  const updates = await HERMES.getLatestPriceUpdates([feedId]);
  const parsed = updates.parsed?.[0];
  if (!parsed) throw new Error("No parsed price from Hermes");
  const price = Number(parsed.price.price) * Math.pow(10, parsed.price.expo);
  const vaa = (updates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);
  return { price, vaa };
}

export function useLimitOrders(
  trader: `0x${string}` | undefined,
  prices: Record<string, PriceData>,
  getProvider: () => Promise<unknown>,
) {
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const triggeringRef = useRef<Set<string>>(new Set());
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  // Refs keep polling effect dependency array stable while always reading latest values
  const getProviderRef = useRef(getProvider);
  getProviderRef.current = getProvider;

  useEffect(() => {
    if (trader) setOrders(loadOrders(trader));
  }, [trader]);

  const persist = useCallback(
    (updated: LimitOrder[]) => {
      if (!trader) return;
      saveOrders(trader, updated);
      setOrders([...updated]);
    },
    [trader],
  );

  const placeLimitOrder = useCallback(
    (order: Omit<LimitOrder, "id" | "createdAt" | "status">) => {
      if (!trader) return;
      const newOrder: LimitOrder = {
        ...order,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        status: "pending",
      };
      persist([...loadOrders(trader), newOrder]);
    },
    [trader, persist],
  );

  const cancelOrder = useCallback(
    (id: string) => {
      if (!trader) return;
      persist(loadOrders(trader).filter((o) => o.id !== id));
    },
    [trader, persist],
  );

  // Polling loop — checks every 5 s if any limit order should trigger.
  // Deps: [trader] only — getProvider is accessed via ref to avoid stale closures
  // without causing the effect to restart on every render.
  useEffect(() => {
    if (!trader) return;

    const capturedTrader = trader;
    let active = true;

    async function checkAndTrigger() {
      if (!active) return;

      const current = loadOrders(capturedTrader);
      const pending = current.filter(
        (o) => o.status === "pending" && !triggeringRef.current.has(o.id),
      );
      if (pending.length === 0) return;

      // In-memory snapshot — single atomic write to localStorage at the end
      const updated = current.map((o) => ({ ...o }));
      let dirty = false;

      for (const order of pending) {
        if (!active) break;

        // Guard: pair must have a known Pyth feed before attempting oracle fetch
        if (!PYTH_IDS[order.pair]) continue;

        const priceStr = pricesRef.current[order.pair]?.price;
        if (!priceStr) continue;
        const currentPrice = parseFloat(priceStr);

        const conditionMet = order.isLong
          ? currentPrice <= order.limitPrice
          : currentPrice >= order.limitPrice;
        if (!conditionMet) continue;

        triggeringRef.current.add(order.id);
        const idx = updated.findIndex((o) => o.id === order.id);
        if (idx === -1) {
          triggeringRef.current.delete(order.id);
          continue;
        }

        try {
          const { vaa } = await fetchOraclePrice(order.pair);
          if (!active) break;

          const provider = await getProviderRef.current();
          if (!active) break;

          const walletClient = createWalletClient({
            account: capturedTrader,
            chain: arcTestnet,
            transport: custom(provider as Parameters<typeof custom>[0]),
          });

          const txHash = await walletClient.writeContract({
            ...perpContract,
            functionName: "openPosition",
            args: [
              order.pairId,
              order.isLong,
              parseUnits(order.marginUsdc.toFixed(6), 6),
              BigInt(order.leverage * 100),
              vaa,
            ],
          });

          // Re-check active immediately before touching shared state
          if (!active) break;
          updated[idx] = { ...order, status: "triggered", txHash };
          dirty = true;
        } catch (err) {
          if (!active) break;
          updated[idx] = {
            ...order,
            status: "failed",
            failReason: err instanceof Error ? err.message.slice(0, 80) : "Trigger failed",
          };
          dirty = true;
        } finally {
          triggeringRef.current.delete(order.id);
        }
      }

      if (dirty && active) {
        saveOrders(capturedTrader, updated);
        setOrders([...updated]);
      }
    }

    checkAndTrigger();
    const intervalId = setInterval(checkAndTrigger, 5_000);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [trader]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingOrders = orders.filter((o) => o.status === "pending");
  const recentOrders = orders.filter((o) => o.status !== "pending").slice(-5);

  return { pendingOrders, recentOrders, allOrders: orders, placeLimitOrder, cancelOrder };
}
