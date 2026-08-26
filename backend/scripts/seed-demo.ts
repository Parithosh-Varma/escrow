/**
 * Demo-data seeder. Run with the dev server UP:
 *   npm run seed
 * Logs in as fixed demo identities through the real API (so every status is
 * state-machine-valid), then does light SQL surgery for things only the
 * chain/indexer would normally set (challenge windows, overdue deadlines).
 * Re-runnable: wipes previous "Demo:*" projects first.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const B = process.env.SEED_URL ?? "http://localhost:3000";
const CLIENT_KEY = "0x" + "11".repeat(32);
const FREELANCER_KEY = "0x" + "22".repeat(32);
const STRANGER_KEY = "0x" + "44".repeat(32);

// ---- minimal .env loader (mirrors src/config.ts precedence rules) ----------
function envUrl(): string {
  const raw = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  let out = process.env.DATABASE_URL ?? "";
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(DATABASE_URL)\s*=\s*"?(.*?)"?\s*$/);
    if (!m) continue;
    if (!(m[1] in process.env)) out = m[2];
  }
  if (!out) throw new Error("DATABASE_URL empty — point .env at Supabase first");
  return out;
}

async function j(pathname: string, opts: any = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(B + pathname, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname}: ${data.message || data.error || res.status}`);
  return data;
}

async function login(pk: string) {
  const acct = (await import("viem/accounts")).privateKeyToAccount(pk as any);
  const { message } = await j("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address: acct.address })
  });
  const signature = await acct.signMessage({ message });
  const { token } = await j("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: acct.address, signature })
  });
  return { token, address: acct.address.toLowerCase() };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function files(note: string) {
  const fd = new FormData();
  fd.append("note", note);
  fd.append("deliverable", new Blob([new Uint8Array(2048).fill(7)], { type: "application/pdf" }), "demo-deliverable.pdf");
  fd.append("screen_recording", new Blob([new Uint8Array(1024).fill(9)], { type: "video/mp4" }), "demo-recording.mp4");
  fd.append("process_file", new Blob([new Uint8Array(512).fill(1)]), "demo-process-a.fig");
  fd.append("process_file", new Blob([new Uint8Array(512).fill(2)]), "demo-process-b.psd");
  return fd;
}

async function main() {
  const health = await fetch(B + "/healthz").then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`dev server not reachable at ${B} — run \`npm run dev\` first`);

  const sql = postgres(envUrl(), { ssl: "require", prepare: false, max: 1 });

  const clientU = await login(CLIENT_KEY);
  const freelancerU = await login(FREELANCER_KEY);
  await login(STRANGER_KEY); // exists as a wallet for realism

  // wipe previous demo content (children cascade)
  await sql`DELETE FROM files WHERE owner_id IN (SELECT id FROM users WHERE address IN (${clientU.address}, ${freelancerU.address}))`;
  await sql`DELETE FROM projects WHERE title LIKE 'Demo:%'`;
  console.log("· cleared previous demo rows");

  const H = bearer(clientU.token);
  const F = bearer(freelancerU.token);
  const TOKEN = "0x036cbd53842c5c666ee88463fdec4af79ca7f2eb"; // USDC Base Sepolia
  const mk = (title: string, amount: string, spec = "") => ({ title, spec, amount });

  async function createProject(title: string, description: string, ms: Array<{ title: string; spec?: string; amount: string }>) {
    const r = await j("/projects", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        freelancerAddress: freelancerU.address,
        title: `Demo: ${title}`,
        description,
        tokenAddress: TOKEN,
        milestones: ms.map((m) => ({ title: m.title, spec: m.spec || "", amount: m.amount }))
      })
    });
    console.log(`· project "${title}" (${r.milestones.length} milestones)`);
    return r;
  }

  // 1 ── awaiting funding -----------------------------------------------------
  await createProject("Brand refresh", "Full identity overhaul for the Q4 launch.", [
    mk("Logo exploration", "800000000", "Three directions, unlimited rounds within scope."),
    mk("Brand book", "600000000")
  ]);

  // 2 ── work in progress ------------------------------------------------------
  const p2 = await createProject("Mobile app MVP", "React Native MVP, two screens + auth.", [
    mk("Auth + onboarding", "150000000"),
    mk("Core screens", "450000000"),
    mk("Polish + handoff", "200000000")
  ]);
  await j(`/projects/${p2.project.id}/fund`, { method: "POST", headers: H });
  await j(`/milestones/${p2.milestones[0].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p2.milestones[1].id}/start`, { method: "POST", headers: F });

  // 3 ── awaiting review -------------------------------------------------------
  const p3 = await createProject("Landing page rebuild", "Marketing site on Next.js.", [
    mk("Design system", "500000000", "Figma tokens + Tailwind theme."),
    mk("Build + deploy", "900000000")
  ]);
  await j(`/projects/${p3.project.id}/fund`, { method: "POST", headers: H });
  await j(`/milestones/${p3.milestones[0].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p3.milestones[0].id}/submit`, { method: "POST", headers: F, body: files("v1 — tokens, components, sample page") });
  await j(`/milestones/${p3.milestones[1].id}/start`, { method: "POST", headers: F });

  // 4 ── partial approval with challenge window ---------------------------------
  const p4 = await createProject("Data pipeline v2", "Ingest + warehouse migration.", [
    mk("Ingestion layer", "1000000000"),
    mk("Warehouse models", "700000000")
  ]);
  await j(`/projects/${p4.project.id}/fund`, { method: "POST", headers: H });
  await j(`/milestones/${p4.milestones[0].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p4.milestones[0].id}/submit`, { method: "POST", headers: F, body: files("airflow DAGs + docs") });
  await j(`/milestones/${p4.milestones[0].id}/approve`, { method: "POST", headers: H, body: JSON.stringify({ approvedBps: 7000 }) });
  await j(`/milestones/${p4.milestones[1].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p4.milestones[1].id}/submit`, { method: "POST", headers: F, body: files("dbt models v1") });
  await j(`/milestones/${p4.milestones[1].id}/approve`, { method: "POST", headers: H, body: JSON.stringify({ approvedBps: 10000 }) });

  // 5 ── disputed ----------------------------------------------------------------
  const p5 = await createProject("Logo suite", "Wordmark + marks for sub-brands.", [
    mk("Concepts", "400000000"),
    mk("Final files", "350000000")
  ]);
  await j(`/projects/${p5.project.id}/fund`, { method: "POST", headers: H });
  await j(`/milestones/${p5.milestones[0].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p5.milestones[0].id}/submit`, { method: "POST", headers: F, body: files("three concepts attached") });
  await j("/disputes", {
    method: "POST",
    headers: F,
    body: JSON.stringify({ milestoneId: p5.milestones[0].id, type: "quality", reason: "Deliverable misses agreed direction B; opening for juror review." })
  });

  // 6 ── history: auto-released + fully paid ------------------------------------
  const p6 = await createProject("SEO audit", "Technical + content audit.", [
    mk("Technical crawl", "250000000"),
    mk("Content plan", "300000000")
  ]);
  await j(`/projects/${p6.project.id}/fund`, { method: "POST", headers: H });
  await j(`/milestones/${p6.milestones[0].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p6.milestones[0].id}/submit`, { method: "POST", headers: F, body: files("crawl report") });
  await j(`/milestones/${p6.milestones[1].id}/start`, { method: "POST", headers: F });
  await j(`/milestones/${p6.milestones[1].id}/submit`, { method: "POST", headers: F, body: files("content calendar") });
  await j(`/milestones/${p6.milestones[0].id}/approve`, { method: "POST", headers: H, body: JSON.stringify({ approvedBps: 10000 }) });

  // ---- surgery: things only the chain would normally produce ------------------
  // Overdue review clock → auto-release button becomes available.
  await sql`UPDATE milestones SET review_deadline = now() - interval '3 hours'
            WHERE project_id IN (
              SELECT id FROM projects WHERE title = 'Demo: Logo suite'
            ) AND idx = 0`;
  await sql`UPDATE milestones SET review_deadline = now() - interval '3 hours',
              submitted_at = now() - interval '9 days'
            WHERE project_id = (SELECT id FROM projects WHERE title = 'Demo: SEO audit') AND idx = 1`;
  // Now the keeper path applies: freelancer (or anyone) triggers auto-release.
  await j(`/milestones/${p6.milestones[1].id}/auto-release`, { method: "POST", headers: F });
  // Partial approval remainder mirror (indexer would set this from RemainderHeld).
  await sql`UPDATE milestones SET remainder_amount = '300000000',
              challenge_deadline = now() + interval '5 days'
            WHERE project_id = (SELECT id FROM projects WHERE title = 'Demo: Data pipeline v2') AND idx = 0`;
  // Age the finished project a bit.
  await sql`UPDATE projects SET created_at = now() - interval '21 days'
            WHERE title = 'Demo: SEO audit'`;

  await sql.end();

  const cnt = await fetch(B + "/projects", { headers: H }).then((r) => r.json());
  console.log(`\n✓ seeded — demo client (${clientU.address.slice(0, 10)}…) now has ${cnt.projects.length} projects`);
  console.log("  log in via the 'Demo client' / 'Demo freelancer' buttons on the dev sign-in card.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
