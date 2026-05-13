import { useState } from "react";
import { useOrderServer, type BackendOrder } from "../hooks/useOrderServer.js";

interface Props {
  trader: `0x${string}` | undefined;
}

type Tab = "orders" | "trades";

const STATUS_COLOR: Record<BackendOrder["status"], string> = {
  pending:   "var(--cyan)",
  triggered: "var(--green)",
  failed:    "var(--red)",
  cancelled: "var(--text-secondary)",
};

const TYPE_LABEL: Record<BackendOrder["type"], string> = {
  limit:         "Limit",
  tp:            "Take Profit",
  sl:            "Stop Loss",
  stop_market:   "Stop Market",
  stop_limit:    "Stop Limit",
  trailing_stop: "Trailing Stop",
  twap:          "TWAP",
};

function fmt2(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtExpiry(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

function OrdersTab({ trader }: { trader: `0x${string}` | undefined }) {
  const { orders, loading, cancelOrder } = useOrderServer(trader);

  if (!trader) return <div style={s.empty}>Connect wallet to view orders</div>;
  if (loading && orders.length === 0) return <div style={s.empty}>Loading orders…</div>;
  if (orders.length === 0) return <div style={s.empty}>No orders yet — place a limit, TP, or SL order to see them here</div>;

  return (
    <div style={s.tableWrap}>
      <table style={s.table}>
        <thead>
          <tr>
            {["Type", "Pair", "Side", "Trigger", "Size", "Status", ""].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...orders].reverse().map((o) => (
            <tr key={o.id} style={s.tr}>
              <td style={s.td}><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{TYPE_LABEL[o.type]}</span></td>
              <td style={s.td}><span style={{ fontSize: 11, fontWeight: 600 }}>{o.pair}</span></td>
              <td style={s.td}>
                <span style={{ fontSize: 11, color: o.isLong ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                  {o.isLong ? "Long" : "Short"}
                </span>
              </td>
              <td style={s.td}><span style={{ fontSize: 11, fontFamily: "var(--font-price)" }}>${fmt2(o.triggerPrice)}</span></td>
              <td style={s.td}>
                {o.marginUsdc != null && o.leverage != null
                  ? <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>${fmt2(o.marginUsdc)} × {o.leverage}×</span>
                  : <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>—</span>}
                {o.type === "twap" && o.numSlices != null && (
                  <span style={{ fontSize: 9, color: "var(--cyan)", marginLeft: 4 }}>
                    {o.executedSlices ?? 0}/{o.numSlices}
                  </span>
                )}
              </td>
              <td style={s.td}>
                <span style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR[o.status] }}>
                  {o.status.toUpperCase()}
                </span>
                {o.status === "pending" && o.expiresAt && (
                  <span style={{ fontSize: 9, color: "var(--text-secondary)", marginLeft: 5 }}>
                    {fmtExpiry(o.expiresAt)}
                  </span>
                )}
                {o.status === "pending" && !o.expiresAt && (
                  <span style={{ fontSize: 9, color: "var(--text-secondary)", marginLeft: 5 }}>GTC</span>
                )}
                {o.txHash && (
                  <a
                    href={`https://testnet.arcscan.app/tx/${o.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 9, color: "var(--cyan)", marginLeft: 5, textDecoration: "none" }}
                  >
                    ↗
                  </a>
                )}
                {o.failReason && (
                  <span style={{ fontSize: 9, color: "var(--red)", marginLeft: 5 }} title={o.failReason}>⚠</span>
                )}
              </td>
              <td style={{ ...s.td, textAlign: "right" as const }}>
                {o.status === "pending" && (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 10, padding: "1px 6px" }}
                    onClick={() => void cancelOrder(o.id)}
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradesTab({ trader }: { trader: `0x${string}` | undefined }) {
  if (!trader) return <div style={s.empty}>Connect wallet to view trade history</div>;
  return (
    <div style={s.empty}>
      <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
        Trade history is available on{" "}
        <a
          href={`https://testnet.arcscan.app/address/${trader}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--cyan)", textDecoration: "none" }}
        >
          ArcScan ↗
        </a>
      </span>
    </div>
  );
}

export function HistoryPanel({ trader }: Props) {
  const [tab, setTab] = useState<Tab>("orders");

  return (
    <div style={s.wrapper}>
      <div style={s.header}>
        <div style={s.tabs}>
          <button
            className={`btn ${tab === "orders" ? "btn-primary" : "btn-ghost"}`}
            style={s.tab}
            onClick={() => setTab("orders")}
          >
            Orders
          </button>
          <button
            className={`btn ${tab === "trades" ? "btn-primary" : "btn-ghost"}`}
            style={s.tab}
            onClick={() => setTab("trades")}
          >
            Trades
          </button>
        </div>
      </div>

      <div style={s.content}>
        {tab === "orders" ? <OrdersTab trader={trader} /> : <TradesTab trader={trader} />}
      </div>
    </div>
  );
}

const s = {
  wrapper: {
    background: "var(--bg-panel)",
    borderTop: "1px solid var(--border-subtle)",
    minHeight: 60,
    maxHeight: 200,
    display: "flex",
    flexDirection: "column" as const,
    flexShrink: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "6px 16px",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  tabs: { display: "flex", gap: 4 },
  tab: { fontSize: 11, padding: "4px 10px" },
  content: { flex: 1, overflow: "hidden" as const, display: "flex", flexDirection: "column" as const },
  empty: {
    padding: "16px",
    color: "var(--text-secondary)",
    fontSize: 12,
    textAlign: "center" as const,
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  tableWrap: { overflowY: "auto" as const, flex: 1 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 },
  th: {
    padding: "5px 12px",
    textAlign: "left" as const,
    fontSize: 10,
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border-subtle)",
    fontWeight: 500,
    background: "var(--bg-panel)",
    position: "sticky" as const,
    top: 0,
  },
  td: { padding: "5px 12px", borderBottom: "1px solid var(--border-subtle)" },
  tr: { transition: "background var(--duration-fast)" },
} satisfies Record<string, React.CSSProperties>;
