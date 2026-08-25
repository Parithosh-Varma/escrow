import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db-instance.js";
import { tokens, users, notifications } from "../../db/schema.js";
import { badRequest, notFound } from "../../errors.js";
import { normalizeAddress } from "../../lib/chains.js";

const tokenBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive(),
  symbol: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(18)
});

export default async function routes(app: FastifyInstance) {
  const admin = [(app as any).requireAdmin];

  app.get("/admin/tokens", { preHandler: admin }, async () => {
    return { tokens: await db().select().from(tokens) };
  });

  app.post("/admin/tokens", { preHandler: admin }, async (req, reply) => {
    const b = tokenBody.parse(req.body);
    const addr = normalizeAddress(b.address);
    await db()
      .insert(tokens)
      .values({ ...b, address: addr })
      .onConflictDoUpdate({
        target: tokens.address,
        set: { symbol: b.symbol, decimals: b.decimals, chainId: b.chainId, active: true }
      });
    reply.code(201);
    return { ok: true };
  });

  app.delete("/admin/tokens/:address", { preHandler: admin }, async (req) => {
    const addr = normalizeAddress((req.params as any).address);
    await db().update(tokens).set({ active: false }).where(eq(tokens.address, addr));
    return { ok: true };
  });

  app.post("/admin/jurors/:address/approve", { preHandler: admin }, async (req) => {
    const addr = normalizeAddress((req.params as any).address);
    await db()
      .insert(users)
      .values({ address: addr, jurorStatus: "approved" })
      .onConflictDoUpdate({ target: users.address, set: { jurorStatus: "approved" } });
    return { ok: true };
  });

  app.post("/admin/jurors/:address/revoke", { preHandler: admin }, async (req) => {
    const addr = normalizeAddress((req.params as any).address);
    await db().update(users).set({ jurorStatus: "none" }).where(eq(users.address, addr));
    return { ok: true };
  });

  app.get("/admin/users", { preHandler: admin }, async () => {
    return { users: await db().select().from(users) };
  });
}

export async function ensureSeedTokens() {
  // Base mainnet + Base Sepolia native USDC addresses.
  const seeds = [
    {
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      chainId: 8453,
      symbol: "USDC",
      decimals: 6
    },
    {
      address: "0x036cbd53842c5c666ee88463fdec4af79ca7f2eb",
      chainId: 84532,
      symbol: "USDC",
      decimals: 6
    },
    // Base Sepolia mock USDT for tests
    {
      address: "0x00000000000000000000000000000000deadbeef",
      chainId: 31337,
      symbol: "MOCKUSDT",
      decimals: 6
    }
  ];
  for (const s of seeds) {
    await db()
      .insert(tokens)
      .values(s)
      .onConflictDoNothing();
  }
}

export async function listNotifications(userId: string) {
  return db().select().from(notifications).where(eq(notifications.userId, userId));
}

export { badRequest, notFound };
