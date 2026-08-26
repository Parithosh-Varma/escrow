/* Escrow frontend — vanilla JS, no build step. Served by the API at /. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const TOKEN_KEY = "escrow_token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let me = null;
let health = null;

const DECIMALS = 6; // seeded tokens are USDC-style
function fmt(amount) {
  try {
    const v = BigInt(amount);
    const whole = v / 10n ** BigInt(DECIMALS);
    const frac = String(v % 10n ** BigInt(DECIMALS)).padStart(DECIMALS, "0").slice(0, 2);
    return `${whole}.${frac}`;
  } catch { return amount; }
}
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.message || data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------------------------------------------------------------- auth

async function connect() {
  if (!window.ethereum) return devLogin();
  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const { message } = await api("/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: addr })
    });
    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [message, addr]
    });
    await completeLogin(addr, signature);
  } catch (e) {
    toast(e.message, true);
  }
}

/** Dev fallback: no wallet extension needed. Signs EIP-191 personal_sign
 *  in-page with @noble/curves from CDN. Keys never leave the browser. */
async function devLogin(err) {
  view.innerHTML = `
    <section class="card">
      <h2>Dev sign-in <span class="badge">no wallet detected</span></h2>
      ${err ? `<p class="small" style="color:var(--red)">${esc(err)}</p>` : ""}
      <p class="muted small">
        Paste any 32-byte test private key, or just mint a throwaway identity.
        Dev-only — the key signs the challenge locally and is not stored.
      </p>
      <label>Private key (64 hex chars, optional)</label>
      <input id="dev-key" class="mono" autocomplete="off" spellcheck="false"
             placeholder="0x… (leave blank to generate below)"/>
      <div class="actions">
        <button class="btn primary" id="dev-go">Sign in</button>
        <button class="btn" id="dev-gen">Generate &amp; sign in</button>
        <button class="btn" id="demo-client">Demo client</button>
        <button class="btn" id="demo-freelancer">Demo freelancer</button>
      </div>
    </section>`;
  $("#dev-gen").onclick = () => doDevLogin(true).catch(show);
  $("#dev-go").onclick = () => doDevLogin(false).catch(show);
  $("#demo-client").onclick = () => doDevLogin(false, "11".repeat(32)).catch(show);
  $("#demo-freelancer").onclick = () => doDevLogin(false, "22".repeat(32)).catch(show);
  function show(e) {
    const msg = String(e?.message || e);
    devLogin(msg.includes("Failed to fetch") || msg.includes("importing")
      ? "could not load crypto libs from CDN — check network"
      : msg);
  }
}

function randHex32() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0")).join("");
}

async function doDevLogin(forceGenerate, fixedHex) {
  const raw = ($("#dev-key")?.value ?? "").trim();
  let hex;
  if (fixedHex) {
    hex = fixedHex; // one-click demo identities (matches scripts/seed-demo.ts)
  } else if (forceGenerate || !raw) {
    hex = randHex32();
  } else {
    const cleaned = raw.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
      throw new Error(`private key must be 64 hex chars (or leave blank to generate); got ${cleaned.length} chars`);
    }
    hex = cleaned.toLowerCase();
  }

  const [{ secp256k1 }, { keccak_256 }] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@noble/curves@1.5.0/secp256k1/+esm"),
    import("https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/sha3/+esm")
  ]);
  const priv = new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));  const pubU = secp256k1.getPublicKey(priv, false);
  const addrBytes = keccak_256(pubU.subarray(1)).subarray(12);
  const addr = "0x" + Array.from(addrBytes, (x) => x.toString(16).padStart(2, "0")).join("");

  const { message } = await api("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address: addr })
  });
  const m = new TextEncoder().encode(message);
  const p = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const buf = new Uint8Array(p.length + m.length);
  buf.set(p); buf.set(m, p.length);
  const sig = secp256k1.sign(keccak_256(buf), priv);
  const signature = "0x" +
    sig.r.toString(16).padStart(64, "0") +
    sig.s.toString(16).padStart(64, "0") +
    (27 + sig.recovery).toString(16).padStart(2, "0");
  await completeLogin(addr.toLowerCase(), signature);
}

async function completeLogin(address, signature) {
  const { token: t, user } = await api("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature })
  });
  token = t;
  me = user;
  localStorage.setItem(TOKEN_KEY, t);
  toast(`Signed in as ${short(user.address)}${user.isAdmin ? " (admin)" : ""}`);
  route();
}

function logout() {
  token = ""; me = null; localStorage.removeItem(TOKEN_KEY);
  $("#connect-btn").textContent = "Connect wallet";
  location.hash = "#/";
  route();
}

// ---------------------------------------------------------------- views

async function listProjects() {
  if (!me) { view.innerHTML = `<section class="card center">Connect a wallet to begin.</section>`; return; }
  view.innerHTML = `<section class="card"><h2>Projects</h2><p class="muted small">loading…</p></section>`;
  const { projects } = await api("/projects");
  const withMs = await Promise.all(projects.map(async (p) => ({
    p, ms: (await api(`/projects/${p.id}`)).milestones
  })));

  const LIVE = ["funded", "in_progress", "submitted", "disputed"];
  let escrow = 0n, active = 0, done = 0, disputed = 0;
  for (const { ms } of withMs) {
    for (const m of ms) {
      if (LIVE.includes(m.status)) { active++; escrow += BigInt(m.amount); }
      else if (["closed", "auto_released", "resolved"].includes(m.status)) done++;
      if (m.status === "disputed") disputed++;
    }
    for (const m of ms) {
      if (m.status === "approved" && m.remainderAmount && m.remainderAmount !== "0")
        escrow += BigInt(m.remainderAmount);
    }
  }

  const rows = withMs.map(({ p }) => `
    <tr class="clickable" onclick="location.hash='#/project/${p.id}'">
      <td><b>${esc(p.title.replace(/^Demo: /, ""))}</b><div class="muted small">${esc(p.description || "")}</div></td>
      <td>${p.clientId === me.id ? `<span class="badge">you are client</span>` : `<span class="badge approved">you are freelancer</span>`}</td>
      <td class="mono">${fmt(p.totalAmount)}</td>
      <td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td>
    </tr>`).join("");

  view.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="stat-n">${withMs.length}</div><div class="muted small">projects</div></div>
      <div class="stat"><div class="stat-n">${active}</div><div class="muted small">active</div></div>
      <div class="stat"><div class="stat-n">${done}</div><div class="muted small">completed</div></div>
      <div class="stat"><div class="stat-n">${disputed}</div><div class="muted small">disputed</div></div>
      <div class="stat"><div class="stat-n mono">${fmt(escrow.toString())}</div><div class="muted small">in escrow</div></div>
    </div>
    <section class="card">
      <div class="split">
        <h1>Your projects</h1>
        <div style="text-align:right"><a href="#/new"><button class="btn primary">+ New project</button></a></div>
      </div>
      ${projects.length === 0 ? `<p class="muted">No projects yet — create one or ask a client to hire you.</p>`
      : `<table><thead><tr><th>Project</th><th>Role</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`}
    </section>`;
}

function newProjectForm() {
  if (!me) return toast("Connect first", true);
  const msRow = () => `
    <div class="row ms-row">
      <input placeholder="Milestone title" class="ms-title"/>
      <input placeholder="Amount (base units, e.g. 100000000 = 100)" class="ms-amount mono"/>
      <button class="btn small danger" onclick="this.closest('.ms-row').remove()">✕</button>
    </div>
    <textarea placeholder="Spec (optional)" class="ms-spec"></textarea>`;
  view.innerHTML = `
    <section class="card">
      <h1>New project</h1>
      <form id="np-form">
        <label>Title</label><input id="np-title" required maxlength="200"/>
        <label>Description</label><textarea id="np-desc"></textarea>
        <div class="row">
          <div><label>Freelancer address</label><input id="np-freelancer" class="mono" required pattern="^0x[0-9a-fA-F]{40}$"/></div>
          <div><label>Token</label>
            <select id="np-token">
              <option value="0x036cbd53842c5c666ee88463fdec4af79ca7f2eb">USDC (Base Sepolia)</option>
              <option value="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913">USDC (Base mainnet)</option>
            </select>
          </div>
        </div>
        <h2>Milestones</h2>
        <div id="ms-list">${msRow()}</div>
        <div class="actions">
          <button type="button" class="btn" id="add-ms">+ Add milestone</button>
          <button type="submit" class="btn primary">Create project</button>
        </div>
      </form>
    </section>`;
  $("#add-ms").onclick = () => {
    const div = document.createElement("div");
    div.innerHTML = msRow();
    $("#ms-list").append(...div.childNodes);
  };
  $("#np-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const milestones = [...document.querySelectorAll(".ms-row")].map((r, i) => ({
        title: $(".ms-title", r).value.trim(),
        spec: $(".ms-spec", r)?.value?.trim() || "",
        amount: $(".ms-amount", r).value.trim()
      }));
      if (!milestones.length) throw new Error("at least one milestone required");
      const res = await api("/projects", {
        method: "POST",
        body: JSON.stringify({
          freelancerAddress: $("#np-freelancer").value.trim(),
          title: $("#np-title").value.trim(),
          description: $("#np-desc").value.trim(),
          tokenAddress: $("#np-token").value,
          milestones
        })
      });
      toast("Project created");
      location.hash = `#/project/${res.project.id}`;
    } catch (err) { toast(err.message, true); }
  };
}

async function projectDetail(id) {
  view.innerHTML = `<section class="card center"><p class="muted small">loading…</p></section>`;
  const { project: p, milestones: ms } = await api(`/projects/${id}`);
  const role = p.clientId === me.id ? "client" : "freelancer";

  const fundBtn = role === "client" && p.status === "created"
    ? `<button class="btn primary" data-fund="${p.id}">Fund escrow (${fmt(p.totalAmount)})</button>` : "";

  const rows = ms.map((m) => milestoneRow(m, role)).join("");
  view.innerHTML = `
    <section class="card">
      <a href="#/" class="muted small">← all projects</a>
      <div class="split">
        <div>
          <h1>${esc(p.title)}</h1>
          <p class="muted">${esc(p.description || "")}</p>
          <p class="small">
            <span class="badge ${esc(p.status)}">${esc(p.status)}</span>&nbsp;
            total <b class="mono">${fmt(p.totalAmount)}</b>
          </p>
        </div>
        <div class="actions" style="justify-content:flex-end">${fundBtn}</div>
      </div>
    </section>
    <section class="card">
      <h2>Milestones</h2>
      ${rows}
    </section>`;

  const fb = $("[data-fund]");
  if (fb) fb.onclick = () => action(() => api(`/projects/${fb.dataset.fund}/fund`, { method: "POST" }), "Escrow funded");

  bindMilestoneActions();
}

function milestoneRow(m, role) {
  const deadline = m.reviewDeadline ? new Date(m.reviewDeadline) : null;
  const overdue = deadline && deadline.getTime() < Date.now();

  const actions = [];
  if (role === "freelancer" && m.status === "funded")
    actions.push(`<button class="btn small primary" data-start="${m.id}">Start work</button>`);

  if (role === "freelancer" && m.status === "in_progress")
    actions.push(`<button class="btn small primary" data-submit="${m.id}">Submit deliverable</button>`);

  if (role === "client" && m.status === "submitted") {
    actions.push(`
      <span>approve
        <input class="inline-input mono" id="bps-${m.id}" value="10000" title="basis points (10000 = full)"/>
        %&nbsp;</span>
      <button class="btn small primary" data-approve="${m.id}">Approve</button>`);
  }
  if (m.status === "submitted" && overdue)
    actions.push(`<button class="btn small" data-auto="${m.id}" title="deadline passed">Auto-release</button>`);

  actions.push(`<button class="btn small danger" data-dispute="${m.id}">Dispute</button>`);

  return `
    <div class="card" style="background:var(--panel-2)">
      <div class="split">
        <div>
          <b>#${m.idx + 1} ${esc(m.title)}</b>
          ${m.spec ? `<div class="muted small">${esc(m.spec)}</div>` : ""}
          <div class="muted small mono">amount ${fmt(m.amount)} · bps ${m.approvedBps ?? "–"}
            ${deadline ? ` · review until ${deadline.toLocaleString()}${overdue ? " (passed)" : ""}` : ""}
          </div>
          ${m.remainderAmount && m.remainderAmount !== "0"
            ? `<div class="small" style="color:var(--amber)">remainder held: ${fmt(m.remainderAmount)}
               ${m.challengeDeadline ? `· claimable after ${new Date(m.challengeDeadline).toLocaleString()}` : ""}</div>` : ""}
          ${role === "freelancer" && m.status === "in_progress" ? submitFormHtml(m.id) : ""}
          <div class="actions">${actions.join("")}</div>
        </div>
        <div style="text-align:right"><span class="badge ${esc(m.status)}">${esc(m.status)}</span></div>
      </div>
    </div>`;
}

let openSubmitId = null;
function submitFormHtml(id) {
  if (openSubmitId !== id) return "";
  return `
    <form class="submit-form" data-for="${id}">
      <label>Note (optional)</label><input name="note"/>
      <label>Deliverable file</label><input type="file" name="deliverable" required/>
      <label>Screen recording</label><input type="file" name="screen_recording" required accept="video/*"/>
      <label>Process files (multi)</label><input type="file" name="process_file" multiple required/>
      <div class="actions"><button class="btn small primary" type="submit">Upload & submit</button></div>
    </form>`;
}

function bindMilestoneActions() {
  document.querySelectorAll("[data-start]").forEach(b => b.onclick = () =>
    action(() => api(`/milestones/${b.dataset.start}/start`, { method: "POST" }), "Work started"));

  document.querySelectorAll("[data-submit]").forEach(b => b.onclick = () => {
    openSubmitId = openSubmitId === b.dataset.submit ? null : b.dataset.submit;
    route();
  });

  document.querySelectorAll(".submit-form").forEach(f => f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    openSubmitId = null;
    try {
      await api(`/milestones/${f.dataset.for}/submit`, { method: "POST", body: fd });
      toast("Submitted — review clock started");
      route();
    } catch (err) {
      openSubmitId = f.dataset.for;
      toast(err.message, true);
    }
  });

  document.querySelectorAll("[data-approve]").forEach(b => b.onclick = () => {
    const id = b.dataset.approve;
    const bps = Number($(`#bps-${id}`).value || 10000);
    action(
      () => api(`/milestones/${id}/approve`, { method: "POST", body: JSON.stringify({ approvedBps: bps }) }),
      bps < 10000 ? "Partially approved — remainder enters challenge window" : "Fully approved"
    );
  });

  document.querySelectorAll("[data-auto]").forEach(b => b.onclick = () =>
    action(() => api(`/milestones/${b.dataset.auto}/auto-release`, { method: "POST" }), "Auto-released"));

  document.querySelectorAll("[data-dispute]").forEach(b => b.onclick = () => openDisputeDialog(b.dataset.dispute));
}

function openDisputeDialog(milestoneId) {
  const type = prompt("Dispute type:\nquality | scope | cancellation | ai_flag | partial_amount", "quality");
  if (!type) return;
  const reason = prompt("Reason (visible to jurors):", "") ?? "";
  action(
    () => api("/disputes", { method: "POST", body: JSON.stringify({ milestoneId, type, reason }) }),
    "Dispute opened"
  );
}

async function action(fn, okMsg, skipReload = false) {
  try {
    await fn();
    toast(okMsg);
    if (!skipReload) route();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- router

async function route() {
  $("#connect-btn").textContent = me ? `${short(me.address)} · logout` : "Connect wallet";
  const hash = location.hash || "#/";

  if (!token) { view.innerHTML = `<section class="card center">Connect a wallet to begin.</section>`; return; }
  if (!me) {
    try { me = (await api("/me")).user; }
    catch { logout(); return; }
  }

  try {
    if (hash.startsWith("#/project/")) await projectDetail(hash.split("/")[2]);
    else if (hash === "#/new") newProjectForm();
    else await listProjects();
  } catch (e) {
    view.innerHTML = `<section class="card center">⚠ ${esc(e.message)}</section>`;
  }
}

$("#connect-btn").onclick = async () => {
  if (me) logout(); else connect();
};
window.addEventListener("hashchange", route);

(async function init() {
  try {
    health = await fetch("/healthz").then(r => r.json());
    const chip = $("#chain-mode");
    chip.textContent = `chain: ${health.chainMode}`;
    chip.classList.toggle("live", health.chainMode === "live");
  } catch { /* header stays bare */ }
  if (token) {
    try { me = (await api("/me")).user; }
    catch { token = ""; localStorage.removeItem(TOKEN_KEY); }
  }
  route();
})();
