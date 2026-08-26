export interface Project {
  id: string;
  clientId: string;
  freelancerId: string;
  title: string;
  description: string;
  tokenAddress: string;
  totalAmount: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  idx: number;
  title: string;
  spec: string;
  amount: string;
  status: string;
  approvedBps: number | null;
  reviewDeadline: string | null;
  fundedAt: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
}

export interface Submission {
  id: string;
  milestoneId: string;
  note: string;
  aiStatus: string;
  deliverableHash: string;
  files?: Array<{ id: string; kind: string; originalName: string }>;
}

export const DEFAULT_TOKEN = "0x00000000000000000000000000000000deadbeef";

export function formatAmount(baseUnits: string): string {
  const n = BigInt(baseUnits);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}
