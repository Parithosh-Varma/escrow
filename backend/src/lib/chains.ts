import { createPublicClient, http, verifyMessage, getAddress } from "viem";
import { baseSepolia, base } from "viem/chains";
import { config } from "../config.js";
import { unauthorized } from "../errors.js";

export function publicClient() {
  const chain = config.CHAIN_MODE === "live" && !config.RPC_URL.includes("sepolia")
    ? base
    : baseSepolia;
  return createPublicClient({ chain, transport: http(config.RPC_URL) });
}

export function normalizeAddress(a: string): string {
  try {
    return getAddress(a).toLowerCase();
  } catch {
    throw unauthorized("invalid address");
  }
}

const CHAIN_ID = 84532; // Base Sepolia; switch on mainnet launch

export function authMessage(address: string, nonce: string): string {
  return [
    `Escrow wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `URI: https://escrow.local`,
    `Version: 1`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`
  ].join("\n");
}

export async function verifyWalletSignature(
  address: string,
  message: string,
  signature: `0x${string}`
): Promise<boolean> {
  try {
    return await verifyMessage({ address: getAddress(address), message, signature });
  } catch {
    return false;
  }
}
