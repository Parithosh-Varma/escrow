import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db-instance.js";
import { disputes, disputeJurors, milestones, projects, users } from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import {
  DISPUTE_TYPES,
  advancePhase,
  assignJurors,
  commitVote,
  createDispute,
  expectedCommit,
  revealVote,
  resolveTie
} from "../../services/disputes.js";
import { getProjectForUser } from "../projects/routes.js";

const createBody = z.object({
  milestoneId: z.string().uuid(),
  type: z.enum(DISPUTE_TYPES),
  reason: z.string().max(4000).default("")
});
const commitBody = z.object({ commitHash: z.string().regex(/^0x[0-9a-f]{64}$/) });
const revealBody = z.object({
  vote: z.enum(["freelancer", "client"]),
  salt: z.string().min(8)
});

export default async function routes(app: FastifyInstance) {
  const auth = [(app as any).authenticate];
  const admin = [(app as any).requireAdmin];

  app.post("/disputes", { preHandler: auth }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const m = await getMilestone(body.milestoneId);
    const p = await getProjectForUser(m.projectId, req.user);
    const [proj] = await db().select().from(projects).where(eq(projects.id, p.id)).limit(1);
    const isParty = proj!.clientId === req.user.sub || proj!.freelancerId === req.user.sub;
    if (!isParty && !req.user.isAdmin) throw forbidden("only project parties can dispute");
    const res = await createDispute(db(), {
      milestoneId: body.milestoneId,
      type: body.type,
      raisedByAddress: req.user.address,
      reason: body.reason
    });
    reply.code(201);
    return res;
  });

  app.post("/disputes/:id/assign-jurors", { preHandler: admin }, async (req) => {
    return assignJurors(db(), (req.params as any).id);
  });

  app.get("/disputes/:id", { preHandler: auth }, async (req) => {
    const [d] = await db()
      .select()
      .from(disputes)
      .where(eq(disputes.id, (req.params as any).id))
      .limit(1);
    if (!d) throw notFound("dispute not found");
    const m = await getMilestone(d.milestoneId);
    await getProjectForUser(m.projectId, req.user);
    const jurors = await db()
      .select({
        userId: disputeJurors.userId,
        address: users.address,
        committed: disputeJurors.commitHash,
        vote: disputeJurors.vote,
        revealedAt: disputeJurors.revealedAt,
        rewarded: disputeJurors.rewarded,
        slashed: disputeJurors.slashed
      })
      .from(disputeJurors)
      .innerJoin(users, eq(users.id, disputeJurors.userId))
      .where(eq(disputeJurors.disputeId, d.id));
    // votes hidden until revealed
    const safe = jurors.map((j) => ({
      address: j.address,
      hasCommitted: !!j.committed,
      vote: j.revealedAt ? j.vote : undefined,
      rewarded: j.rewarded,
      slashed: j.slashed
    }));
    return { dispute: d, jurors: safe };
  });

  app.post("/disputes/:id/vote/commit", { preHandler: auth }, async (req) => {
    const body = commitBody.parse(req.body);
    await commitVote(db(), (req.params as any).id, req.user.sub, body.commitHash);
    return { ok: true };
  });

  /** Convenience for clients computing the commitment hash. */
  app.post("/disputes/:id/vote/commit-hash", { preHandler: auth }, async (req) => {
    const body = revealBody.pick({ vote: true, salt: true }).parse(req.body);
    if (!isAssigned(db, (req.params as any).id, req.user.sub)) {
      throw forbidden("not an assigned juror");
    }
    return { commitHash: expectedCommit((req.params as any).id, body.vote, body.salt) };
  });

  app.post("/disputes/:id/vote/reveal", { preHandler: auth }, async (req) => {
    const body = revealBody.parse(req.body);
    await requireJurorStatusOk(req);
    await revealVote(
      db(),
      (req.params as any).id,
      req.user.sub,
      body.vote,
      body.salt
    );
    return { ok: true };
  });

  app.post("/disputes/:id/advance", { preHandler: admin }, async (req) => {
    return advancePhase(db(), (req.params as any).id);
  });

  app.post("/disputes/:id/resolve-tie", { preHandler: admin }, async (req) => {
    const body = z.object({ splitBps: z.number().int().min(0).max(10000) }).parse(req.body);
    return resolveTie(db(), (req.params as any).id, body.splitBps);
  });

  app.get("/my/juror-cases", { preHandler: auth }, async (req) => {
    const rows = await db()
      .select({ dispute: disputes })
      .from(disputeJurors)
      .innerJoin(disputes, eq(disputes.id, disputeJurors.disputeId))
      .where(eq(disputeJurors.userId, req.user.sub))
      .orderBy(desc(disputes.createdAt));
    return { cases: rows.map((r) => r.dispute) };
  });
}

async function getMilestone(id: string) {
  const [m] = await db().select().from(milestones).where(eq(milestones.id, id)).limit(1);
  if (!m) throw notFound("milestone not found");
  return m;
}

async function isAssigned(_db: unknown, _disputeId: string, _userId: string): Promise<boolean> {
  const [row] = await db()
    .select()
    .from(disputeJurors)
    .where(
      and(
        eq(disputeJurors.disputeId, _disputeId),
        eq(disputeJurors.userId, _userId)
      )
    )
    .limit(1);
  return !!row;
}

async function requireJurorStatusOk(req: any) {
  const [u] = await db().select().from(users).where(eq(users.id, req.user.sub)).limit(1);
  if (u?.jurorStatus === "slashed") throw forbidden("juror slashed");
}
