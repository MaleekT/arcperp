import { useState, useEffect, useCallback } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { arcTestnet, ADDRESSES, perpContract } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";
import { useWallet } from "../lib/wallet.js";

const ORDER_SERVER = (import.meta.env.VITE_ORDER_SERVER_URL as string | undefined) ?? "http://localhost:8082";
const EXECUTOR_ADDRESS = (import.meta.env.VITE_ORDER_EXECUTOR_ADDRESS as string | undefined) ?? "";

const pubClient = createPublicClient({ chain: arcTestnet, transport: http() });

export type OrderType =
  | "limit" | "tp" | "sl"
  | "stop_market" | "stop_limit" | "trailing_stop" | "twap";
export type OrderStatus = "pending" | "triggered" | "failed" | "cancelled";
export type TIF = "GTC" | "1h" | "8h" | "24h";

export interface BackendOrder {
  id: string;
  type: OrderType;
  trader: string;
  pair: string;
  pairId: string;
  isLong: boolean;
  marginUsdc?: number;
  leverage?: number;
  positionId?: string;
  triggerPrice: number;
  limitPrice?: number;
  trailPercent?: number;
  peakPrice?: number;
  expiresAt?: number;
  numSlices?: number;
  executedSlices?: number;
  sliceIntervalMs?: number;
  nextExecutionAt?: number;
  createdAt: number;
  status: OrderStatus;
  txHash?: string;
  failReason?: string;
}

export interface PlaceLimitParams {
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  triggerPrice: number;
  tif?: TIF;
}

export interface PlaceTpSlParams {
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  positionId: `0x${string}`;
  triggerPrice: number;
}

export interface PlaceStopMarketParams extends PlaceLimitParams {
  tif?: TIF;
}

export interface PlaceStopLimitParams extends PlaceLimitParams {
  limitPrice: number;
  tif?: TIF;
}

export interface PlaceTrailingStopParams {
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  positionId: `0x${string}`;
  triggerPrice: number;
  trailPercent: number;
}

export interface PlaceTwapParams {
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  triggerPrice: number;
  numSlices: number;
  sliceIntervalMs: number;
}

export interface PlaceScaleParams {
  pair: string;
  pairId: `0x${string}`;
  isLong: boolean;
  totalMarginUsdc: number;
  leverage: number;
  priceFrom: number;
  priceTo: number;
  numOrders: number;
  tif?: TIF;
}

function tifToExpiresAt(tif?: TIF): number | undefined {
  if (!tif || tif === "GTC") return undefined;
  const ms: Record<string, number> = { "1h": 3_600_000, "8h": 28_800_000, "24h": 86_400_000 };
  return Date.now() + (ms[tif] ?? 0);
}

async function postOrder<T>(body: unknown): Promise<T> {
  const res = await fetch(`${ORDER_SERVER}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json()) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useOrderServer(trader: `0x${string}` | undefined) {
  const { getProvider } = useWallet();
  const [orders, setOrders] = useState<BackendOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [executorApproved, setExecutorApproved] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!trader) { setOrders([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`${ORDER_SERVER}/orders?trader=${trader}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BackendOrder[];
      setOrders(data);
    } catch {
      // Non-fatal — order server may not be running locally
    } finally {
      setLoading(false);
    }
  }, [trader]);

  const checkExecutorApproval = useCallback(async () => {
    if (!trader || !EXECUTOR_ADDRESS) return;
    try {
      const executor = await pubClient.readContract({
        ...perpContract,
        functionName: "getOrderExecutor",
        args: [trader],
      });
      setExecutorApproved(
        typeof executor === "string" && executor.toLowerCase() === EXECUTOR_ADDRESS.toLowerCase()
      );
    } catch {
      setExecutorApproved(false);
    }
  }, [trader]);

  useEffect(() => {
    fetchOrders();
    checkExecutorApproval();
  }, [fetchOrders, checkExecutorApproval]);

  useEffect(() => {
    if (!trader) return;
    const id = setInterval(fetchOrders, 10_000);
    return () => clearInterval(id);
  }, [trader, fetchOrders]);

  const approveExecutor = useCallback(async () => {
    if (!trader || !EXECUTOR_ADDRESS) return;
    setApproving(true);
    setApproveError(null);
    try {
      const provider = await getProvider();
      const walletClient = createWalletClient({
        account: trader,
        chain: arcTestnet,
        transport: custom(provider as Parameters<typeof custom>[0]),
      });
      await walletClient.writeContract({
        address: ADDRESSES.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "approveOrderExecutor",
        args: [EXECUTOR_ADDRESS as `0x${string}`],
      });
      setExecutorApproved(true);
    } catch (err) {
      setApproveError(err instanceof Error ? err.message.slice(0, 100) : "Approval failed");
    } finally {
      setApproving(false);
    }
  }, [trader, getProvider]);

  const placeLimitOrder = useCallback(
    async (params: PlaceLimitParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "limit",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        marginUsdc: params.marginUsdc,
        leverage: params.leverage,
        triggerPrice: params.triggerPrice,
        expiresAt: tifToExpiresAt(params.tif),
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeTPOrder = useCallback(
    async (params: PlaceTpSlParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "tp",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        positionId: params.positionId,
        triggerPrice: params.triggerPrice,
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeSLOrder = useCallback(
    async (params: PlaceTpSlParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "sl",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        positionId: params.positionId,
        triggerPrice: params.triggerPrice,
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeStopMarket = useCallback(
    async (params: PlaceStopMarketParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "stop_market",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        marginUsdc: params.marginUsdc,
        leverage: params.leverage,
        triggerPrice: params.triggerPrice,
        expiresAt: tifToExpiresAt(params.tif),
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeStopLimit = useCallback(
    async (params: PlaceStopLimitParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "stop_limit",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        marginUsdc: params.marginUsdc,
        leverage: params.leverage,
        triggerPrice: params.triggerPrice,
        limitPrice: params.limitPrice,
        expiresAt: tifToExpiresAt(params.tif),
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeTrailingStop = useCallback(
    async (params: PlaceTrailingStopParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "trailing_stop",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        positionId: params.positionId,
        triggerPrice: params.triggerPrice,
        trailPercent: params.trailPercent,
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeTwapOrder = useCallback(
    async (params: PlaceTwapParams): Promise<BackendOrder | null> => {
      if (!trader) return null;
      const order = await postOrder<BackendOrder>({
        type: "twap",
        trader,
        pair: params.pair,
        pairId: params.pairId,
        isLong: params.isLong,
        marginUsdc: params.marginUsdc,
        leverage: params.leverage,
        triggerPrice: params.triggerPrice,
        numSlices: params.numSlices,
        sliceIntervalMs: params.sliceIntervalMs,
      });
      setOrders((prev) => [...prev, order]);
      return order;
    },
    [trader],
  );

  const placeScaleOrder = useCallback(
    async (params: PlaceScaleParams): Promise<BackendOrder[]> => {
      if (!trader) return [];
      const res = await fetch(`${ORDER_SERVER}/orders/scale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader,
          pair: params.pair,
          pairId: params.pairId,
          isLong: params.isLong,
          totalMarginUsdc: params.totalMarginUsdc,
          leverage: params.leverage,
          priceFrom: params.priceFrom,
          priceTo: params.priceTo,
          numOrders: params.numOrders,
          expiresAt: tifToExpiresAt(params.tif),
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const newOrders = (await res.json()) as BackendOrder[];
      setOrders((prev) => [...prev, ...newOrders]);
      return newOrders;
    },
    [trader],
  );

  const cancelOrder = useCallback(
    async (id: string): Promise<void> => {
      if (!trader) return;
      const res = await fetch(`${ORDER_SERVER}/orders/${id}?trader=${trader}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: "cancelled" as const } : o)));
    },
    [trader],
  );

  const pendingOrders = orders.filter((o) => o.status === "pending");
  const settledOrders = orders.filter((o) => o.status !== "pending");

  return {
    orders,
    pendingOrders,
    settledOrders,
    loading,
    executorApproved,
    executorAddress: EXECUTOR_ADDRESS,
    approving,
    approveError,
    approveExecutor,
    placeLimitOrder,
    placeTPOrder,
    placeSLOrder,
    placeStopMarket,
    placeStopLimit,
    placeTrailingStop,
    placeTwapOrder,
    placeScaleOrder,
    cancelOrder,
    refetch: fetchOrders,
  };
}
