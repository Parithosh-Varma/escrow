import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db-instance.js";
import { users, authNonces } from "../../db/schema.js";
import { badRequest, unauthorized } from "../../errors.js";
import { authMessage, normalizeAddress, verifyWalletSignature } from "../../lib/chains.js";
import { ADMIN_ADDRESSES } from "../../config.js";

const challengeBody = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const verifyBody = challengeBody.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/)
});

export default async function routes(app: FastifyInstance) {
  app.post("/auth/challenge", async (req) => {
    const body = challengeBody.parse(req.body);
    const address = normalizeAddress(body.address);
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const message = authMessage(address, nonce);
    await db()
      .insert(authNonces)
      .values({ address, nonce, message, expiresAt })
      .onConflictDoUpdate({
        target: authNonces.address,
        set: { nonce, message, expiresAt }
      });
    return { message, nonce };
  });

  app.post("/auth/verify", async (req) => {
    const body = verifyBody.parse(req.body);
    const address = normalizeAddress(body.address);
    const [row] = await db()
      .select()
      .from(authNonces)
      .where(eq(authNonces.address, address))
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw unauthorized("nonce expired or missing");
    }
    // Verify against the exact challenge string that was issued.
    const message = row.message || authMessage(address, row.nonce);
    const ok = await verifyWalletSignature(
      address,
      message,
      body.signature as `0x${string}`
    );
    if (!ok) throw unauthorized("signature verification failed");
    await db().delete(authNonces).where(eq(authNonces.address, address));

    const [existing] = await db()
      .select()
      .from(users)
      .where(eq(users.address, address))
      .limit(1);
    let user = existing;
    if (!user) {
      const inserted = await db()
        .insert(users)
        .values({
          address,
          isAdmin: ADMIN_ADDRESSES.includes(address)
        })
        .returning();
      user = inserted[0]!;
    }
    const token = app.jwt.sign({
      sub: user.id,
      address: user.address,
      isAdmin: user.isAdmin,
      jurorStatus: user.jurorStatus
    });
    return { token, user: publicUser(user) };
  });

  app.get("/me", { preHandler: [(app as any).authenticate] }, async (req) => {
    const [u] = await db().select().from(users).where(eq(users.id, req.user.sub)).limit(1);
    if (!u) throw unauthorized();
    return { user: publicUser(u) };
  });
}

function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    address: u.address,
    isAdmin: u.isAdmin,
    jurorStatus: u.jurorStatus,
    jurorStake: u.jurorStake,
    createdAt: u.createdAt
  };
}
