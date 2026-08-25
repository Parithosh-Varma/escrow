-- 0001_init.sql — portable across PGlite and Neon Postgres

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address       TEXT NOT NULL UNIQUE,           -- lowercase 0x address
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  juror_status  TEXT NOT NULL DEFAULT 'none',   -- none | approved | slashed
  juror_stake   TEXT NOT NULL DEFAULT '0',      -- non-transferable internal units
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  address     TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  address     TEXT PRIMARY KEY,                -- lowercase contract address
  chain_id    INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  decimals    INTEGER NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS projects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES users(id),
  freelancer_id  UUID NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  token_address  TEXT NOT NULL REFERENCES tokens(address),
  total_amount   TEXT NOT NULL,                -- base units, = sum(milestone amounts)
  status         TEXT NOT NULL,                -- created | funded | closed | cancelled
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS milestones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  spec             TEXT NOT NULL DEFAULT '',
  amount           TEXT NOT NULL,
  status           TEXT NOT NULL,              -- created|funded|in_progress|submitted|approved|disputed|resolved|auto_released|closed|cancelled
  approved_bps     INTEGER,                    -- set on approval (10000 for full)
  review_deadline  TIMESTAMPTZ,
  funded_at        TIMESTAMPTZ,
  submitted_at     TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idx)
);

CREATE TABLE IF NOT EXISTS submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id    UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  note            TEXT NOT NULL DEFAULT '',
  ai_status       TEXT NOT NULL DEFAULT 'pending', -- pending | clean | flagged
  deliverable_hash TEXT NOT NULL,              -- sha256 of primary deliverable
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES users(id),
  submission_id    UUID REFERENCES submissions(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,              -- deliverable | screen_recording | process_file | watermarked_preview
  sha256           TEXT NOT NULL,
  size_bytes       TEXT NOT NULL,
  mime             TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key      TEXT NOT NULL,
  watermarked_key  TEXT,
  original_name    TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_checks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  check_type     TEXT NOT NULL,                -- requirement_match | plagiarism | ai_generation
  provider       TEXT NOT NULL,
  confidence     REAL NOT NULL,
  flagged        BOOLEAN NOT NULL,
  raw            JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id    UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,               -- quality | scope | cancellation | ai_flag | partial_amount
  raised_by       TEXT NOT NULL,               -- user address or 'system:ai'
  reason          TEXT NOT NULL DEFAULT '',
  amount_stake    TEXT NOT NULL,               -- milestone amount at time of dispute
  juror_count     INTEGER NOT NULL,
  status          TEXT NOT NULL,               -- evidence | commit | reveal | resolved
  phase_deadline  TIMESTAMPTZ,
  resolution      TEXT,                        -- freelancer | client | tie_escalated
  split_bps       INTEGER,                     -- final payout bps to freelancer on resolution
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dispute_jurors (
  dispute_id   UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  commit_hash  TEXT,
  vote         TEXT,                           -- freelancer | client (revealed only)
  salt         TEXT,
  revealed_at  TIMESTAMPTZ,
  rewarded     BOOLEAN NOT NULL DEFAULT FALSE,
  slashed      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (dispute_id, user_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  milestone_id  UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                 -- lock | release_freelancer | platform_fee | refund_client | juror_reward | juror_slash
  account       TEXT NOT NULL,                 -- escrow_lock | freelancer | platform_fee | client_refund | juror_pool
  amount        TEXT NOT NULL,
  ref           TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_milestone_idx ON ledger_entries (milestone_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  contract_key TEXT PRIMARY KEY,
  last_block   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chain_events (
  id            BIGSERIAL PRIMARY KEY,
  contract_key  TEXT NOT NULL,
  name          TEXT NOT NULL,
  block_number  BIGINT NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  args          JSONB NOT NULL DEFAULT '{}',
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_key, tx_hash, log_index)
);
