import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Migration {
  id: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  const dir = path.join(__dirname, "sql");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ id: f, sql: fs.readFileSync(path.join(dir, f), "utf8") }));
}
