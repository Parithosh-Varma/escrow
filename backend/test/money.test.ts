import { describe, it, expect } from "vitest";
import {
  parseAmount,
  computePayoutSplit,
  jurorCountForAmount,
  commitVoteHash,
  tallyVotes,
  formatAmount
} from "../src/lib/money.js";

describe("money", () => {
  it("parses and formats base-unit amounts", () => {
    expect(parseAmount("1000000")).toBe(1_000_000n);
    expect(formatAmount(1_000_000n)).toBe("1000000");
    expect(() => parseAmount("1.5")).toThrow();
    expect(() => parseAmount("-5")).toThrow();
    expect(() => parseAmount("abc")).toThrow();
  });

  describe("computePayoutSplit", () => {
    const feeBps = 200; // platform 2%

    it("full approval splits freelancer/fee with no refund", () => {
      // 1000 USDC = 1000e6 base units
      const s = computePayoutSplit(1000_000000n, 10000, feeBps);
      expect(s.approvedGross).toBe(1000_000000n);
      expect(s.platformFee).toBe(20_000000n); // 2%
      expect(s.freelancer).toBe(980_000000n);
      expect(s.clientRefund).toBe(0n);
    });

    it("partial approval refunds the remainder to the client (spec §9.3)", () => {
      const s = computePayoutSplit(2000_000000n, 7000, feeBps); // approve 70%
      expect(s.approvedGross).toBe(1400_000000n);
      expect(s.platformFee).toBe(28_000000n);
      expect(s.freelancer).toBe(1372_000000n);
      expect(s.clientRefund).toBe(600_000000n);
    });

    it("conservation: freelancer + fee + refund == amount", () => {
      for (const bps of [1, 3333, 5000, 7777, 9999, 10000]) {
        const amount = 123456789n;
        const s = computePayoutSplit(amount, bps, feeBps);
        expect(s.freelancer + s.platformFee + s.clientRefund).toBe(amount);
      }
    });

    it("floors the fee so no dust is lost", () => {
      const s = computePayoutSplit(3n, 10000, 3333); // fee would be ~0.999n
      expect(s.platformFee).toBe(0n);
      expect(s.freelancer).toBe(3n);
    });

    it("rejects invalid bps", () => {
      expect(() => computePayoutSplit(100n, -1, 200)).toThrow();
      expect(() => computePayoutSplit(100n, 10001, 200)).toThrow();
      expect(() => computePayoutSplit(100n, 5000.5 as any, 200)).toThrow();
    });
  });

  describe("juror bands", () => {
    const band1 = 500_000000n;
    const band2 = 5000_000000n;
    it("maps amounts to pool sizes", () => {
      expect(jurorCountForAmount(1n, band1, band2)).toBe(3);
      expect(jurorCountForAmount(band1, band1, band2)).toBe(3);
      expect(jurorCountForAmount(band1 + 1n, band1, band2)).toBe(5);
      expect(jurorCountForAmount(band2, band1, band2)).toBe(5);
      expect(jurorCountForAmount(band2 + 1n, band1, band2)).toBe(7);
    });
  });

  describe("commit-reveal", () => {
    it("commitment is deterministic and salt-sensitive", () => {
      const a = commitVoteHash("d1", "freelancer", "saltsaltsalt");
      const b = commitVoteHash("d1", "freelancer", "saltsaltsalt");
      const c = commitVoteHash("d1", "client", "saltsaltsalt");
      const d = commitVoteHash("d2", "freelancer", "saltsaltsalt");
      const e = commitVoteHash("d1", "freelancer", "different12");
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).not.toBe(d);
      expect(a).not.toBe(e);
      expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("rejects short salts", () => {
      expect(() => commitVoteHash("d1", "client", "short")).toThrow();
    });
  });

  describe("tallyVotes", () => {
    it("majority decides; ties escalate", () => {
      expect(tallyVotes(["freelancer", "freelancer", "client"]).outcome).toBe("freelancer");
      expect(tallyVotes(["client", "client", "client"]).outcome).toBe("client");
      expect(tallyVotes(["client", "freelancer", "client"]).outcome).toBe("client");
      expect(tallyVotes(["freelancer", "client"]).outcome).toBe("tie");
      const t = tallyVotes(["freelancer", "client", "freelancer"]);
      expect(t.freelancerVotes).toBe(2);
      expect(t.clientVotes).toBe(1);
    });
  });
});
