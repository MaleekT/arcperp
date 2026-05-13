import { useState } from "react";
import { createWalletClient, custom, parseUnits } from "viem";
import { HermesClient } from "@pythnetwork/hermes-client";
import { useWallet } from "../lib/wallet.js";
import { arcTestnet, perpContract, PAIRS } from "../lib/contracts.js";
import { usePositions, type Position } from "../hooks/usePositions.js";
import { useOrderServer, type PlaceTpSlParams, type BackendOrder } from "../hooks/useOrderServer.js";
import type { PriceData } from "../hooks/usePrices.js";

const PYTH_IDS: Record<string, string> = {
  "BTC-USDC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
};

const HERMES = new HermesClient("https://hermes.pyth.network");

interface Props {
  trader: `0x${string}` | undefined;
  prices: Record<string, PriceData>;
}

function pairIdForLabel(label: string): `0x${string}` {
  return PAIRS.find((p) => p.label === label)?.id ?? ("0x" as `0x${string}`);
}

function computePnl(pos: Position, currentPrice: number): number {
  const entry = Number(pos.entryPrice) / 1e8;
  const notional = Number(pos.notional) / 1e6;
  if (entry === 0) return 0;
  const priceDelta = pos.isLong ? currentPrice - entry : entry - currentPrice;
  return (notional * priceDelta) / entry;
}

function computeHealth(pos: Position, currentPrice: number): number {
  const margin = Number(pos.margin) / 1e6;
  const notional = Number(pos.notional) / 1e6;
  const pnl = computePnl(pos, currentPrice);
  const effectiveMargin = margin + pnl;
  const maintenanceRequired = notional * 0.025;
  if (maintenanceRequired === 0) return Infinity;
  return effectiveMargin / maintenanceRequired;
}

function healthColor(hf: number): string {
  if (hf >= 1.5) return "var(--green)";
  if (hf >= 1.0) return "#F59E0B";
  return "var(--red)";
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ── PositionRow ───────────────────────────────────────────────────────────────

interface PositionRowProps {
  pos: Position;
  prices: Record<string, PriceData>;
  trader: `0x${string}`;
  onClose: () => void;
  placeTP: (p: PlaceTpSlParams) => Promise<BackendOrder | null>;
  placeSL: (p: PlaceTpSlParams) => Promise<BackendOrder | null>;
  executorApproved: boolean;
}

function PositionRow({ pos, prices, trader, onClose, placeTP, placeSL, executorApproved }: PositionRowProps) {
  const { getProvider } = useWallet();

  // Close state
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Partial close state
  const [partialFraction, setPartialFraction] = useState<number | null>(null);

  // Margin management state
  const [showManage, setShowManage] = useState(false);
  const [marginInput, setMarginInput] = useState("");
  const [marginOp, setMarginOp] = useState<"add" | "remove" | null>(null);
  const [marginBusy, setMarginBusy] = useState(false);
  const [marginError, setMarginError] = useState<string | null>(null);

  // TP/SL state
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [tpBusy, setTpBusy] = useState(false);
  const [slBusy, setSlBusy] = useState(false);
  const [tpSlError, setTpSlError] = useState<string | null>(null);

  const currentPriceData = prices[pos.pair];
  const currentPrice = currentPriceData ? parseFloat(currentPriceData.price) : Number(pos.entryPrice) / 1e8;
  const leverage = Number(pos.margin) > 0 ? Number(pos.notional) / Number(pos.margin) : 0;

  const pnl = computePnl(pos, currentPrice);
  const hf = computeHealth(pos, currentPrice);
  const healthPct = Math.min(hf / 2, 1) * 100;
  const healthClass = hf >= 1.5 ? "safe" : hf >= 1.0 ? "warn" : "danger";
  const entryUsd = Number(pos.entryPrice) / 1e8;
  const marginUsd = Number(pos.margin) / 1e6;
  const notionalUsd = Number(pos.notional) / 1e6;

  async function getVaa(): Promise<`0x${string}`[]> {
    const feedId = PYTH_IDS[pos.pair];
    if (!feedId) throw new Error(`No Pyth feed for ${pos.pair}`);
    const updates = await HERMES.getLatestPriceUpdates([feedId]);
    return (updates.binary?.data ?? []).map((d) => `0x${d}` as `0x${string}`);
  }

  async function handleClose() {
    setClosing(true);
    setCloseError(null);
    try {
      const vaa = await getVaa();
      const provider = await getProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });
      await walletClient.writeContract({ ...perpContract, functionName: "closePosition", args: [pos.id as `0x${string}`, vaa] });
      onClose();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message.slice(0, 64) : "Close failed");
    } finally {
      setClosing(false);
    }
  }

  async function handlePartialClose(fractionBps: number) {
    setPartialFraction(fractionBps);
    setCloseError(null);
    try {
      const vaa = await getVaa();
      const provider = await getProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });
      await walletClient.writeContract({
        ...perpContract,
        functionName: "closePartial",
        args: [pos.id as `0x${string}`, BigInt(fractionBps), vaa],
        value: 0n,
      });
      onClose();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message.slice(0, 64) : "Partial close failed");
    } finally {
      setPartialFraction(null);
    }
  }

  async function handleMarginOp(op: "add" | "remove") {
    const amount = parseFloat(marginInput);
    if (!Number.isFinite(amount) || amount <= 0) { setMarginError("Enter a valid amount"); return; }
    setMarginBusy(true);
    setMarginOp(op);
    setMarginError(null);
    try {
      const provider = await getProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });
      const amountUnits = parseUnits(amount.toFixed(6), 6);
      await walletClient.writeContract({
        ...perpContract,
        functionName: op === "add" ? "addMargin" : "removeMargin",
        args: [pos.id as `0x${string}`, amountUnits],
      });
      setMarginInput("");
      onClose();
    } catch (err) {
      setMarginError(err instanceof Error ? err.message.slice(0, 80) : `${op === "add" ? "Add" : "Remove"} margin failed`);
    } finally {
      setMarginBusy(false);
      setMarginOp(null);
    }
  }

  async function handleSetTP() {
    const price = parseFloat(tpInput);
    if (!Number.isFinite(price) || price <= 0) { setTpSlError("Enter a valid TP price"); return; }
    setTpBusy(true);
    setTpSlError(null);
    try {
      await placeTP({ pair: pos.pair, pairId: pairIdForLabel(pos.pair), isLong: pos.isLong, positionId: pos.id as `0x${string}`, triggerPrice: price });
      setTpInput("");
    } catch (err) {
      setTpSlError(err instanceof Error ? err.message.slice(0, 80) : "Failed to set TP");
    } finally {
      setTpBusy(false);
    }
  }

  async function handleSetSL() {
    const price = parseFloat(slInput);
    if (!Number.isFinite(price) || price <= 0) { setTpSlError("Enter a valid SL price"); return; }
    setSlBusy(true);
    setTpSlError(null);
    try {
      await placeSL({ pair: pos.pair, pairId: pairIdForLabel(pos.pair), isLong: pos.isLong, positionId: pos.id as `0x${string}`, triggerPrice: price });
      setSlInput("");
    } catch (err) {
      setTpSlError(err instanceof Error ? err.message.slice(0, 80) : "Failed to set SL");
    } finally {
      setSlBusy(false);
    }
  }

  return (
    <div style={rowStyles.row}>
      {/* ── Main info row ── */}
      <div style={rowStyles.mainRow}>
        {/* Left: pair + stats + health */}
        <div style={rowStyles.left}>
          <div style={rowStyles.titleRow}>
            <span className={`badge badge--${pos.isLong ? "long" : "short"}`}>{pos.isLong ? "Long" : "Short"}</span>
            <span style={rowStyles.pairName}>{pos.pair}</span>
            <span style={rowStyles.leverage}>{leverage.toFixed(1)}×</span>
          </div>

          <div style={rowStyles.stats}>
            <div style={rowStyles.stat}>
              <span className="label">Entry</span>
              <span className="price" style={{ fontSize: 11 }}>${fmt(entryUsd)}</span>
            </div>
            <div style={rowStyles.stat}>
              <span className="label">Mark</span>
              <span className="price" style={{ fontSize: 11 }}>${fmt(currentPrice)}</span>
            </div>
            <div style={rowStyles.stat}>
              <span className="label">Margin</span>
              <span className="price" style={{ fontSize: 11 }}>${fmt(marginUsd)}</span>
            </div>
            <div style={rowStyles.stat}>
              <span className="label">Size</span>
              <span className="price" style={{ fontSize: 11 }}>${fmt(notionalUsd, 0)}</span>
            </div>
          </div>

          <div style={rowStyles.healthRow}>
            <span className="label" style={{ minWidth: 40 }}>Health</span>
            <div className="health-bar" style={{ flex: 1 }}>
              <div className={`health-bar__fill health-bar__fill--${healthClass}`} style={{ width: `${healthPct}%` }} />
            </div>
            <span style={{ fontSize: 10, color: healthColor(hf), minWidth: 28, textAlign: "right" as const }}>
              {isFinite(hf) ? hf.toFixed(2) : "∞"}
            </span>
          </div>

          {closeError && <span style={rowStyles.errText}>{closeError}</span>}
        </div>

        {/* Right: PnL + action buttons */}
        <div style={rowStyles.right}>
          <span style={{ fontSize: 15, fontWeight: 700, color: pnl >= 0 ? "var(--green)" : "var(--red)", fontFamily: "var(--font-price)" }}>
            {pnl >= 0 ? "+" : ""}${fmt(pnl)}
          </span>
          <span style={{ fontSize: 9, color: "var(--text-secondary)", marginTop: 1 }}>Unrealized PnL</span>

          {/* Partial close buttons */}
          <div style={{ display: "flex", gap: 3, marginTop: 8, flexWrap: "wrap" as const, justifyContent: "flex-end" }}>
            {([25, 50, 75] as const).map((pct) => (
              <button
                key={pct}
                className="btn btn-ghost"
                style={{ fontSize: 10, padding: "3px 7px" }}
                onClick={() => void handlePartialClose(pct * 100)}
                disabled={closing || partialFraction !== null}
              >
                {partialFraction === pct * 100 ? "…" : `${pct}%`}
              </button>
            ))}
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: "3px 8px" }}
              onClick={() => void handleClose()}
              disabled={closing || partialFraction !== null}
            >
              {closing ? "…" : "Close"}
            </button>
          </div>

          {/* Manage toggle */}
          <button
            className="btn btn-ghost"
            style={{ fontSize: 10, padding: "2px 8px", marginTop: 4, opacity: 0.7 }}
            onClick={() => setShowManage((v) => !v)}
          >
            {showManage ? "▲ Manage" : "▼ Manage"}
          </button>
        </div>
      </div>

      {/* ── Manage panel ── */}
      {showManage && (
        <div style={rowStyles.managePanel}>
          {/* TP / SL */}
          {executorApproved ? (
            <div style={rowStyles.manageSection}>
              <span className="label" style={{ marginBottom: 4 }}>Take Profit / Stop Loss</span>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <input
                    className="input"
                    type="number"
                    placeholder={`TP price (${pos.isLong ? "above" : "below"} entry)`}
                    value={tpInput}
                    onChange={(e) => setTpInput(e.target.value)}
                    style={{ fontSize: 11 }}
                  />
                </div>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px", flexShrink: 0 }} onClick={() => void handleSetTP()} disabled={tpBusy}>
                  {tpBusy ? "…" : "Set TP"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <input
                    className="input"
                    type="number"
                    placeholder={`SL price (${pos.isLong ? "below" : "above"} entry)`}
                    value={slInput}
                    onChange={(e) => setSlInput(e.target.value)}
                    style={{ fontSize: 11 }}
                  />
                </div>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px", flexShrink: 0 }} onClick={() => void handleSetSL()} disabled={slBusy}>
                  {slBusy ? "…" : "Set SL"}
                </button>
              </div>
              {tpSlError && <span style={rowStyles.errText}>{tpSlError}</span>}
            </div>
          ) : (
            <div style={rowStyles.manageSection}>
              <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                Approve the order executor in the Order panel to enable TP/SL orders.
              </span>
            </div>
          )}

          {/* Add / Remove margin */}
          <div style={rowStyles.manageSection}>
            <span className="label" style={{ marginBottom: 4 }}>Margin Management</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                placeholder="Amount (USDC)"
                value={marginInput}
                onChange={(e) => setMarginInput(e.target.value)}
                style={{ fontSize: 11, flex: 1 }}
              />
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 10px", flexShrink: 0, color: "var(--green)" }}
                onClick={() => void handleMarginOp("add")}
                disabled={marginBusy}
              >
                {marginBusy && marginOp === "add" ? "…" : "Add"}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 10px", flexShrink: 0, color: "var(--red)" }}
                onClick={() => void handleMarginOp("remove")}
                disabled={marginBusy}
              >
                {marginBusy && marginOp === "remove" ? "…" : "Remove"}
              </button>
            </div>
            {marginError && <span style={rowStyles.errText}>{marginError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── PositionsPanel ────────────────────────────────────────────────────────────

export function PositionsPanel({ trader, prices }: Props) {
  const { authenticated } = useWallet();
  const { positions, loading, error, refetch } = usePositions(trader);
  const { placeTPOrder, placeSLOrder, executorApproved } = useOrderServer(trader);

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <span className="heading">Positions</span>
        {positions.length > 0 && <span className="badge badge--cyan">{positions.length}</span>}
        {error && (
          <button className="btn btn-ghost" style={{ fontSize: 10, padding: "1px 6px", marginLeft: "auto" }} onClick={refetch}>
            Retry
          </button>
        )}
      </div>

      {!authenticated ? (
        <div style={styles.empty}>Connect wallet to view positions</div>
      ) : loading && positions.length === 0 ? (
        <div style={styles.empty}>Loading positions…</div>
      ) : positions.length === 0 ? (
        <div style={styles.empty}>No open positions</div>
      ) : (
        <div style={styles.list}>
          {positions.map((pos) => (
            <PositionRow
              key={pos.id}
              pos={pos}
              prices={prices}
              trader={trader!}
              onClose={refetch}
              placeTP={placeTPOrder}
              placeSL={placeSLOrder}
              executorApproved={executorApproved}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  wrapper: {
    background: "var(--bg-panel)",
    borderTop: "1px solid var(--border-subtle)",
    minHeight: 80,
    maxHeight: 320,
    display: "flex",
    flexDirection: "column" as const,
    flexShrink: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  empty: {
    padding: "24px 16px",
    color: "var(--text-secondary)",
    fontSize: 12,
    textAlign: "center" as const,
  },
  list: { overflowY: "auto" as const, flex: 1 },
} satisfies Record<string, React.CSSProperties>;

const rowStyles = {
  row: {
    display: "flex",
    flexDirection: "column" as const,
    padding: "10px 16px",
    borderBottom: "1px solid var(--border-subtle)",
    gap: 0,
  },
  mainRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  left: { display: "flex", flexDirection: "column" as const, gap: 5, flex: 1, minWidth: 0 },
  titleRow: { display: "flex", alignItems: "center", gap: 6 },
  pairName: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)" },
  leverage: {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--cyan)",
    background: "rgba(0,212,200,0.1)",
    padding: "1px 5px",
    borderRadius: 3,
  },
  stats: { display: "flex", gap: 12, flexWrap: "wrap" as const },
  stat: { display: "flex", alignItems: "center", gap: 4 },
  healthRow: { display: "flex", alignItems: "center", gap: 6, maxWidth: 220 },
  errText: { fontSize: 10, color: "var(--red)" },
  right: { display: "flex", flexDirection: "column" as const, alignItems: "flex-end", flexShrink: 0, paddingTop: 2 },
  managePanel: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
    marginTop: 10,
    padding: "10px 0 2px",
    borderTop: "1px solid var(--border-subtle)",
  },
  manageSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
} satisfies Record<string, React.CSSProperties>;
