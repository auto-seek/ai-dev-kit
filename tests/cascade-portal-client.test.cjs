// Perspective: the center operator publishing a reviewed employee request.
// Invariant: HTTPS trust, agent identity and repository binding precede dispatch;
// a frozen proposal reaches one exact native pair and a verified portal receipt.
// Goal: catch gaps between the real CLI, TLS proxy, SQLite and native Git writer,
// including duplicate publication and rejected attempts that must not freeze work.
// Migration: retain this explicit-runtime integration journey with the client CLI.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { authFixture, PASSWORD } = require("./fixtures/portal-auth.cjs");
const { startPortal } = require("../scripts/cascade-portal.cjs");
const { runProcess } = require("../scripts/cascade-process.cjs");

const python = process.env.CASCADE_PYTHON;
assert(python && path.isAbsolute(python) && fs.existsSync(python),
  "CASCADE_PYTHON must name the explicit real Cascade 0.8 interpreter; this integration suite never skips or uses a fake adapter");
const clientScript = path.resolve(__dirname, "../scripts/cascade-portal-client.cjs");
const namespace = "portal-client-integration";
const PROXY = "fixture-proxy-secret-not-a-real-credential-1001";
const AGENT = "fixture-agent-secret-not-a-real-credential-1002";
const FAKE = "fixture-invalid-bearer-not-a-real-credential-1003";
// Canonical key order is written explicitly, independently of the server serializer.
const proposal = {
  acceptance: ["Read back the exact published contract and independent review."],
  baseSha: "1234567890abcdef1234567890abcdef12345678", dependencies: ["baseline"],
  goal: "Publish the reviewed employee request through the secure center 🪷.",
  nonGoals: ["Do not run employee work or merge any candidate."], requiredTier: "lite",
  scope: ["One implementation task and its independent review."], title: "Secure center journey",
};
const proposalHash = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
const nativeSetup = `
import importlib.metadata, sys
from cascade import CascadeClient
from cascade.storage.git_storage import GitStorage
from cascade.types import Contract
assert importlib.metadata.version('cascade-auto').split('+', 1)[0] in ('0.8.0', '0.8.1')
c = CascadeClient(GitStorage(sys.argv[1], namespace=sys.argv[2], cache_dir=sys.argv[3]))
assert c.add('root', required_tier='pro').success
assert c.add('baseline', required_tier='pro', deps={'root': Contract('Original baseline expectation', 'Original baseline promise')}).success
assert c.add('peer', required_tier='pro', reserved_for='fixture-peer').success
r = c.claim('fixture-root', task_id='root', agent_tier='pro', timeout=1800)
assert r.success
assert c.complete('root', agent_id='fixture-root', token=r.data['token'], summary='Fixture root',
    deliverables={'baseline': 'Original baseline receipt'}).success
assert c.claim('fixture-peer', task_id='peer', agent_tier='pro', timeout=1800).success
`;

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-portal-client-"));
  let portal, proxy;
  const upstreams = new Set(), sockets = new Set();
  t.after(async () => {
    try {
      for (const request of upstreams) request.destroy();
      if (proxy) await new Promise(resolve => {
        proxy.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    } finally {
      try { if (portal) await portal.close(); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  });
  const home = path.join(directory, "home"), temp = path.join(directory, "tmp");
  fs.mkdirSync(home); fs.mkdirSync(temp);
  // Do not inherit TLS bypasses, Git redirection, credentials or user Node options.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const run = (command, args, extraEnv = {}, timeoutSeconds = 30) =>
    runProcess(command, args, { timeoutSeconds, env: { ...env, ...extraEnv } });
  const ok = result => {
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const remote = path.join(directory, "remote.git"), nativeCache = path.join(directory, "native-cache");
  ok(await run("git", ["init", "--bare", "--quiet", remote]));
  ok(await run(python, ["-c", nativeSetup, remote, namespace, nativeCache]));
  const git = async args => ok(await run("git", ["--git-dir", remote, ...args]));
  const stateRef = `refs/heads/cascade-state/${namespace}`;
  const snapshot = async () => ({
    ref: await git(["rev-parse", stateRef]),
    graph: JSON.parse(await git(["show", `${stateRef}:data/graph.json`])),
    events: (await git(["show", `${stateRef}:data/events.jsonl`])).split("\n").filter(Boolean).map(line => JSON.parse(line)),
  });

  const ca = path.join(directory, "ca.pem"), caKey = path.join(directory, "ca.key");
  const key = path.join(directory, "server.key"), csr = path.join(directory, "server.csr"), cert = path.join(directory, "server.pem");
  const caConfig = path.join(directory, "ca.cnf"), extensions = path.join(directory, "server.ext");
  fs.writeFileSync(caConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Portal fixture private CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n", { mode: 0o600 });
  fs.writeFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n", { mode: 0o600 });
  ok(await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", caConfig, "-keyout", caKey, "-out", ca]));
  ok(await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", csr]));
  ok(await run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-set_serial", "1", "-days", "1", "-sha256", "-extfile", extensions, "-out", cert]));
  fs.chmodSync(caKey, 0o600); fs.chmodSync(key, 0o600);

  const dataDir = path.join(directory, "portal");
  const dbRows = sql => {
    const db = new DatabaseSync(path.join(dataDir, "portal.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
  };
  const requestState = () => ({ requests: dbRows("SELECT * FROM requests ORDER BY id"),
    messages: dbRows("SELECT * FROM messages ORDER BY id"), audit: dbRows("SELECT * FROM audit ORDER BY id") });
  const observed = [];
  // This is the external reverse-proxy boundary, not a replacement for portal
  // authentication or storage. Agent Bearer is forwarded, never synthesized.
  proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    observed.push({ method: req.method, route: req.url, state: requestState() });
    const agentRoute = req.url.startsWith("/api/agent/");
    const headers = { ...req.headers, host: new URL(origin).host, "x-cascade-proxy": PROXY, "x-real-ip": req.socket.remoteAddress };
    delete headers["x-cascade-user"];
    if (!agentRoute) delete headers.authorization;
    const upstream = http.request({ hostname: "127.0.0.1", port: portal.port, path: req.url,
      method: req.method, headers, agent: false }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
      incoming.on("error", error => res.destroy(error));
    });
    upstreams.add(upstream); upstream.once("close", () => upstreams.delete(upstream));
    upstream.setTimeout(15000, () => upstream.destroy(new Error("Fixture proxy upstream exceeded 15 seconds")));
    upstream.on("error", error => { if (res.headersSent) res.destroy(error); else { res.writeHead(502); res.end("Fixture proxy upstream failed"); } });
    req.on("error", error => upstream.destroy(error));
    req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  proxy.requestTimeout = 20000; proxy.headersTimeout = 10000;
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  portal = await startPortal({ remote, namespace, project: "HTTPS fixture", rootTask: "root", dataDir,
    localDevelopment: true, ...authFixture(directory), publicOrigin: origin, proxySecret: PROXY, agentToken: AGENT, port: 0, refreshMs: 60000 });
  const tokenFile = path.join(directory, "agent.token"), fakeTokenFile = path.join(directory, "fake.token");
  fs.writeFileSync(tokenFile, AGENT, { mode: 0o600 }); fs.writeFileSync(fakeTokenFile, FAKE, { mode: 0o600 });
  const config = { origin, tokenFile, role: "orchestrator", actor: "codex-team-center", cascadePython: python,
    remote, namespace, cacheDir: path.join(directory, "client-cache") };
  const configFile = path.join(directory, "client.json");
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const cli = async (args, { trust = true, override } = {}) => {
    let filename = configFile;
    if (override) {
      filename = path.join(directory, "override.json");
      fs.writeFileSync(filename, JSON.stringify({ ...config, ...override }), { mode: 0o600 });
    }
    const result = await run(process.execPath, [clientScript, "--config", filename, ...args],
      trust ? { NODE_EXTRA_CA_CERTS: ca } : {}, 60);
    for (const secret of [AGENT, PROXY, FAKE]) assert(!`${result.stdout}${result.stderr}`.includes(secret), "CLI output must not disclose fixture secrets");
    return result;
  };
  let employeeHeaders = {};
  const employeePost = (route, value) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const req = https.request(origin + route, { method: "POST", ca: fs.readFileSync(ca), agent: false,
      headers: { ...employeeHeaders, origin, "content-type": "application/json", "content-length": bytes.length,
        "x-cascade-user": "spoofed-user", "x-cascade-proxy": "spoofed-proxy", authorization: "Bearer spoofed" } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Fixture HTTPS request exceeded 15 seconds")));
    req.on("error", reject); req.end(bytes);
  });
  const login = await employeePost("/api/auth/login", { username: "alice", password: PASSWORD });
  assert.equal(login.status, 200); employeeHeaders = { cookie: login.headers["set-cookie"][0].split(";")[0], "x-cascade-csrf": login.body.csrfToken };
  return { directory, remote, origin, ca, config, fakeTokenFile, cli, ok, snapshot, git,
    dbRows, requestState, observed, employeePost, run, nativeCache };
}

test("trusted HTTPS client publishes one native pair, reads back the frozen contract and safely repeats", { timeout: 300000 }, async t => {
  const f = await fixture(t), before = await f.snapshot();
  assert.equal(before.graph.nodes.peer.state, "ACTIVE");
  assert.deepEqual(before.graph.edges, [{ from: "root", to: "baseline",
    expectation: "Original baseline expectation", promise: "Original baseline promise" }]);
  const created = await f.employeePost("/api/requests", { description: "Please publish this reviewed request.", idempotencyKey: "https-journey" });
  assert.equal(created.status, 201); assert.equal(created.body.author, "alice");
  const id = created.body.id, taskId = `portal-${id}`, reviewId = `${taskId}-review`;
  const initial = f.requestState(), observedCount = f.observed.length;

  const untrusted = await f.cli(["publish", "--id", id], { trust: false });
  assert.equal(untrusted.code, 1); assert.match(untrusted.stderr, /fetch failed/);
  assert.equal(untrusted.stdout, "");
  assert.equal(f.observed.length, observedCount, "an untrusted server must fail before an HTTP request reaches the proxy");
  assert.deepEqual(f.requestState(), initial); assert.deepEqual(await f.snapshot(), before);
  assert(!fs.existsSync(f.config.cacheDir));

  const unauthorized = await f.cli(["queue"], { override: { tokenFile: f.fakeTokenFile } });
  assert.equal(unauthorized.code, 1); assert.match(unauthorized.stderr, /Center HTTP 401/);
  assert.equal(unauthorized.stdout, ""); assert.deepEqual(f.requestState(), initial);
  assert.deepEqual(await f.snapshot(), before);

  const queue = JSON.parse(f.ok(await f.cli(["queue"])));
  assert.equal(queue.namespace, namespace); assert.equal(queue.rootTask, "root");
  assert.equal(queue.remoteSha256, createHash("sha256").update(JSON.stringify(f.remote)).digest("hex"));
  assert.deepEqual(queue.requests.map(item => item.id), [id]);
  const input = path.join(f.directory, "plan.json");
  fs.writeFileSync(input, JSON.stringify({ action: "plan", version: 1, proposal }), { mode: 0o600 });
  const planned = JSON.parse(f.ok(await f.cli(["update", "--id", id, "--input", input])));
  assert.equal(planned.state, "planned"); assert.equal(planned.version, 2); assert.deepEqual(planned.proposal, proposal);
  assert.deepEqual(await f.snapshot(), before, "planning must not publish native work");

  const plannedState = f.requestState(), beforeWrong = f.observed.length;
  const wrongRemote = await f.cli(["publish", "--id", id], { override: { remote: path.join(f.directory, "wrong.git") } });
  assert.equal(wrongRemote.code, 1); assert.match(wrongRemote.stderr, /bound to different coordination repositories/);
  assert.equal(wrongRemote.stdout, ""); assert.deepEqual(f.requestState(), plannedState);
  assert.deepEqual(f.observed.slice(beforeWrong).map(item => [item.method, item.route]), [["GET", "/api/agent/queue"]]);
  assert(!fs.existsSync(f.config.cacheDir)); assert.deepEqual(await f.snapshot(), before);

  const published = JSON.parse(f.ok(await f.cli(["publish", "--id", id]))), after = await f.snapshot();
  assert.equal(published.state, "published"); assert.equal(published.version, 4);
  assert.deepEqual(published.dispatch, { taskIds: [taskId, reviewId], proposalVersion: 3,
    proposalSha256: proposalHash, coordinationRevision: after.ref });
  const contractRead = f.observed.find(item => item.route === `/api/agent/requests/${id}/contract`);
  assert(contractRead, "the actual client must fetch the frozen server contract");
  assert.equal(contractRead.state.requests[0].state, "dispatching"); assert.equal(contractRead.state.requests[0].version, 3);
  assert.deepEqual(f.dbRows("SELECT action FROM audit ORDER BY id").map(row => row.action),
    ["request.created", "request.plan", "request.prepare", "request.publish"]);
  for (const [oldId, node] of Object.entries(before.graph.nodes)) assert.deepEqual(after.graph.nodes[oldId], node);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.graph.epoch, before.graph.epoch);
  assert(after.graph.edges.some(edge => JSON.stringify(edge) === JSON.stringify(before.graph.edges[0])));
  assert.equal(Object.keys(after.graph.nodes).length, 5);
  assert.equal(after.graph.nodes[taskId].state, "PENDING"); assert.equal(after.graph.nodes[taskId].required_tier, "lite");
  assert.equal(after.graph.nodes[reviewId].state, "PENDING"); assert.equal(after.graph.nodes[reviewId].required_tier, "pro");
  assert.equal(after.graph.nodes[reviewId].reserved_for, "codex-team-center");
  const added = after.events.slice(before.events.length);
  assert.deepEqual(added.map(event => [event.type, event.data.node_id]), [["node_added", taskId], ["node_added", reviewId]]);
  assert.equal(typeof added[0].trace_id, "string"); assert(added[0].trace_id.length > 0);
  assert.equal(added[0].trace_id, added[1].trace_id);
  assert.equal(await f.git(["rev-list", "--count", `${before.ref}..${after.ref}`]), "1");
  const expectedContract = { requestId: id, proposalVersion: 3, proposalSha256: proposalHash, proposal };
  const edges = after.graph.edges.filter(edge => [taskId, reviewId].includes(edge.to));
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map(edge => [edge.from, edge.to]).sort(), [["root", taskId], ["baseline", taskId], [taskId, reviewId]].sort());
  for (const edge of edges) {
    assert(edge.expectation.startsWith("portal-contract:"));
    assert.deepEqual(JSON.parse(edge.expectation.slice("portal-contract:".length)), expectedContract);
    assert(edge.promise.length > 30);
  }
  const publishedState = f.requestState(), repeatStart = f.observed.length;
  assert.deepEqual(JSON.parse(f.ok(await f.cli(["publish", "--id", id]))), published);
  assert.deepEqual(f.requestState(), publishedState); assert.deepEqual(await f.snapshot(), after);
  assert.deepEqual(f.observed.slice(repeatStart).map(item => [item.method, item.route]),
    [["GET", "/api/agent/queue"], ["GET", `/api/agent/requests/${id}`]]);
  f.ok(await f.run(python, ["-c", `
import sys
from cascade.storage.git_storage import GitStorage
from cascade.replay import replay, verify
s = GitStorage(sys.argv[1], namespace=sys.argv[2], cache_dir=sys.argv[3])
with s.lock():
    g, e = s.load(), s.events.read_all()
    assert s.events.verify_chain()[0]
    assert not verify(e, g, s.content)
    assert replay(e, s.content).contracts == g.contracts
`, f.remote, namespace, path.join(f.directory, "audit-cache")]));
  assert.deepEqual(await f.snapshot(), after, "independent native replay validation must not add state or events");
});
