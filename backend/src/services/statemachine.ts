import { badRequest } from "../errors.js";

export const MilestoneStatus = {
  Created: "created",
  Funded: "funded",
  InProgress: "in_progress",
  Submitted: "submitted",
  Approved: "approved",
  Disputed: "disputed",
  Resolved: "resolved",
  AutoReleased: "auto_released",
  Closed: "closed",
  Cancelled: "cancelled"
} as const;
export type MilestoneStatusValue =
  (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

/** Spec §3 state machine:
 *  CREATED -> FUNDED -> IN_PROGRESS -> SUBMITTED ->
 *    APPROVED | DISPUTED -> RESOLVED | AUTO_RELEASED -> CLOSED
 */
export const TRANSITIONS: Record<string, string[]> = {
  [MilestoneStatus.Created]: [MilestoneStatus.Funded, MilestoneStatus.Cancelled],
  [MilestoneStatus.Funded]: [
    MilestoneStatus.InProgress,
    MilestoneStatus.Disputed // cancellation dispute
  ],
  [MilestoneStatus.InProgress]: [
    MilestoneStatus.Submitted,
    MilestoneStatus.Disputed
  ],
  [MilestoneStatus.Submitted]: [
    MilestoneStatus.Approved,
    MilestoneStatus.AutoReleased,
    MilestoneStatus.Disputed
  ],
  [MilestoneStatus.Approved]: [
    MilestoneStatus.Closed,
    MilestoneStatus.Disputed // freelancer may contest a partial approval's remainder
  ],
  [MilestoneStatus.AutoReleased]: [MilestoneStatus.Closed],
  [MilestoneStatus.Resolved]: [
    MilestoneStatus.Closed,
    MilestoneStatus.InProgress, // resolved in freelancer's favor -> work continues/resubmits not needed but funds released; allow close only in practice
    MilestoneStatus.Submitted
  ],
  [MilestoneStatus.Disputed]: [MilestoneStatus.Resolved], // only via dispute resolution
  [MilestoneStatus.Closed]: [],
  [MilestoneStatus.Cancelled]: []
};

export function assertTransition(from: string, to: string): void {
  const allowed = TRANSITIONS[from];
  if (!allowed) throw badRequest(`unknown milestone status '${from}'`);
  if (!allowed.includes(to)) {
    throw badRequest(`illegal transition ${from} -> ${to}`);
  }
}

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
