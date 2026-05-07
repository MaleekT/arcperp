import { createContext, useContext, useMemo, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import type { Chain, EIP1193Provider } from "viem";

// ── Wallet state shape ────────────────────────────────────────────────────────

export interface WalletState {
  authenticated: boolean;
  address: `0x${string}` | undefined;
  ready: boolean;
  login: () => void;
  logout: () => void;
  getProvider: () => Promise<EIP1193Provider>;
}

const STUB: WalletState = {
  authenticated: false,
  address: undefined,
  ready: true,
  login: () => { alert("Add VITE_PRIVY_APP_ID to frontend/.env.local to enable wallet connection."); },
  logout: () => {},
  getProvider: async () => { throw new Error("Wallet not connected"); },
};

const WalletContext = createContext<WalletState>(STUB);

// ── useWallet — the only hook components should call ─────────────────────────

export function useWallet(): WalletState {
  return useContext(WalletContext);
}

// ── PrivyBridge — lives inside PrivyProvider, syncs state to WalletContext ───

function PrivyBridge({ children }: { children: ReactNode }) {
  const { authenticated, user, ready, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const value = useMemo<WalletState>(() => {
    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    return {
      authenticated,
      address: user?.wallet?.address as `0x${string}` | undefined,
      ready,
      login,
      logout,
      getProvider: async () => {
        if (!wallet) throw new Error("No wallet connected");
        return wallet.getEthereumProvider() as unknown as EIP1193Provider;
      },
    };
  }, [authenticated, user, ready, login, logout, wallets]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// ── WalletProvider — wraps Privy when configured, uses stub otherwise ────────

interface WalletProviderProps {
  children: ReactNode;
  privyAppId: string;
  chain: Chain;
}

export function WalletProvider({ children, privyAppId, chain }: WalletProviderProps) {
  if (!privyAppId) {
    return <WalletContext.Provider value={STUB}>{children}</WalletContext.Provider>;
  }

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: { theme: "dark", accentColor: "#00D4C8" },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}
