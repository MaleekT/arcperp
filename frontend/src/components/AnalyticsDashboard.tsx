import { useProtocolStats } from "../hooks/usePositions.js";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={cardStyles.card}>
      <span className="label" style={{ marginBottom: 4 }}>{label}</span>
      <span className="price" style={cardStyles.value}>{value}</span>
      {sub && <span style={cardStyles.sub}>{sub}</span>}
    </div>
  );
}

function formatMillions(raw: string): string {
  const n = Number(raw) / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function AnalyticsDashboard() {
  const { stats, loading } = useProtocolStats();

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

      {/* Stat grid */}
      <div style={styles.grid}>
        <StatCard
          label="Total Volume"
          value={stats ? formatMillions(stats.totalVolumeUsdc) : "—"}
          sub="All time"
        />
        <StatCard
          label="Total Fees"
          value={stats ? formatMillions(stats.totalFeesUsdc) : "—"}
          sub="Protocol revenue"
        />
        <StatCard
          label="Total Liquidations"
          value={stats ? stats.totalLiquidations.toLocaleString() : "—"}
        />
        <StatCard
          label="Insurance Fund"
          value={stats ? formatMillions(stats.insuranceFund) : "—"}
          sub="USDC reserve"
        />
      </div>

      {/* Open interest bar */}
      <div style={styles.oiSection}>
        <div style={styles.oiHeader}>
          <span className="heading">Open Interest</span>
          <span style={styles.oiTotal}>
            {formatMillions(String((openInterestTotal * 1e6).toFixed(0)))} total
          </span>
        </div>
        <div style={styles.oiBar}>
          <div
            style={{ ...styles.oiBarLong, width: `${longPct}%` }}
            title={`Long: ${longPct.toFixed(1)}%`}
          />
          <div
            style={{ ...styles.oiBarShort, width: `${100 - longPct}%` }}
            title={`Short: ${(100 - longPct).toFixed(1)}%`}
          />
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
} satisfies Record<string, React.CSSProperties>;

const cardStyles = {
  card: {
    background: "var(--bg-panel)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
  },
  value: { fontSize: 22, fontWeight: 700, color: "var(--text-price)", letterSpacing: "-0.03em" },
  sub: { fontSize: 10, color: "var(--text-muted)", marginTop: 2 },
} satisfies Record<string, React.CSSProperties>;
