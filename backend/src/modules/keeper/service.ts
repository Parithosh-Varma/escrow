/**
 * Keeper bot (CHAIN_MODE=live). Permissionless maintenance calls per
 * EscrowCore:
 *
 *   - autoReleaseMilestone(milestoneId): full approval once the review
 *     deadline passed without client action.
 *   - claimRemainder(milestoneId): refund the held remainder to the client
 *     once the challenge window expired claim-free.
 *
 * Candidate discovery runs off the local mirror (milestones ⋈ chain_links),
 * then every candidate is gated by eth_call simulation so reverted txs (e.g.
 * NotYetDue, WrongMilestoneStatus, ChallengeWindowOpen) never hit the chain.
 * The indexer mirrors the resulting events back into the DB; the keeper never
 * mutates DB state itself. In-flight sends are tracked in-memory so a slow
 * receipt doesn't cause a double-send on the next tick; replay safety across
 * restarts comes from the simulate gate (a settled call reverts).
 */
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { and, eq, isNotNull, lt, ne } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db-instance.js";
import { chainLinks, milestones } from "../../db/schema.js";
import { publicClient } from "../../lib/chains.js";
import { ESCROW_WRITE_ABI } from "../indexer/abi.js";

export function keeperIdle(): boolean {
  return (
    config.CHAIN_MODE !== "live" ||
    !config.KEEPER_PRIVATE_KEY ||
    !config.ESCROW_CONTRACT_ADDRESS
  );
}

export interface KeeperCandidate {
  milestoneId: string;
  chainMilestoneId: string;
}

export interface DueWork {
  autoReleases: KeeperCandidate[];
  claims: KeeperCandidate[];
}

/**
 * Pure planner: local mirror → due work lists. Exported for tests.
 * A milestone is a candidate only when it's chain-linked, past its deadline
 * (with grace), and still in the pre-action status locally.
 */
export async function planDueWork(d: ReturnType<typeof db>, nowMs = Date.now()): Promise<DueWork> {
  const cutoff = new Date(nowMs - config.KEEPER_GRACE_SECONDS * 1000);

  const releaseRows = await d
    .select({ id: milestones.id, chainId: chainLinks.chainId })
    .from(milestones)
    .innerJoin(
      chainLinks,
      and(eq(chainLinks.entityType, "milestone"), eq(chainLinks.entityId, milestones.id))
    )
    .where(and(eq(milestones.status, "submitted"), lt(milestones.reviewDeadline, cutoff)));

  const claimRows = await d
    .select({ id: milestones.id, chainId: chainLinks.chainId })
    .from(milestones)
    .innerJoin(
      chainLinks,
      and(eq(chainLinks.entityType, "milestone"), eq(chainLinks.entityId, milestones.id))
    )
    .where(
      and(
        eq(milestones.status, "approved"),
        ne(milestones.remainderAmount, "0"),
        isNotNull(milestones.remainderAmount),
        lt(milestones.challengeDeadline, cutoff)
      )
    );

  return {
    autoReleases: releaseRows.map((r) => ({ milestoneId: r.id, chainMilestoneId: r.chainId })),
    claims: claimRows.map((r) => ({ milestoneId: r.id, chainMilestoneId: r.chainId }))
  };
}

function wallet() {
  const account = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as `0x${string}`);
  const chain = config.RPC_URL.includes("sepolia") ? baseSepolia : base;
  return { account, client: createWalletClient({ account, chain, transport: http(config.RPC_URL) }) };
}

async function trySend(
  functionName: "autoReleaseMilestone" | "claimRemainder",
  args: [bigint]
): Promise<string | null> {
  const pc = publicClient();
  const address = config.ESCROW_CONTRACT_ADDRESS!.trim() as Address;
  const { account, client: wc } = wallet();
  try {
    await pc.simulateContract({
      address,
      abi: ESCROW_WRITE_ABI,
      functionName,
      args,
      account
    });
  } catch (e) {
    console.log("[keeper] %s(%s) not eligible: %s", functionName, args[0], shortReason(e));
    return null;
  }
  try {
    const hash = await wc.writeContract({
      address,
      abi: ESCROW_WRITE_ABI,
      functionName,
      args,
      gas: 300000n
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error("[keeper] %s(%s) reverted on-chain: %s", functionName, args[0], hash);
      return null;
    }
    console.log("[keeper] %s(%s) confirmed: %s", functionName, args[0], hash);
    return hash;
  } catch (e) {
    console.error("[keeper] %s(%s) send failed: %s", functionName, args[0], shortReason(e));
    return null;
  }
}

function shortReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}

/** One keeper tick: plan → simulate → send. Safe to call directly in tests. */
export async function runKeeperOnce(): Promise<DueWork> {
  const work = await planDueWork(db());
  for (const c of work.autoReleases) {
    await trySend("autoReleaseMilestone", [BigInt(c.chainMilestoneId)]);
  }
  for (const c of work.claims) {
    await trySend("claimRemainder", [BigInt(c.chainMilestoneId)]);
  }
  return work;
}

export function startKeeper(_app: unknown): void {
  if (keeperIdle()) {
    console.log(
      "[keeper] idle (CHAIN_MODE=%s, key=%s, escrow=%s)",
      config.CHAIN_MODE,
      config.KEEPER_PRIVATE_KEY ? "set" : "-",
      config.ESCROW_CONTRACT_ADDRESS || "-"
    );
    return;
  }
  const acct = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as `0x${string}`);
  console.log("[keeper] started (address=%s, poll=%dms, grace=%ds)",
    acct.address, config.KEEPER_POLL_MS, config.KEEPER_GRACE_SECONDS);
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runKeeperOnce();
    } catch (e) {
      console.error("[keeper] tick error", e);
    } finally {
      running = false;
    }
  }, config.KEEPER_POLL_MS).unref();
}
