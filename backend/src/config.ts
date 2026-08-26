import { z } from "zod";
import fs from "node:fs";

function loadDotEnv(path = ".env") {
  try {
    const raw = fs.readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2] ?? "";
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        // strip inline comments from unquoted values
        const hashIdx = val.indexOf("#");
        if (hashIdx !== -1) val = val.slice(0, hashIdx).trimEnd();
      }
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* no .env file, fine */
  }
}

loadDotEnv();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(8),
  DATABASE_URL: z.string().optional().or(z.literal("")),

  CHAIN_MODE: z.enum(["off", "live"]).default("off"),
  RPC_URL: z.string().default("https://sepolia.base.org"),
  ESCROW_CONTRACT_ADDRESS: z.string().optional().or(z.literal("")),
  DISPUTE_CONTRACT_ADDRESS: z.string().optional().or(z.literal("")),
  INDEXER_START_BLOCK: z.coerce.number().default(0),
  INDEXER_POLL_MS: z.coerce.number().default(12000),

  // Keeper bot (CHAIN_MODE=live only): sends autoReleaseMilestone /
  // claimRemainder for anything due. Empty key => keeper idle.
  KEEPER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
    .optional()
    .or(z.literal("")),
  KEEPER_POLL_MS: z.coerce.number().default(30000),
  KEEPER_GRACE_SECONDS: z.coerce.number().default(120),

  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(200),
  REVIEW_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(604800),
  PARTIAL_REMAINDER: z.enum(["refund_to_client", "freelancer_keep"]).default("refund_to_client"),

  JUROR_BAND_1_MAX: z.string().default("500000000"),
  JUROR_BAND_2_MAX: z.string().default("5000000000"),

  ADMIN_ADDRESSES: z.string().default(""),

  GPTZERO_API_KEY: z.string().optional().or(z.literal("")),
  HIVE_API_KEY: z.string().optional().or(z.literal("")),

  STORAGE_DRIVER: z.enum(["memory", "disk", "s3"]).default("disk"),
  STORAGE_DIR: z.string().default("./.data/files"),

  S3_BUCKET: z.string().optional().or(z.literal("")),
  S3_REGION: z.string().optional().or(z.literal("")),
  S3_ENDPOINT: z.string().optional().or(z.literal("")),
  S3_ACCESS_KEY_ID: z.string().optional().or(z.literal("")),
  S3_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")),
});

export const config = schema.parse(process.env);

export const ADMIN_ADDRESSES = config.ADMIN_ADDRESSES.split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);
