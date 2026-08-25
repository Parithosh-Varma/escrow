import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../../db-instance.js";
import {
  projects,
  milestones,
  submissions,
  files,
  aiChecks,
  disputes
} from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { config } from "../../config.js";
import { computePayoutSplit, formatAmount } from "../../lib/money.js";
import { assertTransition, MilestoneStatus } from "../../services/statemachine.js";
import { recordLedger, Account } from "../../services/ledger.js";
import { runAllChecks } from "../../services/ai/provider.js";
import { storage } from "../../services/storage.js";
import { watermarker } from "../../services/watermark.js";
import { notifyAddress } from "../../services/notifications.js";
import { getProjectForUser } from "../projects/routes.js";
import { createDispute } from "../../services/disputes.js";

const approveBody = z.object({
  approvedBps: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(10000)
});

export default async function routes(app: FastifyInstance) {
  const auth = [(app as any).authenticate];

  async function loadMilestone(id: string) {
    const [m] = await db().select().from(milestones).where(eq(milestones.id, id)).limit(1);
    if (!m) throw notFound("milestone not found");
    return m;
  }

  app.post("/milestones/:id/start", { preHandler: auth }, async (req) => {
    const m = await loadMilestone((req.params as any).id);
    const p = await getProjectForUser(m.projectId, req.user);
    const [project] = await db().select().from(projects).where(eq(projects.id, p.id)).limit(1);
    const isFreelancer = project!.freelancerId === req.user.sub;
    if (!isFreelancer && !req.user.isAdmin) throw forbidden("freelancer only");

    assertTransition(m.status, MilestoneStatus.InProgress);
    await db()
      .update(milestones)
      .set({ status: MilestoneStatus.InProgress, updatedAt: new Date() })
      .where(eq(milestones.id, m.id));
    return { ok: true, status: MilestoneStatus.InProgress };
  });

  /**
   * Submit work (spec §3 + §4 + §5): multipart form with:
   *   note (optional), deliverable (file, required),
   *   screen_recording (file, required), process_file(s) (>=1 required)
   * Runs the AI check pipeline; any flagged check auto-triggers a dispute.
   */
  app.post("/milestones/:id/submit", { preHandler: auth }, async (req, reply) => {
    const m = await loadMilestone((req.params as any).id);
    const [project] = await db().select().from(projects).where(eq(projects.id, m.projectId)).limit(1);
    if (!project) throw notFound("project missing");
    if (project.freelancerId !== req.user.sub && !req.user.isAdmin) {
      throw forbidden("freelancer only");
    }
    assertTransition(m.status, MilestoneStatus.Submitted);

    let parts: Array<{ field: string; buf: Buffer; mime: string; name: string }> = [];
    let note = "";
    const ctype = req.headers["content-type"] ?? "";
    if (ctype.includes("multipart/form-data")) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const buf = await (part as any).toBuffer();
          parts.push({
            field: part.fieldname,
            buf,
            mime: part.mimetype || "application/octet-stream",
            name: part.filename || "file"
          });
        } else if (part.fieldname === "note") {
          note = String(part.value ?? "");
        }
      }
    } else {
      // JSON dev path: base64-encoded files
      const body = z
        .object({
          note: z.string().default(""),
          deliverableBase64: z.string(),
          deliverableMime: z.string().default("application/octet-stream"),
          deliverableName: z.string().default("deliverable.bin"),
          screenRecordingBase64: z.string(),
          processFilesBase64: z.array(z.string()).min(1)
        })
        .parse(req.body);
      note = body.note;
      parts.push({
        field: "deliverable",
        buf: Buffer.from(body.deliverableBase64, "base64"),
        mime: body.deliverableMime,
        name: body.deliverableName
      });
      parts.push({
        field: "screen_recording",
        buf: Buffer.from(body.screenRecordingBase64, "base64"),
        mime: "video/mp4",
        name: "recording.mp4"
      });
      for (const b64 of body.processFilesBase64) {
        parts.push({
          field: "process_file",
          buf: Buffer.from(b64, "base64"),
          mime: "application/octet-stream",
          name: "process.bin"
        });
      }
    }

    const byField = (f: string) => parts.filter((p) => p.field === f);
    const deliverables = byField("deliverable");
    const recordings = byField("screen_recording");
    const processFiles = byField("process_file");
    if (deliverables.length !== 1) throw badRequest("exactly one 'deliverable' file required");
    if (recordings.length < 1) throw badRequest("'screen_recording' file required");
    if (processFiles.length < 1) throw badRequest("at least one 'process_file' required");

    const store = storage();
    const storedParts = [];
    for (const p of [...deliverables, ...recordings, ...processFiles]) {
      const st = await store.put(p.buf, p.name);
      storedParts.push({ ...p, ...st });
    }
    const deliverableHash = storedParts[0]!.sha256;

    const [submission] = await db()
      .insert(submissions)
      .values({ milestoneId: m.id, note, deliverableHash })
      .returning();

    for (const sp of storedParts) {
      await db().insert(files).values({
        ownerId: req.user.sub,
        submissionId: submission!.id,
        kind: sp.field === "deliverable" ? "deliverable" : sp.field === "screen_recording" ? "screen_recording" : "process_file",
        sha256: sp.sha256,
        sizeBytes: String(sp.size),
        mime: sp.mime,
        storageKey: sp.key,
        originalName: sp.name
      });
    }

    // AI verification pipeline (spec §5) — flags are signals, not verdicts.
    const results = [];
    for (const r of await runAllChecks({
      milestoneSpec: m.spec,
      deliverableText: undefined,
      mime: deliverables[0]!.mime
    })) {
      await db().insert(aiChecks).values({
        submissionId: submission!.id,
        checkType: (results.length === 0
          ? "requirement_match"
          : results.length === 1
            ? "plagiarism"
            : "ai_generation") as string,
        provider: r.provider,
        confidence: r.confidence,
        flagged: r.flagged,
        raw: r.raw
      });
      results.push(r);
    }
    const anyFlagged = results.some((r) => r.flagged);
    await db()
      .update(submissions)
      .set({ aiStatus: anyFlagged ? "flagged" : "clean" })
      .where(eq(submissions.id, submission!.id));

    const reviewDeadline = new Date(Date.now() + config.REVIEW_TIMEOUT_SECONDS * 1000);
    await db()
      .update(milestones)
      .set({
        status: MilestoneStatus.Submitted,
        submittedAt: new Date(),
        reviewDeadline,
        updatedAt: new Date()
      })
      .where(eq(milestones.id, m.id));

    await notifyAddress(db(), project.clientId, "milestone.submitted", {
      milestoneId: m.id,
      submissionId: submission!.id,
      aiFlagged: anyFlagged
    });

    let disputeId: string | undefined;
    if (anyFlagged) {
      const res = await createDispute(db(), {
        milestoneId: m.id,
        type: "ai_flag",
        raisedByAddress: "system:ai",
        reason: `AI checks flagged this submission: ${results
          .filter((r) => r.flagged)
          .map((r) => `${r.provider}@${r.confidence}`)
          .join(", ")}`
      }).catch(() => undefined);
      disputeId = res?.disputeId;
    }

    reply.code(201);
    return { submission, aiResults: results.map(maskConfidence), aiStatus: anyFlagged ? "flagged" : "clean", reviewDeadline, autoDisputeId: disputeId };
  });

  /** Client approves full or partial (spec §3). Remainder refunds to client. */
  app.post("/milestones/:id/approve", { preHandler: auth }, async (req) => {
    const m = await loadMilestone((req.params as any).id);
    const [project] = await db().select().from(projects).where(eq(projects.id, m.projectId)).limit(1);
    if (!project) throw notFound("project missing");
    if (project.clientId !== req.user.sub && !req.user.isAdmin) {
      throw forbidden("client only");
    }
    assertTransition(m.status, MilestoneStatus.Approved);

    const body = approveBody.parse(req.body ?? {});
    const amount = BigInt(m.amount);
    const split = computePayoutSplit(amount, body.approvedBps, config.PLATFORM_FEE_BPS);

    if (split.freelancer > 0n) {
      await recordLedger(db(), {
        milestoneId: m.id,
        kind: "release_freelancer",
        account: Account.Freelancer,
        amount: split.freelancer,
        ref: `approve:${body.approvedBps}`
      });
    }
    if (split.platformFee > 0n) {
      await recordLedger(db(), {
        milestoneId: m.id,
        kind: "platform_fee",
        account: Account.PlatformFee,
        amount: split.platformFee,
        ref: `approve:${body.approvedBps}`
      });
    }
    if (split.clientRefund > 0n) {
      await recordLedger(db(), {
        milestoneId: m.id,
        kind: "refund_client",
        account: Account.ClientRefund,
        amount: split.clientRefund,
        ref: "partial_remainder"
      });
    }

    await db()
      .update(milestones)
      .set({
        status: MilestoneStatus.Approved,
        approvedBps: body.approvedBps,
        resolvedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(milestones.id, m.id));

    await notifyAddress(db(), project.freelancerId, "milestone.approved", {
      milestoneId: m.id,
      approvedBps: body.approvedBps,
      payout: formatAmount(split.freelancer)
    });

    return {
      ok: true,
      status: MilestoneStatus.Approved,
      split: {
        freelancer: formatAmount(split.freelancer),
        platformFee: formatAmount(split.platformFee),
        clientRefund: formatAmount(split.clientRefund)
      },
      note:
        body.approvedBps < 10000
          ? "remainder refunded to client; freelancer may open a partial_amount dispute"
          : undefined
    };
  });

  /**
   * Auto-release keeper (spec §3): anyone may call once review deadline passes
   * with no client action. In CHAIN_MODE=live the contract enforces this;
   * off-mode the backend ledger mirrors it here.
   */
  app.post("/milestones/:id/auto-release", { preHandler: auth }, async (req) => {
    const m = await loadMilestone((req.params as any).id);
    assertTransition(m.status, MilestoneStatus.AutoReleased);
    if (!m.reviewDeadline || m.reviewDeadline.getTime() > Date.now()) {
      throw conflict("review window still open");
    }
    const [project] = await db().select().from(projects).where(eq(projects.id, m.projectId)).limit(1);
    const amount = BigInt(m.amount);
    const split = computePayoutSplit(amount, 10000, config.PLATFORM_FEE_BPS);
    await recordLedger(db(), {
      milestoneId: m.id,
      kind: "release_freelancer",
      account: Account.Freelancer,
      amount: split.freelancer,
      ref: "auto_release"
    });
    await recordLedger(db(), {
      milestoneId: m.id,
      kind: "platform_fee",
      account: Account.PlatformFee,
      amount: split.platformFee,
      ref: "auto_release"
    });
    await db()
      .update(milestones)
      .set({ status: MilestoneStatus.AutoReleased, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(milestones.id, m.id));
    if (project) {
      await notifyAddress(db(), project.freelancerId, "milestone.auto_released", {
        milestoneId: m.id
      });
      await notifyAddress(db(), project.clientId, "milestone.auto_released", {
        milestoneId: m.id
      });
    }
    return { ok: true, releasedToFreelancer: formatAmount(split.freelancer) };
  });

  app.get("/milestones/:id", { preHandler: auth }, async (req) => {
    const m = await loadMilestone((req.params as any).id);
    await getProjectForUser(m.projectId, req.user);
    const subs = await db()
      .select()
      .from(submissions)
      .where(eq(submissions.milestoneId, m.id))
      .orderBy(desc(submissions.createdAt));
    const out = [];
    for (const s of subs) {
      const checks = await db().select().from(aiChecks).where(eq(aiChecks.submissionId, s.id));
      const fs = await db().select().from(files).where(eq(files.submissionId, s.id));
      out.push({
        ...s,
        checks: checks.map(maskConfidenceFull),
        files: fs.map((f) => ({
          id: f.id,
          kind: f.kind,
          sizeBytes: f.sizeBytes,
          mime: f.mime,
          sha256: f.sha256,
          originalName: f.originalName
        }))
      });
    }
    const openDispute = await db()
      .select()
      .from(disputes)
      .where(and(eq(disputes.milestoneId, m.id)));
    return { milestone: m, submissions: out, disputes: openDispute };
  });
}

/** Raw detector confidence is logged for jurors/appeals but never returned to
 *  the counterparty in the submit response — it goes to jurors with evidence. */
function maskConfidence(r: { provider: string; flagged: boolean }) {
  return { provider: r.provider, flagged: r.flagged };
}
function maskConfidenceFull(r: typeof aiChecks.$inferSelect) {
  return {
    checkType: r.checkType,
    provider: r.provider,
    confidence: r.confidence,
    flagged: r.flagged,
    raw: r.raw
  };
}
