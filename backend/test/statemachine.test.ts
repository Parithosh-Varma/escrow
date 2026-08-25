import { describe, it, expect } from "vitest";
import { assertTransition, canTransition, MilestoneStatus as S } from "../src/services/statemachine.js";

describe("milestone state machine (spec §3)", () => {
  it("allows the happy path", () => {
    assertTransition(S.Created, S.Funded);
    assertTransition(S.Funded, S.InProgress);
    assertTransition(S.InProgress, S.Submitted);
    assertTransition(S.Submitted, S.Approved);
    assertTransition(S.Submitted, S.AutoReleased);
    assertTransition(S.Submitted, S.Disputed);
    assertTransition(S.Disputed, S.Resolved);
    assertTransition(S.Approved, S.Closed);
    assertTransition(S.AutoReleased, S.Closed);
  });

  it("blocks skipping steps", () => {
    expect(canTransition(S.Created, S.Submitted)).toBe(false);
    expect(canTransition(S.Funded, S.Approved)).toBe(false);
    expect(canTransition(S.InProgress, S.Approved)).toBe(false);
    expect(canTransition(S.Created, S.Closed)).toBe(false);
  });

  it("blocks terminal states from moving", () => {
    expect(canTransition(S.Closed, S.Submitted)).toBe(false);
    expect(canTransition(S.Cancelled, S.Funded)).toBe(false);
    expect(canTransition(S.Approved, S.InProgress)).toBe(false);
  });

  it("no unilateral cancellation — only via dispute", () => {
    // cancellation is a dispute type; direct cancel transitions don't exist
    expect(canTransition(S.InProgress, S.Cancelled)).toBe(false);
    expect(canTransition(S.Submitted, S.Cancelled)).toBe(false);
  });

  it("partial approval can be contested via dispute", () => {
    expect(canTransition(S.Approved, S.Disputed)).toBe(true);
  });

  it("throws on illegal transition", () => {
    expect(() => assertTransition(S.Created, S.Approved)).toThrow(/illegal transition/);
  });
});
