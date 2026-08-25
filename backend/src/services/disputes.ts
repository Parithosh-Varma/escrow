import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import type { DB } from "../db/driver.js";
import {
  disputes,
  disputeJurors,
  milestones,
  projects,
  users
} from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { config } from "../config.js";
import {
  computePayoutSplit,
  commitVoteHash,
  formatAmount,
  jurorCountForAmount,
  parseAmount,
  tallyVotes,
  type DisputeVote
} from "../lib/money.js";
import { assertTransition } from "./statemachine.js";
import { recordLedger, Account, milestoneBalance } from "./ledger.js";
import { notify } from "./notifications.js";

export const DISPUTE_TYPES = [
  "quality",
  "scope",
  "cancellation",
  "ai_flag",
  "partial_amount"
] as const;

export const PHASE_WINDOWS_MS = {
  evidence: 48 * 3600 * 1000,
  commit: 24 * 3600 * 1000,
  reveal: 24 * 3600 * 1000
};

/** Jurors are funded from the platform fee (spec §6): 50% of the fee collected
 *  on the disputed payout goes to the case's juror reward pool. */
export const JUROR_POOL_SHARE_BPS = 5000;
/** Internal non-transferable stake slashed from dissenting jurors (v1 flat). */
export const SLASH_UNITS = 10n;

export function expectedCommit(
  disputeId: string,
  vote: DisputeVote,
  salt: string
): `0x${string}` {
  return commitVoteHash(disputeId, vote, salt);
}

export async function createDispute(
  db: DB,
  input: {
    milestoneId: string;
    type: (typeof DISPUTE_TYPES)[number];
    raisedByAddress: string;
    reason?: string;
  }
) {
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, input.milestoneId))
    .limit(1);
  if (!milestone) throw notFound("milestone not found");

  const open = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.milestoneId, milestone.id), sql`${disputes.resolvedAt} IS NULL`));
  if (open.length > 0) throw conflict("milestone already has an open dispute");

  assertTransition(milestone.status, "disputed");

  // partial_amount disputes contest the refunded remainder (spec §9.3)
  let amountStake = parseAmount(milestone.amount);
  if (input.type === "partial_amount") {
    const bal = await milestoneBalance(db, milestone.id);
    amountStake = bal.refundedToClient;
    if (amountStake <= 0n) {
      throw badRequest("no refunded remainder to dispute");
    }
  }

  const jurorCount = jurorCountForAmount(
    parseAmount(milestone.amount),
    BigInt(config.JUROR_BAND_1_MAX),
    BigInt(config.JUROR_BAND_2_MAX)
  );

  const id = randomUUID();
  await db.insert(disputes).values({
    id,
    milestoneId: milestone.id,
    type: input.type,
    raisedBy: input.raisedByAddress,
    reason: input.reason ?? "",
    amountStake: formatAmount(amountStake),
    jurorCount,
    status: "evidence",
    phaseDeadline: new Date(Date.now() + PHASE_WINDOWS_MS.evidence)
  });

  await db
    .update(milestones)
    .set({ status: "disputed", updatedAt: new Date() })
    .where(eq(milestones.id, milestone.id));

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, milestone.projectId))
    .limit(1);
  if (project) {
    await notify(db, project.clientId, "dispute.opened", {
      milestoneId: milestone.id,
      disputeId: id,
      type: input.type
    });
    await notify(db, project.freelancerId, "dispute.opened", {
      milestoneId: milestone.id,
      disputeId: id,
      type: input.type
    });
  }
  return { disputeId: id };
}

export async function assignJurors(db: DB, disputeId: string) {
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!dispute) throw notFound("dispute not found");
  if (dispute.status !== "evidence") throw conflict("not in evidence phase");

  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, dispute.milestoneId))
    .limit(1);
  if (!milestone) throw notFound("milestone not found");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, milestone.projectId))
    .limit(1);
  if (!project) throw notFound("project not found");
  // Parties to the dispute may never sit as jurors on their own case.
  const partyIds = [project.clientId, project.freelancerId];

  const eligible = await db
    .select()
    .from(users)
    .where(
      sql`${users.jurorStatus} = 'approved'
          AND ${users.id} NOT IN (${sql.join(
            partyIds.map((id) => sql`${id}::uuid`),
            sql`, `
          )})`
    )
    .orderBy(users.createdAt)
    .limit(dispute.jurorCount);

  if (eligible.length < dispute.jurorCount) {
    const admins = await db
      .select()
      .from(users)
      .where(
        sql`${users.isAdmin} = TRUE
            AND ${users.id} NOT IN (${sql.join(
              partyIds.map((id) => sql`${id}::uuid`),
              sql`, `
            )})
            AND ${users.id} NOT IN (${sql.join(
              eligible.map((e) => sql`${e.id}::uuid`),
              sql`, `
            )})`
      )
      .orderBy(users.createdAt)
      .limit(dispute.jurorCount - eligible.length);
    eligible.push(...admins);
  }

  if (eligible.length < dispute.jurorCount) {
    throw conflict(
      `juror pool too small: need ${dispute.jurorCount}, have ${eligible.length}`
    );
  }
  for (const j of eligible) {
    await db
      .insert(disputeJurors)
      .values({ disputeId, userId: j.id })
      .onConflictDoNothing();
  }
  await db
    .update(disputes)
    .set({
      status: "commit",
      phaseDeadline: new Date(Date.now() + PHASE_WINDOWS_MS.commit)
    })
    .where(eq(disputes.id, disputeId));
  return { assigned: eligible.map((e) => e.address) };
}

export async function commitVote(
  db: DB,
  disputeId: string,
  userId: string,
  commitHash: string
) {
  if (!/^0x[0-9a-f]{64}$/.test(commitHash)) throw badRequest("bad commit hash");
  const [row] = await db
    .select()
    .from(disputeJurors)
    .where(and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, userId)))
    .limit(1);
  if (!row) throw forbidden("not an assigned juror");
  if (row.commitHash) throw conflict("already committed");
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!dispute || dispute.status !== "commit") throw conflict("not in commit phase");
  await db
    .update(disputeJurors)
    .set({ commitHash })
    .where(and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, userId)));
}

export async function revealVote(
  db: DB,
  disputeId: string,
  userId: string,
  vote: DisputeVote,
  salt: string
) {
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!dispute || dispute.status !== "reveal") throw conflict("not in reveal phase");
  const [row] = await db
    .select()
    .from(disputeJurors)
    .where(and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, userId)))
    .limit(1);
  if (!row?.commitHash) throw forbidden("no commit to reveal");
  if (row.vote) throw conflict("already revealed");
  if (expectedCommit(disputeId, vote, salt) !== row.commitHash) {
    throw badRequest("commit mismatch: vote/salt do not match commitment");
  }
  await db
    .update(disputeJurors)
    .set({ vote, salt, revealedAt: new Date() })
    .where(and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, userId)));
}

/** Keeper/admin: advance phases when deadlines pass or everyone has acted. */
export async function advancePhase(db: DB, disputeId: string) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!d || d.status === "resolved") throw conflict("dispute not active");

  const jurors = await db
    .select()
    .from(disputeJurors)
    .where(eq(disputeJurors.disputeId, disputeId));

  if (d.status === "evidence") {
    // assignment is manual in phase 1; nothing to auto-advance until assigned
    throw conflict("awaiting juror assignment");
  }
  if (d.status === "commit") {
    const allCommitted = jurors.length > 0 && jurors.every((j) => j.commitHash);
    const expired = d.phaseDeadline ? d.phaseDeadline.getTime() < Date.now() : false;
    if (!allCommitted && !expired) throw conflict("commit window still open");
    await db
      .update(disputes)
      .set({ status: "reveal", phaseDeadline: new Date(Date.now() + PHASE_WINDOWS_MS.reveal) })
      .where(eq(disputes.id, disputeId));
    return { status: "reveal" };
  }
  // reveal
  const revealed = jurors.filter((j) => j.vote);
  const allRevealed = jurors.length > 0 && revealed.length === jurors.length;
  const expired = d.phaseDeadline ? d.phaseDeadline.getTime() < Date.now() : false;
  if (!allRevealed && !expired && revealed.length < Math.floor(jurors.length / 2) + 1) {
    throw conflict("reveal window still open");
  }
  if (revealed.length === 0) throw conflict("no votes revealed");
  return resolveDispute(db, disputeId);
}

export async function resolveDispute(db: DB, disputeId: string) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!d) throw notFound("dispute not found");
  if (d.status === "resolved") throw conflict("already resolved");
  if (d.status !== "reveal") throw conflict("must be in reveal phase");

  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, d.milestoneId))
    .limit(1);
  if (!milestone) throw notFound("milestone not found");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, milestone.projectId))
    .limit(1);

  const jurors = await db
    .select()
    .from(disputeJurors)
    .where(eq(disputeJurors.disputeId, disputeId));
  const revealed = jurors.filter((j): j is typeof j & { vote: DisputeVote } => !!j.vote);
  const tally = tallyVotes(revealed.map((j) => j.vote));

  let resolution: "freelancer" | "client" | "tie_escalated";
  let splitBps: number;
  if (tally.outcome === "tie") {
    resolution = "tie_escalated";
    splitBps = 0; // pending arbiter
    await db
      .update(disputes)
      .set({ status: "resolved", resolution, splitBps, resolvedAt: new Date() })
      .where(eq(disputes.id, disputeId));
    return { resolution, splitBps, tally };
  } else {
    resolution = tally.outcome;
    splitBps = resolution === "freelancer" ? 10000 : 0;
  }

  const amountStake = BigInt(d.amountStake);
  const split = computePayoutSplit(
    amountStake,
    splitBps,
    config.PLATFORM_FEE_BPS
  );

  if (split.freelancer > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "release_freelancer",
      account: Account.Freelancer,
      amount: split.freelancer,
      ref: `dispute:${disputeId}`
    });
  }
  if (split.platformFee > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "platform_fee",
      account: Account.PlatformFee,
      amount: split.platformFee,
      ref: `dispute:${disputeId}`
    });
    // Juror rewards come out of the fee (spec §7).
    const pool = (split.platformFee * BigInt(JUROR_POOL_SHARE_BPS)) / 10000n;
    if (pool > 0n) {
      await recordLedger(db, {
        milestoneId: milestone.id,
        kind: "juror_reward",
        account: Account.JurorPool,
        amount: pool,
        ref: `dispute:${disputeId}`
      });
      const winners = revealed.filter((j) => j.vote === resolution);
      const each = winners.length > 0 ? pool / BigInt(winners.length) : 0n;
      for (const w of winners) {
        await db
          .update(users)
          .set({
            jurorStake: sql`((${users.jurorStake}::numeric + ${each.toString()}::numeric)::text)`
          })
          .where(eq(users.id, w.userId));
        await db
          .update(disputeJurors)
          .set({ rewarded: true })
          .where(
            and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, w.userId))
          );
      }
    }
  }
  if (split.clientRefund > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "refund_client",
      account: Account.ClientRefund,
      amount: split.clientRefund,
      ref: `dispute:${disputeId}`
    });
  }

  // Slashing: dissenting jurors lose internal stake.
  {
    const dissenters = revealed.filter((j) => j.vote !== resolution);
    for (const j of dissenters) {
      await db
        .update(users)
        .set({
          jurorStake: sql`(GREATEST(${users.jurorStake}::numeric - ${SLASH_UNITS.toString()}::numeric, 0)::text)`,
          jurorStatus: "slashed"
        })
        .where(eq(users.id, j.userId));
      await db
        .update(disputeJurors)
        .set({ slashed: true })
        .where(
          and(eq(disputeJurors.disputeId, disputeId), eq(disputeJurors.userId, j.userId))
        );
    }
  }

  await db
    .update(disputes)
    .set({ status: "resolved", resolution, splitBps, resolvedAt: new Date() })
    .where(eq(disputes.id, disputeId));

  await db
    .update(milestones)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(milestones.id, milestone.id));

  if (project) {
    await notify(db, project.clientId, "dispute.resolved", {
      disputeId,
      resolution,
      splitBps
    });
    await notify(db, project.freelancerId, "dispute.resolved", {
      disputeId,
      resolution,
      splitBps
    });
  }

  return { resolution, splitBps, tally };
}

export async function resolveTie(
  db: DB,
  disputeId: string,
  adminSplitBps: number
) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!d) throw notFound("dispute not found");
  if (d.resolution !== "tie_escalated" || d.status !== "resolved") {
    throw conflict("dispute is not awaiting arbiter decision");
  }
  // Arbiter overrides: apply chosen split directly on the staked amount.
  const amountStake = BigInt(d.amountStake);
  const split = computePayoutSplit(amountStake, adminSplitBps, config.PLATFORM_FEE_BPS);
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, d.milestoneId))
    .limit(1);
  if (!milestone) throw notFound("milestone not found");
  if (split.freelancer > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "release_freelancer",
      account: Account.Freelancer,
      amount: split.freelancer,
      ref: `arbiter:${disputeId}`
    });
  }
  if (split.platformFee > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "platform_fee",
      account: Account.PlatformFee,
      amount: split.platformFee,
      ref: `arbiter:${disputeId}`
    });
  }
  if (split.clientRefund > 0n) {
    await recordLedger(db, {
      milestoneId: milestone.id,
      kind: "refund_client",
      account: Account.ClientRefund,
      amount: split.clientRefund,
      ref: `arbiter:${disputeId}`
    });
  }
  await db
    .update(disputes)
    .set({ splitBps: adminSplitBps, resolution: "client" })
    .where(eq(disputes.id, disputeId));
  return { splitBps: adminSplitBps, split: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v.toString()])) };
}
