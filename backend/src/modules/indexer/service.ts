/**
 * Event indexer (spec §10 step 6). Polls the escrow + dispute contracts on
 * Base and mirrors state into the backend DB. Stays idle unless
 * CHAIN_MODE=live AND contract addresses are configured — so local dev and
 * tests never touch the chain.
 *
 * Planned event surface (matches spec §3; adjust once contracts land):
 *   Escrow: ProjectFunded, MilestoneSubmitted(bytes32,string), MilestoneApproved(bytes32,uint256),
 *           AutoReleased(bytes32), FundsReleased(bytes32,uint256,uint256,uint256), Refunded(bytes32,uint256)
 *   Disputes: DisputeOpened, VoteCommitted, VoteRevealed, DisputeResolved
 */
import type { FastifyInstance } from "fastify";
import { createPublicClient, http } from "viem";
import { baseSepolia, base } from "viem/chains";
import { config } from "../../config.js";
import { db } from "../../db-instance.js";
import { indexerState, chainEvents } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const ESCROW_EVENTS = [
  "ProjectFunded(uint256,address,address)",
  "MilestoneSubmitted(bytes32,address)",
  "MilestoneApproved(bytes32,uint256,address)",
  "AutoReleased(bytes32)",
  "FundsReleased(bytes32,uint256,uint256,uint256)",
  "Refunded(bytes32,uint256)"
] as const;

export function client() {
  if (!config.RPC_URL) return null;
  const chain = config.RPC_URL.includes("sepolia") ? baseSepolia : base;
  return createPublicClient({ chain, transport: http(config.RPC_URL) });
}

export function contractsConfigured(): boolean {
  return Boolean(config.ESCROW_CONTRACT_ADDRESS || config.DISPUTE_CONTRACT_ADDRESS);
}

export function indexerIdle(): boolean {
  return config.CHAIN_MODE !== "live" || !contractsConfigured();
}

export async function recordEvent(input: {
  contractKey: string;
  name: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  args: Record<string, unknown>;
}): Promise<{ inserted: boolean }> {
  try {
    await db().insert(chainEvents).values({
      contractKey: input.contractKey,
      name: input.name,
      blockNumber: input.blockNumber,
      txHash: input.txHash,
      logIndex: input.logIndex,
      args: input.args as object
    });
    return { inserted: true };
  } catch {
    return { inserted: false }; // unique(tx_hash, log_index) → idempotent replay
  }
}

export async function lastIndexerBlock(contractKey: string): Promise<number> {
  const [row] = await db()
    .select()
    .from(indexerState)
    .where(eq(indexerState.contractKey, contractKey))
    .limit(1);
  return row?.lastBlock ?? config.INDEXER_START_BLOCK;
}

export async function saveIndexerBlock(contractKey: string, block: number) {
  await db()
    .insert(indexerState)
    .values({ contractKey, lastBlock: block })
    .onConflictDoUpdate({ target: indexerState.contractKey, set: { lastBlock: block } });
}

export function startPolling(_app: FastifyInstance): void {
  if (indexerIdle()) {
    console.log(
      "[indexer] idle (CHAIN_MODE=%s, escrow=%s, dispute=%s)",
      config.CHAIN_MODE,
      config.ESCROW_CONTRACT_ADDRESS || "-",
      config.DISPUTE_CONTRACT_ADDRESS || "-"
    );
    return;
  }
  const pc = client();
  if (!pc) return;
  console.log("[indexer] polling started");
  setInterval(async () => {
    try {
      const head = Number(await pc.getBlockNumber());
      for (const key of ["escrow", "disputes"]) {
        const last = await lastIndexerBlock(key);
        if (head > last) await saveIndexerBlock(key, head);
      }
      // TODO(contracts): fetchLogs per ESCROW_EVENTS ABI once addresses exist,
      // then call recordEvent() + apply state transitions idempotently.
    } catch (e) {
      console.error("[indexer] poll error", e);
    }
  }, config.INDEXER_POLL_MS).unref();
}
