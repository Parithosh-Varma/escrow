import type { DB, Tx } from "../db/driver.js";
import { ledgerEntries } from "../db/schema.js";
import { formatAmount } from "../lib/money.js";

export const Account = {
  EscrowLock: "escrow_lock",
  Freelancer: "freelancer",
  PlatformFee: "platform_fee",
  ClientRefund: "client_refund",
  JurorPool: "juror_pool"
} as const;

export type LedgerKind =
  | "lock"
  | "release_freelancer"
  | "platform_fee"
  | "refund_client"
  | "juror_reward"
  | "juror_slash";

/**
 * Single-leg audit entries per milestone (double-entry is overkill while the
 * contract holds custody off-mode; the on-chain events become source of truth
 * once CHAIN_MODE=live). Every payout path must write entries here so balances
 * are reconstructable: sum(amount where account=X) == X's lifetime balance.
 */
export async function recordLedger(
  tx: DB | Tx,
  input: {
    milestoneId: string;
    kind: LedgerKind;
    account: string;
    amount: bigint;
    ref?: string;
  }
): Promise<void> {
  await tx.insert(ledgerEntries).values({
    milestoneId: input.milestoneId,
    kind: input.kind,
    account: input.account,
    amount: formatAmount(input.amount),
    ref: input.ref ?? ""
  });
}

export interface MilestoneBalance {
  locked: bigint;
  releasedToFreelancer: bigint;
  platformFee: bigint;
  refundedToClient: bigint;
}

export async function milestoneBalance(
  db: DB | Tx,
  milestoneId: string
): Promise<MilestoneBalance> {
  const rows = await db.select().from(ledgerEntries);
  const acc: MilestoneBalance = {
    locked: 0n,
    releasedToFreelancer: 0n,
    platformFee: 0n,
    refundedToClient: 0n
  };
  for (const r of rows) {
    if (r.milestoneId !== milestoneId) continue;
    const amt = BigInt(r.amount);
    switch (r.kind) {
      case "lock":
        acc.locked += amt;
        break;
      case "release_freelancer":
        acc.releasedToFreelancer += amt;
        break;
      case "platform_fee":
        acc.platformFee += amt;
        break;
      case "refund_client":
        acc.refundedToClient += amt;
        break;
    }
  }
  return acc;
}
