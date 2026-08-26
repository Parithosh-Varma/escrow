import { createWalletClient, custom, type WalletClient } from "viem";
import { baseSepolia } from "viem/chains";

export function hasWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export function getWalletClient(): WalletClient {
  if (!window.ethereum) throw new Error("No Ethereum wallet detected. Install MetaMask.");
  return createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
}

export async function connectAddress(): Promise<`0x${string}`> {
  const client = getWalletClient();
  const [address] = await client.requestAddresses();
  return address;
}

export async function signMessage(address: `0x${string}`, message: string): Promise<`0x${string}`> {
  const client = getWalletClient();
  return client.signMessage({ account: address, message });
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
