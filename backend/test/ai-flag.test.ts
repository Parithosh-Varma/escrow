import { describe, it, expect, beforeAll, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";

// Spec §5: any flagged AI check auto-triggers a dispute — it is a signal,
// never an auto-rejection. Mock the provider pipeline deterministically.
vi.mock("../src/services/ai/provider.js", () => ({
  runAllChecks: async () => [
    {
      provider: "mock-requirement",
      confidence: 0.42,
      flagged: true, // requirement mismatch flag
      raw: { note: "deliverable does not reference milestone scope keywords" }
    },
    { provider: "mock-plagiarism", confidence: 0.11, flagged: false, raw: {} },
    {
      provider: "mock-ai-detect",
      confidence: 0.93,
      flagged: true, // high-confidence AI-generation signal
      raw: { detector: "gptzero-style" }
    }
  ]
}));

const key = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
const CLIENT_KEY = key(2);
const FREELANCER_KEY = key(3);
const MOCK_TOKEN = "0x00000000000000000000000000000000deadbeef";

let app: FastifyInstance;
let clientToken: string;
let freelancerToken: string;

async function login(pk: string) {
  const acct = privateKeyToAccount(pk);
  const ch = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    payload: { address: acct.address }
  });
  const sig = await acct.signMessage({ message: ch.json().message });
  const v = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: acct.address, signature: sig }
  });
  return v.json().token as string;
}

beforeAll(async () => {
  const { buildApp } = await import("../src/server.js");
  app = await buildApp();
  clientToken = await login(CLIENT_KEY);
  freelancerToken = await login(FREELANCER_KEY);
});

describe("AI flag -> auto-dispute wiring", () => {
  it("flags the submission and opens a dispute without client action", async () => {
    const proj = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: `Bearer ${clientToken}` },
      payload: {
        freelancerAddress: privateKeyToAccount(FREELANCER_KEY).address,
        title: "AI-flag case",
        tokenAddress: MOCK_TOKEN,
        milestones: [{ title: "Illustration", spec: "hand-drawn mascot", amount: "300000000" }]
      }
    });
    const mid = proj.json().milestones[0].id;
    await app.inject({
      method: "POST",
      url: `/projects/${proj.json().project.id}/fund`,
      headers: { authorization: `Bearer ${clientToken}` }
    });
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: { authorization: `Bearer ${freelancerToken}` }
    });

    const sub = await app.inject({
      method: "POST",
      url: `/milestones/${mid}/submit`,
      headers: { authorization: `Bearer ${freelancerToken}` },
      payload: {
        deliverableBase64: Buffer.from("suspect-artwork").toString("base64"),
        screenRecordingBase64: Buffer.from("recording").toString("base64"),
        processFilesBase64: [Buffer.from("layers").toString("base64")]
      }
    });
    expect(sub.statusCode).toBe(201);
    const body = sub.json();

    // flagged, and confidence is masked from the counterparty-facing response
    expect(body.aiStatus).toBe("flagged");
    expect(body.aiResults.filter((r: any) => r.flagged)).toHaveLength(2);
    for (const r of body.aiResults) expect(r.confidence).toBeUndefined();

    // auto-dispute created; milestone moved to disputed
    expect(body.autoDisputeId).toBeTruthy();

    const detail = await app.inject({
      method: "GET",
      url: `/milestones/${mid}`,
      headers: { authorization: `Bearer ${clientToken}` }
    });
    expect(detail.json().milestone.status).toBe("disputed");
    expect(detail.json().disputes[0].type).toBe("ai_flag");
    // jurors later see FULL raw confidence in evidence
    const checks = detail.json().submissions[0].checks as Array<any>;
    expect(checks.find((c) => c.checkType === "ai_generation")?.confidence).toBeCloseTo(0.93);
  });
});
