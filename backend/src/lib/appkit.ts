/**
 * Circle App Kit integration for ArcPerp.
 *
 * Exposes three operations:
 *   bridgeDeposit  — CCTP: any chain → Arc testnet USDC via TokenMessenger
 *   swapAndDeposit — App Kit Swap: any token → USDC, then deposit to VaultManager
 *   withdrawToWallet — withdraw USDC from VaultManager to external wallet
 */

import { parseAbi, parseUnits } from "viem";
import { createArcPublicClient, createArcWalletClient, CONTRACTS } from "./arc.js";

// ── Circle Arc contract addresses ─────────────────────────────────────────────

const CCTP_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
const CCTP_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

const ARC_CHAIN_ID = 5042002;
const USDC_DECIMALS = 6;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const TOKEN_MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
]);

const VAULT_ABI = parseAbi([
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount, address recipient) external",
  "function getMarginBalance(address trader) view returns (uint256)",
]);

// ── Arc chain domain ID for CCTP ──────────────────────────────────────────────

const ARC_CCTP_DOMAIN = 9; // Circle's registered domain ID for Arc testnet

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pad an address to bytes32 for CCTP mintRecipient */
function addressToBytes32(address: `0x${string}`): `0x${string}` {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

async function ensureApproval(
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  owner: `0x${string}`
): Promise<void> {
  const publicClient = createArcPublicClient();
  const walletClient = createArcWalletClient();

  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });

  if (allowance < amount) {
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BridgeDepositParams {
  /** Source chain USDC token address */
  sourceBurnToken: `0x${string}`;
  /** Amount in human-readable USDC (e.g. "100.50") */
  amountUsdc: string;
  /** Recipient on Arc testnet — defaults to wallet address */
  recipient?: `0x${string}`;
}

/**
 * Bridge USDC from any CCTP-supported chain to Arc testnet via TokenMessengerV2.
 * Caller must be on the source chain; this function runs source-side approval + depositForBurn.
 */
export async function bridgeDeposit(params: BridgeDepositParams): Promise<`0x${string}`> {
  const { sourceBurnToken, amountUsdc, recipient } = params;
  const walletClient = createArcWalletClient();
  const publicClient = createArcPublicClient();

  const amount = parseUnits(amountUsdc, USDC_DECIMALS);
  const account = walletClient.account.address;
  const mintRecipient = addressToBytes32(recipient ?? account);

  await ensureApproval(sourceBurnToken, CCTP_TOKEN_MESSENGER, amount, account);

  const hash = await walletClient.writeContract({
    address: CCTP_TOKEN_MESSENGER,
    abi: TOKEN_MESSENGER_ABI,
    functionName: "depositForBurn",
    args: [amount, ARC_CCTP_DOMAIN, mintRecipient as `0x${string}`, sourceBurnToken],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[appkit] CCTP bridge initiated: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

export interface SwapAndDepositParams {
  /** Amount of USDC to deposit after swap (in human units) */
  amountUsdc: string;
}

/**
 * Approve VaultManager to spend USDC, then deposit into VaultManager.
 * Swap step is handled externally by Circle App Kit UI SDK.
 */
export async function depositToVault(amountUsdc: string): Promise<`0x${string}`> {
  const walletClient = createArcWalletClient();
  const publicClient = createArcPublicClient();

  const amount = parseUnits(amountUsdc, USDC_DECIMALS);
  const account = walletClient.account.address;

  await ensureApproval(CONTRACTS.usdc, CONTRACTS.vaultManager, amount, account);

  const hash = await walletClient.writeContract({
    address: CONTRACTS.vaultManager,
    abi: VAULT_ABI,
    functionName: "deposit",
    args: [amount],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[appkit] Deposited ${amountUsdc} USDC: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

export interface WithdrawParams {
  /** Amount in human-readable USDC */
  amountUsdc: string;
  /** Destination wallet — defaults to connected wallet */
  recipient?: `0x${string}`;
}

/**
 * Withdraw USDC from VaultManager to an external wallet.
 */
export async function withdrawToWallet(params: WithdrawParams): Promise<`0x${string}`> {
  const { amountUsdc, recipient } = params;
  const walletClient = createArcWalletClient();
  const publicClient = createArcPublicClient();

  const amount = parseUnits(amountUsdc, USDC_DECIMALS);
  const account = walletClient.account.address;

  const hash = await walletClient.writeContract({
    address: CONTRACTS.vaultManager,
    abi: VAULT_ABI,
    functionName: "withdraw",
    args: [amount, recipient ?? account],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[appkit] Withdrew ${amountUsdc} USDC: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

/**
 * Read the current margin balance of a trader from VaultManager.
 */
export async function getMarginBalance(trader: `0x${string}`): Promise<bigint> {
  const publicClient = createArcPublicClient();
  return publicClient.readContract({
    address: CONTRACTS.vaultManager,
    abi: VAULT_ABI,
    functionName: "getMarginBalance",
    args: [trader],
  });
}
