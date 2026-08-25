/**
 * Applies SQL migrations to whichever database driver is configured.
 * Works with both PGlite and Neon (postgres.js). Idempotent via schema_migrations.
 */
import { getDb } from "./driver.js";
import { loadMigrations } from "./loader.js";

const CREATE_TRACKING = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** PGlite cannot run multi-statement strings; split on statement boundaries. */
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  for (const stmt of splitStatements(CREATE_TRACKING)) {
    await db.execute(stmt);
  }
  for (const m of loadMigrations()) {
    const res = await db.execute(
      `SELECT id FROM schema_migrations WHERE id = '${m.id}'`
    );
    const applied = Array.isArray(res) ? res : (res as any).rows;
    if ((applied ?? []).length > 0) continue;
    console.log(`-> applying migration ${m.id}`);
    for (const stmt of splitStatements(m.sql)) {
      await db.execute(stmt);
    }
    await db.execute(`INSERT INTO schema_migrations (id) VALUES ('${m.id}')`);
  }
}

const invokedDirectly = process.argv[1]?.includes("migrate");
if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log("migrations up to date");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
