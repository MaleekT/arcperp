import { useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, parseUnits } from "viem";
import { arcTestnet, vaultContract, usdcContract, ADDRESSES } from "../lib/contracts.js";
import { useMarginBalance } from "../hooks/useMarginBalance.js";

type Tab = "deposit" | "withdraw";

function formatUsdc(raw: bigint): string {
  const dollars = Number(raw < 0n ? 0n : raw) / 1_000_000;
  return dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Props {
  trader: `0x${string}` | undefined;
}

export function MarginPanel({ trader }: Props) {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { balance, refetch } = useMarginBalance(trader);
  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit() {
    if (!authenticated) { login(); return; }
    if (!trader || !wallets[0]) return;

    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) { setError("Enter a valid amount"); return; }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const provider = await wallets[0].getEthereumProvider();
      const walletClient = createWalletClient({ account: trader, chain: arcTestnet, transport: custom(provider) });
      const amountBn = parseUnits(parsed.toFixed(6), 6);

      if (tab === "deposit") {
        await walletClient.writeContract({
          ...usdcContract,
          functionName: "approve",
          args: [ADDRESSES.vault, amountBn],
        });
        await walletClient.writeContract({
          ...vaultContract,
          functionName: "deposit",
          args: [amountBn],
        });
        setSuccess(`Deposited $${parsed.toFixed(2)} USDC`);
      } else {
        await walletClient.writeContract({
          ...vaultContract,
          functionName: "withdraw",
          args: [amountBn, trader],
        });
        setSuccess(`Withdrew $${parsed.toFixed(2)} USDC`);
      }

      setAmount("");
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 80) : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel" style={styles.wrapper}>
      {/* Balance row */}
      <div style={styles.balanceRow}>
        <span className="label">Vault Balance</span>
        <span className="price" style={styles.balance}>
          ${authenticated && trader ? formatUsdc(balance) : "—"}
        </span>
      </div>

      <div className="divider" />

      {/* Tab strip */}
      <div className="tab-strip">
        <button className={`tab ${tab === "deposit" ? "tab--active" : ""}`} onClick={() => setTab("deposit")}>
          Deposit
        </button>
        <button className={`tab ${tab === "withdraw" ? "tab--active" : ""}`} onClick={() => setTab("withdraw")}>
          Withdraw
        </button>
      </div>

      {/* Amount input */}
      <div style={styles.field}>
        <label className="label">Amount (USDC)</label>
        <input
          className="input"
          type="number"
          min="0"
          step="1"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {tab === "withdraw" && authenticated && trader && balance > 0n && (
          <button
            className="btn btn-ghost"
            style={styles.maxBtn}
            onClick={() => setAmount((Number(balance) / 1e6).toFixed(6))}
          >
            Max
          </button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {success && <div style={styles.successMsg}>{success}</div>}

      <button
        className="btn btn-primary"
        style={styles.submitBtn}
        onClick={handleSubmit}
        disabled={submitting || (!amount && authenticated)}
      >
        {submitting ? "Confirming…" : authenticated ? (tab === "deposit" ? "Deposit" : "Withdraw") : "Connect Wallet"}
      </button>
    </div>
  );
}

const styles = {
  wrapper: { padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 },
  balanceRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  balance: { fontSize: 18, fontWeight: 700, color: "var(--cyan)" },
  field: { display: "flex", flexDirection: "column" as const, gap: 6, position: "relative" as const },
  maxBtn: { alignSelf: "flex-end", fontSize: 10, padding: "3px 8px", marginTop: 2 },
  error: { fontSize: 11, color: "var(--red)", padding: "6px 10px", background: "var(--red-dim)", borderRadius: "var(--radius-md)" },
  successMsg: { fontSize: 11, color: "var(--green)", padding: "6px 10px", background: "var(--green-dim)", borderRadius: "var(--radius-md)" },
  submitBtn: { width: "100%" },
} satisfies Record<string, React.CSSProperties>;
