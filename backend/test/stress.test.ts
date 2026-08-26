import { describe, it, expect, beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

const key = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
const ADMIN_KEY = key(1);
const MOCK_TOKEN = "0x00000000000000000000000000000000deadbeef";

async function login(app: FastifyInstance, pk: string): Promise<{ token: string; address: string }> {
  const acct = privateKeyToAccount(pk as `0x${string}`);
  const ch = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    payload: { address: acct.address }
  });
  const { message } = ch.json();
  const sig = await acct.signMessage({ message });
  const v = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: acct.address, signature: sig }
  });
  return { token: v.json().token, address: acct.address.toLowerCase() };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function b64(b: Buffer) { return b.toString("base64"); }

async function createProject(
  clientToken: string,
  freelancerAddr: string,
  opts: { title?: string; amounts?: string[] } = {}
) {
  const amounts = opts.amounts ?? ["100000000"];
  const res = await app.inject({
    method: "POST",
    url: "/projects",
    headers: auth(clientToken),
    payload: {
      freelancerAddress: freelancerAddr,
      title: opts.title ?? `Project ${Date.now()}`,
      tokenAddress: MOCK_TOKEN,
      milestones: amounts.map((a, i) => ({ title: `M${i}`, amount: a }))
    }
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function fundProject(clientToken: string, projectId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/projects/${projectId}/fund`,
    headers: auth(clientToken)
  });
  return res;
}

async function submitMilestone(
  freelancerToken: string,
  milestoneId: string
) {
  return app.inject({
    method: "POST",
    url: `/milestones/${milestoneId}/submit`,
    headers: auth(freelancerToken),
    payload: {
      deliverableBase64: b64(Buffer.from(`deliverable-${milestoneId}-${Date.now()}`)),
      screenRecordingBase64: b64(Buffer.from("recording")),
      processFilesBase64: [b64(Buffer.from("process-1"))]
    }
  });
}

beforeAll(async () => {
  const { buildApp } = await import("../src/server.js");
  app = await buildApp();
});

// ── 1. Auth flood ──────────────────────────────────────────────
describe("stress: auth flood", () => {
  it("handles 50 concurrent challenge/verify cycles", async () => {
    const CONCURRENCY = 50;
    const users = Array.from({ length: CONCURRENCY }, (_, i) => key(100 + i));

    const results = await Promise.allSettled(
      users.map(async (pk) => {
        const acct = privateKeyToAccount(pk);
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
        expect(v.json().token).toBeTruthy();
        return v.json().token;
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBe(CONCURRENCY);
  });
});

// ── 2. Concurrent project creation ─────────────────────────────
describe("stress: concurrent project creation", () => {
  it("creates 20 projects in parallel without collisions", async () => {
    const CONCURRENCY = 20;
    const clients = Array.from({ length: CONCURRENCY }, (_, i) => key(200 + i));
    const freelancers = Array.from({ length: CONCURRENCY }, (_, i) => key(300 + i));

    const logins = await Promise.all([
      ...clients.map((k) => login(app, k)),
      ...freelancers.map((k) => login(app, k))
    ]);
    const clientLogins = logins.slice(0, CONCURRENCY);
    const freelancerLogins = logins.slice(CONCURRENCY);

    const results = await Promise.allSettled(
      clientLogins.map(async (c, i) => {
        return createProject(c.token, freelancerLogins[i].address, {
          title: `Stress project ${i}`
        });
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(succeeded.length).toBe(CONCURRENCY);

    // verify all projects exist — each client sees their own project
    const listChecks = await Promise.all(
      clientLogins.map((c) =>
        app.inject({
          method: "GET",
          url: "/projects",
          headers: auth(c.token)
        })
      )
    );
    const totalProjects = listChecks.reduce(
      (sum, r) => sum + r.json().projects.length, 0
    );
    expect(totalProjects).toBe(CONCURRENCY);
  });
});

// ── 3. Concurrent milestone submissions ────────────────────────
describe("stress: concurrent milestone submissions", () => {
  it("submits 15 milestones simultaneously on the same project", async () => {
    const CONCURRENCY = 15;
    const clientLogin = await login(app, key(400));
    const freelancerLogin = await login(app, key(401));

    const amounts = Array.from({ length: CONCURRENCY }, () => "100000000");
    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Concurrent submission test",
      amounts
    });
    const msIds = project.milestones.map((m: any) => m.id);

    await fundProject(clientLogin.token, project.project.id);

    // start all
    await Promise.all(
      msIds.map((id: string) =>
        app.inject({
          method: "POST",
          url: `/milestones/${id}/start`,
          headers: auth(freelancerLogin.token)
        })
      )
    );

    // submit all concurrently
    const submissions = await Promise.allSettled(
      msIds.map((id: string) => submitMilestone(freelancerLogin.token, id))
    );

    const succeeded = submissions.filter((r) => r.status === "fulfilled" && r.value.statusCode === 201);
    expect(succeeded.length).toBe(CONCURRENCY);

    // approve all concurrently
    const approvals = await Promise.allSettled(
      msIds.map((id: string) =>
        app.inject({
          method: "POST",
          url: `/milestones/${id}/approve`,
          headers: auth(clientLogin.token),
          payload: { approvedBps: 10000 }
        })
      )
    );

    const approved = approvals.filter((r) => r.status === "fulfilled" && r.value.statusCode === 200);
    expect(approved.length).toBe(CONCURRENCY);
  });
});

// ── 4. Race condition: double-fund ─────────────────────────────
describe("stress: race conditions", () => {
  it("rejects double-fund on same project", async () => {
    const clientLogin = await login(app, key(500));
    const freelancerLogin = await login(app, key(501));

    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Double-fund race"
    });
    const pid = project.project.id;

    // fire 10 fund requests concurrently
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => fundProject(clientLogin.token, pid))
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 200
    );
    const conflicts = results.filter(
      (r) => r.status === "fulfilled" && (r.value.statusCode === 409 || r.value.statusCode === 400)
    );

    // exactly one must succeed, rest must fail
    expect(succeeded.length).toBe(1);
    expect(conflicts.length).toBe(9);
  });

  it("rejects double-submit on same milestone", async () => {
    const clientLogin = await login(app, key(510));
    const freelancerLogin = await login(app, key(511));

    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Double-submit race"
    });
    const pid = project.project.id;
    const mid = project.milestones[0].id;

    await fundProject(clientLogin.token, pid);
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: auth(freelancerLogin.token)
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: "POST",
          url: `/milestones/${mid}/submit`,
          headers: auth(freelancerLogin.token),
          payload: {
            note: `attempt-${i}`,
            deliverableBase64: b64(Buffer.from(`deliverable-${i}`)),
            screenRecordingBase64: b64(Buffer.from("recording")),
            processFilesBase64: [b64(Buffer.from("process"))]
          }
        })
      )
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 201
    );
    // only first submit should succeed; subsequent ones hit "submitted" status
    expect(succeeded.length).toBe(1);
  });

  it("rejects double-approve on same milestone", async () => {
    const clientLogin = await login(app, key(520));
    const freelancerLogin = await login(app, key(521));

    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Double-approve race"
    });
    const pid = project.project.id;
    const mid = project.milestones[0].id;

    await fundProject(clientLogin.token, pid);
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: auth(freelancerLogin.token)
    });
    await submitMilestone(freelancerLogin.token, mid);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: `/milestones/${mid}/approve`,
          headers: auth(clientLogin.token),
          payload: { approvedBps: 10000 }
        })
      )
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 200
    );
    expect(succeeded.length).toBe(1);
  });
});

// ── 5. File upload stress ──────────────────────────────────────
describe("stress: file upload", () => {
  it("uploads and retrieves 30 files concurrently", async () => {
    const CONCURRENCY = 30;
    const clientLogin = await login(app, key(600));
    const freelancerLogin = await login(app, key(601));

    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "File stress test"
    });
    const mid = project.milestones[0].id;

    await fundProject(clientLogin.token, project.project.id);
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: auth(freelancerLogin.token)
    });

    // upload 30 files via JSON base64
    const uploads = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/files/upload",
          headers: auth(freelancerLogin.token),
          payload: {
            name: `file-${i}.bin`,
            mime: "application/octet-stream",
            contentBase64: b64(Buffer.alloc(1024, i)) // 1KB each
          }
        })
      )
    );

    const succeeded = uploads.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 201
    );
    expect(succeeded.length).toBe(CONCURRENCY);

    // retrieve all concurrently
    const fileIds = succeeded.map((r) => r.value.json().id);
    const retrieves = await Promise.allSettled(
      fileIds.map((id: string) =>
        app.inject({
          method: "GET",
          url: `/files/${id}/meta`,
          headers: auth(freelancerLogin.token)
        })
      )
    );

    const retrieved = retrieves.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 200
    );
    expect(retrieved.length).toBe(CONCURRENCY);
  });

  it("handles large file upload (5MB)", async () => {
    const clientLogin = await login(app, key(610));
    const freelancerLogin = await login(app, key(611));

    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Large file test"
    });
    const mid = project.milestones[0].id;

    await fundProject(clientLogin.token, project.project.id);
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: auth(freelancerLogin.token)
    });

    const large = Buffer.alloc(5 * 1024 * 1024, 0xab); // 5MB
    const res = await app.inject({
      method: "POST",
      url: "/files/upload",
      headers: auth(freelancerLogin.token),
      payload: {
        name: "large-deliverable.bin",
        mime: "application/octet-stream",
        contentBase64: b64(large)
      }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sizeBytes).toBe(String(5 * 1024 * 1024));

    // retrieve and verify
    const content = await app.inject({
      method: "GET",
      url: `/files/${res.json().id}/content`,
      headers: auth(freelancerLogin.token)
    });
    expect(content.statusCode).toBe(200);
    expect(content.body.length).toBe(5 * 1024 * 1024);
  });
});

// ── 6. Dispute juror flood ─────────────────────────────────────
describe("stress: dispute juror flood", () => {
  it("5 jurors commit+reveal concurrently without deadlocks", async () => {
    const JUROR_COUNT = 5;
    const jurorKeys = Array.from({ length: JUROR_COUNT }, (_, i) => key(700 + i));
    const clientLogin = await login(app, key(800));
    const freelancerLogin = await login(app, key(801));
    const adminLogin = await login(app, ADMIN_KEY);

    // approve jurors
    const jurorLogins = await Promise.all(jurorKeys.map((k) => login(app, k)));
    await Promise.all(
      jurorLogins.map((j) =>
        app.inject({
          method: "POST",
          url: `/admin/jurors/${j.address}/approve`,
          headers: auth(adminLogin.token)
        })
      )
    );

    // create, fund, submit — use 1200M so refunded remainder (600M at 50%) gets 5 jurors (band 2)
    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Dispute flood test",
      amounts: ["1200000000"]
    });
    const mid = project.milestones[0].id;

    await fundProject(clientLogin.token, project.project.id);
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/start`,
      headers: auth(freelancerLogin.token)
    });
    await submitMilestone(freelancerLogin.token, mid);

    // partial approval (BPS=5000 = 50%) to allow dispute
    await app.inject({
      method: "POST",
      url: `/milestones/${mid}/approve`,
      headers: auth(clientLogin.token),
      payload: { approvedBps: 5000 }
    });

    // create dispute on the partial remainder
    const disRes = await app.inject({
      method: "POST",
      url: "/disputes",
      headers: auth(freelancerLogin.token),
      payload: { milestoneId: mid, type: "partial_amount", reason: "stress test" }
    });
    expect(disRes.statusCode).toBe(201);
    const disputeId = disRes.json().disputeId;

    // assign jurors
    const assignRes = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/assign-jurors`,
      headers: auth(adminLogin.token)
    });
    expect(assignRes.statusCode).toBe(200);

    const { expectedCommit } = await import("../src/services/disputes.js");
    const votes = ["freelancer", "client", "freelancer", "client", "freelancer"];
    const salts = jurorKeys.map((_, i) => `salt-flood-${i}`);

    // concurrent commits
    const commits = await Promise.allSettled(
      jurorLogins.map((j, i) =>
        app.inject({
          method: "POST",
          url: `/disputes/${disputeId}/vote/commit`,
          headers: auth(j.token),
          payload: { commitHash: expectedCommit(disputeId, votes[i] as any, salts[i]) }
        })
      )
    );
    expect(commits.filter((r) => r.status === "fulfilled" && r.value.statusCode === 200).length).toBe(JUROR_COUNT);

    // advance to reveal
    const adv1 = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/advance`,
      headers: auth(adminLogin.token)
    });
    expect(adv1.json().status).toBe("reveal");

    // concurrent reveals
    const reveals = await Promise.allSettled(
      jurorLogins.map((j, i) =>
        app.inject({
          method: "POST",
          url: `/disputes/${disputeId}/vote/reveal`,
          headers: auth(j.token),
          payload: { vote: votes[i], salt: salts[i] }
        })
      )
    );
    expect(reveals.filter((r) => r.status === "fulfilled" && r.value.statusCode === 200).length).toBe(JUROR_COUNT);

    // resolve
    const resolved = await app.inject({
      method: "POST",
      url: `/disputes/${disputeId}/advance`,
      headers: auth(adminLogin.token)
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().resolution).toBe("freelancer"); // 3 freelancer vs 2 client
  });
});

// ── 7. Mixed workload (realistic) ──────────────────────────────
describe("stress: mixed workload", () => {
  it("handles 10 concurrent full lifecycles (create→fund→submit→approve)", async () => {
    const CONCURRENCY = 10;
    const pairs = Array.from({ length: CONCURRENCY }, (_, i) => ({
      client: key(900 + i * 2),
      freelancer: key(900 + i * 2 + 1)
    }));

    const allLogins = await Promise.all(
      pairs.flatMap((p) => [login(app, p.client), login(app, p.freelancer)])
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, async (_, i) => {
        const clientL = allLogins[i * 2];
        const freelancerL = allLogins[i * 2 + 1];

        // create
        const project = await createProject(clientL.token, freelancerL.address, {
          title: `Lifecycle ${i}`
        });
        const mid = project.milestones[0].id;

        // fund
        const fundRes = await fundProject(clientL.token, project.project.id);
        expect(fundRes.statusCode).toBe(200);

        // start
        await app.inject({
          method: "POST",
          url: `/milestones/${mid}/start`,
          headers: auth(freelancerL.token)
        });

        // submit
        const subRes = await submitMilestone(freelancerL.token, mid);
        expect(subRes.statusCode).toBe(201);

        // approve
        const approveRes = await app.inject({
          method: "POST",
          url: `/milestones/${mid}/approve`,
          headers: auth(clientL.token),
          payload: { approvedBps: 10000 }
        });
        expect(approveRes.statusCode).toBe(200);

        return { projectId: project.project.id, milestoneId: mid };
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBe(CONCURRENCY);
  });
});

// ── 8. API endpoint flood ──────────────────────────────────────
describe("stress: endpoint flood", () => {
  it("GET /healthz 100x concurrently", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        app.inject({ method: "GET", url: "/healthz" })
      )
    );
    expect(results.every((r) => r.status === "fulfilled" && r.value.statusCode === 200)).toBe(true);
  });

  it("GET /projects 50x concurrently for same user", async () => {
    const clientLogin = await login(app, key(999));
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        app.inject({
          method: "GET",
          url: "/projects",
          headers: auth(clientLogin.token)
        })
      )
    );
    expect(results.every((r) => r.status === "fulfilled" && r.value.statusCode === 200)).toBe(true);
  });

  it("concurrent admin user listing", async () => {
    const adminLogin = await login(app, ADMIN_KEY);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: "GET",
          url: "/admin/users",
          headers: auth(adminLogin.token)
        })
      )
    );
    expect(results.every((r) => r.status === "fulfilled" && r.value.statusCode === 200)).toBe(true);
  });
});

// ── 9. Memory / state leak check ───────────────────────────────
describe("stress: state leak checks", () => {
  it("100 sequential logins produce 100 unique users", async () => {
    const users = await Promise.all(
      Array.from({ length: 100 }, (_, i) => login(app, key(1000 + i)))
    );
    const addresses = new Set(users.map((u) => u.address));
    expect(addresses.size).toBe(100);

    const adminLogin = await login(app, ADMIN_KEY);
    const listRes = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: auth(adminLogin.token)
    });
    expect(listRes.json().users.length).toBeGreaterThanOrEqual(100);
  });

  it("ledger balances stay consistent under concurrent approvals", async () => {
    const clientLogin = await login(app, key(1100));
    const freelancerLogin = await login(app, key(1101));

    const amounts = Array.from({ length: 5 }, () => "100000000");
    const project = await createProject(clientLogin.token, freelancerLogin.address, {
      title: "Ledger consistency",
      amounts
    });
    const pid = project.project.id;
    const msIds = project.milestones.map((m: any) => m.id);

    await fundProject(clientLogin.token, pid);

    // start + submit all
    for (const mid of msIds) {
      await app.inject({ method: "POST", url: `/milestones/${mid}/start`, headers: auth(freelancerLogin.token) });
      await submitMilestone(freelancerLogin.token, mid);
    }

    // approve all concurrently with varying BPS
    const bpsValues = [10000, 7000, 5000, 3000, 10000];
    const approvals = await Promise.allSettled(
      msIds.map((mid: string, i: number) =>
        app.inject({
          method: "POST",
          url: `/milestones/${mid}/approve`,
          headers: auth(clientLogin.token),
          payload: { approvedBps: bpsValues[i] }
        })
      )
    );

    // count how many succeeded
    const approvedCount = approvals.filter(
      (r) => r.status === "fulfilled" && r.value.statusCode === 200
    ).length;

    // verify ledger invariants for this project's milestones only
    const { db: getDbHandle } = await import("../src/db/driver.js");
    const db = getDbHandle();
    const { ledgerEntries } = await import("../src/db/schema.js");
    const rows = await db.select().from(ledgerEntries);

    // filter to only this test's milestones
    const msIdSet = new Set(msIds);
    const relevantRows = rows.filter((r) => msIdSet.has(r.milestoneId));

    const totalLocked = relevantRows
      .filter((r) => r.kind === "lock")
      .reduce((a, r) => a + BigInt(r.amount), 0n);
    const totalReleased = relevantRows
      .filter((r) => r.kind === "release_freelancer")
      .reduce((a, r) => a + BigInt(r.amount), 0n);
    const totalFee = relevantRows
      .filter((r) => r.kind === "platform_fee")
      .reduce((a, r) => a + BigInt(r.amount), 0n);
    const totalRefund = relevantRows
      .filter((r) => r.kind === "refund_client")
      .reduce((a, r) => a + BigInt(r.amount), 0n);

    // conservation: released + fee + refund == locked
    expect(totalReleased + totalFee + totalRefund).toBe(totalLocked);
    expect(totalLocked).toBe(500000000n); // 5 × 100M
    // fee should be 2% of released+fee
    const expectedFee = (totalReleased * 200n) / 9800n;
    expect(totalFee).toBe(expectedFee);
  });
});
