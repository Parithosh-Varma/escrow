import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db-instance.js";
import { tokens, users, notifications } from "../../db/schema.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import { normalizeAddress } from "../../lib/chains.js";
import {
  bindChainEntity,
  chainIdForEntity,
  toChainId,
  type ChainEntityType
} from "../indexer/mapping.js";
import { projects, milestones, disputes } from "../../db/schema.js";

const bindBody = z.object({
  entityType: z.enum(["project", "milestone", "dispute"]),
  entityId: z.string().uuid(),
  chainId: z.string().regex(/^\d+$/, "decimal uint256 string")
});

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

  /** Manual chain-id ↔ UUID binding (overrides/repairs indexer auto-bind). */
  app.get("/admin/chain-links/:entityType/:entityId", { preHandler: admin }, async (req) => {
    const entityType = (req.params as any).entityType as ChainEntityType;
    const entityId = (req.params as any).entityId as string;
    return { chainId: await chainIdForEntity(db(), entityType, entityId) };
  });

  app.post("/admin/chain-links", { preHandler: admin }, async (req, reply) => {
    const b = bindBody.parse(req.body);
    const table =
      b.entityType === "project" ? projects : b.entityType === "milestone" ? milestones : disputes;
    const [row] = await db()
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, b.entityId))
      .limit(1);
    if (!row) throw notFound(`${b.entityType} not found`);
    try {
      await bindChainEntity(db(), b.entityType, b.entityId, toChainId(b.chainId));
    } catch {
      throw conflict("chain id already bound to another entity");
    }
    reply.code(201);
    return { ok: true };
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
