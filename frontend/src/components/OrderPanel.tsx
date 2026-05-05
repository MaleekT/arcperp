import { useState, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, parseUnits } from "viem";
import { HermesClient } from "@pythnetwork/hermes-client";
import { arcTestnet, perpContract, usdcContract, ADDRESSES } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";
import type { PriceData } from "../hooks/usePrices.js";

const PYTH_IDS: Record<string, string> = {
  "BTC-USDC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
};

const HERMES = new HermesClient("https://hermes.pyth.network");
const LEVERAGE_STEPS = [1, 2, 5, 10, 15, 20, 25];

interface Props {
  pair: { id: `0x${string}`; label: string };
  trader: `0x${string}` | undefined;
  prices: Record<string, PriceData>;
}

export function OrderPanel({ pair, trader, prices }: Props) {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const [isLong, setIsLong] = useState(true);
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentPrice = prices[pair.label];

  const { notional, fee, liqPrice } = useMemo(() => {
    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0 || !currentPrice) return { notional: 0, fee: 0, liqPrice: 0 };

    const n = m * leverage;
    const f = n * 0.0005; // 0.05% taker fee
    const entryP = parseFloat(currentPrice.price);
    const leverageFrac = 1 / leverage;
    const maintFrac = 0.025; // 2.5%
    const netDist = leverageFrac - maintFrac;
    const liq = isLong ? entryP * (1 - netDist) : entryP * (1 + netDist);
    return { notional: n, fee: f, liqPrice: liq };
  }, [marginInput, leverage, isLong, currentPrice]);

  async function handleSubmit() {
    if (!authenticated) { login(); return; }
    if (!trader || !wallets[0]) return;

    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0) { setError("Enter a valid margin"); return; }
    if (m < 1) { setError("Minimum margin is 1 USDC"); return; }

    setSubmitting(true);
    setError(null);
    setTxHash(null);

    try {
      const provider = await wallets[0].getEthereumProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });

      // Fetch Pyth VAA
      const feedId = PYTH_IDS[pair.label];
      if (!feedId) throw new Error(`No Pyth feed for ${pair.label}`);
      const updates = await HERMES.getLatestPriceUpdates([feedId]);
      const vaa = (updates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);

      const marginBn = parseUnits(m.toFixed(6), 6);
      const leverageBps = leverage * 100;

      // Approve vault to spend USDC if needed
      const hash = await walletClient.writeContract({
        ...usdcContract,
        functionName: "approve",
        args: [ADDRESSES.vault, marginBn],
      });
      // Fire-and-forget approval — vault checks allowance in deposit
      void hash;

      const posHash = await walletClient.writeContract({
        ...perpContract,
        functionName: "openPosition",
        args: [pair.id, isLong, marginBn, BigInt(leverageBps), vaa],
      });

      setTxHash(posHash);
      setMarginInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel" style={styles.wrapper}>
      <div className="heading" style={styles.title}>Open Position</div>

      {/* Long / Short toggle */}
      <div style={styles.toggle}>
        <button
          className={`btn ${isLong ? "btn-long" : "btn-ghost"}`}
          style={styles.toggleBtn}
          onClick={() => setIsLong(true)}
        >
          Long
        </button>
        <button
          className={`btn ${!isLong ? "btn-short" : "btn-ghost"}`}
          style={styles.toggleBtn}
          onClick={() => setIsLong(false)}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div style={styles.field}>
        <label className="label">Margin (USDC)</label>
        <div style={styles.inputRow}>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="0.00"
            value={marginInput}
            onChange={(e) => setMarginInput(e.target.value)}
          />
        </div>
      </div>

      {/* Leverage slider */}
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

      {/* Order summary */}
      {notional > 0 && (
        <div style={styles.summary}>
          <Row label="Notional" value={`$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          <Row label="Est. Fee" value={`$${fee.toFixed(2)}`} />
          <Row
            label="Liq. Price"
            value={`$${liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
            accent={isLong ? "red" : "green"}
          />
        </div>
      )}

      {/* Error / tx hash */}
      {error && <div style={styles.error}>{error}</div>}
      {txHash && (
        <a
          href={`https://testnet.arcscan.app/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.txLink}
        >
          View on ArcScan ↗
        </a>
      )}

      {/* Submit */}
      <button
        className={`btn ${isLong ? "btn-long" : "btn-short"}`}
        style={styles.submitBtn}
        onClick={handleSubmit}
        disabled={submitting || (!marginInput && authenticated)}
      >
        {submitting ? "Confirming…" : authenticated ? `Open ${isLong ? "Long" : "Short"}` : "Connect to Trade"}
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
  toggle: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  toggleBtn: { flex: 1, fontSize: 13 },
  field: { display: "flex", flexDirection: "column" as const, gap: 6 },
  inputRow: { position: "relative" as const },
  leverageHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  leverageValue: { fontSize: 14, color: "var(--cyan)" },
  leveragePills: { display: "flex", gap: 4, flexWrap: "wrap" as const },
  leveragePill: { padding: "4px 8px", fontSize: 11, minWidth: 36 },
  summary: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    padding: 12,
    background: "var(--bg-elevated)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-subtle)",
  },
  error: { fontSize: 12, color: "var(--red)", padding: "8px 12px", background: "var(--red-dim)", borderRadius: "var(--radius-md)" },
  txLink: { fontSize: 11, color: "var(--cyan)", textDecoration: "none" },
  submitBtn: { width: "100%", padding: "12px", fontSize: 14, marginTop: 4 },
} satisfies Record<string, React.CSSProperties>;
