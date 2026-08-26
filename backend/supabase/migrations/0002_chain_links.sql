-- 0002_chain_links.sql — CHAIN_MODE=live support:
--   * chain_links: bidirectional mapping between on-chain uint256 ids (EscrowCore)
--     and backend UUIDs. chain_id is stored as a decimal TEXT so the full
--     uint256 range is representable.
--   * milestones.remainder_amount / challenge_deadline: mirror of the on-chain
--     partial-approval challenge window (RemainderHeld event) used by the keeper
--     to schedule claimRemainder calls.

CREATE TABLE IF NOT EXISTS chain_links (
  entity_type  TEXT NOT NULL,               -- project | milestone | dispute
  entity_id    UUID NOT NULL,
  contract_key TEXT NOT NULL DEFAULT 'escrow',
  chain_id     TEXT NOT NULL,               -- decimal string of on-chain uint256 id
  bound_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chain_links_chain_unique
  ON chain_links (contract_key, entity_type, chain_id);

ALTER TABLE milestones ADD COLUMN IF NOT EXISTS remainder_amount TEXT;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS challenge_deadline TIMESTAMPTZ;
