import { useState } from "react";
import { ApolloClient, ApolloProvider, InMemoryCache, HttpLink } from "@apollo/client";
import { WalletProvider, useWallet } from "./lib/wallet.js";
import { arcTestnet, PAIRS } from "./lib/contracts.js";
import { WalletButton } from "./components/WalletButton.js";
import { TradingChart } from "./components/TradingChart.js";
import { OrderPanel } from "./components/OrderPanel.js";
import { PositionsPanel } from "./components/PositionsPanel.js";
import { MarginPanel } from "./components/MarginPanel.js";
import { AnalyticsDashboard } from "./components/AnalyticsDashboard.js";
import { usePrices } from "./hooks/usePrices.js";
import "./styles/globals.css";

// ── Provider setup ────────────────────────────────────────────────────────────

const apolloClient = new ApolloClient({
  link: new HttpLink({ uri: (import.meta.env.VITE_GRAPHQL_URL as string | undefined) ?? "http://localhost:8080/graphql" }),
  cache: new InMemoryCache(),
});

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? "";

// ── Layout ────────────────────────────────────────────────────────────────────

type ActiveView = "trade" | "analytics";

function AppShell() {
  const { address } = useWallet();
  const [activePair, setActivePair] = useState<typeof PAIRS[number]>(PAIRS[0]);
  const [activeView, setActiveView] = useState<ActiveView>("trade");
  const prices = usePrices();

  return (
    <div style={styles.root}>
      {/* ── Top navigation ── */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>ARC<span style={styles.logoAccent}>PERP</span></span>
          <nav style={styles.pairNav}>
            {PAIRS.map((pair) => {
              const price = prices[pair.label];
              return (
                <button
                  key={pair.id}
                  onClick={() => setActivePair(pair)}
                  style={{
                    ...styles.pairBtn,
                    ...(activePair.id === pair.id ? styles.pairBtnActive : {}),
                  }}
                >
                  <span>{pair.label}</span>
                  {price && (
                    <span
                      className={`price price-${price.direction}`}
                      style={styles.pairPrice}
                    >
                      ${parseFloat(price.price).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div style={styles.headerRight}>
          <button
            onClick={() => setActiveView(activeView === "trade" ? "analytics" : "trade")}
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: "5px 10px" }}
          >
            {activeView === "trade" ? "Analytics" : "Trade"}
          </button>
          <WalletButton />
        </div>
      </header>

      {/* ── Main content ── */}
      {activeView === "analytics" ? (
        <AnalyticsDashboard />
      ) : (
        <div style={styles.main}>
          <div style={styles.chartArea}>
            <TradingChart pair={activePair} prices={prices} />
            <PositionsPanel trader={address} prices={prices} />
          </div>

          <div style={styles.sidebar}>
            <MarginPanel trader={address} />
            <OrderPanel pair={activePair} trader={address} prices={prices} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root with providers ───────────────────────────────────────────────────────

export default function App() {
  return (
    <WalletProvider privyAppId={PRIVY_APP_ID} chain={arcTestnet}>
      <ApolloProvider client={apolloClient}>
        <AppShell />
      </ApolloProvider>
    </WalletProvider>
  );
}

// ── Inline styles (layout only — colors via CSS vars) ─────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100vh",
    overflow: "hidden",
    background: "var(--bg-base)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    height: 48,
    borderBottom: "1px solid var(--border-subtle)",
    background: "var(--bg-panel)",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 24 },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  logo: {
    fontFamily: "var(--font-price)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text-primary)",
    letterSpacing: "-0.03em",
  },
  logoAccent: { color: "var(--cyan)" },
  pairNav: { display: "flex", gap: 2 },
  pairBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 12px",
    borderRadius: "var(--radius-md)",
    background: "transparent",
    border: "1px solid transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    transition: "all var(--duration-fast)",
  } as React.CSSProperties,
  pairBtnActive: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  pairPrice: { fontSize: 13, color: "var(--text-price)" },
  main: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    gap: 1,
    background: "var(--border-subtle)",
  },
  chartArea: {
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    overflow: "hidden",
    background: "var(--bg-base)",
    gap: 1,
  },
  sidebar: {
    display: "flex",
    flexDirection: "column" as const,
    width: 320,
    flexShrink: 0,
    background: "var(--bg-base)",
    gap: 1,
    overflowY: "auto" as const,
  },
} satisfies Record<string, React.CSSProperties | Record<string, React.CSSProperties>>;
