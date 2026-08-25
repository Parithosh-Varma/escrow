import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  real,
  jsonb,
  primaryKey,
  bigserial,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  address: text("address").notNull().unique(),
  isAdmin: boolean("is_admin").notNull().default(false),
  jurorStatus: text("juror_status").notNull().default("none"),
  jurorStake: text("juror_stake").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const authNonces = pgTable("auth_nonces", {
  address: text("address").primaryKey(),
  nonce: text("nonce").notNull(),
  message: text("message").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
});

export const tokens = pgTable("tokens", {
  address: text("address").primaryKey(),
  chainId: integer("chain_id").notNull(),
  symbol: text("symbol").notNull(),
  decimals: integer("decimals").notNull(),
  active: boolean("active").notNull().default(true)
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => users.id),
  freelancerId: uuid("freelancer_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  tokenAddress: text("token_address")
    .notNull()
    .references(() => tokens.address),
  totalAmount: text("total_amount").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    spec: text("spec").notNull().default(""),
    amount: text("amount").notNull(),
    status: text("status").notNull(),
    approvedBps: integer("approved_bps"),
    reviewDeadline: timestamp("review_deadline", { withTimezone: true }),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("milestones_project_idx").on(t.projectId, t.idx)]
);

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  milestoneId: uuid("milestone_id")
    .notNull()
    .references(() => milestones.id, { onDelete: "cascade" }),
  note: text("note").notNull().default(""),
  aiStatus: text("ai_status").notNull().default("pending"),
  deliverableHash: text("deliverable_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  submissionId: uuid("submission_id").references(() => submissions.id, {
    onDelete: "set null"
  }),
  kind: text("kind").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: text("size_bytes").notNull(),
  mime: text("mime").notNull().default("application/octet-stream"),
  storageKey: text("storage_key").notNull(),
  watermarkedKey: text("watermarked_key"),
  originalName: text("original_name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const aiChecks = pgTable("ai_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  checkType: text("check_type").notNull(),
  provider: text("provider").notNull(),
  confidence: real("confidence").notNull(),
  flagged: boolean("flagged").notNull(),
  raw: jsonb("raw").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const disputes = pgTable("disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  milestoneId: uuid("milestone_id")
    .notNull()
    .references(() => milestones.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  raisedBy: text("raised_by").notNull(),
  reason: text("reason").notNull().default(""),
  amountStake: text("amount_stake").notNull(),
  jurorCount: integer("juror_count").notNull(),
  status: text("status").notNull(), // evidence | commit | reveal | resolved
  phaseDeadline: timestamp("phase_deadline", { withTimezone: true }),
  resolution: text("resolution"),
  splitBps: integer("split_bps"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
});

export const disputeJurors = pgTable(
  "dispute_jurors",
  {
    disputeId: uuid("dispute_id")
      .notNull()
      .references(() => disputes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    commitHash: text("commit_hash"),
    vote: text("vote"),
    salt: text("salt"),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    rewarded: boolean("rewarded").notNull().default(false),
    slashed: boolean("slashed").notNull().default(false)
  },
  (t) => [primaryKey({ columns: [t.disputeId, t.userId] })]
);

export const ledgerEntries = pgTable("ledger_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  milestoneId: uuid("milestone_id")
    .notNull()
    .references(() => milestones.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  account: text("account").notNull(),
  amount: text("amount").notNull(),
  ref: text("ref").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const notifications = pgTable("notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const indexerState = pgTable("indexer_state", {
  contractKey: text("contract_key").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull().default(0)
});

export const chainEvents = pgTable(
  "chain_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    contractKey: text("contract_key").notNull(),
    name: text("name").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    args: jsonb("args").notNull().default({}),
    processed: boolean("processed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
  },
  (t) => [
    uniqueIndex("chain_events_unique_log").on(t.contractKey, t.txHash, t.logIndex)
  ]
);
