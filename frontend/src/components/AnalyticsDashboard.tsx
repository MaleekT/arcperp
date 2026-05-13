import { useState, useEffect } from "react";
import { useProtocolStats } from "../hooks/usePositions.js";
import { ADDRESSES } from "../lib/contracts.js";

const PRICE_SERVER_HTTP = (import.meta.env.VITE_PRICE_SERVER_URL as string | undefined)
  ?.replace(/^ws(s?):\/\//, "http$1://") ?? "http://localhost:8081";

const EXPLORER_API = "https://testnet.arcscan.app/api/v2";

// ── Oracle freshness ──────────────────────────────────────────────────────────

interface OracleHealth {
  pair: string;
  ageMs: number;
}

function useOracleFreshness(): OracleHealth[] {
  const [freshness, setFreshness] = useState<OracleHealth[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${PRICE_SERVER_HTTP}/health`, { signal: AbortSignal.timeout(4_000) });
        if (!res.ok) return;
        const data = (await res.json()) as { pairs?: Record<string, { price: string; timestamp: number }> };
        if (!cancelled && data.pairs) {
          const now = Date.now();
          setFreshness(
            Object.entries(data.pairs).map(([pair, v]) => ({
              pair,
              ageMs: now - v.timestamp,
            }))
          );
        }
      } catch {
        // price server offline in dev
      }
    }

    void poll();
    const id = setInterval(() => void poll(), 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return freshness;
}

// ── Recent events from Blockscout ────────────────────────────────────────────

interface FundingEvent {
  pair: string;
  rate: string;
  timestamp: string;
}

interface LiqEvent {
  positionId: string;
  trader: string;
  timestamp: string;
}

function useRecentEvents() {
  const [funding, setFunding] = useState<FundingEvent[]>([]);
  const [liquidations, setLiquidations] = useState<LiqEvent[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const addr = ADDRESSES.perpEngine.toLowerCase();

      try {
        const res = await fetch(
          `${EXPLORER_API}/addresses/${addr}/logs?topic=0x&limit=20`,
          { signal: AbortSignal.timeout(8_000) }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          items?: Array<{
            topics: string[];
            data: string;
            block_number: number;
            transaction_hash: string;
            timestamp?: string;
          }>;
        };

        if (!cancelled && data.items) {
          const fundingTopic = "0x" + "FundingSettled".padEnd(64, "0").slice(0, 64);
          const closedTopic = "0x" + "PositionClosed".padEnd(64, "0").slice(0, 64);

          const fe: FundingEvent[] = [];
          const le: LiqEvent[] = [];

          for (const item of data.items) {
            const t0 = item.topics[0] ?? "";
            if (t0.startsWith(fundingTopic.slice(0, 10))) {
              fe.push({ pair: item.topics[1] ?? "unknown", rate: item.data.slice(0, 18), timestamp: item.timestamp ?? String(item.block_number) });
            } else if (t0.startsWith(closedTopic.slice(0, 10))) {
              le.push({
                positionId: (item.topics[1] ?? "").slice(0, 10) + "…",
                trader: `0x${(item.topics[2] ?? "").slice(-40, -24)}…`,
                timestamp: item.timestamp ?? String(item.block_number),
              });
            }
          }

          setFunding(fe.slice(0, 5));
          setLiquidations(le.slice(0, 5));
        }
      } catch {
        // Blockscout may be unavailable
      }
    }

    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { funding, liquidations };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMillions(raw: string): string {
  const n = Number(raw) / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function ageLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={cardStyles.card}>
      <span className="label" style={{ marginBottom: 4 }}>{label}</span>
      <span className="price" style={cardStyles.value}>{value}</span>
      {sub && <span style={cardStyles.sub}>{sub}</span>}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AnalyticsDashboard() {
  const { stats, loading } = useProtocolStats();
  const oracleFreshness = useOracleFreshness();
  const { funding, liquidations } = useRecentEvents();

  if (loading && !stats) {
    return (
      <div style={styles.loading}>
        <span style={{ color: "var(--text-secondary)" }}>Loading analytics…</span>
      </div>
    );
  }

  const openInterestTotal = stats
    ? Number(stats.openInterestLong) / 1e6 + Number(stats.openInterestShort) / 1e6
    : 0;

  const longPct = stats && openInterestTotal > 0
    ? (Number(stats.openInterestLong) / 1e6 / openInterestTotal) * 100
    : 50;

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.title}>Protocol Analytics</span>
        {stats && (
          <span className="label">
            Updated {new Date(stats.lastUpdated * 1000).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* ── Stat grid ── */}
      <div style={styles.grid}>
        <StatCard label="Total Volume" value={stats ? formatMillions(stats.totalVolumeUsdc) : "—"} sub="All time" />
        <StatCard label="Total Fees" value={stats ? formatMillions(stats.totalFeesUsdc) : "—"} sub="Protocol revenue" />
        <StatCard label="Total Liquidations" value={stats ? stats.totalLiquidations.toLocaleString() : "—"} />
        <StatCard label="Insurance Fund" value={stats ? formatMillions(stats.insuranceFund) : "—"} sub="USDC reserve" />
      </div>

      {/* ── Open interest ── */}
      <div style={styles.oiSection}>
        <div style={styles.oiHeader}>
          <span className="heading">Open Interest</span>
          <span style={styles.oiTotal}>
            {formatMillions(String((openInterestTotal * 1e6).toFixed(0)))} total
          </span>
        </div>
        <div style={styles.oiBar}>
          <div style={{ ...styles.oiBarLong, width: `${longPct}%` }} title={`Long: ${longPct.toFixed(1)}%`} />
          <div style={{ ...styles.oiBarShort, width: `${100 - longPct}%` }} title={`Short: ${(100 - longPct).toFixed(1)}%`} />
        </div>
        <div style={styles.oiLabels}>
          <div style={styles.oiLabel}>
            <div style={{ ...styles.oiDot, background: "var(--green)" }} />
            <span className="label">Long {longPct.toFixed(1)}%</span>
            <span style={styles.oiAmt}>{stats ? formatMillions(stats.openInterestLong) : "—"}</span>
          </div>
          <div style={styles.oiLabel}>
            <div style={{ ...styles.oiDot, background: "var(--red)" }} />
            <span className="label">Short {(100 - longPct).toFixed(1)}%</span>
            <span style={styles.oiAmt}>{stats ? formatMillions(stats.openInterestShort) : "—"}</span>
          </div>
        </div>
      </div>

      {/* ── Oracle status ── */}
      <div style={styles.section}>
        <span className="heading" style={{ marginBottom: 10, display: "block" }}>Oracle Status</span>
        {oracleFreshness.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Price server offline or no data yet</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {oracleFreshness.map((o) => (
              <div key={o.pair} style={{ ...styles.oracleChip, borderColor: o.ageMs < 30_000 ? "var(--green)" : o.ageMs < 120_000 ? "var(--yellow, #F59E0B)" : "var(--red)" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{o.pair}</span>
                <span style={{ fontSize: 10, color: o.ageMs < 30_000 ? "var(--green)" : o.ageMs < 120_000 ? "var(--yellow, #F59E0B)" : "var(--red)" }}>
                  {ageLabel(o.ageMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recent funding ── */}
      {funding.length > 0 && (
        <div style={styles.section}>
          <span className="heading" style={{ marginBottom: 10, display: "block" }}>Last Funding Events</span>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Pair</th>
                <th style={styles.th}>Rate</th>
                <th style={styles.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {funding.map((f, i) => (
                <tr key={i}>
                  <td style={styles.td}>{f.pair.slice(0, 12)}</td>
                  <td style={styles.td}>{f.rate}</td>
                  <td style={styles.td}>{f.timestamp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Recent liquidations ── */}
      {liquidations.length > 0 && (
        <div style={styles.section}>
          <span className="heading" style={{ marginBottom: 10, display: "block" }}>Recent Liquidations</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {liquidations.map((l, i) => (
              <div key={i} style={styles.liqRow}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-price)" }}>{l.positionId}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-price)" }}>{l.trader}</span>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{l.timestamp}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  loading: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1 },
  wrapper: { flex: 1, overflowY: "auto" as const, padding: 24, display: "flex", flexDirection: "column" as const, gap: 24 },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  title: { fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 },
  oiSection: { display: "flex", flexDirection: "column" as const, gap: 10 },
  oiHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  oiTotal: { fontSize: 12, color: "var(--text-secondary)" },
  oiBar: { height: 8, borderRadius: 4, overflow: "hidden", display: "flex", background: "var(--bg-elevated)" },
  oiBarLong: { height: "100%", background: "var(--green)", transition: "width 400ms ease" },
  oiBarShort: { height: "100%", background: "var(--red)", transition: "width 400ms ease" },
  oiLabels: { display: "flex", gap: 24 },
  oiLabel: { display: "flex", alignItems: "center", gap: 6 },
  oiDot: { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 },
  oiAmt: { fontSize: 12, color: "var(--text-primary)", fontFamily: "var(--font-price)" },
  section: { display: "flex", flexDirection: "column" as const },
  oracleChip: { padding: "6px 10px", borderRadius: "var(--radius-md)", border: "1px solid", background: "var(--bg-elevated)", display: "flex", flexDirection: "column" as const, gap: 2 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  th: { textAlign: "left" as const, padding: "4px 8px", color: "var(--text-secondary)", fontWeight: 500, borderBottom: "1px solid var(--border-subtle)" },
  td: { padding: "5px 8px", color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)" },
  liqRow: { display: "flex", gap: 12, alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--border-subtle)" },
} satisfies Record<string, React.CSSProperties>;

const cardStyles = {
  card: { background: "var(--bg-panel)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", padding: 16, display: "flex", flexDirection: "column" as const },
  value: { fontSize: 22, fontWeight: 700, color: "var(--text-price)", letterSpacing: "-0.03em" },
  sub: { fontSize: 10, color: "var(--text-muted)", marginTop: 2 },
} satisfies Record<string, React.CSSProperties>;
