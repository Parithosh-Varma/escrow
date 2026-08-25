import { config } from "../config.js";
import { drizzle as drizzleJs } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";

export type DB = ReturnType<typeof drizzleJs<typeof schema>> | ReturnType<typeof drizzlePglite>;

let singleton: { db: DB; kind: "neon" | "pglite"; close: () => Promise<void> } | null =
  null;

export async function getDb(): Promise<DB> {
  if (singleton) return singleton.db;
  const url = config.DATABASE_URL?.trim();
  if (url) {
    const queryClient = postgres(url, {
      prepare: false, // required for Neon pooler
      max: 10,
      connect_timeout: 15
    });
    const db = drizzleJs(queryClient, { schema });
    singleton = {
      db,
      kind: "neon",
      close: async () => await queryClient.end()
    };
    return db;
  }
  const client = new PGlite(
    config.NODE_ENV === "test" ? undefined : "escrow-local-db"
  );
  const db = drizzlePglite(client, { schema });
  singleton = {
    db,
    kind: "pglite",
    close: async () => await client.close()
  };
  return db;
}

export async function closeDb() {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/** Synchronous accessor after initDb() has run (called by buildApp/tests). */
export function db(): DB {
  if (!singleton) throw new Error("database not initialized — call initDb() first");
  return singleton.db;
}

export async function initDb(): Promise<DB> {
  return await getDb();
}

export type PostgresJsDb = ReturnType<typeof drizzleJs<typeof schema>>;
export type PgliteDb = ReturnType<typeof drizzlePglite>;
export type Tx = Parameters<Parameters<PostgresJsDb["transaction"]>[0]>[0];
