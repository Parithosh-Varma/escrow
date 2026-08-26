/**
 * Event indexer (spec §10 step 6). Polls EscrowCore on Base and mirrors state
 * into the backend DB. Stays idle unless CHAIN_MODE=live AND a contract
 * address is configured — local dev and tests never touch the chain.
 *
 * Real event surface (contracts/files/EscrowCore.sol):
 *   ProjectCreated(uint256 indexed projectId, address indexed client,
 *                  address indexed freelancer, address token, uint256 totalAmount)
 *   ProjectFunded(uint256 indexed projectId, uint256 amount)
 *   MilestoneStarted(uint256 indexed milestoneId, address indexed freelancer)
 *   MilestoneSubmitted(uint256 indexed milestoneId, bytes32 deliverableHash,
 *                      bytes32 proofOfWorkHash, uint64 reviewDeadline)
 *   MilestoneApproved(uint256 indexed milestoneId, uint32 approvedBps, address indexed approver)
 *   AutoReleased(uint256 indexed milestoneId, uint32 approvedBps)
 *   MilestoneDisputed(uint256 indexed milestoneId, uint8 disputeType)
 *   DisputeResolved(uint256 indexed milestoneId, uint16 splitBps)
 *   FundsReleased(uint256 indexed milestoneId, uint256 freelancerAmount, uint256 fee, uint256 clientRefund)
 *   RemainderHeld(uint256 indexed milestoneId, uint256 amount, uint64 challengeDeadline)
 *   RemainderClaimed(uint256 indexed milestoneId, uint256 amount)
 *
 * Idempotent replay: chain_events has UNIQUE (contract_key, tx_hash, log_index);
 * side effects run only when a log row is newly inserted, and every handler is
 * written to tolerate re-application (upserts / status overwrites with the same
 * on-chain truth). Ledger refs are `${txHash}:${logIndex}` so money rows stay
 * deduplicated per log.
 */
import type { FastifyInstance } from "fastify";
import { createPublicClient, http, getAddress, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db-instance.js";
import {
  indexerState,
  chainEvents,
  milestones,
  disputes,
  submissions,
  projects
} from "../../db/schema.js";
import { recordLedger } from "../../services/ledger.js";
import { notify } from "../../services/notifications.js";
import { DISPUTE_TYPE_CANCELLATION, ESCROW_CORE_ABI, ESCROW_VIEW_ABI } from "./abi.js";
import {
  entityForChainId,
  hydrateMilestoneLinks,
  resolveMilestone,
  toChainId,
  tryAutoBindProject,
  type FetchChainMilestones
} from "./mapping.js";

export interface ChainEventInput {
  contractKey: string;
  name: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  args: Record<string, unknown>;
}

/** viem returns BigInt for uint256/uint64 — JSONB needs plain values. */
export function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

export function client() {
  if (!config.RPC_URL) return null;
  const chain = config.RPC_URL.includes("sepolia") ? baseSepolia : base;
  return createPublicClient({ chain, transport: http(config.RPC_URL) });
}

export function contractsConfigured(): boolean {
  return Boolean(config.ESCROW_CONTRACT_ADDRESS);
}

export function indexerIdle(): boolean {
  return config.CHAIN_MODE !== "live" || !contractsConfigured();
}

/** Insert-first gate: UNIQUE (contract_key, tx_hash, log_index). */
export async function recordEvent(input: ChainEventInput): Promise<{ inserted: boolean }> {
  const rows = await db()
    .insert(chainEvents)
    .values({
      contractKey: input.contractKey,
      name: input.name,
      blockNumber: input.blockNumber,
      txHash: input.txHash.toLowerCase(),
      logIndex: input.logIndex,
      args: serializeArgs(input.args) as object
    })
    .onConflictDoNothing()
    .returning();
  return { inserted: rows.length > 0 };
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

// ---------------------------------------------------------------------------
// Handlers — each receives canonicalized args (BigInts already parsed back).
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;
interface Ctx {
  /** Injected RPC accessor for lazy milestone-link hydration; null in tests. */
  fetchChainMilestones: FetchChainMilestones | null;
}

const big = (v: unknown): bigint => BigInt(toChainId(v));

async function touchMilestone(
  d: ReturnType<typeof db>,
  chainMilestoneId: unknown,
  ctx: Ctx,
  set: Partial<typeof milestones.$inferInsert>
) {
  const uuid = await resolveMilestone(d, toChainId(chainMilestoneId), ctx.fetchChainMilestones ?? undefined);
  if (!uuid) return null;
  await d
    .update(milestones)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(milestones.id, uuid));
  return uuid;
}

async function notifyProjectParties(
  d: ReturnType<typeof db>,
  projectId: string,
  type: string,
  payload: Record<string, unknown>
) {
  const [p] = await d.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) return;
  await notify(d, p.clientId, type, payload);
  await notify(d, p.freelancerId, type, payload);
}

async function applyEscrowEvent(
  event: { name: string; args: Args; txHash?: string; logIndex?: number },
  ctx: Ctx
): Promise<void> {
  const d = db();
  const a = event.args;

  switch (event.name) {
    case "ProjectCreated": {
      // Auto-bind by wallet pair + totalAmount; explicit admin bind wins later.
      const res = await tryAutoBindProject(
        d,
        toChainId(a.projectId),
        String(a.client ?? ""),
        String(a.freelancer ?? ""),
        toChainId(a.totalAmount ?? "0")
      );
      if (res?.bound) {
        await hydrateFromChain(d, res.projectId, toChainId(a.projectId), ctx);
      }
      break;
    }

    case "ProjectFunded": {
      const chainId = toChainId(a.projectId);
      const uuid = await entityForChainId(d, "project", chainId);
      if (!uuid) break; // unbound (ProjectCreated missed) — admin bind will heal history
      await d
        .update(projects)
        .set({ status: "funded", updatedAt: new Date() })
        .where(eq(projects.id, uuid));
      await d
        .update(milestones)
        .set({ status: "funded", fundedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(milestones.projectId, uuid), eq(milestones.status, "created")));
      await notifyProjectParties(d, uuid, "project.funded", { chainProjectId: chainId });
      break;
    }

    case "MilestoneStarted":
      await touchMilestone(d, a.milestoneId, ctx, { status: "in_progress" });
      break;

    case "MilestoneSubmitted": {
      const deadlineMs = Number(big(a.reviewDeadline ?? 0n)) * 1000;
      const msUuid = await touchMilestone(d, a.milestoneId, ctx, {
        status: "submitted",
        submittedAt: new Date(),
        reviewDeadline: deadlineMs > 0 ? new Date(deadlineMs) : null
      });
      if (msUuid) {
        await d.insert(submissions).values({
          milestoneId: msUuid,
          note: "mirrored from on-chain submitMilestone",
          deliverableHash: String(a.deliverableHash ?? ""),
          aiStatus: "onchain"
        });
      }
      break;
    }

    case "MilestoneApproved":
      await touchMilestone(d, a.milestoneId, ctx, {
        status: "approved",
        approvedBps: Number(a.approvedBps ?? 10000)
      });
      break;

    case "AutoReleased":
      await touchMilestone(d, a.milestoneId, ctx, {
        status: "auto_released",
        approvedBps: Number(a.approvedBps ?? 10000),
        resolvedAt: new Date()
      });
      break;

    case "FundsReleased": {
      // Money mirror lives here (single place); statuses are owned by the
      // lifecycle events above/below so replay order never double-writes.
      const msUuid = await resolveMilestone(
        d,
        toChainId(a.milestoneId),
        ctx.fetchChainMilestones ?? undefined
      );
      if (!msUuid) break;
      const ref = `${event.txHash ?? "unknown"}:${event.logIndex ?? 0}`;
      const freelancerAmount = big(a.freelancerAmount ?? 0n);
      const fee = big(a.fee ?? 0n);
      const clientRefund = big(a.clientRefund ?? 0n);
      if (freelancerAmount > 0n) {
        await recordLedger(d, {
          milestoneId: msUuid,
          kind: "release_freelancer",
          account: "freelancer",
          amount: freelancerAmount,
          ref
        });
      }
      if (fee > 0n) {
        await recordLedger(d, {
          milestoneId: msUuid,
          kind: "platform_fee",
          account: "platform_fee",
          amount: fee,
          ref
        });
      }
      if (clientRefund > 0n) {
        await recordLedger(d, {
          milestoneId: msUuid,
          kind: "refund_client",
          account: "client_refund",
          amount: clientRefund,
          ref
        });
      }
      break;
    }

    case "RemainderHeld":
      await touchMilestone(d, a.milestoneId, ctx, {
        remainderAmount: toChainId(a.amount ?? 0n),
        challengeDeadline: new Date(Number(big(a.challengeDeadline ?? 0n)) * 1000)
      });
      break;

    case "RemainderClaimed": {
      const msUuid = await touchMilestone(d, a.milestoneId, ctx, {
        remainderAmount: "0",
        status: "closed",
        resolvedAt: new Date()
      });
      if (msUuid) {
        const amount = big(a.amount ?? 0n);
        if (amount > 0n) {
          await recordLedger(d, {
            milestoneId: msUuid,
            kind: "refund_client",
            account: "client_refund",
            amount,
            ref: `${event.txHash ?? "unknown"}:${event.logIndex ?? 0}`
          });
        }
        const projId = await projectOf(d, msUuid);
        if (projId) {
          await notifyProjectParties(d, projId, "milestone.remainder_claimed", {
            milestoneId: msUuid,
            amount: amount.toString()
          });
        }
      }
      break;
    }

    case "MilestoneDisputed": {
      const msUuid = await resolveMilestone(
        d,
        toChainId(a.milestoneId),
        ctx.fetchChainMilestones ?? undefined
      );
      if (!msUuid) break;
      const disputeType = Number(a.disputeType ?? 0);
      const [open] = await d
        .select({ id: disputes.id })
        .from(disputes)
        .where(and(eq(disputes.milestoneId, msUuid), sql`${disputes.resolvedAt} IS NULL`))
        .limit(1);
      if (!open) {
        await d.insert(disputes).values({
          milestoneId: msUuid,
          type: disputeType === DISPUTE_TYPE_CANCELLATION ? "cancellation" : "quality",
          raisedBy: "chain",
          reason: `on-chain dispute (type ${disputeType})`,
          amountStake: "0",
          jurorCount: 3,
          status: "evidence"
        }).onConflictDoNothing();
      }
      await d
        .update(milestones)
        .set({ status: "disputed", updatedAt: new Date() })
        .where(eq(milestones.id, msUuid));
      break;
    }

    case "DisputeResolved": {
      const msUuid = await resolveMilestone(
        d,
        toChainId(a.milestoneId),
        ctx.fetchChainMilestones ?? undefined
      );
      if (!msUuid) break;
      const splitBps = Number(a.splitBps ?? 0);
      const resolution = splitBps >= 5000 ? "freelancer" : "client";
      await d
        .update(disputes)
        .set({ status: "resolved", resolution, splitBps, resolvedAt: new Date() })
        .where(and(eq(disputes.milestoneId, msUuid), sql`${disputes.resolvedAt} IS NULL`));
      await d
        .update(milestones)
        .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(milestones.id, msUuid));
      const projId = await projectOf(d, msUuid);
      if (projId) {
        await notifyProjectParties(d, projId, "dispute.resolved", {
          milestoneId: msUuid,
          splitBps,
          resolution
        });
      }
      break;
    }

    default:
      break;
  }
}

async function projectOf(d: ReturnType<typeof db>, milestoneId: string): Promise<string | null> {
  const [m] = await d.select({ projectId: milestones.projectId }).from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
  return m?.projectId ?? null;
}

/** Derive milestone links right after a project binds (best effort). */
async function hydrateFromChain(
  d: ReturnType<typeof db>,
  projectUuid: string,
  chainProjectId: string,
  ctx: Ctx
) {
  if (!ctx.fetchChainMilestones) return;
  try {
    const ids = await ctx.fetchChainMilestones(chainProjectId);
    await hydrateMilestoneLinks(d, projectUuid, ids);
  } catch {
    // hydration retries lazily via resolveMilestone on first milestone event
  }
}

/** Top-level entry: apply one ingested log. Exported for tests/replay tooling. */
export async function applyEvent(event: ChainEventInput): Promise<void> {
  await applyEscrowEvent(
    {
      name: event.name,
      args: deserializeArgs(event.args),
      txHash: event.txHash,
      logIndex: event.logIndex
    },
    { fetchChainMilestones: liveFetchChainMilestonesOrNull() }
  );
}

function deserializeArgs(args: Record<string, unknown>): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && /^\d+$/.test(v)) out[k] = BigInt(v);
    else out[k] = v;
  }
  return out;
}

function liveFetchChainMilestonesOrNull(): FetchChainMilestones | null {
  if (config.CHAIN_MODE !== "live" || !config.ESCROW_CONTRACT_ADDRESS || !config.RPC_URL) return null;
  const pc = client();
  if (!pc) return null;
  const address = normalizeContractAddress(config.ESCROW_CONTRACT_ADDRESS);
  return async (chainProjectId: string) => {
    return await pc.readContract({
      address,
      abi: ESCROW_VIEW_ABI,
      functionName: "getProjectMilestones",
      args: [BigInt(toChainId(chainProjectId))]
    });
  };
}

export function normalizeContractAddress(addr: string): Address {
  return getAddress(addr.trim());
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

const CHUNK = 5000; // stay polite with public RPC range limits

async function processLogs(
  pc: NonNullable<ReturnType<typeof client>>,
  contractAddress: Address
) {
  const contractKey = "escrow";
  const last = await lastIndexerBlock(contractKey);
  const head = Number(await pc.getBlockNumber());
  if (head <= last) return;

  const ctx: Ctx = { fetchChainMilestones: liveFetchChainMilestonesOrNull() };
  let cursor = last;
  while (cursor < head) {
    const to = Math.min(cursor + CHUNK, head);
    const logs = await pc.getLogs({
      address: contractAddress,
      fromBlock: BigInt(cursor + 1),
      toBlock: BigInt(to),
      events: ESCROW_CORE_ABI
    });

    // Logs arrive ordered; process strictly in block/log order.
    logs.sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex);
    for (const log of logs) {
      const inserted = await recordEvent({
        contractKey,
        name: log.eventName ?? "unknown",
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: log.logIndex ?? 0,
        args: (log.args as Record<string, unknown>) ?? {}
      });
      if (!inserted.inserted) continue; // replayed log — side effects already applied
      await applyEscrowEvent(
        {
          name: log.eventName ?? "unknown",
          args: (log.args as Record<string, unknown>) ?? {}
        },
        ctx
      );
    }
    cursor = to;
    await saveIndexerBlock(contractKey, to);
  }
}

export function startPolling(_app: FastifyInstance): void {
  if (indexerIdle()) {
    console.log(
      "[indexer] idle (CHAIN_MODE=%s, escrow=%s)",
      config.CHAIN_MODE,
      config.ESCROW_CONTRACT_ADDRESS || "-"
    );
    return;
  }
  const pc = client();
  if (!pc) return;
  const address = normalizeContractAddress(config.ESCROW_CONTRACT_ADDRESS!);
  console.log("[indexer] polling %s from block %d", address, config.INDEXER_START_BLOCK);
  let running = false;
  setInterval(async () => {
    if (running) return; // previous tick still in flight
    running = true;
    try {
      await processLogs(pc, address);
    } catch (e) {
      console.error("[indexer] poll error", e);
    } finally {
      running = false;
    }
  }, config.INDEXER_POLL_MS).unref();
}
