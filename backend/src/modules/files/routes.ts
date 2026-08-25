import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db-instance.js";
import { files, submissions, milestones, projects } from "../../db/schema.js";
import { badRequest, notFound } from "../../errors.js";
import { storage } from "../../services/storage.js";
import { watermarker, stripBinaryWatermark, previewHash } from "../../services/watermark.js";

const jsonUpload = z.object({
  name: z.string().default("file.bin"),
  mime: z.string().default("application/octet-stream"),
  contentBase64: z.string()
});

export default async function routes(app: FastifyInstance) {
  const auth = [(app as any).authenticate];

  app.post("/files/upload", { preHandler: auth }, async (req, reply) => {
    const ctype = req.headers["content-type"] ?? "";
    if (ctype.includes("multipart/form-data")) {
      const part = await req.file();
      if (!part) throw badRequest("no file");
      const buf = await part.toBuffer();
      const st = await storage().put(buf, part.filename);
      const [row] = await db()
        .insert(files)
        .values({
          ownerId: req.user.sub,
          kind: "deliverable",
          sha256: st.sha256,
          sizeBytes: String(st.size),
          mime: part.mimetype || "application/octet-stream",
          storageKey: st.key,
          originalName: part.filename || "file"
        })
        .returning();
      reply.code(201);
      return fileMeta(row!);
    }
    const body = jsonUpload.parse(req.body);
    const buf = Buffer.from(body.contentBase64, "base64");
    const st = await storage().put(buf, body.name);
    const [row] = await db()
      .insert(files)
      .values({
        ownerId: req.user.sub,
        kind: "deliverable",
        sha256: st.sha256,
        sizeBytes: String(st.size),
        mime: body.mime,
        storageKey: st.key,
        originalName: body.name
      })
      .returning();
    reply.code(201);
    return fileMeta(row!);
  });

  app.get("/files/:id/meta", { preHandler: auth }, async (req) => {
    const f = await getFile((req.params as any).id);
    return fileMeta(f);
  });

  /**
   * Access gate (spec §4):
   *   - uploader/freelancer & admins always see the original
   *   - client sees the ORIGINAL only once the milestone reached
   *     approved/auto_released/resolved; before that they get the
   *     watermarked preview + integrity hash comparison.
   */
  app.get("/files/:id/content", { preHandler: auth }, async (req, reply) => {
    const f = await getFile((req.params as any).id);
    let unlocked = true;
    let variant = "original";

    const isOwner = f.ownerId === req.user.sub;
    if (!isOwner && !req.user.isAdmin && f.submissionId) {
      unlocked = await submissionUnlocked(f.submissionId);
      variant = unlocked ? "original" : "watermarked_preview";
    }

    const raw = await storage().get(f.storageKey);
    let payload = raw;
    if (variant === "watermarked_preview") {
      const wm = await watermarker().watermark(raw, f.mime, {
        fileId: f.id,
        viewer: req.user.address,
        at: new Date().toISOString()
      });
      payload = wm;
      // persist preview once so its hash can be referenced later
      if (!f.watermarkedKey) {
        const st = await storage().put(wm, `preview-${f.originalName}`);
        await db()
          .update(files)
          .set({ watermarkedKey: st.key })
          .where(eq(files.id, f.id));
      }
    } else if (!isOwner && !req.user.isAdmin) {
      payload = stripBinaryWatermark(raw);
    }

    reply.header("Content-Type", f.mime);
    reply.header("X-File-Hash", f.sha256);
    reply.header("X-Preview-Hash", previewHash(payload));
    reply.header("X-Variant", variant);
    reply.header("X-Access-Unlocked", String(unlocked));
    return reply.send(payload);
  });
}

async function getFile(id: string) {
  const [f] = await db().select().from(files).where(eq(files.id, id)).limit(1);
  if (!f) throw notFound("file not found");
  return f;
}

async function submissionUnlocked(submissionId: string): Promise<boolean> {
  const [s] = await db()
    .select()
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (!s) throw notFound("submission not found");
  const [m] = await db()
    .select()
    .from(milestones)
    .where(eq(milestones.id, s.milestoneId))
    .limit(1);
  if (!m) throw badRequest("milestone missing for submission");
  return ["approved", "auto_released", "resolved"].includes(m.status);
}

function fileMeta(f: typeof files.$inferSelect) {
  return {
    id: f.id,
    kind: f.kind,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    originalName: f.originalName,
    submissionId: f.submissionId,
    createdAt: f.createdAt
  };
}
