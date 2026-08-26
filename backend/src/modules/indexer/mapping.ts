/**
 * Chain-id ↔ UUID mapping layer.
 *
 * EscrowCore identifies projects/milestones by sequential uint256 ids; the
 * backend uses UUIDs. `chain_links` stores both directions:
 *   PK  (entity_type, entity_id)              — one chain id per entity
 *   UNIQUE (contract_key, entity_type, chain_id) — one entity per chain id
 *
 * Binding happens three ways, in priority order:
 *   1. explicit admin bind (POST /admin/chain/bind)
 *   2. auto-bind on ProjectCreated/ProjectFunded (match client+freelancer
 *      addresses and totalAmount against unbound local projects, oldest first)
 *   3. hydration: once a project is bound, its milestones are derived from
 *      getProjectMilestones(chainProjectId) zipped against local idx order
 *
 * All writes are onConflictDoNothing so replaying old logs is a no-op.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "../../db/driver.js";
import { chainLinks, milestones, projects, users } from "../../db/schema.js";

export type ChainEntityType = "project" | "milestone" | "dispute";

/** RPC accessor for getProjectMilestones(chainProjectId), injectable for tests. */
export type FetchChainMilestones = (
  chainProjectId: string
) => Promise<readonly (string | bigint)[]>;

/** Canonical decimal-string form of an on-chain uint256 id. */
export function toChainId(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("chain id exceeds safe integer");
    return String(v);
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (/^\d+$/.test(s)) return s;
    if (/^0x[0-9a-f]+$/.test(s)) return BigInt(s).toString();
  }
  throw new Error(`cannot interpret chain id: ${String(v)}`);
}

export async function bindChainEntity(
  db: DB,
  entityType: ChainEntityType,
  entityId: string,
  chainId: string | bigint
): Promise<boolean> {
  const id = toChainId(chainId);
  const rows = await db
    .insert(chainLinks)
    .values({ entityType, entityId, chainId: id })
    .onConflictDoNothing()
    .returning();
  return rows.length > 0;
}

export async function unbindChainEntity(
  db: DB,
  entityType: ChainEntityType,
  entityId: string
): Promise<void> {
  await db
    .delete(chainLinks)
    .where(and(eq(chainLinks.entityType, entityType), eq(chainLinks.entityId, entityId)));
}

export async function chainIdForEntity(
  db: DB,
  entityType: ChainEntityType,
  entityId: string
): Promise<string | null> {
  const [row] = await db
    .select({ chainId: chainLinks.chainId })
    .from(chainLinks)
    .where(and(eq(chainLinks.entityType, entityType), eq(chainLinks.entityId, entityId)))
    .limit(1);
  return row?.chainId ?? null;
}

export async function entityForChainId(
  db: DB,
  entityType: ChainEntityType,
  chainId: string | bigint
): Promise<string | null> {
  const [row] = await db
    .select({ entityId: chainLinks.entityId })
    .from(chainLinks)
    .where(
      and(
        eq(chainLinks.entityType, entityType),
        eq(chainLinks.chainId, toChainId(chainId))
      )
    )
    .limit(1);
  return row?.entityId ?? null;
}

/**
 * Auto-bind a ProjectCreated/ProjectFunded event to the single unbound local
 * project whose client+freelancer wallets (and, when known, totalAmount) match.
 * Ambiguous or missing matches are left for an explicit admin bind.
 */
export async function tryAutoBindProject(
  db: DB,
  chainProjectId: string | bigint,
  clientAddr: string,
  freelancerAddr: string,
  totalAmount?: string | bigint
): Promise<{ projectId: string; bound: boolean } | null> {
  const client = clientAddr.toLowerCase();
  const freelancer = freelancerAddr.toLowerCase();

  const conditions = [
    sql`(SELECT address FROM users WHERE users.id = ${projects.clientId}) = ${client}`,
    sql`(SELECT address FROM users WHERE users.id = ${projects.freelancerId}) = ${freelancer}`,
    sql`NOT EXISTS (
      SELECT 1 FROM chain_links
      WHERE chain_links.entity_type = 'project'
        AND chain_links.entity_id = ${projects.id}
    )`
  ];
  if (totalAmount !== undefined) {
    conditions.push(eq(projects.totalAmount, toChainId(totalAmount)));
  }

  const candidates = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(...conditions))
    .orderBy(asc(projects.createdAt))
    .limit(2);

  // Exactly one candidate: bind. Zero or ambiguous: leave for manual binding.
  if (candidates.length !== 1) return null;
  const projectId = candidates[0]!.id;
  const bound = await bindChainEntity(db, "project", projectId, chainProjectId);
  return { projectId, bound };
}

/**
 * Given ordered on-chain milestone ids for a project (from
 * getProjectMilestones), bind each local milestone (ordered by idx) to its
 * chain id. Idempotent; re-binds are no-ops.
 */
export async function hydrateMilestoneLinks(
  db: DB,
  projectId: string,
  chainMilestoneIds: readonly (string | bigint)[]
): Promise<number> {
  const locals = await db
    .select({ id: milestones.id })
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(asc(milestones.idx));
  let bound = 0;
  const n = Math.min(locals.length, chainMilestoneIds.length);
  for (let i = 0; i < n; i++) {
    if (await bindChainEntity(db, "milestone", locals[i]!.id, chainMilestoneIds[i]!)) {
      bound++;
    }
  }
  return bound;
}

/**
 * Resolve the UUID for a milestone-keyed event, hydrating links lazily when the
 * project is already bound but milestone links haven't been derived yet.
 * `fetchChainMilestones` is injected so tests (and non-RPC contexts) can run
 * without a provider.
 */
export async function resolveMilestone(
  db: DB,
  chainMilestoneId: string | bigint,
  fetchChainMilestones?: FetchChainMilestones
): Promise<string | null> {
  const known = await entityForChainId(db, "milestone", chainMilestoneId);
  if (known) return known;

  if (!fetchChainMilestones) return null;
  const id = toChainId(chainMilestoneId);

  // Try each bound project until one claims this milestone id.
  const linkedProjects = await db
    .select({ entityId: chainLinks.entityId, chainId: chainLinks.chainId })
    .from(chainLinks)
    .where(eq(chainLinks.entityType, "project"));
  for (const lp of linkedProjects) {
    try {
      const ids = await fetchChainMilestones(lp.chainId);
      if (ids.map(toChainId).includes(id)) {
        await hydrateMilestoneLinks(db, lp.entityId, ids);
        return await entityForChainId(db, "milestone", id);
      }
    } catch {
      // provider hiccup — leave unresolved; next poll retries
    }
  }
  return null;
}

/** Address of a user row (helper for handlers that need wallet lookups). */
export async function userAddress(db: DB, userId: string): Promise<string | null> {
  const [u] = await db.select({ address: users.address }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.address ?? null;
}
