import { useEffect, useState } from "react";
import { gql, useQuery } from "@apollo/client";

const POSITIONS_QUERY = gql`
  query OpenPositions($trader: String!) {
    positions(where: { trader: $trader, closedAt: null }, orderBy: openedAt, orderDirection: desc) {
      id
      pair
      notional
      margin
      entryPrice
      isLong
      openedAt
      isLiquidated
    }
  }
`;

export interface Position {
  id: string;
  pair: string;
  notional: string;
  margin: string;
  entryPrice: string;
  isLong: boolean;
  openedAt: number;
  isLiquidated: boolean;
}

export function usePositions(trader: string | undefined): {
  positions: Position[];
  loading: boolean;
  error: Error | undefined;
  refetch: () => void;
} {
  const { data, loading, error, refetch } = useQuery<{ positions: Position[] }>(POSITIONS_QUERY, {
    variables: { trader: trader?.toLowerCase() ?? "" },
    skip: !trader,
    pollInterval: 5_000,
  });

  return {
    positions: data?.positions ?? [],
    loading,
    error: error as Error | undefined,
    refetch,
  };
}

// ── Protocol stats ────────────────────────────────────────────────────────────

const STATS_QUERY = gql`
  query ProtocolStats {
    protocolStats(id: "global") {
      totalVolumeUsdc
      totalFeesUsdc
      totalLiquidations
      openInterestLong
      openInterestShort
      insuranceFund
      lastUpdated
    }
  }
`;

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
  const { data, loading } = useQuery<{ protocolStats: ProtocolStats | null }>(STATS_QUERY, {
    pollInterval: 15_000,
  });
  return { stats: data?.protocolStats ?? null, loading };
}
