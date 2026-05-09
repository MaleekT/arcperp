import { useState, useMemo } from "react";
import { createPublicClient, createWalletClient, custom, decodeEventLog, http, parseUnits, formatUnits } from "viem";
import { useWallet } from "../lib/wallet.js";
import { arcTestnet, perpContract } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";
import { cacheNewPositionId } from "../hooks/usePositions.js";
import { useMarginBalance } from "../hooks/useMarginBalance.js";
import { useLimitOrders, fetchOraclePrice, PYTH_IDS } from "../hooks/useLimitOrders.js";
import type { PriceData } from "../hooks/usePrices.js";

const LEVERAGE_STEPS = [1, 2, 5, 10, 15, 20, 25];
const pubClient = createPublicClient({ chain: arcTestnet, transport: http() });

type OrderType = "market" | "limit";
type MarketStep = "idle" | "previewing" | "confirm" | "submitting";

interface Props {
  pair: { id: `0x${string}`; label: string };
  trader: `0x${string}` | undefined;
  prices: Record<string, PriceData>;
}

interface OraclePreview {
  price: number;
  vaa: `0x${string}`[];
}

export function OrderPanel({ pair, trader, prices }: Props) {
  const { authenticated, login, getProvider } = useWallet();
  const { balance: vaultBalance } = useMarginBalance(trader);
  const { pendingOrders, placeLimitOrder, cancelOrder } = useLimitOrders(trader, prices, getProvider);

  const [orderType, setOrderType] = useState<OrderType>("market");
  const [isLong, setIsLong] = useState(true);
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [limitPriceInput, setLimitPriceInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [marketStep, setMarketStep] = useState<MarketStep>("idle");
  const [oraclePreview, setOraclePreview] = useState<OraclePreview | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [positionId, setPositionId] = useState<string | null>(null);

  const currentPrice = prices[pair.label];
  const vaultBalanceUsdc = Number(formatUnits(vaultBalance, 6));

  const { notional, fee, liqPrice, marginNum } = useMemo(() => {
    const m = parseFloat(marginInput);
    const entryP = oraclePreview?.price ?? (currentPrice ? parseFloat(currentPrice.price) : 0);
    if (!Number.isFinite(m) || m <= 0 || !entryP) return { notional: 0, fee: 0, liqPrice: 0, marginNum: 0 };

    const n = m * leverage;
    const f = n * 0.0005;
    const netDist = 1 / leverage - 0.025;
    const liq = isLong ? entryP * (1 - netDist) : entryP * (1 + netDist);
    return { notional: n, fee: f, liqPrice: liq, marginNum: m };
  }, [marginInput, leverage, isLong, currentPrice, oraclePreview]);

  const insufficientBalance = authenticated && marginNum > 0 && marginNum > vaultBalanceUsdc;

  function validateOrder(): string | null {
    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0) return "Enter a valid margin";
    if (m < 1) return "Minimum margin is 1 USDC";
    if (m > vaultBalanceUsdc) return `Insufficient balance — deposit $${(m - vaultBalanceUsdc).toFixed(2)} more`;
    return null;
  }

  async function handleMarketPreview() {
    if (!authenticated) { login(); return; }
    const err = validateOrder();
    if (err) { setError(err); return; }

    setError(null);
    setMarketStep("previewing");
    try {
      const preview = await fetchOraclePrice(pair.label);
      setOraclePreview(preview);
      setMarketStep("confirm");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch oracle price");
      setMarketStep("idle");
    }
  }

  async function handleMarketConfirm() {
    if (!trader) return;
    setMarketStep("submitting");
    setError(null);

    try {
      const { vaa } = await fetchOraclePrice(pair.label);
      const provider = await getProvider();
      const walletClient = createWalletClient({
        account: trader,
        chain: arcTestnet,
        transport: custom(provider as Parameters<typeof custom>[0]),
      });

      const m = parseFloat(marginInput);
      const posHash = await walletClient.writeContract({
        ...perpContract,
        functionName: "openPosition",
        args: [pair.id, isLong, parseUnits(m.toFixed(6), 6), BigInt(leverage * 100), vaa],
      });

      setTxHash(posHash);
      setMarginInput("");
      setOraclePreview(null);
      setMarketStep("idle");

      try {
        const receipt = await pubClient.waitForTransactionReceipt({ hash: posHash, timeout: 30_000 });
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: PERP_ENGINE_ABI, eventName: "PositionOpened", data: log.data, topics: log.topics });
            const pid = decoded.args.positionId as string | undefined;
            if (pid) { cacheNewPositionId(trader, pid); setPositionId(pid); break; }
          } catch { /* not a PositionOpened log */ }
        }
      } catch { /* receipt timeout — position still opened */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
      setMarketStep("confirm");
    }
  }

  function handleLimitPlace() {
    if (!authenticated) { login(); return; }
    if (!trader) return;

    const err = validateOrder();
    if (err) { setError(err); return; }

    const limitPrice = parseFloat(limitPriceInput);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) { setError("Enter a valid limit price"); return; }
    if (!PYTH_IDS[pair.label]) { setError(`No oracle feed for ${pair.label}`); return; }

    setError(null);
    placeLimitOrder({
      trader,
      pair: pair.label,
      pairId: pair.id,
      isLong,
      marginUsdc: parseFloat(marginInput),
      leverage,
      limitPrice,
    });
    setMarginInput("");
    setLimitPriceInput("");
  }

  function cancelPreview() {
    setOraclePreview(null);
    setMarketStep("idle");
    setError(null);
  }

  function switchOrderType(t: OrderType) {
    setOrderType(t);
    setError(null);
    cancelPreview();
  }

  const isMarket = orderType === "market";
  const showActionBtn = isMarket ? (marketStep === "idle" || marketStep === "previewing") : true;

  return (
    <div className="panel" style={styles.wrapper}>
      <div className="heading" style={styles.title}>Open Position</div>

      {/* Order type tabs */}
      <div style={styles.typeTabs}>
        <button className={`btn ${isMarket ? "btn-primary" : "btn-ghost"}`} style={styles.typeTab} onClick={() => switchOrderType("market")}>Market</button>
        <button className={`btn ${!isMarket ? "btn-primary" : "btn-ghost"}`} style={styles.typeTab} onClick={() => switchOrderType("limit")}>Limit</button>
      </div>

      {/* Vault balance */}
      {authenticated && (
        <div style={styles.balanceBar}>
          <span className="label">Vault Balance</span>
          <span style={{ fontSize: 12, color: vaultBalanceUsdc > 0 ? "var(--text-primary)" : "var(--red)", fontWeight: 600 }}>
            ${vaultBalanceUsdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      {authenticated && vaultBalanceUsdc === 0 && (
        <div style={styles.nudge}>Deposit USDC above before opening a position</div>
      )}

      {/* Long / Short */}
      <div style={styles.toggle}>
        <button className={`btn ${isLong ? "btn-long" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(true)}>Long</button>
        <button className={`btn ${!isLong ? "btn-short" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(false)}>Short</button>
      </div>

      {/* Margin */}
      <div style={styles.field}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <label className="label">Margin (USDC)</label>
          {authenticated && vaultBalanceUsdc > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 10, padding: "1px 6px" }} onClick={() => setMarginInput(vaultBalanceUsdc.toFixed(2))}>Max</button>
          )}
        </div>
        <input className="input" type="number" min="0" step="1" placeholder="0.00" value={marginInput}
          onChange={(e) => setMarginInput(e.target.value)}
          style={insufficientBalance ? { borderColor: "var(--red)" } : undefined} />
        {insufficientBalance && <span style={{ fontSize: 10, color: "var(--red)" }}>Exceeds vault balance (${vaultBalanceUsdc.toFixed(2)})</span>}
      </div>

      {/* Limit price (limit orders only) */}
      {!isMarket && (
        <div style={styles.field}>
          <label className="label">{isLong ? "Trigger price — buy at or below (USDC)" : "Trigger price — sell at or above (USDC)"}</label>
          <input className="input" type="number" min="0" step="any"
            placeholder={currentPrice ? currentPrice.price : "0.00"}
            value={limitPriceInput} onChange={(e) => setLimitPriceInput(e.target.value)} />
          <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
            {isLong ? "Order submits when market price ≤ this value" : "Order submits when market price ≥ this value"}
          </span>
        </div>
      )}

      {/* Leverage */}
      <div style={styles.field}>
        <div style={styles.leverageHeader}>
          <label className="label">Leverage</label>
          <span className="price" style={styles.leverageValue}>{leverage}×</span>
        </div>
        <div style={styles.leveragePills}>
          {LEVERAGE_STEPS.map((s) => (
            <button key={s} className={`btn ${leverage === s ? "btn-primary" : "btn-ghost"}`} style={styles.leveragePill} onClick={() => setLeverage(s)}>{s}×</button>
          ))}
        </div>
      </div>

      {/* Summary */}
      {notional > 0 && (
        <div style={styles.summary}>
          {isMarket && marketStep === "confirm" && oraclePreview && (
            <Row label="Entry Price (Oracle)" value={`$${oraclePreview.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} accent="green" />
          )}
          {!isMarket && limitPriceInput && Number.isFinite(parseFloat(limitPriceInput)) && (
            <Row label="Limit Price" value={`$${parseFloat(limitPriceInput).toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          )}
          <Row label="Notional" value={`$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          <Row label="Est. Fee" value={`$${fee.toFixed(2)}`} />
          <Row label="Liq. Price" value={`$${liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} accent={isLong ? "red" : "green"} />
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {/* Market — confirm prompt */}
      {isMarket && marketStep === "confirm" && oraclePreview && (
        <div style={styles.confirmBox}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
            Your position will open at the oracle entry price above. Price may move slightly before on-chain settlement.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" style={{ flex: 1, fontSize: 12 }} onClick={cancelPreview}>Cancel</button>
            <button
              className={`btn ${isLong ? "btn-long" : "btn-short"}`}
              style={{ flex: 2, fontSize: 13 }}
              onClick={handleMarketConfirm}
              disabled={marketStep as string === "submitting"}
            >
              Confirm &amp; Open
            </button>
          </div>
        </div>
      )}

      {txHash && (
        <div style={styles.txBox}>
          <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noopener noreferrer" style={styles.txLink}>View on ArcScan ↗</a>
          {positionId && <div style={styles.posId}>Position tracked in Positions tab</div>}
        </div>
      )}

      {/* Primary action button */}
      {showActionBtn && (
        <button
          className={`btn ${isLong ? "btn-long" : "btn-short"}`}
          style={styles.submitBtn}
          onClick={isMarket ? handleMarketPreview : handleLimitPlace}
          disabled={marketStep === "previewing" || insufficientBalance || (!marginInput && authenticated)}
        >
          {!authenticated
            ? "Connect to Trade"
            : marketStep === "previewing"
            ? "Fetching Price…"
            : isMarket
            ? `Preview ${isLong ? "Long" : "Short"}`
            : `Place Limit ${isLong ? "Long" : "Short"}`}
        </button>
      )}

      {/* Pending limit orders list */}
      {!isMarket && pendingOrders.length > 0 && (
        <div style={styles.limitOrderList}>
          <div className="label" style={{ marginBottom: 4 }}>Pending Orders</div>
          {pendingOrders.map((o) => (
            <div key={o.id} style={styles.limitRow}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 11, color: o.isLong ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{o.isLong ? "Long" : "Short"}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 6 }}>@ ${o.limitPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                <span style={{ fontSize: 10, color: "var(--text-secondary)", marginLeft: 6 }}>${o.marginUsdc} × {o.leverage}×</span>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => cancelOrder(o.id)}>Cancel</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "red" | "green" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span className="label">{label}</span>
      <span style={{ fontSize: 12, color: accent === "red" ? "var(--red)" : accent === "green" ? "var(--green)" : "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

const styles = {
  wrapper: { padding: 16, display: "flex", flexDirection: "column" as const, gap: 14 },
  title: { marginBottom: 2 },
  typeTabs: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  typeTab: { fontSize: 12 },
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
  confirmBox: { padding: 12, background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--cyan, #06b6d4)", display: "flex", flexDirection: "column" as const, gap: 8 },
  error: { fontSize: 12, color: "var(--red)", padding: "8px 12px", background: "var(--red-dim)", borderRadius: "var(--radius-md)" },
  txBox: { display: "flex", flexDirection: "column" as const, gap: 4 },
  txLink: { fontSize: 11, color: "var(--cyan)", textDecoration: "none" },
  posId: { fontSize: 10, color: "var(--text-secondary)" },
  submitBtn: { width: "100%", padding: "12px", fontSize: 14, marginTop: 4 },
  limitOrderList: { display: "flex", flexDirection: "column" as const, gap: 4, padding: 10, background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" },
  limitRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border-subtle)" },
} satisfies Record<string, React.CSSProperties>;
