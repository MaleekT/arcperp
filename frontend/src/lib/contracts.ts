import { createPublicClient, defineChain, http, keccak256, toBytes } from "viem";
import { VAULT_ABI, PERP_ENGINE_ABI, LIQ_ENGINE_ABI, ERC20_ABI } from "./abis/index.js";

function requireEnv(key: string, fallback: string): string {
  const value = import.meta.env[key] as string | undefined;
  if (!value) {
    console.warn(`[contracts] ${key} not set — using fallback`);
    return fallback;
  }
  return value;
}

function requireAddress(key: string, fallback: string): `0x${string}` {
  const value = requireEnv(key, fallback);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    console.warn(`[contracts] ${key}="${value}" is not a valid address — using fallback`);
    return fallback as `0x${string}`;
  }
  return value as `0x${string}`;
}

const rpcUrl = requireEnv("VITE_ARC_RPC_URL", "https://rpc.quicknode.testnet.arc.network");

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
  usdc:       requireAddress("VITE_USDC_ADDRESS",              "0x3600000000000000000000000000000000000000"),
  vault:      requireAddress("VITE_VAULT_MANAGER_ADDRESS",     "0x5fa17b9d90c5bc74ec9ef42ca149fb9c5c096899"),
  perpEngine: requireAddress("VITE_PERP_ENGINE_ADDRESS",       "0xdc07cbe108aae0b83356ccc5a8fdb1e728418d4f"),
  liqEngine:  requireAddress("VITE_LIQUIDATION_ENGINE_ADDRESS","0xb2ff23167f9c965f6d7060324f348c77ed3e4b2c"),
} as const;

export const PAIR_IDS = {
  BTC_USDC:  keccak256(toBytes("BTC-USDC"))  as `0x${string}`,
  ETH_USDC:  keccak256(toBytes("ETH-USDC"))  as `0x${string}`,
  EURC_USDC: keccak256(toBytes("EURC-USDC")) as `0x${string}`,
} as const;

export const PAIRS = [
  { id: PAIR_IDS.BTC_USDC,  label: "BTC-USDC",  symbol: "BTC"  },
  { id: PAIR_IDS.ETH_USDC,  label: "ETH-USDC",  symbol: "ETH"  },
  { id: PAIR_IDS.EURC_USDC, label: "EURC-USDC", symbol: "EURC" },
] as const;

export function createClient() {
  return createPublicClient({ chain: arcTestnet, transport: http() });
}

export const vaultContract  = { address: ADDRESSES.vault,      abi: VAULT_ABI       } as const;
export const perpContract   = { address: ADDRESSES.perpEngine, abi: PERP_ENGINE_ABI  } as const;
export const liqContract    = { address: ADDRESSES.liqEngine,  abi: LIQ_ENGINE_ABI   } as const;
export const usdcContract   = { address: ADDRESSES.usdc,       abi: ERC20_ABI        } as const;
