import { keccak256, encodePacked } from "viem";
import { badRequest } from "../errors.js";

/** All monetary amounts are integer base units (e.g. USDC has 6 decimals),
 *  represented as decimal strings over the wire and BigInt internally. */

const DECIMAL_RE = /^\d+$/;

export function parseAmount(s: string, label = "amount"): bigint {
  if (typeof s !== "string" || !DECIMAL_RE.test(s)) {
    throw badRequest(`${label} must be a non-negative integer base-unit string`);
  }
  return BigInt(s);
}

export function formatAmount(v: bigint): string {
  return v.toString();
}

export const BPS_DENOM = 10_000n;

export function bpsToRatio(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw badRequest(`bps must be an integer within [0, 10000]`);
  }
  return BigInt(bps);
}

export function mulDivFloor(a: bigint, num: bigint, den: bigint): bigint {
  return (a * num) / den;
}

export interface PayoutSplit {
  /** gross portion approved for the freelancer, before fee */
  approvedGross: bigint;
  /** platform fee taken from the approved portion */
  platformFee: bigint;
  /** net paid to freelancer */
  freelancer: bigint;
  /** un-approved remainder returned to the client */
  clientRefund: bigint;
}

/**
 * Splits a milestone allocation given an approval percentage and fee basis points.
 * Decision (spec §9.3): the un-approved remainder is refunded to the client;
 * the freelancer may open a `partial_amount` dispute to contest it.
 * Rounding always floors against the freelancer's favor-neutral middle ground:
 * fee floors first, then freelancer gets approved minus fee (no dust loss).
 */
export function computePayoutSplit(
  amountBase: bigint,
  approvedBps: number,
  feeBps: number
): PayoutSplit {
  if (amountBase < 0n) throw badRequest("amount must be >= 0");
  const ratio = bpsToRatio(approvedBps);
  const feeRatio = bpsToRatio(feeBps);
  const approvedGross = mulDivFloor(amountBase, ratio, BPS_DENOM);
  const platformFee = mulDivFloor(approvedGross, feeRatio, BPS_DENOM);
  const freelancer = approvedGross - platformFee;
  const clientRefund = amountBase - approvedGross;
  return { approvedGross, platformFee, freelancer, clientRefund };
}

/**
 * Juror pool sizing bands (spec §6): small -> 3, medium -> 5, large -> 7.
 * Amount compared in USD-equivalent base units assuming 6-decimal stablecoin
 * cents-style thresholds supplied via config.
 */
export function jurorCountForAmount(
  amountBase: bigint,
  band1Max: bigint,
  band2Max: bigint
): number {
  if (amountBase <= band1Max) return 3;
  if (amountBase <= band2Max) return 5;
  return 7;
}

export type DisputeVote = "freelancer" | "client";

/**
 * Canonical commit-reveal commitment: keccak256(utf8(disputeId || vote || salt)).
 * Salt is chosen by the juror and must be revealed alongside the vote.
 */
export function commitVoteHash(
  disputeId: string,
  vote: DisputeVote,
  salt: string
): `0x${string}` {
  if (salt.length < 8) throw badRequest("salt too short");
  return keccak256(
    encodePacked(["string", "string", "string"], [disputeId, vote, salt])
  );
}

export interface TallyResult {
  outcome: DisputeVote | "tie";
  freelancerVotes: number;
  clientVotes: number;
}

export function tallyVotes(votes: DisputeVote[]): TallyResult {
  const f = votes.filter((v) => v === "freelancer").length;
  const c = votes.filter((v) => v === "client").length;
  if (f === c) return { outcome: "tie", freelancerVotes: f, clientVotes: c };
  return {
    outcome: f > c ? "freelancer" : "client",
    freelancerVotes: f,
    clientVotes: c
  };
}
