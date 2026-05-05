import { createPublicClient, defineChain, http, keccak256, toBytes } from "viem";
import { VAULT_ABI, PERP_ENGINE_ABI, LIQ_ENGINE_ABI, ERC20_ABI } from "./abis/index.js";

/** Throws at module load time if a required env var is missing or invalid. */
function requireEnv(key: string, fallback?: string): string {
  const value = import.meta.env[key] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${key}. Set it in .env.local`);
  return value;
}

/** Requires an env var that must be a 0x-prefixed Ethereum address. */
function requireAddress(key: string, fallback?: string): `0x${string}` {
  const value = requireEnv(key, fallback);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Env var ${key}="${value}" is not a valid Ethereum address`);
  }
  return value as `0x${string}`;
}

const rpcUrl = requireEnv("VITE_ARC_RPC_URL", "https://rpc.arc.testnet");

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [rpcUrl] },
    public: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

export const ADDRESSES = {
  usdc: requireAddress("VITE_USDC_ADDRESS", "0x3600000000000000000000000000000000000000"),
  vault: requireAddress("VITE_VAULT_MANAGER_ADDRESS"),
  perpEngine: requireAddress("VITE_PERP_ENGINE_ADDRESS"),
  liqEngine: requireAddress("VITE_LIQUIDATION_ENGINE_ADDRESS"),
} as const;

export const PAIR_IDS = {
  BTC_USDC: keccak256(toBytes("BTC-USDC")) as `0x${string}`,
  ETH_USDC: keccak256(toBytes("ETH-USDC")) as `0x${string}`,
  EURC_USDC: keccak256(toBytes("EURC-USDC")) as `0x${string}`,
} as const;

export const PAIRS = [
  { id: PAIR_IDS.BTC_USDC, label: "BTC-USDC", symbol: "BTC" },
  { id: PAIR_IDS.ETH_USDC, label: "ETH-USDC", symbol: "ETH" },
  { id: PAIR_IDS.EURC_USDC, label: "EURC-USDC", symbol: "EURC" },
] as const;

export function createClient() {
  return createPublicClient({ chain: arcTestnet, transport: http() });
}

export const vaultContract = { address: ADDRESSES.vault, abi: VAULT_ABI } as const;
export const perpContract = { address: ADDRESSES.perpEngine, abi: PERP_ENGINE_ABI } as const;
export const liqContract = { address: ADDRESSES.liqEngine, abi: LIQ_ENGINE_ABI } as const;
export const usdcContract = { address: ADDRESSES.usdc, abi: ERC20_ABI } as const;
