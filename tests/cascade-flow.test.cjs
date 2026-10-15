// Perspective: a team member checking the center without changing its work.
// Invariant: one immutable Git revision, honest status, and no write endpoint.
// Goal: catch mixed snapshots, false progress, hidden read errors and unsafe text.
// Migration: keep the Git/HTTP boundary tests if the presentation is replaced.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createReader, projectSnapshot } = require(process.env.CASCADE_FLOW_SNAPSHOT || "../scripts/cascade-flow/snapshot.cjs");
const { startViewer } = require("../scripts/cascade-flow.cjs");

function graph() {
  return { epoch: 2, lamport: 3, nodes: {
    publish: { id: "publish", state: "COMPLETED", context: { summary: "scope published" } },
    task: { id: "task", state: "READY", reserved_for: "worker", required_tier: "pro" },
    review: { id: "review", state: "PENDING", reserved_for: "center" },
    peer: { id: "peer", state: "COMPLETED", reserved_for: "peer-worker", context: { summary: "<script>alert(1)</script>", artifacts_ref: "abc", provenance: { git_ref: "def" } } },
  }, edges: [
    { from: "publish", to: "task", expectation: "scope", promise: "contract" },
    { from: "task", to: "review", expectation: "tested change", promise: "branch" },
  ] };
}
const event = (id, type, node, logical, timestamp = logical) => ({ id, type, timestamp, logical_ts: logical, data: { node_id: node } });
const events = () => [event("e1", "node_added", "task", 1), event("e2", "task_claimed", "peer", 2), event("e3", "task_completed", "peer", 3)];
const project = (g = graph(), e = events()) => projectSnapshot(JSON.stringify(g), e.map(x => JSON.stringify(x)).join("\n"), { revision: "a".repeat(40), fetchedAt: "2026-09-09T00:00:00.000Z", project: "test" });

test("real states and dependency flow do not infer readiness, authorship or acceptance", () => {
  const value = project();
  assert.deepEqual(value.flow, ["publish", "task", "review"]);
  assert.deepEqual(value.history, ["peer"]);
  const task = value.nodes.find(n => n.id === "task");
  assert.equal(task.state, "READY");
  assert.equal(task.owner, null);
  assert.equal(task.reservedFor, "worker");
  assert.equal(task.tier, "pro");
  assert.deepEqual(task.dependencies, [{ id: "publish", title: "publish", state: "COMPLETED", expectation: "scope", promise: "contract" }]);
  const peer = value.nodes.find(n => n.id === "peer");
  assert.equal(peer.owner, null, "reservation does not prove who completed the task");
  assert.equal(peer.state, "COMPLETED");
  assert.equal(peer.accepted, undefined);
  assert.equal(peer.summary, "<script>alert(1)</script>", "text remains text for safe DOM rendering");
  assert.equal(peer.gitRef, "def");
  assert.equal(peer.artifactRef, "abc");
});

test("lease uses renewed lease start, never rewrites ACTIVE or leaks fencing token", () => {
  const g = graph();
  Object.assign(g.nodes.task, { state: "ACTIVE", agent_id: "worker", claimed_at: 100, timeout: 30, claim_token: 2 });
  const n = project(g).nodes.find(n => n.id === "task");
  assert.equal(n.state, "ACTIVE");
  assert.equal(n.leaseExpiresAt, "1970-01-01T00:02:10.000Z");
  assert.equal(n.owner, "worker");
  assert(!JSON.stringify(n).includes("claim_token"));
  g.nodes.task.claimed_at = 200;
  assert.equal(project(g).nodes.find(n => n.id === "task").leaseExpiresAt, "1970-01-01T00:03:50.000Z");
});

test("retained history can include deleted nodes and backward wall clocks", () => {
  const e = events();
  e[1].data.agent_id = "actual-author";
  e[2].timestamp = 1.5;
  e[0].data.node_id = "deleted";
  const result = project(graph(), e);
  assert.equal(result.nodes.find(n => n.id === "peer").owner, "actual-author");
  assert.equal(result.lastEventAt, "1970-01-01T00:00:01.500Z");
  const compacted = project(graph(), []);
  assert.equal(compacted.lastEventAt, null);
  assert.deepEqual(compacted.nodes.find(n => n.id === "task").events, []);
});

test("reusing a removed node ID does not attribute old work to its new lifecycle", () => {
  const e = events();
  e[0] = event("old-claim", "task_claimed", "peer", 1);
  e[0].data.agent_id = "old-worker";
  e[1] = event("new-node", "node_added", "peer", 2);
  const peer = project(graph(), e).nodes.find(n => n.id === "peer");
  assert.equal(peer.owner, null);
  assert.deepEqual(peer.events.map(e => e.type), ["node_added", "task_completed"]);
});

test("malformed snapshots and dependencies fail instead of becoming empty success", () => {
  const cases = [
    g => { g.nodes.task.state = "MAGIC"; },
    g => { g.nodes.task.id = "wrong"; },
    g => { g.nodes.task.state = "ACTIVE"; },
    g => { g.edges[0].from = "missing"; },
    g => { g.edges.push(g.edges[0]); },
    g => { g.edges.push({ from: "review", to: "publish", expectation: "cycle", promise: "cycle" }); },
    g => { delete g.edges[0].promise; },
    g => { g.schema_version = 99; },
    g => { g.epoch = -1; },
    g => { g.nodes = []; },
  ];
  for (const mutate of cases) { const g = graph(); mutate(g); assert.throws(() => project(g)); }
  assert.throws(() => projectSnapshot("{broken", "", {}));
  assert.throws(() => projectSnapshot(JSON.stringify(graph()), "{broken", {}));
  assert.throws(() => project(graph(), [events()[0], events()[0]]));
  assert.throws(() => project(graph(), [event("future", "node_added", "task", 4)]));
});

test("arbitrary critical metadata is not a mandatory display schema", () => {
  const g = graph();
  g.nodes.task.context = { critical: { title: 42, private: "not sent" } };
  const node = project(g).nodes.find(n => n.id === "task");
  assert.equal(node.title, "task");
  assert(!JSON.stringify(node).includes("not sent"));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-flow-test-"));
  const remote = path.join(root, "remote.git"), writer = path.join(root, "writer");
  const git = (args, cwd = writer) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--bare", "--quiet", remote], root);
  fs.mkdirSync(writer);
  git(["init", "--quiet"]);
  git(["config", "user.name", "Flow test"]);
  git(["config", "user.email", "flow@example.invalid"]);
  fs.mkdirSync(path.join(writer, "data"));
  const commit = (g = graph(), e = events(), missingEvents = false) => {
    fs.writeFileSync(path.join(writer, "data/graph.json"), typeof g === "string" ? g : JSON.stringify(g));
    if (missingEvents) fs.rmSync(path.join(writer, "data/events.jsonl"), { force: true });
    else fs.writeFileSync(path.join(writer, "data/events.jsonl"), e.map(x => JSON.stringify(x)).join("\n"));
    git(["add", "--all"]); git(["commit", "--quiet", "--allow-empty", "-m", "snapshot"]);
    git(["push", "--quiet", remote, "HEAD:refs/heads/cascade-state/test"]);
    return git(["rev-parse", "HEAD"]);
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, writer, remote, git, commit, refs: () => git(["ls-remote", remote]) };
}

test("real bare Git read is single-flight, immutable, refreshable and zero remote writes", async t => {
  const f = fixture(t), revision = f.commit(), before = f.refs();
  const reader = await createReader({ remote: f.remote, namespace: "test" });
  try {
    const [first, concurrent] = await Promise.all([reader.read(), reader.read()]);
    assert.equal(first, concurrent);
    assert.equal(first.revision, revision);
    assert.equal(first.nodes.length, 4);
    assert.equal(f.refs(), before);
    const g = graph(); g.nodes.task.state = "FAILED";
    const next = f.commit(g);
    assert.equal((await reader.read()).revision, next);
    assert.equal(first.nodes.find(n => n.id === "task").state, "READY");
    assert.equal(f.refs(), `${next}\trefs/heads/cascade-state/test`);
    f.commit("{broken");
    await assert.rejects(reader.read(), SyntaxError);
    f.commit(graph(), events(), true);
    await assert.rejects(reader.read(), /events.jsonl/);
    f.git(["update-ref", "-d", "refs/heads/cascade-state/test"], f.remote);
    await assert.rejects(reader.read(), /Git fetch failed/);
  } finally { await reader.close(); }
  await assert.rejects(reader.read(), /closed/);
});

test("bad namespace and remote arguments are rejected before Git", async () => {
  for (const namespace of [undefined, "../bad", "-x", "a/b", "foo.lock", ""]) {
    await assert.rejects(createReader({ remote: "/tmp/test", namespace }), /namespace/);
  }
  await assert.rejects(createReader({ remote: "--upload-pack=bad", namespace: "test" }), /remote/);
});

test("inherited Git common-dir and index cannot redirect viewer writes", async t => {
  const f = fixture(t); f.commit();
  const before = f.git(["count-objects", "-v"]);
  const configPath = path.join(f.writer, ".git/config"), indexPath = path.join(f.writer, ".git/index");
  const config = fs.readFileSync(configPath), index = fs.readFileSync(indexPath), refs = f.refs();
  const variables = { GIT_COMMON_DIR: path.join(f.writer, ".git"), GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: f.writer, GIT_NAMESPACE: "poisoned" };
  const saved = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  let reader;
  try { Object.assign(process.env, variables); reader = await createReader({ remote: f.remote, namespace: "test" }); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  try {
    assert.equal((await reader.read()).nodes.length, 4);
    assert.deepEqual(fs.readFileSync(configPath), config);
    assert.deepEqual(fs.readFileSync(indexPath), index);
    assert.equal(f.git(["count-objects", "-v"]), before);
    assert.equal(f.refs(), refs);
  } finally { await reader.close(); }
});

test("remote advance between blob reads cannot mix graph and event revisions", async t => {
  const f = fixture(t), first = f.commit();
  const g = graph(); g.nodes.task.state = "FAILED"; g.lamport = 4;
  const second = f.commit(g, [...events(), event("e4", "task_failed", "task", 4)]);
  f.git(["update-ref", "refs/heads/cascade-state/test", first], f.remote);
  const bin = path.join(f.root, "bin"), marker = path.join(f.root, "advanced");
  fs.mkdirSync(bin);
  // The fixture only advances the external remote between two real Git reads.
  // It delegates every viewer command unchanged to the actual Git executable.
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'); const {spawnSync,execFileSync}=require('node:child_process');
const args=process.argv.slice(2); if(args.some(x=>x.endsWith(':data/graph.json'))&&!fs.existsSync(${JSON.stringify(marker)})) {
execFileSync(${JSON.stringify(realGit)}, ['--git-dir',${JSON.stringify(f.remote)},'update-ref','refs/heads/cascade-state/test',${JSON.stringify(second)}]); fs.writeFileSync(${JSON.stringify(marker)},'advanced'); }
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); process.exit(r.status ?? 1);\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  let reader;
  try { process.env.PATH = `${bin}${path.delimiter}${oldPath}`; reader = await createReader({ remote: f.remote, namespace: "test" }); }
  finally { process.env.PATH = oldPath; }
  try {
    const value = await reader.read();
    assert.equal(fs.readFileSync(marker, "utf8"), "advanced");
    assert.equal(f.refs(), `${second}\trefs/heads/cascade-state/test`);
    assert.equal(value.revision, first);
    assert.equal(value.nodes.find(n => n.id === "task").state, "READY");
    assert.equal(value.lastEventAt, "1970-01-01T00:00:03.000Z");
    assert(!value.nodes.some(n => n.events.some(e => e.type === "task_failed")));
    assert.equal((await reader.read()).revision, second);
  } finally { await reader.close(); }
});

async function settledSnapshot(viewer) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await fetch(viewer.url + "/api/snapshot");
    const body = await response.json();
    if (!body.refreshing && body.status !== "loading") return { response, body };
    await delay(10);
  }
  throw new Error("Viewer refresh did not settle within 10 seconds");
}

test("HTTP is loopback GET only, serves packaged assets and labels failed refreshes", async t => {
  const f = fixture(t), revision = f.commit();
  const reader = await createReader({ remote: f.remote, namespace: "test" });
  const viewer = await startViewer({ reader, port: 0, refreshMs: 100 });
  try {
    const loading = await (await fetch(viewer.url + "/api/snapshot")).json();
    assert.equal(loading.status, "loading", "HTTP returns before the real Git fetch finishes");
    assert.equal(loading.refreshing, true);
    assert.equal(loading.snapshot, null);
    const { response: first, body } = await settledSnapshot(viewer);
    assert.equal(first.status, 200);
    assert.equal(body.status, "fresh");
    assert.equal(body.snapshot.revision, revision);
    assert.equal((await fetch(viewer.url)).status, 200);
    for (const asset of ["/app.js", "/style.css", "/layout.js", "/vendor/dagre-3.1.1.esm.js"]) assert.equal((await fetch(viewer.url + asset)).status, 200);
    assert.match(first.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(first.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(viewer.url + "/api/snapshot", { method: "POST" })).status, 405);
    assert.equal((await fetch(viewer.url + "/api/snapshot", { headers: { Origin: "https://evil.invalid" } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      const request = http.get(viewer.url + "/api/snapshot", { headers: { Host: "evil.invalid" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(viewer.url + "/.git/config")).status, 404);
    f.commit("{broken");
    await delay(110);
    const { response: failed, body: stale } = await settledSnapshot(viewer);
    assert.equal(failed.status, 503);
    assert.equal(stale.status, "error");
    assert(stale.error);
    assert.equal(stale.snapshot.revision, revision);
    assert.equal(stale.snapshot.fetchedAt, body.snapshot.fetchedAt);
    f.commit();
    await delay(110);
    assert.equal((await settledSnapshot(viewer)).body.status, "fresh");
  } finally { await viewer.close(); }
});

test("first read failure is an error with no pretend empty snapshot", async t => {
  const f = fixture(t);
  const reader = await createReader({ remote: f.remote, namespace: "test" });
  const viewer = await startViewer({ reader, port: 0 });
  try {
    const initial = await (await fetch(viewer.url + "/api/snapshot")).json();
    assert.equal(initial.status, "loading");
    assert.equal(initial.snapshot, null);
    const { response, body: result } = await settledSnapshot(viewer);
    assert.equal(response.status, 503);
    assert.equal(result.status, "error");
    assert.equal(result.snapshot, null);
    assert.match(result.error, /Git fetch failed/);
  } finally { await viewer.close(); }
});

// Perspective: a reader following branching dependencies, including old prerequisites.
// Invariant: every actual edge flows left to right, including when a card expands, without overlaps.
// Goal: catch missing cross-layer/history edges and incorrect endpoints in the shipped layout.
// Migration: assert semantic geometry, not a layout library's incidental pixel arrangement.
test("DAG layout preserves branches, direct contracts, history links and disconnected tasks", async () => {
  const { layoutGraph, edgePath } = await import("../scripts/cascade-flow/layout.js");
  const states = { A: "COMPLETED", B: "ACTIVE", C: "FAILED", D: "PENDING", X: "READY", K: "CANCELLED", Y: "PENDING", H: "COMPLETED", I: "CANCELLED" };
  const pairs = [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["A", "D"], ["K", "Y"], ["A", "H"], ["H", "I"]];
  const input = { epoch: 1, lamport: 0, nodes: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { id, state, ...(state === "ACTIVE" ? { agent_id: "worker", claimed_at: 100, timeout: 30, claim_token: 1 } : {}) }])), edges: pairs.map(([from, to]) => ({ from, to, expectation: `expected ${from}->${to}`, promise: `promised ${from}->${to}` })) };
  const snapshot = project(input, []);
  assert.deepEqual(new Set(snapshot.flow), new Set(["A", "B", "C", "D", "X", "K", "Y"]));
  assert.deepEqual(new Set(snapshot.history), new Set(["H", "I"]));
  const before = JSON.stringify(snapshot);
  for (const ids of [snapshot.flow, [...snapshot.flow, ...snapshot.history]]) {
    const nodes = ids.map(id => snapshot.nodes.find(node => node.id === id));
    for (const dimensions of [new Map(), new Map([["C", { width: 320, height: 730 }]]), new Map([["D", { width: 242, height: 1180 }]])]) {
      const result = layoutGraph(nodes, dimensions);
      assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(ids));
      const expectedEdges = pairs.filter(([from, to]) => ids.includes(from) && ids.includes(to)).map(edge => edge.join("->"));
      assert.deepEqual(result.edges.map(edge => `${edge.from}->${edge.to}`).sort(), expectedEdges.sort());
      assert.equal(result.edges.length, expectedEdges.length);
      const byId = new Map(result.nodes.map(node => [node.id, node]));
      for (const node of result.nodes) {
        assert([node.x, node.y, result.width, result.height].every(Number.isFinite));
        assert.equal(node.width, dimensions.get(node.id)?.width ?? 208);
        assert.equal(node.height, dimensions.get(node.id)?.height ?? 96);
        assert(node.x >= node.width / 2 && node.y >= node.height / 2);
        assert(node.x + node.width / 2 <= result.width && node.y + node.height / 2 <= result.height);
        for (const other of result.nodes.filter(other => other.id !== node.id)) {
          assert(Math.abs(node.x - other.x) >= (node.width + other.width) / 2 || Math.abs(node.y - other.y) >= (node.height + other.height) / 2, `${node.id} overlaps ${other.id}`);
        }
      }
      function onBoundary(point, node) {
        const dx = Math.abs(point.x - node.x), dy = Math.abs(point.y - node.y), epsilon = 1e-6;
        return dx <= node.width / 2 + epsilon && dy <= node.height / 2 + epsilon && (Math.abs(dx - node.width / 2) < epsilon || Math.abs(dy - node.height / 2) < epsilon);
      }
      for (const edge of result.edges) {
        const source = byId.get(edge.from), target = byId.get(edge.to);
        assert(source.x + source.width / 2 < target.x - target.width / 2, "prerequisites are fully left of their dependents");
        assert(edge.points[0].x >= source.x, "edge leaves the forward half of its prerequisite");
        assert(edge.points.at(-1).x <= target.x, "edge enters the incoming half of its dependent");
        assert(onBoundary(edge.points[0], byId.get(edge.from)));
        assert(onBoundary(edge.points.at(-1), byId.get(edge.to)));
        assert.deepEqual(edge.points[0], { x: source.x + source.width / 2, y: source.y });
        assert.deepEqual(edge.points.at(-1), { x: target.x - target.width / 2, y: target.y });
        assert(edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
        for (let i = 1; i < edge.points.length; i++) {
          const a = edge.points[i - 1], b = edge.points[i];
          assert(a.x === b.x || a.y === b.y, "dependency routes use horizontal and vertical segments");
          assert.notDeepEqual(a, b, "no zero-length segments can corrupt rounded corners");
        }
        assert(!/NaN|Infinity/.test(edgePath(edge.points)));
        // Clip each line segment against the open interior of unrelated card rectangles.
        for (const other of result.nodes.filter(node => ![edge.from, edge.to].includes(node.id))) {
          for (let i = 1; i < edge.points.length; i++) {
            const a = edge.points[i - 1], b = edge.points[i]; let low = 0, high = 1;
            for (const [axis, half] of [["x", other.width / 2 - .01], ["y", other.height / 2 - .01]]) {
              const min = other[axis] - half, max = other[axis] + half, delta = b[axis] - a[axis];
              if (delta === 0) { if (a[axis] < min || a[axis] > max) high = -1; }
              else { const t = [(min - a[axis]) / delta, (max - a[axis]) / delta].sort((x, y) => x - y); low = Math.max(low, t[0]); high = Math.min(high, t[1]); }
            }
            assert(low > high, `${edge.from}->${edge.to} crosses ${other.id}`);
          }
        }
      }
    }
  }
  assert.equal(JSON.stringify(snapshot), before, "layout never rewrites state, contracts or snapshot partitions");
});

test("dense dependency routes avoid intervening cards and keep separate source lanes", async () => {
  const { layoutGraph, edgePath } = await import("../scripts/cascade-flow/layout.js");
  const nodes = Array.from({ length: 96 }, (_, i) => ({ id: `task-${i}`, dependencies: [] }));
  for (let i = 12; i < nodes.length; i++) {
    const column = Math.floor(i / 12), row = i % 12;
    const parents = new Set([(column - 1) * 12 + row, (column - 1) * 12 + (row + 3) % 12]);
    if (column > 1 && row % 3 === 0) parents.add((column - 2) * 12 + row);
    nodes[i].dependencies = [...parents].map(index => ({ id: nodes[index].id }));
  }
  const result = layoutGraph(nodes, new Map([["task-41", { width: 320, height: 920 }]]));
  assert.equal(result.nodes.length, 96);
  assert.equal(result.edges.length, nodes.reduce((total, node) => total + node.dependencies.length, 0));
  assert(result.edges.some(edge => edgePath(edge.points).includes(" Q ")), "bends are rounded in rendered SVG paths");
  for (const edge of result.edges) {
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      assert(a.x === b.x || a.y === b.y);
      for (const node of result.nodes.filter(node => ![edge.from, edge.to].includes(node.id))) {
        const left = node.x - node.width / 2, right = node.x + node.width / 2;
        const top = node.y - node.height / 2, bottom = node.y + node.height / 2;
        const crosses = a.x === b.x
          ? a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom
          : a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
        assert(!crosses, `${edge.from}->${edge.to} crosses ${node.id}`);
      }
    }
  }
  const simple = layoutGraph([{ id: "a", dependencies: [] }, { id: "b", dependencies: [] },
    { id: "c", dependencies: [{ id: "a" }, { id: "b" }] }]);
  const verticalLanes = simple.edges.map(edge => edge.points.find((point, i) => i && point.x === edge.points[i - 1].x)?.x);
  assert(verticalLanes.every(Number.isFinite));
  assert.notEqual(verticalLanes[0], verticalLanes[1], "unrelated source tasks must not share a vertical trunk");
});

test("DAG empty/single/special-ID graphs remain valid and invalid topology is explicit", async () => {
  const { layoutGraph } = await import("../scripts/cascade-flow/layout.js");
  assert.deepEqual(layoutGraph([]), { nodes: [], edges: [], width: 0, height: 0 });
  const one = layoutGraph([{ id: "__proto__", dependencies: [] }]);
  assert.equal(one.nodes.length, 1); assert.equal(one.edges.length, 0); assert(one.width > 0 && one.height > 0);
  const special = layoutGraph([{ id: "__proto__", dependencies: [] }, { id: "constructor [<img>]", dependencies: [{ id: "__proto__" }] }]);
  assert.deepEqual(special.edges.map(({from, to}) => [from, to]), [["__proto__", "constructor [<img>]"]]);
  assert.throws(() => layoutGraph([{ id: "A", dependencies: [{ id: "missing" }] }]), /依赖端点/);
  assert.throws(() => layoutGraph([{ id: "A", dependencies: [{ id: "B" }] }, { id: "B", dependencies: [{ id: "A" }] }]), /循环/);
  for (const size of [{ width: 0, height: 96 }, { width: 208, height: NaN }, { width: Infinity, height: 96 }]) {
    assert.throws(() => layoutGraph([{ id: "A", dependencies: [] }], new Map([["A", size]])), /尺寸无效/);
  }
});

test("vendored layout bytes match recorded upstream provenance and include MIT notices", () => {
  const { createHash } = require("node:crypto");
  const vendor = path.join(__dirname, "../scripts/cascade-flow/vendor");
  const source = fs.readFileSync(path.join(vendor, "dagre-3.1.1.esm.js"));
  const provenance = fs.readFileSync(path.join(vendor, "README.md"), "utf8");
  assert(provenance.includes(createHash("sha256").update(source).digest("hex")));
  assert(provenance.includes("@dagrejs/dagre")); assert(provenance.includes("sha512-"));
  for (const name of ["DAGRE-LICENSE", "dagre.esm.js.LEGAL.txt"]) assert.match(fs.readFileSync(path.join(vendor, name), "utf8"), /Permission is hereby granted/);
});
