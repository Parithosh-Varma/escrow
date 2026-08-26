/**
 * CHAIN_MODE=live plumbing: real EscrowCore event surface (uint256 ids),
 * chain-id ↔ UUID mapping layer, idempotent replay, and the keeper planner.
 * No RPC involved — events are fed exactly as viem would decode them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db-instance.js";
import { users, projects, milestones, submissions, disputes, chainEvents } from "../src/db/schema.js";
import {
  applyEvent,
  recordEvent,
  type ChainEventInput
} from "../src/modules/indexer/service.js";
import {
  bindChainEntity,
  chainIdForEntity,
  entityForChainId,
  hydrateMilestoneLinks,
  resolveMilestone,
  toChainId
} from "../src/modules/indexer/mapping.js";
import { planDueWork } from "../src/modules/keeper/service.js";

let app: FastifyInstance;

const CLIENT = "0x00000000000000000000000000000000000000c1";
const FREELANCER = "0x00000000000000000000000000000000000000f2";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const M1_AMOUNT = 1000_000000n;
const M2_AMOUNT = 500_000000n;
const TOTAL = M1_AMOUNT + M2_AMOUNT;
// EscrowCore assigns sequential ids; pretend this project landed at 7/11/12.
const CHAIN_PROJECT = 7n;
const CHAIN_M1 = 11n;
const CHAIN_M2 = 12n;

let projectId: string;
let m1Id: string;
let m2Id: string;

function ev(
  name: string,
  args: Record<string, unknown>,
  n: number,
  logIndex = 0
): ChainEventInput {
  return {
    contractKey: "escrow",
    name,
    blockNumber: 100 + n,
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    logIndex,
    args
  };
}

async function apply(input: ChainEventInput) {
  const { inserted } = await recordEvent(input);
  if (inserted) await applyEvent(input);
  return inserted;
}

beforeAll(async () => {
  const { buildApp } = await import("../src/server.js");
  app = await buildApp();
  const d = db();

  await d.insert(users).values([
    { address: CLIENT },
    { address: FREELANCER }
  ]).onConflictDoNothing();
  const [c] = await d.select().from(users).where(eq(users.address, CLIENT));
  const [f] = await d.select().from(users).where(eq(users.address, FREELANCER));

  [projectId] = (
    await d
      .insert(projects)
      .values({
        clientId: c!.id,
        freelancerId: f!.id,
        title: "Chain-linked project",
        tokenAddress: TOKEN,
        totalAmount: TOTAL.toString(),
        status: "created"
      })
      .returning({ id: projects.id })
  ).map((r) => r.id);

  [m1Id, m2Id] = (
    await d
      .insert(milestones)
      .values([
        { projectId: projectId!, idx: 0, title: "m1", amount: M1_AMOUNT.toString(), status: "created" },
        { projectId: projectId!, idx: 1, title: "m2", amount: M2_AMOUNT.toString(), status: "created" }
      ])
      .returning({ id: milestones.id })
  ).map((r) => r.id);
});

describe("chain-id ↔ UUID mapping layer", () => {
  it("canonicalizes uint256 ids", () => {
    expect(toChainId(7n)).toBe("7");
    expect(toChainId(7)).toBe("7");
    expect(toChainId("7")).toBe("7");
    expect(toChainId("0x0b")).toBe("11");
    expect(() => toChainId("nope")).toThrow();
    expect(() => toChainId(1.5)).toThrow();
  });

  it("auto-binds ProjectCreated by wallet pair + totalAmount and hydrates milestones", async () => {
    await apply(
      ev("ProjectCreated", {
        projectId: CHAIN_PROJECT,
        client: CLIENT,
        freelancer: FREELANCER,
        token: TOKEN,
        totalAmount: TOTAL
      }, 1)
    );
    expect(await chainIdForEntity(db(), "project", projectId!)).toBe("7");
    expect(await entityForChainId(db(), "project", 7n)).toBe(projectId);

    // Milestone ids derive from getProjectMilestones order zipped with idx.
    await hydrateMilestoneLinks(db(), projectId!, [CHAIN_M1, CHAIN_M2]);
    expect(await entityForChainId(db(), "milestone", CHAIN_M1)).toBe(m1Id);
    expect(await entityForChainId(db(), "milestone", CHAIN_M2)).toBe(m2Id);
    expect(await chainIdForEntity(db(), "milestone", m1Id!)).toBe("11");
  });

  it("binding is idempotent both directions", async () => {
    expect(await bindChainEntity(db(), "project", projectId!, CHAIN_PROJECT)).toBe(false);
    const other = await db().select().from(projects).limit(1);
    void other;
    // second entity claiming same chain id must not overwrite
    await expect(bindChainEntity(db(), "milestone", m2Id!, CHAIN_PROJECT)).resolves.toBe(false);
    expect(await entityForChainId(db(), "project", CHAIN_PROJECT)).toBe(projectId);
  });

  it("resolveMilestone lazily hydrates via injected RPC accessor", async () => {
    // unknown milestone id, but project link exists → fetcher is consulted
    const uuid = await resolveMilestone(db(), 99n, async (chainPid) =>
      chainPid === "7" ? [CHAIN_M1, CHAIN_M2] : []
    );
    expect(uuid).toBeNull(); // 99 not in list → stays unresolved
    const known = await resolveMilestone(db(), CHAIN_M1, async () => {
      throw new Error("should not be called for already-bound ids");
    });
    expect(known).toBe(m1Id);
  });
});

describe("indexer applies real EscrowCore events", () => {
  it("ProjectFunded mirrors project + milestone funding", async () => {
    await apply(ev("ProjectFunded", { projectId: CHAIN_PROJECT, amount: TOTAL }, 2));
    const [p] = await db().select().from(projects).where(eq(projects.id, projectId!));
    expect(p!.status).toBe("funded");
    const ms = await db().select().from(milestones).where(eq(milestones.projectId, projectId!));
    expect(ms.every((m) => m.status === "funded")).toBe(true);
  });

  it("submit/approve/remainder lifecycle lands in the right columns", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // past
    await apply(
      ev("MilestoneStarted", { milestoneId: CHAIN_M1, freelancer: FREELANCER }, 3)
    );
    await apply(
      ev("MilestoneSubmitted", {
        milestoneId: CHAIN_M1,
        deliverableHash: `0x${"ab".repeat(32)}`,
        proofOfWorkHash: `0x${"cd".repeat(32)}`,
        reviewDeadline: deadline + 7200n
      }, 4)
    );
    let [m1] = await db().select().from(milestones).where(eq(milestones.id, m1Id!));
    expect(m1!.status).toBe("submitted");
    expect(m1!.reviewDeadline).toBeTruthy();
    const subs = await db().select().from(submissions).where(eq(submissions.milestoneId, m1Id!));
    expect(subs).toHaveLength(1);

    // Partial approval: 7000 bps → FundsReleased + RemainderHeld in one tx.
    await apply(ev("MilestoneApproved", { milestoneId: CHAIN_M1, approvedBps: 7000, approver: CLIENT }, 5));
    await apply(
      ev("FundsReleased", { milestoneId: CHAIN_M1, freelancerAmount: 686000000n, fee: 14000000n, clientRefund: 0n }, 5, 1)
    );
    await apply(
      ev("RemainderHeld", { milestoneId: CHAIN_M1, amount: 300000000n, challengeDeadline: deadline }, 5, 2)
    );
    [m1] = await db().select().from(milestones).where(eq(milestones.id, m1Id!));
    expect(m1!.status).toBe("approved");
    expect(m1!.approvedBps).toBe(7000);
    expect(m1!.remainderAmount).toBe("300000000");
    expect(m1!.challengeDeadline).toBeTruthy();

    // Ledger mirrored once per log with tx:log ref.
    const led = await import("../src/db/schema.js").then((s) => s.ledgerEntries);
    const rows = await db().select().from(led).where(eq(led.milestoneId, m1Id!));
    expect(rows.filter((r) => r.kind === "release_freelancer")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "platform_fee")).toHaveLength(1);
    expect(rows.every((r) => /^0x[0-9a-f]+:[0-9]+$/.test(r.ref))).toBe(true);
  });

  it("replaying the same log is a no-op (idempotent replay)", async () => {
    const input = ev("FundsReleased", { milestoneId: CHAIN_M1, freelancerAmount: 1n, fee: 0n, clientRefund: 0n }, 99, 3);
    expect(await apply(input)).toBe(true);
    expect(await apply(input)).toBe(false); // unique(tx_hash, log_index) gate

    const led = await import("../src/db/schema.js").then((s) => s.ledgerEntries);
    const rows = await db().select().from(led).where(and(eq(led.milestoneId, m1Id!), eq(led.ref, `${input.txHash}:3`)));
    expect(rows).toHaveLength(1);

    const stored = await db().select().from(chainEvents).where(eq(chainEvents.txHash, input.txHash));
    expect(stored).toHaveLength(1);
    // BigInt args were serialized for JSONB storage
    expect(typeof stored[0]!.args).toBe("object");
  });

  it("claimRemainder closes the milestone and books the refund once", async () => {
    await apply(ev("RemainderClaimed", { milestoneId: CHAIN_M1, amount: 300000000n }, 6));
    const [m1] = await db().select().from(milestones).where(eq(milestones.id, m1Id!));
    expect(m1!.status).toBe("closed");
    expect(m1!.remainderAmount).toBe("0");

    await apply(ev("RemainderClaimed", { milestoneId: CHAIN_M1, amount: 300000000n }, 6)); // replay
    const led = await import("../src/db/schema.js").then((s) => s.ledgerEntries);
    const refunds = await db()
      .select()
      .from(led)
      .where(and(eq(led.milestoneId, m1Id!), eq(led.kind, "refund_client")));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount).toBe("300000000");
  });

  it("on-chain dispute hooks create and resolve local disputes", async () => {
    // m2: submitted then disputed (type 2 = cancellation)
    await db()
      .update(milestones)
      .set({ status: "submitted", reviewDeadline: new Date(Date.now() + 3600_000) })
      .where(eq(milestones.id, m2Id!));

    await apply(ev("MilestoneDisputed", { milestoneId: CHAIN_M2, disputeType: 2 }, 7));
    let [d] = await db().select().from(disputes).where(eq(disputes.milestoneId, m2Id!));
    expect(d).toBeTruthy();
    expect(d!.type).toBe("cancellation");
    expect(d!.status).toBe("evidence");

    let [m2] = await db().select().from(milestones).where(eq(milestones.id, m2Id!));
    expect(m2!.status).toBe("disputed");

    await apply(ev("DisputeResolved", { milestoneId: CHAIN_M2, splitBps: 10000 }, 8));
    [d] = await db().select().from(disputes).where(eq(disputes.id, d!.id));
    expect(d!.status).toBe("resolved");
    expect(d!.resolution).toBe("freelancer");
    [m2] = await db().select().from(milestones).where(eq(milestones.id, m2Id!));
    expect(m2!.status).toBe("resolved");
  });

  it("AutoReleased sets terminal auto_released with full bps", async () => {
    await apply(ev("AutoReleased", { milestoneId: CHAIN_M2, approvedBps: 10000 }, 9));
    const [m2] = await db().select().from(milestones).where(eq(milestones.id, m2Id!));
    expect(m2!.status).toBe("auto_released");
    expect(m2!.approvedBps).toBe(10000);
  });
});

describe("keeper planner", () => {
  it("flags overdue submitted milestones for autoRelease and expired remainders for claim", async () => {
    // m2 → submitted long ago; m1 closed so ineligible
    await db()
      .update(milestones)
      .set({
        status: "submitted",
        reviewDeadline: new Date(Date.now() - 10 * 3600_000),
        remainderAmount: null,
        challengeDeadline: null
      })
      .where(eq(milestones.id, m2Id!));

    // fresh approved+remainder milestone whose window just expired
    const [m3] = await db()
      .insert(milestones)
      .values({
        projectId: projectId!,
        idx: 2,
        title: "m3",
        amount: "100",
        status: "approved",
        remainderAmount: "40",
        challengeDeadline: new Date(Date.now() - 3600_000)
      })
      .returning({ id: milestones.id });
    await bindChainEntity(db(), "milestone", m3!.id, 21n);

    // not-yet-due control: review deadline still ahead of grace window
    const [m4] = await db()
      .insert(milestones)
      .values({
        projectId: projectId!,
        idx: 3,
        title: "m4",
        amount: "100",
        status: "submitted",
        reviewDeadline: new Date(Date.now() + 3600_000)
      })
      .returning({ id: milestones.id });
    await bindChainEntity(db(), "milestone", m4!.id, 22n);

    const work = await planDueWork(db());
    expect(work.autoReleases.map((c) => c.chainMilestoneId)).toContain("12");
    expect(work.claims.map((c) => c.chainMilestoneId)).toContain("21");
    expect(work.autoReleases.map((c) => c.chainMilestoneId)).not.toContain("22");
    expect(work.autoReleases.map((c) => c.chainMilestoneId)).not.toContain("11"); // closed
  });
});

void app;
