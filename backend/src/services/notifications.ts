import type { DB, Tx } from "../db/driver.js";
import { notifications, users } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function notify(
  db: DB | Tx,
  userId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  await db.insert(notifications).values({ userId, type, payload });
}

export async function notifyAddress(
  db: DB | Tx,
  address: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.address, address.toLowerCase()))
    .limit(1);
  if (u) await notify(db, u.id, type, payload);
}
