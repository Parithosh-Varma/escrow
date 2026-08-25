import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { config } from "../../config.js";
import { getDb } from "../../db/driver.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { unauthorized } from "../../errors.js";

export interface AuthUser {
  sub: string;
  address: string;
  isAdmin: boolean;
  jurorStatus: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: any, reply?: any) => Promise<void>;
    requireAdmin: (req: any, reply?: any) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(jwt, { secret: config.JWT_SECRET });

  app.decorate("authenticate", async (req: any, _reply: any) => {
    try {
      await req.jwtVerify();
      const u = req.user as AuthUser;
      // refresh admin flag server-side; never trust token-only claims
      const db = await getDb();
      const [row] = await db.select().from(users).where(eq(users.id, u.sub)).limit(1);
      if (!row) throw unauthorized("user missing");
      u.isAdmin = row.isAdmin;
      u.jurorStatus = row.jurorStatus;
    } catch (e) {
      if (e instanceof unauthorized("").constructor) throw e;
      throw unauthorized("missing or invalid token");
    }
  });

  app.decorate("requireAdmin", async (req: any, reply: any) => {
    await (app as any).authenticate(req, reply);
    if (!(req.user as AuthUser).isAdmin) throw unauthorized("admin only");
  });
});
