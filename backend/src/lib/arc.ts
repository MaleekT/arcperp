import { createPublicClient, createWalletClient, defineChain, http, webSocket, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Arc Network (Chain ID 5042002) ────────────────────────────────────────────

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.arc.testnet"], webSocket: [process.env.ARC_WS_URL ?? "wss://rpc.arc.testnet"] },
    public: { http: [process.env.ARC_RPC_URL ?? "https://rpc.arc.testnet"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

// ── Contract addresses ────────────────────────────────────────────────────────

export const CONTRACTS = {
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  pyth: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729" as `0x${string}`,
  vaultManager: (process.env.VAULT_MANAGER_ADDRESS ?? "") as `0x${string}`,
  feeCollector: (process.env.FEE_COLLECTOR_ADDRESS ?? "") as `0x${string}`,
  perpEngine: (process.env.PERP_ENGINE_ADDRESS ?? "") as `0x${string}`,
  liquidationEngine: (process.env.LIQUIDATION_ENGINE_ADDRESS ?? "") as `0x${string}`,
} as const;

// ── Pair constants ────────────────────────────────────────────────────────────

export const PAIRS = {
  BTC_USDC: keccak256(toBytes("BTC-USDC")),
  ETH_USDC: keccak256(toBytes("ETH-USDC")),
  EURC_USDC: keccak256(toBytes("EURC-USDC")),
} as const;

export const PYTH_IDS = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" as `0x${string}`,
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as `0x${string}`,
  EURC: "0x76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb" as `0x${string}`,
} as const;

// ── Clients ───────────────────────────────────────────────────────────────────

/** Public (read-only) client for Arc testnet */
export function createArcPublicClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(process.env.ARC_RPC_URL),
    batch: { multicall: true },
  });
}

/** WebSocket client for real-time event subscriptions */
export function createArcWsClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: webSocket(process.env.ARC_WS_URL),
  });
}

/** Wallet client for transaction sending — loads key from env */
export function createArcWalletClient() {
  const key = process.env.BOT_PRIVATE_KEY;
  if (!key) throw new Error("BOT_PRIVATE_KEY not set");
  const account = privateKeyToAccount(`0x${key.replace(/^0x/, "")}`);
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(process.env.ARC_RPC_URL),
  });
}

/** Retry a promise-returning function with exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/** Validate all required env vars are present at startup */
export function validateEnv(required: string[]): void {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
