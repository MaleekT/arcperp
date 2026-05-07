import { useWallet } from "../lib/wallet.js";
import { useMarginBalance } from "../hooks/useMarginBalance.js";

/** Renders a USDC bigint (1e6 precision) as "$1,234.56". Safe: pure arithmetic, no interpolation of external input. */
function formatUsdc(raw: bigint): string {
  const safeRaw = raw < 0n ? 0n : raw;
  const dollars = Number(safeRaw) / 1_000_000;
  return dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { ready, authenticated, login, logout, address: trader } = useWallet();
  const { balance } = useMarginBalance(trader);

  if (!ready) {
    return <div style={styles.skeleton} aria-hidden />;
  }

  if (!authenticated) {
    return (
      <button className="btn btn-primary" onClick={login} style={styles.connectBtn}>
        Connect Wallet
      </button>
    );
  }

  return (
    <div style={styles.wrapper}>
      {trader && (
        <div style={styles.balancePill}>
          <span className="label" style={{ marginRight: 4 }}>Balance</span>
          <span className="price" style={styles.balanceAmt}>
            ${formatUsdc(balance)}
          </span>
        </div>
      )}
      <button
        className="btn btn-ghost"
        onClick={() => logout()}
        style={styles.addrBtn}
        title="Click to disconnect"
      >
        {trader ? truncateAddress(trader) : "Connected"}
      </button>
    </div>
  );
}

const styles = {
  skeleton: {
    width: 120,
    height: 32,
    background: "var(--bg-elevated)",
    borderRadius: "var(--radius-md)",
    opacity: 0.5,
  },
  connectBtn: { minWidth: 140 },
  wrapper: { display: "flex", alignItems: "center", gap: 8 },
  balancePill: {
    display: "flex",
    alignItems: "center",
    padding: "4px 10px",
    background: "var(--cyan-dim)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
  },
  balanceAmt: { fontSize: 13, color: "var(--cyan)", fontWeight: 600 },
  addrBtn: { fontSize: 12, padding: "5px 10px" },
} satisfies Record<string, React.CSSProperties>;
