import { useEffect, useState, useCallback, useRef } from "react";
import { createPublicClient, http, isAddress } from "viem";
import { arcTestnet, ADDRESSES, PAIR_IDS } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";

const client = createPublicClient({ chain: arcTestnet, transport: http() });

// Blockscout REST API base — works where eth_getLogs does not
const EXPLORER_API = "https://testnet.arcscan.app/api/v2";

// PositionOpened event topic0 = keccak256("PositionOpened(bytes32,address,bytes32,uint256,uint256,uint256,bool)")
const POSITION_OPENED_TOPIC = "0x6ab3396b09d1394ea7c46920a3169cfccde3a9411e461b5b5436fdb9cb935c47";

const PAIR_LABEL: Record<string, string> = {
  [PAIR_IDS.BTC_USDC.toLowerCase()]: "BTC-USDC",
  [PAIR_IDS.ETH_USDC.toLowerCase()]: "ETH-USDC",
  [PAIR_IDS.EURC_USDC.toLowerCase()]: "EURC-USDC",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const BATCH_SIZE = 10;

// ── localStorage cache ─────────────────────────────────────────────────────────

function lsKey(trader: string) {
  return `arcperp:posids:${trader.toLowerCase()}`;
}

function cacheId(trader: string, id: string) {
  try {
    const set = new Set<string>(JSON.parse(localStorage.getItem(lsKey(trader)) ?? "[]") as string[]);
    set.add(id.toLowerCase());
    localStorage.setItem(lsKey(trader), JSON.stringify([...set]));
  } catch { /* storage unavailable */ }
}

function loadCachedIds(trader: string): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(lsKey(trader)) ?? "[]") as string[]);
  } catch { return new Set(); }
}

// ── Blockscout REST log discovery (primary — works on Arc testnet) ─────────────

interface BlockscoutLog {
  topics: string[];
  transaction_hash: string;
  block_number: number;
}

interface BlockscoutLogsResponse {
  items: BlockscoutLog[];
  next_page_params: Record<string, unknown> | null;
}

async function fetchPositionIdsFromExplorer(trader: string): Promise<string[]> {
  const paddedTrader = trader.toLowerCase().replace("0x", "").padStart(64, "0");
  const ids: string[] = [];

  // Blockscout v2 does NOT support ?topic0= filtering — must filter client-side
  let url: string | null =
    `${EXPLORER_API}/addresses/${ADDRESSES.perpEngine}/logs`;

  // Walk pages (max 10 to avoid infinite loops)
  for (let page = 0; page < 10 && url; page++) {
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json() as BlockscoutLogsResponse;

      for (const log of data.items) {
        // Filter client-side: must be a PositionOpened event
        if (log.topics[0]?.toLowerCase() !== POSITION_OPENED_TOPIC) continue;

        // topics[2] = indexed trader address (padded to 32 bytes)
        const traderTopic = log.topics[2]?.replace("0x", "").toLowerCase();
        if (traderTopic !== paddedTrader) continue;

        // topics[1] = indexed positionId
        const posId = log.topics[1];
        if (posId && posId.length === 66) ids.push(posId.toLowerCase());
      }

      if (!data.next_page_params) break;
      const params = new URLSearchParams(
        Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])
      );
      url = `${EXPLORER_API}/addresses/${ADDRESSES.perpEngine}/logs?${params}`;
    } catch { break; }
  }

  return ids;
}

// ── Batch position reads ───────────────────────────────────────────────────────

type RawPosition = readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, boolean];

async function batchReadPositions(ids: `0x${string}`[]): Promise<Array<RawPosition | null>> {
  const out: Array<RawPosition | null> = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map((id) =>
        client
          .readContract({ address: ADDRESSES.perpEngine, abi: PERP_ENGINE_ABI, functionName: "getPosition", args: [id] })
          .catch(() => null)
      )
    );
    out.push(...(results as Array<RawPosition | null>));
  }
  return out;
}

function safePairLabel(pairHash: string): string {
  return PAIR_LABEL[pairHash.toLowerCase()] ?? `${pairHash.slice(0, 8)}…`;
}

// ── Public types & hook ────────────────────────────────────────────────────────

export interface Position {
  id: string;
  pair: string;
  notional: string;
  margin: string;
  entryPrice: string;
  isLong: boolean;
  openedAtBlock: number;
  isLiquidated: boolean;
}

export function usePositions(trader: string | undefined): {
  positions: Position[];
  loading: boolean;
  error: Error | undefined;
  refetch: () => void;
} {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const cancelRef = useRef(false);

  const fetchPositions = useCallback(async () => {
    const traderAddr = trader?.toLowerCase();
    if (!traderAddr || !isAddress(traderAddr) || ADDRESSES.perpEngine === ZERO_ADDRESS) {
      setPositions([]);
      return;
    }

    cancelRef.current = false;
    setLoading(true);
    setError(undefined);

    try {
      // Merge: Blockscout API (primary) + localStorage cache
      const explorerIds = await fetchPositionIdsFromExplorer(traderAddr);
      if (cancelRef.current) return;

      const cached = loadCachedIds(traderAddr);
      explorerIds.forEach((id) => {
        cached.add(id);
        cacheId(traderAddr, id);
      });

      const allIds = [...cached] as `0x${string}`[];
      if (allIds.length === 0) {
        setPositions([]);
        return;
      }

      const results = await batchReadPositions(allIds);
      if (cancelRef.current) return;

      const open: Position[] = [];
      for (let i = 0; i < allIds.length; i++) {
        const result = results[i];
        if (!result || !Array.isArray(result) || result.length < 7) continue;

        const [posTrader, pair, notional, margin, entryPrice, openedAtBlock, isLong] = result;

        if (typeof posTrader !== "string" || !isAddress(posTrader)) continue;
        if (typeof pair !== "string") continue;
        if (typeof notional !== "bigint" || typeof margin !== "bigint" || typeof entryPrice !== "bigint") continue;
        if (posTrader === ZERO_ADDRESS) continue;
        if (posTrader.toLowerCase() !== traderAddr) continue;

        open.push({
          id: allIds[i],
          pair: safePairLabel(pair),
          notional: notional.toString(),
          margin: margin.toString(),
          entryPrice: entryPrice.toString(),
          isLong: Boolean(isLong),
          openedAtBlock: Number(openedAtBlock ?? 0n),
          isLiquidated: false,
        });
      }

      setPositions(open);
    } catch (err) {
      if (!cancelRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (!cancelRef.current) setLoading(false);
    }
  }, [trader]);

  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 5_000);
    return () => {
      cancelRef.current = true;
      clearInterval(interval);
    };
  }, [fetchPositions]);

  return { positions, loading, error, refetch: fetchPositions };
}

// ── Called by OrderPanel after successful openPosition ────────────────────────

export function cacheNewPositionId(trader: string, positionId: string) {
  cacheId(trader, positionId);
}

// ── Protocol stats stub ───────────────────────────────────────────────────────

export interface ProtocolStats {
  totalVolumeUsdc: string;
  totalFeesUsdc: string;
  totalLiquidations: number;
  openInterestLong: string;
  openInterestShort: string;
  insuranceFund: string;
  lastUpdated: number;
}

export function useProtocolStats(): { stats: ProtocolStats | null; loading: boolean } {
  return { stats: null, loading: false };
}
