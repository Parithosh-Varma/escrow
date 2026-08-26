/**
 * Real event surface of contracts/files/EscrowCore.sol. All ids are uint256
 * (NOT bytes32) — the mapping layer in ./mapping.ts translates them to backend
 * UUIDs. Disputes surface through EscrowCore hooks (MilestoneDisputed /
 * DisputeResolved are emitted by the escrow itself, keyed by milestoneId).
 */
export const ESCROW_CORE_ABI = [
  { type: "event", name: "ProjectCreated", inputs: [
    { name: "projectId", type: "uint256", indexed: true },
    { name: "client", type: "address", indexed: true },
    { name: "freelancer", type: "address", indexed: true },
    { name: "token", type: "address", indexed: false },
    { name: "totalAmount", type: "uint256", indexed: false }
  ]},
  { type: "event", name: "ProjectFunded", inputs: [
    { name: "projectId", type: "uint256", indexed: true },
    { name: "amount", type: "uint256", indexed: false }
  ]},
  { type: "event", name: "MilestoneStarted", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "freelancer", type: "address", indexed: true }
  ]},
  { type: "event", name: "MilestoneSubmitted", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "deliverableHash", type: "bytes32", indexed: false },
    { name: "proofOfWorkHash", type: "bytes32", indexed: false },
    { name: "reviewDeadline", type: "uint64", indexed: false }
  ]},
  { type: "event", name: "MilestoneApproved", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "approvedBps", type: "uint32", indexed: false },
    { name: "approver", type: "address", indexed: true }
  ]},
  { type: "event", name: "AutoReleased", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "approvedBps", type: "uint32", indexed: false }
  ]},
  { type: "event", name: "MilestoneDisputed", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "disputeType", type: "uint8", indexed: false }
  ]},
  { type: "event", name: "DisputeResolved", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "splitBps", type: "uint16", indexed: false }
  ]},
  { type: "event", name: "FundsReleased", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "freelancerAmount", type: "uint256", indexed: false },
    { name: "fee", type: "uint256", indexed: false },
    { name: "clientRefund", type: "uint256", indexed: false }
  ]},
  { type: "event", name: "RemainderHeld", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "challengeDeadline", type: "uint64", indexed: false }
  ]},
  { type: "event", name: "RemainderClaimed", inputs: [
    { name: "milestoneId", type: "uint256", indexed: true },
    { name: "amount", type: "uint256", indexed: false }
  ]}
] as const;

/** Write functions used by the keeper bot. */
export const ESCROW_WRITE_ABI = [
  {
    type: "function",
    name: "autoReleaseMilestone",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "claimRemainder",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneId", type: "uint256" }],
    outputs: []
  }
] as const;

/** View used to hydrate project→milestone chain-id mappings after a bind. */
export const ESCROW_VIEW_ABI = [
  {
    type: "function",
    name: "getProjectMilestones",
    stateMutability: "view",
    inputs: [{ name: "projectId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }]
  }
] as const;

/** Mirrors DisputeModule.DisputeType layout per EscrowCore's constants/docs. */
export const DISPUTE_TYPE_CANCELLATION = 2;
