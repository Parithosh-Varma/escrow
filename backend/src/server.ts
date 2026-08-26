import Fastify, { type FastifyInstance, type FastifyError, type FastifyRequest, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { AppError } from "./errors.js";
import authPlugin from "./modules/auth/plugin.js";
import authRoutes from "./modules/auth/routes.js";
import projectRoutes from "./modules/projects/routes.js";
import milestoneRoutes from "./modules/milestones/routes.js";
import disputeRoutes from "./modules/disputes/routes.js";
import fileRoutes from "./modules/files/routes.js";
import adminRoutes from "./modules/admin/routes.js";
import webRoutes from "./modules/web/routes.js";
import { startPolling } from "./modules/indexer/service.js";
import { startKeeper } from "./modules/keeper/service.js";
import { ensureSeedTokens } from "./modules/admin/routes.js";
import { initDb, db } from "./db/driver.js";
import { runMigrations } from "./db/migrate.js";

export async function buildApp(): Promise<FastifyInstance> {
  await initDb();
  await runMigrations();
  void db(); // warm singleton

  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : true,
    bodyLimit: 100 * 1024 * 1024 // submissions include recordings
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 512 * 1024 * 1024 }
  });
  await app.register(authPlugin);

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: "VALIDATION",
        message: "invalid request body",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
      });
      return;
    }
    if (err.validation) {
      reply.code(400).send({ error: "VALIDATION", message: err.message });
      return;
    }
    const status = err.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      reply.code(status).send({ error: "REQUEST_ERROR", message: err.message });
      return;
    }
    console.error(err);
    reply.code(500).send({ error: "INTERNAL", message: "internal server error" });
  });

  app.get("/healthz", async () => ({
    ok: true,
    chainMode: process.env.CHAIN_MODE ?? "off"
  }));

  await app.register(webRoutes);
  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(milestoneRoutes);
  await app.register(disputeRoutes);
  await app.register(fileRoutes);
  await app.register(adminRoutes);
  await ensureSeedTokens();

  setImmediate(() => startPolling(app));
  setImmediate(() => startKeeper(app));

  return app;
}
