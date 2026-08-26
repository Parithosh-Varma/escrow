/**
 * Serves the static frontend (repo-root ./frontend) from the API server.
 * Explicit allow-listed files only — no directory listing, no traversal.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/{src,dist}/modules/web -> up 4 = repo root
const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "frontend");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function serve(reply: FastifyReply, file: string) {
  const full = path.join(ROOT, file);
  try {
    const data = fs.readFileSync(full);
    reply.header("cache-control", "no-store");
    return reply.type(MIME[path.extname(full)] ?? "application/octet-stream").send(data);
  } catch {
    return reply.status(404).send({ error: "NOT_FOUND", message: `${file} not found` });
  }
}

export default async function routes(app: FastifyInstance) {
  app.get("/", async (_req: unknown, reply: FastifyReply) => serve(reply, "index.html"));
  app.get("/index.html", async (_req: unknown, reply: FastifyReply) => serve(reply, "index.html"));
  app.get("/app.js", async (_req: unknown, reply: FastifyReply) => serve(reply, "app.js"));
  app.get("/style.css", async (_req: unknown, reply: FastifyReply) => serve(reply, "style.css"));
}
