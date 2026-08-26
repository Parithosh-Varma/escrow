import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, or, and } from "drizzle-orm";
import { db } from "../../db-instance.js";
import { users, tokens, projects, milestones } from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { formatAmount, parseAmount } from "../../lib/money.js";
import { recordLedger, Account } from "../../services/ledger.js";
import { notifyAddress } from "../../services/notifications.js";

const milestoneInput = z.object({
  title: z.string().min(1).max(200),
  spec: z.string().max(8000).default(""),
  amount: z.string()
});

const createProject = z.object({
  freelancerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).default(""),
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  milestones: z.array(milestoneInput).min(1).max(50)
});

export default async function routes(app: FastifyInstance) {
  const auth = [(app as any).authenticate];

  app.post("/projects", { preHandler: auth }, async (req) => {
    const body = createProject.parse(req.body);
    const clientAddr = req.user.address.toLowerCase();
    const freelancerAddr = body.freelancerAddress.toLowerCase();
    if (freelancerAddr === clientAddr) throw badRequest("cannot hire yourself");

    const [token] = await db()
      .select()
      .from(tokens)
      .where(and(eq(tokens.address, body.tokenAddress.toLowerCase()), eq(tokens.active, true)))
      .limit(1);
    if (!token) throw badRequest("token not on allowlist");

    const ids = await ensureUsers(clientAddr, freelancerAddr);

    let total = 0n;
    body.milestones.forEach((m, i) => {
      const amt = parseAmount(m.amount, `milestones[${i}].amount`);
      if (amt === 0n) throw badRequest(`milestones[${i}].amount must be > 0`);
      total += amt;
    });

    const [project] = await db()
      .insert(projects)
      .values({
        clientId: ids.clientId,
        freelancerId: ids.freelancerId,
        title: body.title,
        description: body.description,
        tokenAddress: token.address,
        totalAmount: formatAmount(total),
        status: "created"
      })
      .returning();

    const created = [];
    for (let i = 0; i < body.milestones.length; i++) {
      const m = body.milestones[i]!;
      const [row] = await db()
        .insert(milestones)
        .values({
          projectId: project!.id,
          idx: i,
          title: m.title,
          spec: m.spec,
          amount: m.amount,
          status: "created"
        })
        .returning();
      created.push(row);
    }

    await notifyAddress(db(), freelancerAddr, "project.created", {
      projectId: project!.id,
      title: body.title
    });
    return { project, milestones: created };
  });

  app.get("/projects", { preHandler: auth }, async (req) => {
    const uid = req.user.sub;
    const rows = await db()
      .select()
      .from(projects)
      .where(or(eq(projects.clientId, uid), eq(projects.freelancerId, uid)));
    return { projects: rows };
  });

  app.get("/projects/:id", { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await getProjectForUser(id, req.user);
    const ms = await db()
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, id))
      .orderBy(milestones.idx);
    return { project: p, milestones: ms };
  });

  /**
   * Full upfront funding (spec §3). CHAIN_MODE=off: the backend ledger is the
   * source of truth. CHAIN_MODE=live: funding happens on-chain; the indexer
   * applies MilestoneFunded events — this endpoint is then read-only/absent.
   */
  app.post("/projects/:id/fund", { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await getProjectForUser(id, req.user);
    if (p.status !== "created") throw conflict(`project already ${p.status}`);

    // Atomic conditional update to prevent double-fund race condition
    const [updated] = await db()
      .update(projects)
      .set({ status: "funded", updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.status, "created")))
      .returning();
    if (!updated) throw conflict("project already funded (concurrent request)");

    const ms = await db()
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, id))
      .orderBy(milestones.idx);
    for (const m of ms) {
      await db()
        .update(milestones)
        .set({ status: "funded", fundedAt: new Date(), updatedAt: new Date() })
        .where(eq(milestones.id, m.id));
      await recordLedger(db(), {
        milestoneId: m.id,
        kind: "lock",
        account: Account.EscrowLock,
        amount: BigInt(m.amount),
        ref: `project:${id}`
      });
    }
    const [freelancer] = await db()
      .select()
      .from(users)
      .where(eq(users.id, p.freelancerId))
      .limit(1);
    if (freelancer) {
      await notifyAddress(db(), freelancer.address, "project.funded", { projectId: id });
    }
    return { ok: true };
  });

  app.post("/projects/:id/cancel", { preHandler: auth }, async (req) => {
    // Cancellation always routes through the dispute system (spec §3).
    throw forbidden(
      "cancellation requires a 'cancellation' dispute — POST /disputes with type=cancellation"
    );
  });
}

async function ensureUsers(...addrs: string[]) {
  const map = new Map<string, string>();
  for (const a of addrs.map((x) => x.toLowerCase())) {
    const [existing] = await db().select().from(users).where(eq(users.address, a)).limit(1);
    if (existing) {
      map.set(a, existing.id);
    } else {
      const isAdmin = false;
      const [created] = await db()
        .insert(users)
        .values({ address: a, isAdmin })
        .returning();
      map.set(a, created!.id);
    }
  }
  return {
    clientId: map.get(addrs[0]!.toLowerCase())!,
    freelancerId: map.get(addrs[1]!.toLowerCase())!
  };
}

export async function getProjectForUser(id: string, user: { sub: string; isAdmin?: boolean }) {
  const [p] = await db().select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!p) throw notFound("project not found");
  if (!user.isAdmin && p.clientId !== user.sub && p.freelancerId !== user.sub) {
    throw forbidden("not your project");
  }
  return p;
}
