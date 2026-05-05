import { useEffect, useState } from "react";
import { createClient, vaultContract } from "../lib/contracts.js";

const POLL_INTERVAL_MS = 10_000;

export function useMarginBalance(trader: `0x${string}` | undefined): {
  balance: bigint;
  loading: boolean;
  refetch: () => void;
} {
  const [balance, setBalance] = useState(0n);
  const [loading, setLoading] = useState(false);
  const client = createClient();

  async function fetch() {
    if (!trader) return;
    setLoading(true);
    try {
      const result = await client.readContract({
        ...vaultContract,
        functionName: "getMarginBalance",
        args: [trader],
      });
      setBalance(result);
    } catch {
      // RPC error — keep stale value
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetch();
    const id = setInterval(() => void fetch(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trader]);

  return { balance, loading, refetch: fetch };
}
