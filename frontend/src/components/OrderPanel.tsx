import { useState, useMemo } from "react";
import { createPublicClient, createWalletClient, custom, decodeEventLog, http, parseUnits, formatUnits } from "viem";
import { HermesClient } from "@pythnetwork/hermes-client";
import { useWallet } from "../lib/wallet.js";
import { arcTestnet, perpContract } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";
import { cacheNewPositionId } from "../hooks/usePositions.js";
import { useMarginBalance } from "../hooks/useMarginBalance.js";
import type { PriceData } from "../hooks/usePrices.js";

const PYTH_IDS: Record<string, string> = {
  "BTC-USDC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
};

const HERMES = new HermesClient("https://hermes.pyth.network");
const LEVERAGE_STEPS = [1, 2, 5, 10, 15, 20, 25];
const pubClient = createPublicClient({ chain: arcTestnet, transport: http() });

interface Props {
  pair: { id: `0x${string}`; label: string };
  trader: `0x${string}` | undefined;
  prices: Record<string, PriceData>;
}

export function OrderPanel({ pair, trader, prices }: Props) {
  const { authenticated, login, getProvider } = useWallet();
  const { balance: vaultBalance } = useMarginBalance(trader);
  const [isLong, setIsLong] = useState(true);
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [positionId, setPositionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentPrice = prices[pair.label];
  const vaultBalanceUsdc = Number(formatUnits(vaultBalance, 6));

  const { notional, fee, liqPrice, marginNum } = useMemo(() => {
    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0 || !currentPrice) return { notional: 0, fee: 0, liqPrice: 0, marginNum: 0 };

    const n = m * leverage;
    const f = n * 0.0005;
    const entryP = parseFloat(currentPrice.price);
    const leverageFrac = 1 / leverage;
    const maintFrac = 0.025;
    const netDist = leverageFrac - maintFrac;
    const liq = isLong ? entryP * (1 - netDist) : entryP * (1 + netDist);
    return { notional: n, fee: f, liqPrice: liq, marginNum: m };
  }, [marginInput, leverage, isLong, currentPrice]);

  const insufficientBalance = authenticated && marginNum > 0 && marginNum > vaultBalanceUsdc;

  async function handleSubmit() {
    if (!authenticated) { login(); return; }
    if (!trader) return;

    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0) { setError("Enter a valid margin"); return; }
    if (m < 1) { setError("Minimum margin is 1 USDC"); return; }
    if (m > vaultBalanceUsdc) {
      setError(`Insufficient vault balance. Deposit at least $${(m - vaultBalanceUsdc).toFixed(2)} USDC first.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    setTxHash(null);
    setPositionId(null);

    try {
      const provider = await getProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });

      const feedId = PYTH_IDS[pair.label];
      if (!feedId) throw new Error(`No Pyth feed for ${pair.label}`);
      const updates = await HERMES.getLatestPriceUpdates([feedId]);
      const vaa = (updates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);

      const marginBn = parseUnits(m.toFixed(6), 6);
      const leverageBps = leverage * 100;

      // openPosition deducts from vault balance — no approve needed here
      const posHash = await walletClient.writeContract({
        ...perpContract,
        functionName: "openPosition",
        args: [pair.id, isLong, marginBn, BigInt(leverageBps), vaa],
      });

      setTxHash(posHash);
      setMarginInput("");

      // Wait for receipt and cache positionId for the positions panel
      try {
        const receipt = await pubClient.waitForTransactionReceipt({ hash: posHash, timeout: 30_000 });
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: PERP_ENGINE_ABI, eventName: "PositionOpened", data: log.data, topics: log.topics });
            const pid = decoded.args.positionId as string | undefined;
            if (pid) {
              cacheNewPositionId(trader, pid);
              setPositionId(pid);
              break;
            }
          } catch { /* not a PositionOpened log */ }
        }
      } catch { /* receipt timeout — position still opened on-chain */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = () => {
    if (!authenticated) return "Connect to Trade";
    if (submitting) return "Confirming…";
    return `Open ${isLong ? "Long" : "Short"}`;
  };

  return (
    <div className="panel" style={styles.wrapper}>
      <div className="heading" style={styles.title}>Open Position</div>

      {/* Vault balance indicator */}
      {authenticated && (
        <div style={styles.balanceBar}>
          <span className="label">Vault Balance</span>
          <span style={{ fontSize: 12, color: vaultBalanceUsdc > 0 ? "var(--text-primary)" : "var(--red)", fontWeight: 600 }}>
            ${vaultBalanceUsdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      {/* Deposit nudge when vault is empty */}
      {authenticated && vaultBalanceUsdc === 0 && (
        <div style={styles.nudge}>
          Deposit USDC above before opening a position
        </div>
      )}

      <div style={styles.toggle}>
        <button className={`btn ${isLong ? "btn-long" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(true)}>Long</button>
        <button className={`btn ${!isLong ? "btn-short" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(false)}>Short</button>
      </div>

      <div style={styles.field}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <label className="label">Margin (USDC)</label>
          {authenticated && vaultBalanceUsdc > 0 && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 10, padding: "1px 6px" }}
              onClick={() => setMarginInput(vaultBalanceUsdc.toFixed(2))}
            >
              Max
            </button>
          )}
        </div>
        <input
          className="input"
          type="number"
          min="0"
          step="1"
          placeholder="0.00"
          value={marginInput}
          onChange={(e) => setMarginInput(e.target.value)}
          style={insufficientBalance ? { borderColor: "var(--red)" } : undefined}
        />
        {insufficientBalance && (
          <span style={{ fontSize: 10, color: "var(--red)" }}>
            Exceeds vault balance (${vaultBalanceUsdc.toFixed(2)})
          </span>
        )}
      </div>

      <div style={styles.field}>
        <div style={styles.leverageHeader}>
          <label className="label">Leverage</label>
          <span className="price" style={styles.leverageValue}>{leverage}×</span>
        </div>
        <div style={styles.leveragePills}>
          {LEVERAGE_STEPS.map((step) => (
            <button
              key={step}
              className={`btn ${leverage === step ? "btn-primary" : "btn-ghost"}`}
              style={styles.leveragePill}
              onClick={() => setLeverage(step)}
            >
              {step}×
            </button>
          ))}
        </div>
      </div>

      {notional > 0 && (
        <div style={styles.summary}>
          <Row label="Notional" value={`$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          <Row label="Est. Fee" value={`$${fee.toFixed(2)}`} />
          <Row label="Liq. Price" value={`$${liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} accent={isLong ? "red" : "green"} />
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {txHash && (
        <div style={styles.txBox}>
          <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noopener noreferrer" style={styles.txLink}>
            View on ArcScan ↗
          </a>
          {positionId && (
            <div style={styles.posId}>Position tracked in Positions tab</div>
          )}
        </div>
      )}

      <button
        className={`btn ${isLong ? "btn-long" : "btn-short"}`}
        style={styles.submitBtn}
        onClick={handleSubmit}
        disabled={submitting || insufficientBalance || (!marginInput && authenticated)}
      >
        {submitLabel()}
      </button>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "red" | "green" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span className="label">{label}</span>
      <span style={{ fontSize: 12, color: accent === "red" ? "var(--red)" : accent === "green" ? "var(--green)" : "var(--text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

const styles = {
  wrapper: { padding: 16, display: "flex", flexDirection: "column" as const, gap: 14 },
  title: { marginBottom: 2 },
  balanceBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" },
  nudge: { fontSize: 11, color: "var(--yellow, #F59E0B)", padding: "6px 10px", background: "rgba(245,158,11,0.08)", borderRadius: "var(--radius-md)", textAlign: "center" as const },
  toggle: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  toggleBtn: { flex: 1, fontSize: 13 },
  field: { display: "flex", flexDirection: "column" as const, gap: 6 },
  leverageHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  leverageValue: { fontSize: 14, color: "var(--cyan)" },
  leveragePills: { display: "flex", gap: 4, flexWrap: "wrap" as const },
  leveragePill: { padding: "4px 8px", fontSize: 11, minWidth: 36 },
  summary: { display: "flex", flexDirection: "column" as const, gap: 6, padding: 12, background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" },
  error: { fontSize: 12, color: "var(--red)", padding: "8px 12px", background: "var(--red-dim)", borderRadius: "var(--radius-md)" },
  txBox: { display: "flex", flexDirection: "column" as const, gap: 4 },
  txLink: { fontSize: 11, color: "var(--cyan)", textDecoration: "none" },
  posId: { fontSize: 10, color: "var(--text-secondary)" },
  submitBtn: { width: "100%", padding: "12px", fontSize: 14, marginTop: 4 },
} satisfies Record<string, React.CSSProperties>;
