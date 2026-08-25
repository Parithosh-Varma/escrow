import { describe, it, expect, beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

const key = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
const ADMIN_KEY = key(1);
const CLIENT_KEY = key(2);
const FREELANCER_KEY = key(3);
const JUROR_KEYS = [key(4), key(5), key(6), key(7), key(8)];

const MOCK_TOKEN = "0x00000000000000000000000000000000deadbeef";
const M1 = 1000_000000n; // 1000 USDC-ish
const M2 = 2000_000000n;

async function login(app: FastifyInstance, pk: string): Promise<{ token: string; address: string }> {
  const acct = privateKeyToAccount(pk as `0x${string}`);
  const ch = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    payload: { address: acct.address }
  });
  expect(ch.statusCode).toBe(200);
  const { message } = ch.json();
  const sig = await acct.signMessage({ message });
  const v = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: acct.address, signature: sig }
  });
  expect(v.statusCode).toBe(200);
  return { token: v.json().token, address: acct.address.toLowerCase() };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const { buildApp } = await import("../src/server.js");
  app = await buildApp();
});

describe("escrow backend end-to-end", () => {
  let admin: { token: string; address: string };
  let clientU: { token: string; address: string };
  let freelancerU: { token: string; address: string };

  let projectId: string;
  let m1Id: string;
  let m2Id: string;

  beforeAll(async () => {
    admin = await login(app, ADMIN_KEY);
    clientU = await login(app, CLIENT_KEY);
    freelancerU = await login(app, FREELANCER_KEY);
    for (const jk of JUROR_KEYS) {
      const j = await login(app, jk);
      const r = await app.inject({
        method: "POST",
        url: `/admin/jurors/${j.address}/approve`,
        headers: auth(admin.token)
      });
      expect(r.statusCode).toBe(200);
    }
  });

  it("rejects forged wallet signatures", async () => {
    const acct = privateKeyToAccount(CLIENT_KEY);
    await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: acct.address } });
    const r = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: acct.address, signature: "0x" + "ff".repeat(65) }
    });
    expect(r.statusCode).toBe(401);
  });

  it("creates a multi-milestone project with upfront funding", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      headers: auth(clientU.token),
      payload: {
        freelancerAddress: freelancerU.address,
        title: "Brand kit",
        tokenAddress: MOCK_TOKEN,
        milestones: [
          { title: "Logo", spec: "vector logo + variants", amount: M1.toString() },
          { title: "Landing page", spec: "figma + html", amount: M2.toString() }
        ]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    projectId = body.project.id;
    m1Id = body.milestones[0].id;
    m2Id = body.milestones[1].id;
    expect(body.project.totalAmount).toBe((M1 + M2).toString());
    expect(body.project.status).toBe("created");
  });

  it("rejects tokens off the allowlist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      headers: auth(clientU.token),
      payload: {
        freelancerAddress: freelancerU.address,
        title: "x",
        tokenAddress: "0x1111111111111111111111111111111111111111",
        milestones: [{ title: "a", amount: "1" }]
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it("blocks unilateral cancellation (spec §3)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/cancel`,
      headers: auth(clientU.token)
    });
    expect(res.statusCode).toBe(403);
  });

  it("funds all milestones upfront and locks ledger entries", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/fund`,
      headers: auth(clientU.token)
    });
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/projects/${projectId}`,
      headers: auth(clientU.token)
    });
    for (const m of detail.json().milestones) expect(m.status).toBe("funded");

    const { db: getDbHandle } = await import("../src/db/driver.js");
    const db = getDbHandle();
    const { ledgerEntries } = await import("../src/db/schema.js");
    const rows = await db.select().from(ledgerEntries);
    const locks = rows.filter((r) => r.kind === "lock");
    const total = locks.reduce((a, r) => a + BigInt(r.amount), 0n);
    expect(total).toBe(M1 + M2);
  });

  async function submitMilestone(
    milestoneId: string,
    opts: { deliverable?: Buffer } = {}
  ): Promise<any> {
    const deliverable =
      opts.deliverable ?? Buffer.from(`deliverable-for-${milestoneId}`);
    const b64 = (b: Buffer) => b.toString("base64");
    return app.inject({
      method: "POST",
      url: `/milestones/${milestoneId}/submit`,
      headers: auth(freelancerU.token),
      payload: {
        note: "done",
        deliverableBase64: b64(deliverable),
        screenRecordingBase64: b64(Buffer.from("fake-recording")),
        processFilesBase64: [b64(Buffer.from("process-file-1")), b64(Buffer.from("psd-layers"))]
      }
    });
  }

  it("enforces proof-of-work on submission (spec §5)", async () => {
    await app.inject({
      method: "POST",
      url: `/milestones/${m1Id}/start`,
      headers: auth(freelancerU.token)
    });
    const missingRecording = await app.inject({
      method: "POST",
      url: `/milestones/${m1Id}/submit`,
      headers: auth(freelancerU.token),
      payload: {
        deliverableBase64: Buffer.from("d").toString("base64"),
        processFilesBase64: [Buffer.from("p").toString("base64")]
      }
    });
    expect(missingRecording.statusCode).toBe(400);

    const missingProcess = await app.inject({
      method: "POST",
      url: `/milestones/${m1Id}/submit`,
      headers: auth(freelancerU.token),
      payload: {
        deliverableBase64: Buffer.from("d").toString("base64"),
        screenRecordingBase64: Buffer.from("r").toString("base64")
      }
    });
    expect(missingProcess.statusCode).toBe(400);
  });

  it("m1: submits cleanly, client approves full, split pays 98% net", async () => {
    const sub = await submitMilestone(m1Id);
    expect(sub.statusCode).toBe(201);
    expect(sub.json().aiStatus).toBe("clean");
    expect(sub.json().reviewDeadline).toBeTruthy();

    const approve = await app.inject({
      method: "POST",
      url: `/milestones/${m1Id}/approve`,
      headers: auth(clientU.token),
      payload: { approvedBps: 10000 }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().split.freelancer).toBe("980000000");
    expect(approve.json().split.platformFee).toBe("20000000");
    expect(approve.json().split.clientRefund).toBe("0");

    const { db: getDbHandle } = await import("../src/db/driver.js");
    const db = getDbHandle();
    const { milestones } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [m] = await db.select().from(milestones).where(eq(milestones.id, m1Id));
    expect(m!.status).toBe("approved");
    expect(m!.approvedBps).toBe(10000);
  });

  it("m2: gates the deliverable behind watermarked preview until approval", async () => {
    await app.inject({
      method: "POST",
      url: `/milestones/${m2Id}/start`,
      headers: auth(freelancerU.token)
    });
    const original = Buffer.from(`secret-final-art-${Date.now()}`);
    const sub = await submitMilestone(m2Id, { deliverable: original });
    expect(sub.statusCode).toBe(201);
    const submissionId = sub.json().submission.id;
    const fileIdRow = await app.inject({
      method: "GET",
      url: `/milestones/${m2Id}`,
      headers: auth(clientU.token)
    });
    const files = fileIdRow.json().submissions[0].files as Array<{
      id: string;
      kind: string;
    }>;
    const deliverableFile = files.find((f) => f.kind === "deliverable")!;
    expect(deliverableFile).toBeTruthy();

    // client, pre-approval -> watermarked preview, NOT the original bytes
    const locked = await app.inject({
      method: "GET",
      url: `/files/${deliverableFile.id}/content`,
      headers: auth(clientU.token)
    });
    expect(locked.headers["x-variant"]).toBe("watermarked_preview");
    expect(locked.headers["x-access-unlocked"]).toBe("false");
    expect(locked.body).not.toEqual(original.toString());

    // freelancer always sees original
    const own = await app.inject({
      method: "GET",
      url: `/files/${deliverableFile.id}/content`,
      headers: auth(freelancerU.token)
    });
    expect(own.headers["x-variant"]).toBe("original");
    expect(own.body).toEqual(original.toString());
    expect(own.headers["x-file-hash"]).toBe(createHash("sha256").update(original).digest("hex"));

    void submissionId;
  });

  it("m2: partial approval (70%) refunds remainder and unlocks files", async () => {
    const approve = await app.inject({
      method: "POST",
      url: `/milestones/${m2Id}/approve`,
      headers: auth(clientU.token),
      payload: { approvedBps: 7000 }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().split.freelancer).toBe("1372000000");
    expect(approve.json().split.platformFee).toBe("28000000");
    expect(approve.json().split.clientRefund).toBe("600000000");

    const detail = await app.inject({
      method: "GET",
      url: `/milestones/${m2Id}`,
      headers: auth(clientU.token)
    });
    const f = detail.json().submissions[0].files.find(
      (x: any) => x.kind === "deliverable"
    );
    const unlocked = await app.inject({
      method: "GET",
      url: `/files/${f.id}/content`,
      headers: auth(clientU.token)
    });
    expect(unlocked.headers["x-access-unlocked"]).toBe("true");
  });

  it("freelancer can dispute the partial remainder; jurors resolve 2-1", async () => {
    const d = await app.inject({
      method: "POST",
      url: "/disputes",
      headers: auth(freelancerU.token),
      payload: {
        milestoneId: m2Id,
        type: "partial_amount",
        reason: "70% undervalues delivered scope"
      }
    });
    expect(d.statusCode).toBe(201);
    const disputeId = d.json().disputeId;

    const detail = await app.inject({
      method: "GET",
      url: `/disputes/${disputeId}`,
      headers: auth(admin.token)
    });
    expect(detail.json().dispute.amountStake).toBe("600000000"); // refunded remainder
    expect(detail.json().dispute.status).toBe("evidence");
    expect(detail.json().dispute.jurorCount).toBe(5); // 600e6 falls in band 2

    const assigned = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/assign-jurors`,
      headers: auth(admin.token)
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assigned).toHaveLength(5);

    const votes = ["freelancer", "freelancer", "client", "freelancer", "client"];
    const salts = ["salt-juror-1", "salt-juror-2", "salt-juror-3", "salt-juror-4", "salt-juror-5"];
    const jurorAccounts = JUROR_KEYS.map((k) => privateKeyToAccount(k));

    const { expectedCommit } = await import("../src/services/disputes.js");
    for (let i = 0; i < 5; i++) {
      const t = await login(app, JUROR_KEYS[i]!);
      const c = await app.inject({
        method: "POST",
        url: `/disputes/${disputeId}/vote/commit`,
        headers: auth(t.token),
        payload: { commitHash: expectedCommit(disputeId, votes[i] as any, salts[i]!) }
      });
      expect(c.statusCode).toBe(200);
    }

    // cannot reveal during commit phase
    const earlyReveal = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/vote/reveal`,
      headers: auth(await login(app, JUROR_KEYS[0]!).then((t) => t.token)),
      payload: { vote: votes[0], salt: salts[0] }
    }).then((r) => r.statusCode);
    expect(earlyReveal).toBe(409);

    const advanced = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/advance`,
      headers: auth(admin.token)
    });
    expect(advanced.json().status).toBe("reveal");

    for (let i = 0; i < 5; i++) {
      const t = await login(app, JUROR_KEYS[i]!);
      const r = await app.inject({
        method: "POST",
        url: `/disputes/${disputeId}/vote/reveal`,
        headers: auth(t.token),
        payload: { vote: votes[i], salt: salts[i] }
      });
      expect(r.statusCode).toBe(200);
    }

    // wrong salt must fail commitment check
    const badSalt = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/vote/reveal`,
      headers: auth(await login(app, JUROR_KEYS[0]!).then((t) => t.token)),
      payload: { vote: votes[0], salt: "wrong-salt-99" }
    });
    expect([400, 409]).toContain(badSalt.statusCode);

    const resolved = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/advance`,
      headers: auth(admin.token)
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().resolution).toBe("freelancer");
    expect(resolved.json().tally).toEqual({ outcome: "freelancer", freelancerVotes: 3, clientVotes: 2 });

    // payout on staked remainder 600e6: fee 2% -> 12e6, freelancer 588e6
    const { db: getDbHandle } = await import("../src/db/driver.js");
    const db = getDbHandle();
    const { ledgerEntries, users } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(ledgerEntries);
    const ref = rows.filter((r) => r.ref === `dispute:${disputeId}`);
    const sum = (kind: string) =>
      ref.filter((r) => r.kind === kind).reduce((a, r) => a + BigInt(r.amount), 0n);
    expect(sum("release_freelancer")).toBe(588000000n);
    expect(sum("platform_fee")).toBe(12000000n);
    // juror pool = 50% of fee = 6e6, split between 3 majority jurors
    expect(sum("juror_reward")).toBe(6000000n);

    const winners = await Promise.all(jurorAccounts.map(async (a) => {
      const [u] = await db.select().from(users).where(eq(users.address, a.address.toLowerCase()));
      return u!;
    }));
    const stakes = winners.map((u) => u.jurorStake);
    expect(stakes).toContain("2000000"); // 6e6 pool / 3 winners
    expect(stakes.filter((s) => s === "2000000")).toHaveLength(3);
    const slashed = winners.filter((u) => u.jurorStatus === "slashed");
    expect(slashed).toHaveLength(2);
  });

  it("auto-releases funds after the review timeout (spec §3)", async () => {
    // fresh project so state is isolated
    const proj = await app.inject({
      method: "POST",
      url: "/projects",
      headers: auth(clientU.token),
      payload: {
        freelancerAddress: freelancerU.address,
        title: "Timeout case",
        tokenAddress: MOCK_TOKEN,
        milestones: [{ title: "Quick task", amount: "500000000" }]
      }
    });
    const pid = proj.json().project.id;
    const mid = proj.json().milestones[0].id;
    await app.inject({ method: "POST", url: `/projects/${pid}/fund`, headers: auth(clientU.token) });
    await app.inject({ method: "POST", url: `/milestones/${mid}/start`, headers: auth(freelancerU.token) });
    await submitMilestone(mid);

    // keeper call before deadline must be rejected
    const early = await app.inject({
      method: "POST",
      url: `/milestones/${mid}/auto-release`,
      headers: auth(admin.token)
    });
    expect(early.statusCode).toBe(409);

    // backdate the review deadline (simulates time passing)
    const { db: getDbHandle } = await import("../src/db/driver.js");
    const db = getDbHandle();
    const { milestones } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db
      .update(milestones)
      .set({ reviewDeadline: new Date(Date.now() - 60_000) })
      .where(eq(milestones.id, mid));

    const rel = await app.inject({
      method: "POST",
      url: `/milestones/${mid}/auto-release`,
      headers: auth(admin.token)
    });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().releasedToFreelancer).toBe("490000000"); // 500 - 2%
  });
});
