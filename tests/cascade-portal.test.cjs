// Perspective: employees submitting work and inspecting exact candidate evidence.
// Invariant: only trusted identities write their permitted records; versioned
// requests, dispatch contracts and sealed artifact bytes cannot silently change.
// Goal: reject spoofed writes, stale dispatch, wrong commits and corrupt evidence
// while proving the successful HTTP/Git/SQLite workflow survives a restart.
// Migration: retain these boundary tests if the portal UI or storage code changes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { authFixture, PASSWORD } = require("./fixtures/portal-auth.cjs");
const { settleFirstExec } = require("./fixtures/first-exec.cjs");
const { startPortal } = require("../scripts/cascade-portal.cjs");
const { createStore } = require("../scripts/cascade-portal/store.cjs");

const PROXY = "fixture-proxy-secret-not-a-real-credential-0001";
const AGENT = "fixture-center-secret-not-a-real-credential-0002";
const BASE = "a".repeat(40), DELIVERY = "b".repeat(40), CENTER_DELIVERY = "c".repeat(40);
// Keys are explicitly in canonical order; no production serializer is used to
// derive the expected proposal or artifact digest.
const PROPOSAL = {
  acceptance: ["A teammate can download the exact candidate."], baseSha: BASE,
  dependencies: ["upstream"], goal: "Expose reviewed candidate evidence.",
  nonGoals: ["Do not merge or execute a game."], requiredTier: "pro",
  scope: ["The result page and its evidence endpoint."], title: "Candidate evidence",
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PROPOSAL_HASH = sha256(JSON.stringify(PROPOSAL));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

function graph() {
  return { epoch: 0, lamport: 0, nodes: {
    "project-root": { id: "project-root", state: "COMPLETED" },
    upstream: { id: "upstream", state: "COMPLETED" },
    delivered: { id: "delivered", state: "COMPLETED", context: {
      provenance: { git_ref: BASE }, critical: { worker: { publication_verified: true, commit: DELIVERY } },
    } },
    "center-delivered": { id: "center-delivered", state: "COMPLETED", context: {
      critical: { publication_verified: true, final_sha: CENTER_DELIVERY, readback_sha: CENTER_DELIVERY },
    } },
    "producer-only": { id: "producer-only", state: "COMPLETED", context: { provenance: { git_ref: BASE } } },
    unverified: { id: "unverified", state: "COMPLETED", context: { critical: { worker: { publication_verified: false, commit: DELIVERY } } } },
    "wrong-readback": { id: "wrong-readback", state: "COMPLETED", context: {
      critical: { publication_verified: true, final_sha: CENTER_DELIVERY, readback_sha: BASE },
    } },
    unfinished: { id: "unfinished", state: "READY", context: { critical: { worker: { publication_verified: true, commit: DELIVERY } } } },
  }, edges: [] };
}

async function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-portal-test-"));
  const remote = path.join(root, "remote.git"), writer = path.join(root, "writer"), dataDir = path.join(root, "portal");
  let portal;
  t.after(async () => { try { if (portal) await portal.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  const git = (args, cwd = writer) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init", "--bare", "--quiet", remote], root);
  fs.mkdirSync(writer); git(["init", "--quiet"]);
  git(["config", "user.name", "Portal test"]); git(["config", "user.email", "portal@example.invalid"]);
  fs.mkdirSync(path.join(writer, "data"));
  // This fixture writes a retained snapshot to a real bare Git repository. It
  // tests the portal's readback, not native Cascade mutation/hashchain semantics.
  const commit = value => {
    fs.writeFileSync(path.join(writer, "data/graph.json"), typeof value === "string" ? value : JSON.stringify(value));
    fs.writeFileSync(path.join(writer, "data/events.jsonl"), "");
    git(["add", "--all"]); git(["commit", "--quiet", "--allow-empty", "-m", "portal snapshot"]);
    git(["push", "--quiet", remote, "HEAD:refs/heads/cascade-state/test"]);
    return git(["rev-parse", "HEAD"]);
  };
  commit(graph());
  const options = { remote, namespace: "test", project: "Fixture team", rootTask: "project-root", dataDir,
    proxySecret: PROXY, agentToken: AGENT, localDevelopment: true, port: 0, refreshMs: 60000, ...authFixture(root), ...extra };
  const logins = new Map();
  const start = async () => { logins.clear(); portal = await startPortal(options); return portal; };
  const stop = async () => { const current = portal; portal = null; if (current) await current.close(); };
  await start();
  const rawCall = (route, { method = "GET", role = "alice", json, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const bytes = json === undefined ? body : Buffer.from(JSON.stringify(json));
    const outgoing = { "x-cascade-proxy": PROXY };
    if (role === "agent") outgoing.authorization = `Bearer ${AGENT}`;
    if (method !== "GET" && role !== "agent") outgoing.origin = portal.url;
    if (json !== undefined) outgoing["content-type"] = "application/json";
    if (bytes !== undefined) outgoing["content-length"] = bytes.length;
    Object.assign(outgoing, headers);
    for (const key of Object.keys(outgoing)) if (outgoing[key] === null) delete outgoing[key];
    // Malformed length fixtures must not poison a reused HTTP parser connection.
    const request = http.request(portal.url + route, { method, headers: outgoing, agent: false }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => {
        const buffer = Buffer.concat(chunks), result = { status: response.statusCode, headers: response.headers, bytes: buffer };
        if ((response.headers["content-type"] || "").startsWith("application/json")) {
          try { result.body = JSON.parse(buffer.toString()); } catch (error) { reject(error); return; }
        }
        resolve(result);
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("Fixture HTTP request exceeded 15 seconds")));
    request.on("error", error => reject(new Error(`${method} ${route}: ${error.message}`, { cause: error }))); request.end(bytes);
  });
  const call = async (route, options = {}) => {
    const role = options.role === undefined ? "alice" : options.role;
    if (["alice", "bob"].includes(role)) {
      if (!logins.has(role)) logins.set(role, rawCall("/api/auth/login", { method: "POST", role: null, json: { username: role, password: PASSWORD } }).then(result => {
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return { cookie: result.headers["set-cookie"][0].split(";")[0], "x-cascade-csrf": result.body.csrfToken };
      }));
      return rawCall(route, { ...options, headers: { ...await logins.get(role), ...options.headers } });
    }
    return rawCall(route, options);
  };
  const post = (route, json, role = "alice") => call(route, { method: "POST", role, json });
  const dbRead = sql => {
    const db = new DatabaseSync(path.join(dataDir, "portal.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
  };
  return { root, dataDir, options, commit, start, stop, call, rawCall, post, dbRead,
    refs: () => git(["ls-remote", remote]), get portal() { return portal; } };
}

async function planned(f) {
  const created = await f.post("/api/requests", { description: "Please expose reviewed evidence.", idempotencyKey: "plan-request" });
  assert.equal(created.status, 201);
  const result = await f.post(`/api/agent/requests/${created.body.id}`, { version: 1, action: "plan", proposal: PROPOSAL }, "agent");
  assert.equal(result.status, 200); assert.equal(result.body.version, 2);
  return result.body;
}

async function candidate(f, taskId = "delivered", sha = DELIVERY) {
  const result = await f.post("/api/agent/candidates", { taskId, sha, title: "Review this build", summary: "Fixed candidate; not game acceptance." }, "agent");
  assert.equal(result.status, 201); return result.body;
}
const upload = (f, id, name, bytes) => f.call(`/api/agent/candidates/${id}/artifacts?name=${encodeURIComponent(name)}`, { method: "POST", role: "agent", body: bytes });
async function rejectsStartup(options, pattern) {
  let unexpected;
  try { await assert.rejects(async () => { unexpected = await startPortal(options); }, pattern); }
  finally { if (unexpected) await unexpected.close(); }
}

test("trusted proxy, employee ownership boundary, center credential and Origin are independently required", { timeout: 30000 }, async t => {
  const f = await fixture(t), refs = f.refs();
  const good = await f.call("/api/portal");
  assert.equal(good.status, 200); assert.equal(good.body.user, "alice");
  assert.match(good.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(good.headers["cache-control"], "no-store");
  assert.equal(good.headers["access-control-allow-origin"], undefined);
  for (const headers of [{ "x-cascade-proxy": null }, { "x-cascade-proxy": "wrong" }, { host: "evil.invalid" },
    { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await f.call("/api/portal", { headers })).status, 403);
  }
  assert.equal((await f.call("/api/portal", { role: null })).status, 401);
  assert.equal((await f.call("/api/portal", { role: "agent" })).status, 401, "center bearer does not create an employee identity");
  assert.equal((await f.call("/api/portal", { role: "bad user" })).status, 401);
  assert.equal((await f.call("/api/agent/queue")).status, 401);
  assert.equal((await f.call("/api/agent/queue", { role: "agent", headers: { authorization: `Bearer ${PROXY}` } })).status, 401);
  assert.equal((await f.call("/api/agent/queue", { role: "agent" })).status, 200);
  const data = { description: "A request", idempotencyKey: "auth" };
  for (const origin of [null, "https://evil.invalid"]) {
    assert.equal((await f.call("/api/requests", { method: "POST", json: data, headers: { origin } })).status, 403);
  }
  assert.equal((await f.call("/api/requests", { method: "POST", body: Buffer.from("{}"), headers: { "content-type": "text/plain" } })).status, 415);
  for (const body of [Buffer.from("{"), Buffer.from("[]"), Buffer.from("null")]) {
    assert.equal((await f.call("/api/requests", { method: "POST", body, headers: { "content-type": "application/json" } })).status, 400);
  }
  assert.equal((await f.post("/api/requests", { ...data, author: "bob" })).status, 400);
  assert.equal((await f.post("/api/requests", { ...data, description: "x".repeat(131073) })).status, 413);
  for (const route of ["/", "/portal.js", "/portal.css", "/flow", "/app.js", "/style.css", "/layout.js", "/vendor/dagre-3.1.1.esm.js"]) assert.equal((await f.call(route)).status, 200);
  assert.equal((await f.call("/.git/config")).status, 404);
  assert.deepEqual(f.dbRead("SELECT id FROM requests"), []);
  assert.equal(f.refs(), refs, "portal endpoints never mutate fixture coordination refs");
});

test("request idempotency, owner checks and competing versions persist atomically across restart", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const input = { description: "Preserve my request.", idempotencyKey: "one-request" };
  const first = await f.post("/api/requests", input), repeat = await f.post("/api/requests", input);
  assert.equal(first.status, 201); assert.deepEqual(repeat.body, first.body);
  assert.equal(first.body.author, "alice"); assert.equal(first.body.version, 1);
  assert.equal((await f.post("/api/requests", { ...input, description: "Different content" })).status, 409);
  const bob = await f.post("/api/requests", input, "bob");
  assert.equal(bob.status, 201); assert.notEqual(bob.body.id, first.body.id);
  const id = first.body.id, replyRoute = `/api/requests/${id}/reply`, agentRoute = `/api/agent/requests/${id}`;
  assert.equal((await f.post(replyRoute, { version: 1, body: "Spoofed reply" }, "bob")).status, 403);
  assert.equal((await f.post(agentRoute, { version: 1, action: "reject", body: "Not an employee operation" })).status, 401);
  assert.equal((await f.post(agentRoute, { version: 1, action: "question", body: "Which candidate?" }, "agent")).status, 200);
  assert.equal((await f.post(replyRoute, { version: 1, body: "Old reply" })).status, 409);
  const results = await Promise.all([
    f.post(replyRoute, { version: 2, body: "Use the reviewed branch." }),
    f.post(replyRoute, { version: 2, body: "Use the candidate branch." }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.post(agentRoute, { version: 3, action: "plan", proposal: PROPOSAL }, "agent")).status, 200);
  assert.equal((await f.post(replyRoute, { version: 4, body: "Clarify before dispatch." })).status, 200);
  const saved = (await f.call(agentRoute, { role: "agent" })).body;
  assert.equal(saved.version, 5); assert.equal(saved.state, "received"); assert.equal(saved.messages.length, 3);
  assert.equal(saved.messages[0].body, "Which candidate?"); assert.equal(saved.messages[1].author, "alice");
  assert.equal(saved.proposal, null);
  assert.equal((await f.post(agentRoute, { version: 4, action: "plan", proposal: PROPOSAL }, "agent")).status, 409);
  assert.equal(f.dbRead(`SELECT id FROM audit WHERE subject='${id}'`).length, 5, "failed writes leave no audit or conversation fragments");
  await f.stop(); await f.start();
  assert.deepEqual((await f.call(agentRoute, { role: "agent" })).body, saved);
  assert.deepEqual((await f.post("/api/requests", input)).body, saved, "same submission key remains idempotent after restart");
  const shared = (await f.call("/api/portal", { role: "bob" })).body;
  assert.equal(shared.requests.length, 2, "this single-project contract explicitly shares read visibility");
  assert.equal(f.dbRead("PRAGMA integrity_check")[0].integrity_check, "ok");
  assert.equal(f.dbRead("PRAGMA journal_mode")[0].journal_mode, "wal");
});

test("proposal validation rejects coercions, credentials and unsupported fields without advancing the request", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const created = (await f.post("/api/requests", { description: "Validate contract", idempotencyKey: "validation" })).body;
  const route = `/api/agent/requests/${created.id}`;
  for (const patch of [{ baseSha: [BASE] }, { dependencies: [null] }, { dependencies: [["upstream"]] },
    { dependencies: ["upstream", "upstream"] }, { requiredTier: "tiny" }, { scope: [] },
    { goal: "Unpaired high surrogate: \ud800" }, { goal: "Unpaired low surrogate: \udfff" },
    { goal: "Read https://fixture:fake-password@example.invalid/private" }, { execute: "a command" }]) {
    assert.equal((await f.post(route, { version: 1, action: "plan", proposal: { ...PROPOSAL, ...patch } }, "agent")).status, 400);
    assert.deepEqual((await f.call(route, { role: "agent" })).body, created);
  }
  assert.equal(f.dbRead("SELECT id FROM audit").length, 1);
  const validUnicode = { ...PROPOSAL, goal: "Keep a valid paired emoji 🪷 in the proposal." };
  const good = await f.post(route, { version: 1, action: "plan", proposal: validUnicode }, "agent");
  assert.equal(good.status, 200); assert.deepEqual(good.body.proposal, validUnicode);
});

test("dispatch acknowledges only exact fresh Git contracts, tiers, reservation and dependency set", { timeout: 60000 }, async t => {
  const f = await fixture(t), draft = await planned(f), route = `/api/agent/requests/${draft.id}`;
  assert.equal((await f.post(route, { version: 1, action: "prepare" }, "agent")).status, 409);
  const prepared = await f.post(route, { version: 2, action: "prepare" }, "agent");
  assert.equal(prepared.status, 200); assert.equal(prepared.body.state, "dispatching"); assert.equal(prepared.body.version, 3);
  const request = prepared.body;
  assert.equal((await f.post(`/api/requests/${request.id}/reply`, { version: 3, body: "Change while Git publishes" })).status, 409);
  for (const action of ["plan", "question", "reject", "prepare"]) {
    const input = { version: 3, action, ...(action === "plan" ? { proposal: PROPOSAL } : {}),
      ...(["question", "reject"].includes(action) ? { body: "Rewrite during dispatch" } : {}) };
    assert.equal((await f.post(route, input, "agent")).status, 409);
  }
  assert.deepEqual((await f.call(route, { role: "agent" })).body, request);
  const store = createStore(path.join(f.dataDir, "portal.sqlite"));
  try {
    for (const invalid of [{ proposalVersion: 2, proposalSha256: PROPOSAL_HASH },
      { proposalVersion: 3, proposalSha256: "0".repeat(64) }]) {
      assert.throws(() => store.updateRequest(request.id, { version: 3, action: "publish" }, invalid), error => error.status === 409);
      assert.deepEqual(store.getRequest(request.id), request);
    }
  } finally { store.close(); }
  const response = await f.call(`${route}/contract`, { role: "agent" });
  assert.equal(response.status, 200);
  const plan = response.body, id = `portal-${request.id}`, reviewId = `${id}-review`;
  const expectedContract = { requestId: request.id, proposalVersion: 3, proposalSha256: PROPOSAL_HASH, proposal: PROPOSAL };
  assert.deepEqual(plan.contract, expectedContract); assert.deepEqual(plan.taskIds, [id, reviewId]);
  assert.equal(plan.specs.length, 2);
  assert.equal(plan.specs[0].node_id, id); assert.equal(plan.specs[0].required_tier, "pro");
  assert.equal(plan.specs[0].reserved_for, undefined);
  assert.deepEqual(Object.keys(plan.specs[0].deps).sort(), ["project-root", "upstream"]);
  assert.equal(plan.specs[1].node_id, reviewId); assert.equal(plan.specs[1].required_tier, "pro");
  assert.equal(plan.specs[1].reserved_for, "codex-team-center");
  assert.deepEqual(Object.keys(plan.specs[1].deps), [id]);
  for (const spec of plan.specs) for (const edge of Object.values(spec.deps)) {
    assert.ok(edge.expectation.startsWith("portal-contract:"));
    assert.deepEqual(JSON.parse(edge.expectation.slice("portal-contract:".length)), expectedContract);
    assert.equal(typeof edge.promise, "string"); assert.ok(edge.promise.length > 20);
  }
  assert.notEqual(plan.specs[0].deps["project-root"].promise, plan.specs[0].deps.upstream.promise);
  assert.ok(plan.specs[0].deps["project-root"].promise.includes("project-root"));
  assert.ok(plan.specs[0].deps.upstream.promise.includes("upstream"));
  assert.equal(plan.specs[0].deps.upstream.promise,
    "上游 upstream 提供其真实完成证据与批准基线；完整需求合同见 expectation，实施仍须有效租约、范围核对、独立复审和最终 HEAD preflight。");
  assert.equal(plan.specs[1].deps[id].promise,
    "交付精确候选 SHA、可获取结果分支、完整变更、实际测试及独立复审/内容绑定 preflight；不得自审、自动合并或把网页意见当技术门禁。");
  const exact = graph();
  for (const spec of plan.specs) {
    exact.nodes[spec.node_id] = { id: spec.node_id, state: spec.node_id === id ? "READY" : "PENDING", required_tier: spec.required_tier,
      ...(spec.reserved_for ? { reserved_for: spec.reserved_for } : {}) };
    for (const [from, edge] of Object.entries(spec.deps)) exact.edges.push({ from, to: spec.node_id, ...edge });
  }
  assert.equal((await f.post(route, { version: 3, action: "publish" }, "agent")).status, 409, "IDs must actually exist in Git");
  const mutations = [
    g => { g.nodes[id].required_tier = "lite"; },
    g => { g.nodes[reviewId].reserved_for = "different-reviewer"; },
    g => { g.nodes[id].reserved_for = "unexpected-owner"; },
    g => { g.edges[0].expectation = g.edges[0].expectation.replace('"proposalVersion":3', '"proposalVersion":2'); },
    g => { g.edges[0].expectation = g.edges[0].expectation.replace(PROPOSAL_HASH, "0".repeat(64)); },
    g => { g.edges[0].promise += " changed"; },
    g => { g.edges.splice(0, 1); },
    g => { g.edges.push({ from: "producer-only", to: id, expectation: "unapproved extra gate", promise: "extra upstream" }); },
  ];
  for (const mutate of mutations) {
    const wrong = structuredClone(exact); mutate(wrong); f.commit(wrong);
    const refs = f.refs();
    assert.equal((await f.post(route, { version: 3, action: "publish" }, "agent")).status, 409);
    assert.deepEqual((await f.call(route, { role: "agent" })).body, request);
    assert.equal(f.refs(), refs);
  }
  f.commit("{broken");
  assert.equal((await f.post(route, { version: 3, action: "publish" }, "agent")).status, 503, "failed fresh read cannot reuse an older task snapshot");
  assert.deepEqual((await f.call(route, { role: "agent" })).body, request);
  const revision = f.commit(exact), refs = f.refs();
  const published = await f.post(route, { version: 3, action: "publish" }, "agent");
  assert.equal(published.status, 200); assert.equal(published.body.state, "published"); assert.equal(published.body.version, 4);
  assert.deepEqual(published.body.dispatch, { taskIds: [id, reviewId], proposalVersion: 3, proposalSha256: PROPOSAL_HASH, coordinationRevision: revision });
  assert.equal((await f.post(`/api/requests/${request.id}/reply`, { version: 4, body: "Change after publication" })).status, 409);
  assert.equal((await f.call("/api/agent/queue", { role: "agent" })).body.requests.length, 0);
  assert.equal(f.refs(), refs); assert.equal(f.dbRead("SELECT id FROM audit").length, 4);
});

test("candidate registration uses published delivery SHA, never producer provenance or unfinished work", { timeout: 30000 }, async t => {
  const f = await fixture(t), refs = f.refs();
  for (const [taskId, sha] of [["delivered", BASE], ["producer-only", BASE], ["unverified", DELIVERY],
    ["unfinished", DELIVERY], ["wrong-readback", CENTER_DELIVERY], ["missing", DELIVERY]]) {
    assert.equal((await f.post("/api/agent/candidates", { taskId, sha, title: "Candidate", summary: "Must not be registered" }, "agent")).status, 409);
  }
  assert.deepEqual(f.dbRead("SELECT id FROM candidates"), []);
  const first = await candidate(f), again = await candidate(f);
  assert.deepEqual(again, first); assert.equal(first.sha, DELIVERY); assert.notEqual(first.sha, BASE);
  assert.equal((await f.post("/api/agent/candidates", { taskId: "delivered", sha: DELIVERY, title: "Overwrite", summary: "Different" }, "agent")).status, 409);
  assert.equal((await candidate(f, "center-delivered", CENTER_DELIVERY)).sha, CENTER_DELIVERY);
  assert.equal(f.dbRead("SELECT id FROM candidates").length, 2); assert.equal(f.refs(), refs);
});

test("uploads retain exact bytes, reject unsafe names/media and serve literal ranges without accepting corrupt files", { timeout: 30000 }, async t => {
  const f = await fixture(t), c = await candidate(f), files = path.join(f.dataDir, "artifacts");
  assert.equal((await f.post(`/api/agent/candidates/${c.id}/seal`, {}, "agent")).status, 409);
  assert.equal((await f.post(`/api/candidates/${c.id}/reviews`, { verdict: "accepted", body: "Too soon", idempotencyKey: "unsealed" })).status, 409);
  for (const name of ["../outside.txt", "a/b.txt", "a\\b.txt", "line\n.txt"]) assert.equal((await upload(f, c.id, name, PNG)).status, 400);
  assert.equal((await upload(f, c.id, "payload.js", Buffer.from("alert(1)"))).status, 415);
  assert.equal((await upload(f, c.id, "fake.png", Buffer.from("not an image"))).status, 415);
  assert.equal((await upload(f, c.id, "empty.txt", Buffer.alloc(0))).status, 413);
  assert.equal((await f.call(`/api/agent/candidates/${c.id}/artifacts?name=no-length.txt`, {
    method: "POST", role: "agent", body: Buffer.from("body"), headers: { "content-length": null, "transfer-encoding": "chunked" },
  })).status, 413);
  assert.equal((await f.call(`/api/agent/candidates/${c.id}/artifacts?name=huge.txt`, {
    method: "POST", role: "agent", headers: { "content-length": 67108865 },
  })).status, 413);
  assert.deepEqual(fs.readdirSync(files), []); assert.deepEqual(f.dbRead("SELECT id FROM artifacts"), []);
  const uploaded = await upload(f, c.id, "pixel.png", PNG);
  assert.equal(uploaded.status, 201);
  const a = uploaded.body, filename = path.join(files, a.id);
  assert.equal(a.bytes, PNG.length); assert.equal(a.sha256, sha256(PNG)); assert.equal(a.mime, "image/png");
  assert.match(a.id, /^[a-f0-9-]{36}$/); assert.deepEqual(fs.readFileSync(filename), PNG);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600); assert.equal(fs.statSync(files).mode & 0o777, 0o700);
  const full = await f.call(`/artifacts/${a.id}`);
  assert.equal(full.status, 200); assert.deepEqual(full.bytes, PNG); assert.equal(full.headers["content-type"], "image/png");
  assert.match(full.headers["content-disposition"], /^inline;/); assert.equal(full.headers["x-content-type-options"], "nosniff");
  const range = await f.call(`/artifacts/${a.id}`, { headers: { range: "bytes=0-7" } });
  assert.equal(range.status, 206); assert.equal(range.headers["content-range"], `bytes 0-7/${PNG.length}`);
  assert.equal(range.headers["content-length"], "8"); assert.deepEqual(range.bytes, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const suffix = await f.call(`/artifacts/${a.id}`, { headers: { range: "bytes=-4" } });
  assert.equal(suffix.status, 206); assert.deepEqual(suffix.bytes, PNG.subarray(-4));
  const openEnded = await f.call(`/artifacts/${a.id}`, { headers: { range: "bytes=8-" } });
  assert.equal(openEnded.status, 206); assert.deepEqual(openEnded.bytes, PNG.subarray(8));
  for (const value of ["bytes=999-1000", "bytes=4-1", "bytes=-0", "bytes=0-1,4-5", "nonsense"]) {
    assert.equal((await f.call(`/artifacts/${a.id}`, { headers: { range: value } })).status, 416);
  }
  assert.equal((await upload(f, c.id, "pixel.png", PNG)).status, 409);
  assert.deepEqual(fs.readdirSync(files), [a.id]); assert.deepEqual(fs.readFileSync(filename), PNG);
  const corrupted = Buffer.from(PNG); corrupted[20] ^= 1; fs.writeFileSync(filename, corrupted);
  assert.equal((await f.call(`/artifacts/${a.id}`)).status, 503, "same-size corruption must not be served under the recorded digest");
  assert.equal((await f.post(`/api/agent/candidates/${c.id}/seal`, {}, "agent")).status, 503);
  fs.writeFileSync(filename, PNG);
  const saved = path.join(f.root, "symlink-target"); fs.renameSync(filename, saved); fs.symlinkSync(saved, filename);
  assert.equal((await f.call(`/artifacts/${a.id}`)).status, 503);
  assert.equal((await f.post(`/api/agent/candidates/${c.id}/seal`, {}, "agent")).status, 503);
  fs.unlinkSync(filename); fs.renameSync(saved, filename);
  const report = Buffer.from("Actual portal test evidence.\n"), textUpload = await upload(f, c.id, "report.txt", report);
  assert.equal(textUpload.status, 201);
  const download = await f.call(`/artifacts/${textUpload.body.id}`);
  assert.equal(download.status, 200); assert.deepEqual(download.bytes, report);
  assert.equal(download.headers["content-type"], "application/octet-stream"); assert.match(download.headers["content-disposition"], /^attachment;/);
  assert.equal(f.dbRead("SELECT id FROM artifacts").length, 2);
});

test("sealed manifests bind human feedback, forbid later artifacts and persist without changing coordination", { timeout: 30000 }, async t => {
  const f = await fixture(t), c = await candidate(f), refs = f.refs();
  const a = (await upload(f, c.id, "pixel.png", PNG)).body;
  const expectedManifest = sha256(JSON.stringify([{ bytes: PNG.length, id: a.id, mime: "image/png", name: "pixel.png", sha256: sha256(PNG) }]));
  const seal = await f.post(`/api/agent/candidates/${c.id}/seal`, {}, "agent");
  assert.equal(seal.status, 200); assert.equal(seal.body.manifestSha256, expectedManifest);
  assert.deepEqual((await f.post(`/api/agent/candidates/${c.id}/seal`, {}, "agent")).body, seal.body);
  const reviewRoute = `/api/candidates/${c.id}/reviews`;
  const input = { verdict: "accepted", body: "Inspected this screenshot, not a game release.", idempotencyKey: "review-once" };
  const reviewed = await f.post(reviewRoute, input, "bob");
  assert.equal(reviewed.status, 201); assert.equal(reviewed.body.sha, DELIVERY);
  assert.equal(reviewed.body.reviews.length, 1);
  const review = reviewed.body.reviews[0]; assert.equal(review.author, "bob"); assert.equal(review.manifestSha256, expectedManifest);
  assert.deepEqual((await f.post(reviewRoute, input, "bob")).body, reviewed.body);
  assert.equal((await f.post(reviewRoute, { ...input, verdict: "rework" }, "bob")).status, 409);
  const rework = await f.post(reviewRoute, { verdict: "rework", body: "Add the missing reproduction steps.", idempotencyKey: "separate-rework" });
  assert.equal(rework.status, 201); assert.equal(rework.body.reviews.length, 2);
  const reworkRecord = rework.body.reviews.find(item => item.verdict === "rework");
  assert.equal(reworkRecord.author, "alice"); assert.equal(reworkRecord.manifestSha256, expectedManifest);
  assert.equal((await upload(f, c.id, "new-build.zip", Buffer.from("new evidence"))).status, 409);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "artifacts")), [a.id]);
  const queue = (await f.call("/api/agent/queue", { role: "agent" })).body;
  assert.equal(queue.reviews.length, 2);
  assert.deepEqual(queue.reviews.map(item => item.id).sort(), [review.id, reworkRecord.id].sort());
  for (const item of queue.reviews) assert.equal(item.sha, DELIVERY);
  const response = { response: "Recorded screenshot feedback; technical review remains separate." };
  assert.equal((await f.post(`/api/agent/reviews/${review.id}`, response)).status, 401);
  assert.equal((await f.post(`/api/agent/reviews/${review.id}`, response, "agent")).status, 200);
  assert.equal((await f.post(`/api/agent/reviews/${review.id}`, response, "agent")).status, 200);
  assert.equal((await f.post(`/api/agent/reviews/${review.id}`, { response: "Overwrite old processing" }, "agent")).status, 409);
  const remaining = (await f.call("/api/agent/queue", { role: "agent" })).body.reviews;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, reworkRecord.id); assert.equal(remaining[0].verdict, "rework");
  const before = (await f.call("/api/portal")).body.candidates;
  await f.stop(); await f.start();
  assert.deepEqual((await f.call("/api/portal")).body.candidates, before);
  assert.deepEqual((await f.call("/api/agent/queue", { role: "agent" })).body.reviews, remaining);
  const persisted = f.dbRead("SELECT manifest_sha256 FROM reviews");
  assert.deepEqual(persisted, [{ manifest_sha256: expectedManifest }, { manifest_sha256: expectedManifest }]);
  assert.equal(f.refs(), refs, "human acceptance never completes, refines or merges a task");
});

test("restart fails closed on orphaned, missing or changed artifact bytes without deleting evidence", { timeout: 30000 }, async t => {
  const f = await fixture(t), c = await candidate(f);
  const a = (await upload(f, c.id, "pixel.png", PNG)).body, directory = path.join(f.dataDir, "artifacts"), filename = path.join(directory, a.id);
  await f.stop();
  const orphan = path.join(directory, "11111111-2222-4333-8444-555555555555");
  fs.writeFileSync(orphan, "orphaned upload", { mode: 0o600 });
  await assert.rejects(f.start(), /Unregistered artifact files/);
  assert.equal(fs.readFileSync(orphan, "utf8"), "orphaned upload");
  assert.deepEqual(fs.readFileSync(filename), PNG); fs.rmSync(orphan);
  fs.renameSync(filename, path.join(f.root, "saved-artifact"));
  await assert.rejects(f.start(), /missing|ENOENT|缺失|artifact/i);
  fs.renameSync(path.join(f.root, "saved-artifact"), filename);
  const altered = Buffer.from(PNG); altered[20] ^= 1; fs.writeFileSync(filename, altered);
  await assert.rejects(f.start(), /Artifact storage differs/);
  assert.deepEqual(fs.readFileSync(filename), altered, "failed startup preserves evidence for diagnosis");
  fs.writeFileSync(filename, PNG); await f.start();
  assert.deepEqual((await f.call(`/artifacts/${a.id}`)).bytes, PNG);
  assert.equal(f.dbRead("SELECT id FROM artifacts").length, 1);
});

test("production startup refuses missing roots, insecure origins and interchangeable credentials", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const rootTask of [undefined, ["project-root"], "../root"]) await rejectsStartup({ ...f.options, rootTask }, /root task/);
  await rejectsStartup({ ...f.options, proxySecret: AGENT }, /distinct secrets/);
  await rejectsStartup({ ...f.options, agentToken: "short" }, /distinct secrets/);
  for (const publicOrigin of ["http://center.example.invalid", "https://center.example.invalid/path", "https://user:password@center.example.invalid"]) {
    await rejectsStartup({ ...f.options, localDevelopment: false, publicOrigin }, /HTTPS origin/);
  }
});

// Perspective: real browsers owning opaque sessions, not proxy identity headers.
// Invariant: only a verified account/session can read private data or write with
// a bound CSRF token; idle polls, logout, rotation and restart never revive it.
// Goal: prove authentication through actual HTTP, files and htpasswd processes.
// Migration: keep these boundaries when replacing the verifier or session store.
const login = (f, username = "alice", password = PASSWORD, headers = {}) => f.rawCall("/api/auth/login", { method: "POST", role: null, json: { username, password }, headers });
const credentials = result => ({ cookie: result.headers["set-cookie"][0].split(";")[0], "x-cascade-csrf": result.body.csrfToken });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("anonymous pages redirect, login is public, and identity headers or Basic never create sessions", async t => {
  const f = await fixture(t);
  for (const [route, target] of [["/", "/login"], ["/flow", "/login?next=%2Fflow"]]) {
    const result = await f.rawCall(route, { role: null });
    assert.equal(result.status, 303); assert.equal(result.headers.location, target);
  }
  for (const route of ["/login", "/login?next=https://evil.invalid", "/portal.js", "/portal.css"]) assert.equal((await f.rawCall(route, { role: null })).status, 200);
  for (const route of ["/api/portal", "/api/snapshot", "/artifacts/11111111-1111-1111-1111-111111111111", "/app.js", "/style.css", "/layout.js", "/vendor/dagre-3.1.1.esm.js"]) {
    const result = await f.rawCall(route, { headers: { "x-cascade-user": "alice", authorization: `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}` } });
    assert.equal(result.status, 401); assert.equal(result.body.code, "auth_required");
    assert.equal(result.headers["www-authenticate"], undefined);
  }
  assert.equal((await login(f, "alice", PASSWORD, { origin: null })).status, 403);
  assert.equal((await login(f, "alice", PASSWORD, { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await login(f, "alice", PASSWORD, { "sec-fetch-site": "cross-site" })).status, 403);
  const bad = await login(f, "alice", "wrong"), absent = await login(f, "missing", "wrong");
  assert.equal(bad.status, 401); assert.deepEqual(absent.body, bad.body);
  assert.equal(bad.headers["set-cookie"], undefined);
  assert.equal((await login(f)).status, 200);
});

test("session tokens rotate, CSRF binds writes, logout and restart reject cookie replay", async t => {
  const f = await fixture(t), first = await login(f), old = credentials(first);
  assert.match(first.headers["set-cookie"][0], /^cascade_session_dev=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/);
  assert.equal(first.body.user, "alice"); assert.equal(first.body.csrfToken.length, 43);
  const second = await login(f, "alice", PASSWORD, old), fresh = credentials(second);
  assert.notEqual(fresh.cookie, old.cookie); assert.notEqual(fresh["x-cascade-csrf"], old["x-cascade-csrf"]);
  const staleRead = await f.rawCall("/api/portal", { headers: old });
  assert.equal(staleRead.status, 401);
  assert.equal(staleRead.headers["set-cookie"], undefined, "a stale response must not erase a concurrent fresh login cookie");
  const input = { description: "Authenticated real employee write.", idempotencyKey: "session-bound" };
  for (const csrf of [undefined, "wrong", old["x-cascade-csrf"]]) {
    const result = await f.rawCall("/api/requests", { method: "POST", json: input, headers: { cookie: fresh.cookie, ...(csrf ? { "x-cascade-csrf": csrf } : {}) } });
    assert.equal(result.status, 403); assert.equal(result.body.code, "csrf_invalid");
  }
  assert.equal((await f.rawCall("/api/requests", { method: "POST", json: input, headers: fresh })).status, 201);
  assert.equal((await f.rawCall("/api/agent/queue", { headers: fresh })).status, 401);
  assert.equal((await f.rawCall("/api/auth/logout", { method: "POST", json: {}, headers: { cookie: fresh.cookie } })).status, 403);
  const logout = await f.rawCall("/api/auth/logout", { method: "POST", json: {}, headers: fresh });
  assert.equal(logout.status, 200); assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  for (const route of ["/api/auth/session", "/api/portal"]) assert.equal((await f.rawCall(route, { headers: fresh })).status, 401);
  assert.equal((await f.rawCall("/api/auth/activity", { method: "POST", json: {}, headers: fresh })).status, 401);
  const beforeRestart = credentials(await login(f)); await f.stop(); await f.start();
  assert.equal((await f.rawCall("/api/portal", { headers: beforeRestart })).status, 401);
  assert.equal((await f.rawCall("/api/agent/queue", { role: "agent" })).status, 200);
  assert.equal((await f.call("/api/portal")).body.requests.length, 1);
});

test("automatic GET polling never renews idle; authenticated activity cannot exceed absolute expiry", async t => {
  const f = await fixture(t, { authOptions: { idleMs: 250, absoluteMs: 750 } });
  const poller = credentials(await login(f));
  for (let i = 0; i < 4; i++) { await pause(80); await f.rawCall("/api/portal", { headers: poller }); }
  assert.equal((await f.rawCall("/api/auth/session", { headers: poller })).status, 401);
  assert.equal((await f.rawCall("/api/auth/activity", { method: "POST", json: {}, headers: poller })).status, 401);
  const active = credentials(await login(f));
  for (let i = 0; i < 4; i++) {
    await pause(150);
    assert.equal((await f.rawCall("/api/auth/activity", { method: "POST", json: {}, headers: active })).status, 200);
  }
  await pause(180);
  assert.equal((await f.rawCall("/api/auth/activity", { method: "POST", json: {}, headers: active })).status, 401);
});

test("password rotation and account removal revoke at the next auth point, other accounts stay signed in", async t => {
  const f = await fixture(t), alice = credentials(await login(f)), bob = credentials(await login(f, "bob"));
  const original = fs.readFileSync(f.options.usersFile, "utf8");
  const fresh = authFixture(path.join(f.root), ["alice"]);
  const rotated = fs.readFileSync(fresh.usersFile, "utf8");
  fs.writeFileSync(f.options.usersFile, rotated + original.split("\n").filter(line => line.startsWith("bob:")).join("\n") + "\n");
  assert.equal((await f.rawCall("/api/portal", { headers: alice })).status, 401);
  assert.equal((await f.rawCall("/api/portal", { headers: bob })).status, 200);
  fs.writeFileSync(f.options.usersFile, rotated);
  assert.equal((await f.rawCall("/api/portal", { headers: bob })).status, 401);
  const renewed = credentials(await login(f));
  fs.chmodSync(f.options.usersFile, 0o666);
  const invalid = await f.rawCall("/api/portal", { headers: renewed });
  assert.equal(invalid.status, 503); assert.equal(invalid.body.code, "auth_unavailable");
  fs.chmodSync(f.options.usersFile, 0o600);
  fs.writeFileSync(f.options.usersFile, rotated + rotated);
  assert.equal((await login(f)).status, 503);
  fs.rmSync(f.options.usersFile);
  assert.equal((await f.rawCall("/api/portal", { headers: renewed })).status, 503);
  assert.equal((await f.rawCall("/api/agent/queue", { role: "agent" })).status, 200);
});

test("password transport rejects truncation/control bytes and limits guessing without persisting secrets", async t => {
  const f = await fixture(t);
  for (const password of [PASSWORD + "\0suffix", PASSWORD + "\nsuffix", PASSWORD + "\rsuffix", "x".repeat(256), "\ud800"]) {
    assert.equal((await login(f, "alice", password)).status, 400);
  }
  assert.equal((await login(f, "alice", "中".repeat(25))).status, 400, "bcrypt limit counts UTF-8 bytes");
  for (let i = 0; i < 4; i++) assert.equal((await login(f, "alice", "wrong")).status, 401);
  const limited = await login(f); assert.equal(limited.status, 429); assert.equal(limited.body.code, "login_limited");
  assert.equal((await login(f, "bob")).status, 200, "one account must not block another behind the same proxy");
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "auth-private")), [], "temporary verifier snapshots are cleaned");
  const database = fs.readFileSync(path.join(f.dataDir, "portal.sqlite"));
  assert.equal(database.includes(Buffer.from(PASSWORD)), false);
  assert.equal(database.includes(Buffer.from("$2y$")), false);
});

test("a password verified from a fixed snapshot cannot authenticate after the account record changes", async t => {
  const f = await fixture(t); await f.stop();
  const wrapper = path.join(f.root, "delayed-verifier"), marker = path.join(f.root, "verifying");
  // External process fixture delays only employee verification. Capability
  // probes and password checks still execute the real platform htpasswd.
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$3" = alice ]; then touch '${marker}'; sleep 0.2; fi\nexec '${f.options.htpasswdPath}' "$@"\n`, { mode: 0o700 });
  settleFirstExec(wrapper, ["-vi", path.join(f.root, "absent-record"), "probe"]);
  f.options.htpasswdPath = wrapper; await f.start();
  const pending = login(f);
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await pause(10);
  assert(fs.existsSync(marker), "real verifier reached its fixed-snapshot boundary");
  authFixture(f.root);
  const result = await pending;
  assert.equal(result.status, 401); assert.equal(result.headers["set-cookie"], undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "auth-private")), []);
});

test("verifier timeouts hold the four-process capacity until cleanup and then allow recovery", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.stop();
  authFixture(f.root, ["alice", "bob", "carol", "dave", "ellen"]);
  const wrapper = path.join(f.root, "bounded-verifier"), flag = path.join(f.root, "delay");
  fs.writeFileSync(flag, "1");
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$3" != probe ] && [ -f '${flag}' ]; then sleep 10; fi\nexec '${f.options.htpasswdPath}' "$@"\n`, { mode: 0o700 });
  settleFirstExec(wrapper, ["-vi", path.join(f.root, "absent-record"), "probe"]);
  f.options.htpasswdPath = wrapper; f.options.authOptions = { verifierTimeoutSeconds: 1 }; await f.start();
  const pending = ["alice", "bob", "carol", "dave"].map(name => login(f, name));
  for (let i = 0; i < 100 && fs.readdirSync(path.join(f.dataDir, "auth-private")).length < 4; i++) await pause(10);
  assert.equal(fs.readdirSync(path.join(f.dataDir, "auth-private")).length, 4);
  await pause(1200);
  const limited = await login(f, "ellen"); assert.equal(limited.status, 429); assert.equal(limited.body.code, "login_busy");
  for (const result of await Promise.all(pending)) { assert.equal(result.status, 503); assert.equal(result.body.code, "auth_unavailable"); assert.equal(result.headers["set-cookie"], undefined); }
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "auth-private")), []);
  fs.rmSync(flag); assert.equal((await login(f, "ellen")).status, 200);
});

test("startup refuses missing tools, malformed records, symlinks and a verifier that cannot reject wrong passwords", async t => {
  const f = await fixture(t); await f.stop();
  await rejectsStartup({ ...f.options, htpasswdPath: path.join(f.root, "missing-verifier") }, /cannot verify/);
  const alwaysSuccess = path.join(f.root, "invalid-verifier");
  fs.writeFileSync(alwaysSuccess, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await rejectsStartup({ ...f.options, htpasswdPath: alwaysSuccess }, /cannot verify/);
  fs.writeFileSync(f.options.usersFile, "alice:plaintext-is-forbidden\n");
  await rejectsStartup(f.options, /登录服务暂不可用/);
  fs.rmSync(f.options.usersFile); const target = path.join(f.root, "target"); fs.writeFileSync(target, "", { mode: 0o600 }); fs.symlinkSync(target, f.options.usersFile);
  await rejectsStartup(f.options, /登录服务暂不可用/);
});

test("logout while an employee body is still streaming prevents the later write", async t => {
  const f = await fixture(t), headers = credentials(await login(f));
  const bytes = Buffer.from(JSON.stringify({ description: "Must not persist after logout.", idempotencyKey: "streamed-after-logout" }));
  let request;
  const pending = new Promise((resolve, reject) => {
    request = http.request(f.portal.url + "/api/requests", { method: "POST", agent: false, headers: {
      ...headers, "x-cascade-proxy": PROXY, origin: f.portal.url, "content-type": "application/json", "content-length": bytes.length,
    } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); response.on("error", reject); });
    request.setTimeout(5000, () => request.destroy(new Error("Streaming fixture timeout"))); request.on("error", reject);
    request.write(bytes.subarray(0, 1));
  });
  await pause(100);
  assert.equal((await f.rawCall("/api/auth/session", { headers })).status, 200);
  assert.equal((await f.rawCall("/api/auth/logout", { method: "POST", json: {}, headers })).status, 200);
  request.end(bytes.subarray(1));
  assert.equal(await pending, 401); assert.deepEqual(f.dbRead("SELECT id FROM requests"), []);
});
