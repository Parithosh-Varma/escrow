/// <reference types="vite/client"/>

interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

interface Window {
  ethereum?: EIP1193Provider;
}
