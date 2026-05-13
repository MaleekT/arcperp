import { useState, useMemo } from "react";
import { createPublicClient, createWalletClient, custom, decodeEventLog, http, parseUnits, formatUnits } from "viem";
import { useWallet } from "../lib/wallet.js";
import { arcTestnet, perpContract } from "../lib/contracts.js";
import { PERP_ENGINE_ABI } from "../lib/abis/index.js";
import { cacheNewPositionId } from "../hooks/usePositions.js";
import { useMarginBalance } from "../hooks/useMarginBalance.js";
import { useOrderServer, type TIF } from "../hooks/useOrderServer.js";
import { fetchOraclePrice, PYTH_IDS } from "../hooks/useLimitOrders.js";
import type { PriceData } from "../hooks/usePrices.js";

const LEVERAGE_STEPS = [1, 2, 5, 10, 15, 20, 25];
const TWAP_INTERVALS = [
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "30m", ms: 1_800_000 },
  { label: "1h", ms: 3_600_000 },
];
const pubClient = createPublicClient({ chain: arcTestnet, transport: http() });

type OrderTypeTab = "market" | "limit" | "advanced";
type AdvancedSubType = "stop_market" | "stop_limit" | "trailing_stop" | "twap" | "scale";
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
  const {
    pendingOrders,
    placeLimitOrder,
    placeStopMarket,
    placeStopLimit,
    placeTrailingStop,
    placeTwapOrder,
    placeScaleOrder,
    cancelOrder,
    executorApproved,
    executorAddress,
    approving,
    approveError,
    approveExecutor,
  } = useOrderServer(trader);

  // ── Tab state ────────────────────────────────────────────────────────────────
  const [orderTypeTab, setOrderTypeTab] = useState<OrderTypeTab>("market");
  const [advancedSubType, setAdvancedSubType] = useState<AdvancedSubType>("stop_market");
  const [tif, setTif] = useState<TIF>("GTC");

  // ── Shared fields ────────────────────────────────────────────────────────────
  const [isLong, setIsLong] = useState(true);
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [slippageTolerance, setSlippageTolerance] = useState("0.5");
  const [error, setError] = useState<string | null>(null);

  // ── Market-only state ────────────────────────────────────────────────────────
  const [marketStep, setMarketStep] = useState<MarketStep>("idle");
  const [oraclePreview, setOraclePreview] = useState<OraclePreview | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [positionId, setPositionId] = useState<string | null>(null);

  // ── Limit-only state ─────────────────────────────────────────────────────────
  const [limitPriceInput, setLimitPriceInput] = useState("");

  // ── Advanced fields ──────────────────────────────────────────────────────────
  const [stopTriggerInput, setStopTriggerInput] = useState("");
  const [stopLimitPriceInput, setStopLimitPriceInput] = useState("");
  const [trailPercentInput, setTrailPercentInput] = useState("1.5");
  const [twapSlices, setTwapSlices] = useState(4);
  const [twapIntervalMs, setTwapIntervalMs] = useState(900_000);
  const [scalePriceFrom, setScalePriceFrom] = useState("");
  const [scalePriceTo, setScalePriceTo] = useState("");
  const [scaleNumOrders, setScaleNumOrders] = useState(5);

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

  function validateMargin(): string | null {
    const m = parseFloat(marginInput);
    if (!Number.isFinite(m) || m <= 0) return "Enter a valid margin";
    if (m < 1) return "Minimum margin is 1 USDC";
    if (m > vaultBalanceUsdc) return `Insufficient balance — deposit $${(m - vaultBalanceUsdc).toFixed(2)} more`;
    return null;
  }

  function resetPanel() {
    setMarginInput("");
    setLimitPriceInput("");
    setStopTriggerInput("");
    setStopLimitPriceInput("");
    setError(null);
  }

  // ── Market handlers ──────────────────────────────────────────────────────────
  async function handleMarketPreview() {
    if (!authenticated) { login(); return; }
    const err = validateMargin();
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
      const previewE8 = BigInt(Math.round((oraclePreview?.price ?? 0) * 1e8));
      const slipBps = BigInt(Math.round(Math.max(0, parseFloat(slippageTolerance) || 0.5) * 100));
      const minPriceBig = previewE8 > 0n ? (previewE8 * (10000n - slipBps)) / 10000n : 0n;
      const maxPriceBig = previewE8 > 0n ? (previewE8 * (10000n + slipBps)) / 10000n : 0n;

      const posHash = await walletClient.writeContract({
        ...perpContract,
        functionName: "openPosition",
        args: [pair.id, isLong, parseUnits(m.toFixed(6), 6), BigInt(leverage * 100), minPriceBig, maxPriceBig, vaa],
        value: 0n,
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
      } catch { /* receipt timeout */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
      setMarketStep("confirm");
    }
  }

  function cancelPreview() {
    setOraclePreview(null);
    setMarketStep("idle");
    setError(null);
  }

  // ── Limit handler ────────────────────────────────────────────────────────────
  async function handleLimitPlace() {
    if (!authenticated) { login(); return; }
    if (!trader) return;
    const err = validateMargin();
    if (err) { setError(err); return; }
    const triggerPrice = parseFloat(limitPriceInput);
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) { setError("Enter a valid limit price"); return; }
    if (!PYTH_IDS[pair.label]) { setError(`No oracle feed for ${pair.label}`); return; }
    setError(null);
    try {
      await placeLimitOrder({ pair: pair.label, pairId: pair.id, isLong, marginUsdc: parseFloat(marginInput), leverage, triggerPrice, tif });
      resetPanel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to place order");
    }
  }

  // ── Advanced handler ─────────────────────────────────────────────────────────
  async function handleAdvancedPlace() {
    if (!authenticated) { login(); return; }
    if (!trader) return;
    setError(null);

    try {
      if (advancedSubType === "stop_market") {
        const err = validateMargin();
        if (err) { setError(err); return; }
        const triggerPrice = parseFloat(stopTriggerInput);
        if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) { setError("Enter a valid trigger price"); return; }
        await placeStopMarket({ pair: pair.label, pairId: pair.id, isLong, marginUsdc: parseFloat(marginInput), leverage, triggerPrice, tif });
        resetPanel();

      } else if (advancedSubType === "stop_limit") {
        const err = validateMargin();
        if (err) { setError(err); return; }
        const triggerPrice = parseFloat(stopTriggerInput);
        const limitPrice = parseFloat(stopLimitPriceInput);
        if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) { setError("Enter a valid trigger price"); return; }
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) { setError("Enter a valid limit price"); return; }
        await placeStopLimit({ pair: pair.label, pairId: pair.id, isLong, marginUsdc: parseFloat(marginInput), leverage, triggerPrice, limitPrice, tif });
        resetPanel();

      } else if (advancedSubType === "trailing_stop") {
        const trailPercent = parseFloat(trailPercentInput);
        if (!Number.isFinite(trailPercent) || trailPercent <= 0) { setError("Trail % must be > 0"); return; }
        const triggerPrice = parseFloat(stopTriggerInput);
        if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) { setError("Enter a reference trigger price"); return; }
        await placeTrailingStop({ pair: pair.label, pairId: pair.id, isLong, positionId: "0x0" as `0x${string}`, triggerPrice, trailPercent });
        resetPanel();

      } else if (advancedSubType === "twap") {
        const err = validateMargin();
        if (err) { setError(err); return; }
        if (twapSlices < 2) { setError("Slices must be at least 2"); return; }
        const triggerPrice = parseFloat(stopTriggerInput);
        if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) { setError("Enter a trigger price to start TWAP"); return; }
        await placeTwapOrder({ pair: pair.label, pairId: pair.id, isLong, marginUsdc: parseFloat(marginInput), leverage, triggerPrice, numSlices: twapSlices, sliceIntervalMs: twapIntervalMs });
        resetPanel();

      } else if (advancedSubType === "scale") {
        const err = validateMargin();
        if (err) { setError(err); return; }
        const priceFrom = parseFloat(scalePriceFrom);
        const priceTo = parseFloat(scalePriceTo);
        if (!Number.isFinite(priceFrom) || priceFrom <= 0) { setError("Enter a valid price from"); return; }
        if (!Number.isFinite(priceTo) || priceTo <= 0) { setError("Enter a valid price to"); return; }
        if (priceFrom === priceTo) { setError("Price from and price to must differ"); return; }
        if (scaleNumOrders < 2 || scaleNumOrders > 20) { setError("Orders must be between 2 and 20"); return; }
        await placeScaleOrder({ pair: pair.label, pairId: pair.id, isLong, totalMarginUsdc: parseFloat(marginInput), leverage, priceFrom, priceTo, numOrders: scaleNumOrders, tif });
        resetPanel();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to place order");
    }
  }

  function switchTab(t: OrderTypeTab) {
    setOrderTypeTab(t);
    setError(null);
    cancelPreview();
  }

  const showNeedsExecutor = orderTypeTab !== "market" && executorAddress && !executorApproved && authenticated;
  const isMarket = orderTypeTab === "market";

  return (
    <div className="panel" style={styles.wrapper}>
      <div className="heading" style={styles.title}>Open Position</div>

      {/* ── 3-tab header ── */}
      <div style={styles.typeTabs}>
        {(["market", "limit", "advanced"] as OrderTypeTab[]).map((t) => (
          <button
            key={t}
            className={`btn ${orderTypeTab === t ? "btn-primary" : "btn-ghost"}`}
            style={styles.typeTab}
            onClick={() => switchTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Advanced sub-type pills ── */}
      {orderTypeTab === "advanced" && (
        <div style={styles.subTypePills}>
          {(["stop_market", "stop_limit", "trailing_stop", "twap", "scale"] as AdvancedSubType[]).map((s) => (
            <button
              key={s}
              className={`btn ${advancedSubType === s ? "btn-primary" : "btn-ghost"}`}
              style={styles.subTypePill}
              onClick={() => { setAdvancedSubType(s); setError(null); }}
            >
              {s === "stop_market" ? "Stop Mkt" : s === "stop_limit" ? "Stop Lmt" : s === "trailing_stop" ? "Trailing" : s === "twap" ? "TWAP" : "Scale"}
            </button>
          ))}
        </div>
      )}

      {/* ── Vault balance ── */}
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

      {/* ── Long / Short ── */}
      <div style={styles.toggle}>
        <button className={`btn ${isLong ? "btn-long" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(true)}>Long</button>
        <button className={`btn ${!isLong ? "btn-short" : "btn-ghost"}`} style={styles.toggleBtn} onClick={() => setIsLong(false)}>Short</button>
      </div>

      {/* ── Margin ── */}
      {advancedSubType !== "trailing_stop" && (
        <div style={styles.field}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label className="label">{orderTypeTab === "advanced" && advancedSubType === "scale" ? "Total Margin (USDC)" : "Margin (USDC)"}</label>
            {authenticated && vaultBalanceUsdc > 0 && (
              <button className="btn btn-ghost" style={{ fontSize: 10, padding: "1px 6px" }} onClick={() => setMarginInput(vaultBalanceUsdc.toFixed(2))}>Max</button>
            )}
          </div>
          <input className="input" type="number" min="0" step="1" placeholder="0.00" value={marginInput}
            onChange={(e) => setMarginInput(e.target.value)}
            style={insufficientBalance ? { borderColor: "var(--red)" } : undefined} />
          {insufficientBalance && <span style={{ fontSize: 10, color: "var(--red)" }}>Exceeds vault balance (${vaultBalanceUsdc.toFixed(2)})</span>}
        </div>
      )}

      {/* ── Per-tab form fields ── */}

      {/* Limit tab */}
      {orderTypeTab === "limit" && (
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

      {/* Advanced — Stop Market */}
      {orderTypeTab === "advanced" && advancedSubType === "stop_market" && (
        <div style={styles.field}>
          <label className="label">{isLong ? "Trigger price — enter when price rises to (USDC)" : "Trigger price — enter when price falls to (USDC)"}</label>
          <input className="input" type="number" min="0" step="any"
            placeholder={currentPrice ? currentPrice.price : "0.00"}
            value={stopTriggerInput} onChange={(e) => setStopTriggerInput(e.target.value)} />
          <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
            {isLong ? `Long entry when price ≥ $${stopTriggerInput || "…"}` : `Short entry when price ≤ $${stopTriggerInput || "…"}`}
          </span>
        </div>
      )}

      {/* Advanced — Stop Limit */}
      {orderTypeTab === "advanced" && advancedSubType === "stop_limit" && (
        <>
          <div style={styles.field}>
            <label className="label">Trigger price (USDC)</label>
            <input className="input" type="number" min="0" step="any"
              placeholder={currentPrice ? currentPrice.price : "0.00"}
              value={stopTriggerInput} onChange={(e) => setStopTriggerInput(e.target.value)} />
            <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>Activates the order when price breaks out</span>
          </div>
          <div style={styles.field}>
            <label className="label">{isLong ? "Limit price — max fill price (USDC)" : "Limit price — min fill price (USDC)"}</label>
            <input className="input" type="number" min="0" step="any" placeholder="0.00"
              value={stopLimitPriceInput} onChange={(e) => setStopLimitPriceInput(e.target.value)} />
            <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              {isLong ? "Protects against filling above this price" : "Protects against filling below this price"}
            </span>
          </div>
        </>
      )}

      {/* Advanced — Trailing Stop */}
      {orderTypeTab === "advanced" && advancedSubType === "trailing_stop" && (
        <>
          <div style={styles.field}>
            <label className="label">Reference price (USDC) — sets initial peak</label>
            <input className="input" type="number" min="0" step="any"
              placeholder={currentPrice ? currentPrice.price : "0.00"}
              value={stopTriggerInput} onChange={(e) => setStopTriggerInput(e.target.value)} />
          </div>
          <div style={styles.field}>
            <label className="label">Trail % — retrace threshold</label>
            <input className="input" type="number" min="0.1" max="20" step="0.1"
              value={trailPercentInput} onChange={(e) => setTrailPercentInput(e.target.value)} />
            <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              Follows price; closes when it retraces {trailPercentInput || "…"}% from peak. Always GTC.
            </span>
          </div>
        </>
      )}

      {/* Advanced — TWAP */}
      {orderTypeTab === "advanced" && advancedSubType === "twap" && (
        <>
          <div style={styles.field}>
            <label className="label">Trigger price — start TWAP when price reaches (USDC)</label>
            <input className="input" type="number" min="0" step="any"
              placeholder={currentPrice ? currentPrice.price : "0.00"}
              value={stopTriggerInput} onChange={(e) => setStopTriggerInput(e.target.value)} />
          </div>
          <div style={styles.field}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label className="label">Slices</label>
              <span style={{ fontSize: 12, color: "var(--cyan)", fontWeight: 600 }}>{twapSlices}</span>
            </div>
            <input type="range" min={2} max={10} step={1} value={twapSlices} onChange={(e) => setTwapSlices(Number(e.target.value))} style={{ width: "100%" }} />
          </div>
          <div style={styles.field}>
            <label className="label">Interval between slices</label>
            <div style={{ display: "flex", gap: 4 }}>
              {TWAP_INTERVALS.map((iv) => (
                <button key={iv.label}
                  className={`btn ${twapIntervalMs === iv.ms ? "btn-primary" : "btn-ghost"}`}
                  style={{ flex: 1, fontSize: 11 }}
                  onClick={() => setTwapIntervalMs(iv.ms)}
                >{iv.label}</button>
              ))}
            </div>
            {marginInput && parseFloat(marginInput) > 0 && (
              <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                Will open {twapSlices} positions of ${(parseFloat(marginInput) / twapSlices).toFixed(2)} each,{" "}
                every {TWAP_INTERVALS.find(iv => iv.ms === twapIntervalMs)?.label ?? "…"}
              </span>
            )}
          </div>
        </>
      )}

      {/* Advanced — Scale */}
      {orderTypeTab === "advanced" && advancedSubType === "scale" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={styles.field}>
              <label className="label">Price from (USDC)</label>
              <input className="input" type="number" min="0" step="any" placeholder="lower"
                value={scalePriceFrom} onChange={(e) => setScalePriceFrom(e.target.value)} />
            </div>
            <div style={styles.field}>
              <label className="label">Price to (USDC)</label>
              <input className="input" type="number" min="0" step="any" placeholder="upper"
                value={scalePriceTo} onChange={(e) => setScalePriceTo(e.target.value)} />
            </div>
          </div>
          <div style={styles.field}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label className="label">Number of orders</label>
              <span style={{ fontSize: 12, color: "var(--cyan)", fontWeight: 600 }}>{scaleNumOrders}</span>
            </div>
            <input type="range" min={2} max={10} step={1} value={scaleNumOrders} onChange={(e) => setScaleNumOrders(Number(e.target.value))} style={{ width: "100%" }} />
            {scalePriceFrom && scalePriceTo && marginInput && parseFloat(marginInput) > 0 && parseFloat(scalePriceFrom) !== parseFloat(scalePriceTo) && (
              <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                {scaleNumOrders} orders of ${(parseFloat(marginInput) / scaleNumOrders).toFixed(2)} each, from ${scalePriceFrom} to ${scalePriceTo}
              </span>
            )}
          </div>
        </>
      )}

      {/* ── Leverage ── */}
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

      {/* ── TIF selector (limit + relevant advanced types) ── */}
      {(orderTypeTab === "limit" || (orderTypeTab === "advanced" && advancedSubType !== "trailing_stop" && advancedSubType !== "twap")) && (
        <div style={styles.field}>
          <label className="label">Time in force</label>
          <div style={{ display: "flex", gap: 4 }}>
            {(["GTC", "1h", "8h", "24h"] as TIF[]).map((t) => (
              <button key={t}
                className={`btn ${tif === t ? "btn-primary" : "btn-ghost"}`}
                style={{ flex: 1, fontSize: 11 }}
                onClick={() => setTif(t)}
              >{t}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── IOC/FOK note (advanced tab only) ── */}
      {orderTypeTab === "advanced" && (
        <div style={styles.ioNote}>
          IOC, FOK, and Post-only are not available — oracle-based fills are always immediate and fully matched.
        </div>
      )}

      {/* ── Summary (market + limit only) ── */}
      {(isMarket || orderTypeTab === "limit") && notional > 0 && (
        <div style={styles.summary}>
          {isMarket && marketStep === "confirm" && oraclePreview && (
            <Row label="Entry Price (Oracle)" value={`$${oraclePreview.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} accent="green" />
          )}
          {orderTypeTab === "limit" && limitPriceInput && Number.isFinite(parseFloat(limitPriceInput)) && (
            <Row label="Limit Price" value={`$${parseFloat(limitPriceInput).toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          )}
          <Row label="Notional" value={`$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          <Row label="Est. Fee" value={`$${fee.toFixed(2)}`} />
          <Row label="Liq. Price" value={`$${liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} accent={isLong ? "red" : "green"} />
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {/* ── Market confirm prompt ── */}
      {isMarket && marketStep === "confirm" && oraclePreview && (
        <div style={styles.confirmBox}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
            Your position will open at the oracle entry price above. Price may move slightly before on-chain settlement.
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Slippage tolerance</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="number" min="0.1" max="5" step="0.1" value={slippageTolerance}
                onChange={(e) => setSlippageTolerance(e.target.value)}
                style={{ width: 52, fontSize: 11, padding: "2px 6px", textAlign: "right", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)" }}
              />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>%</span>
            </div>
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

      {/* ── Primary action button ── */}
      {!(isMarket && marketStep === "confirm") && (
        <button
          className={`btn ${isLong ? "btn-long" : "btn-short"}`}
          style={styles.submitBtn}
          onClick={isMarket ? handleMarketPreview : orderTypeTab === "limit" ? handleLimitPlace : handleAdvancedPlace}
          disabled={marketStep === "previewing" || insufficientBalance || (!marginInput && authenticated && advancedSubType !== "trailing_stop")}
        >
          {!authenticated
            ? "Connect to Trade"
            : marketStep === "previewing"
            ? "Fetching Price…"
            : isMarket
            ? `Preview ${isLong ? "Long" : "Short"}`
            : orderTypeTab === "limit"
            ? `Place Limit ${isLong ? "Long" : "Short"}`
            : advancedSubType === "stop_market"
            ? `Place Stop Market ${isLong ? "Long" : "Short"}`
            : advancedSubType === "stop_limit"
            ? `Place Stop Limit ${isLong ? "Long" : "Short"}`
            : advancedSubType === "trailing_stop"
            ? `Place Trailing Stop`
            : advancedSubType === "twap"
            ? `Place TWAP ${isLong ? "Long" : "Short"}`
            : `Place Scale ${isLong ? "Long" : "Short"}`}
        </button>
      )}

      {/* ── Executor approval banner ── */}
      {showNeedsExecutor && (
        <div style={styles.approvalBanner}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
            Enable automated order execution — approve the backend bot wallet to execute orders on your behalf.
          </div>
          {approveError && <div style={{ fontSize: 10, color: "var(--red)", marginBottom: 4 }}>{approveError}</div>}
          <button className="btn btn-primary" style={{ fontSize: 11, padding: "5px 12px", width: "100%" }}
            onClick={approveExecutor} disabled={approving}>
            {approving ? "Approving…" : "Enable Backend Orders"}
          </button>
        </div>
      )}

      {/* ── Pending orders list (non-market tabs) ── */}
      {!isMarket && pendingOrders.length > 0 && (
        <div style={styles.limitOrderList}>
          <div className="label" style={{ marginBottom: 4 }}>Pending Orders</div>
          {pendingOrders.map((o) => (
            <div key={o.id} style={styles.limitRow}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase" }}>{o.type}</span>
                <span style={{ fontSize: 11, color: o.isLong ? "var(--green)" : "var(--red)", fontWeight: 600, marginLeft: 6 }}>{o.isLong ? "L" : "S"}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 6 }}>@ ${o.triggerPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                {o.marginUsdc != null && <span style={{ fontSize: 10, color: "var(--text-secondary)", marginLeft: 6 }}>${o.marginUsdc.toFixed(0)} × {o.leverage}×</span>}
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => void cancelOrder(o.id)}>✕</button>
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
  typeTabs: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 },
  typeTab: { fontSize: 12 },
  subTypePills: { display: "flex", gap: 4, flexWrap: "wrap" as const },
  subTypePill: { fontSize: 10, padding: "4px 8px" },
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
  ioNote: { fontSize: 10, color: "var(--text-secondary)", padding: "6px 10px", background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", fontStyle: "italic" as const },
  txBox: { display: "flex", flexDirection: "column" as const, gap: 4 },
  txLink: { fontSize: 11, color: "var(--cyan)", textDecoration: "none" },
  posId: { fontSize: 10, color: "var(--text-secondary)" },
  submitBtn: { width: "100%", padding: "12px", fontSize: 14, marginTop: 4 },
  limitOrderList: { display: "flex", flexDirection: "column" as const, gap: 4, padding: 10, background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" },
  limitRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border-subtle)" },
  approvalBanner: { padding: 12, background: "rgba(6,182,212,0.06)", borderRadius: "var(--radius-md)", border: "1px solid rgba(6,182,212,0.25)", display: "flex", flexDirection: "column" as const, gap: 4 },
} satisfies Record<string, React.CSSProperties>;
