// Perspective: a team publisher and workers sharing one Cascade task graph.
// Invariant: open work remains claimable, private work retains its owner, and
// finite leases plus fenced delivery survive the project's profile adapter.
// Goal: catch inaccessible worker pools, lost fencing, duplicate retry events
// and runtime/profile mismatches using real Cascade file and Git backends.
// Migration: run with pinned CASCADE_BIN and CASCADE_PYTHON; invocation audits only wrap that
// real executable and must never replace the engine with a fake store.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const laneScript = process.env.CASCADE_LANE_SCRIPT || path.resolve(__dirname, "../scripts/cascade-lane.cjs");
const cascade = process.env.CASCADE_BIN;
assert(cascade && path.isAbsolute(cascade) && fs.existsSync(cascade), "CASCADE_BIN must name a real Cascade >=0.7 executable; this suite never skips or substitutes an engine");

function fixture(t, storage = "file") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-team-lane-"));
  const bin = path.join(root, "bin"), store = path.join(root, "state"), remote = path.join(root, "center.git");
  fs.mkdirSync(bin);
  fs.symlinkSync(cascade, path.join(bin, "cascade"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const name of ["AI_DEV_KIT_CASCADE_GIT_REMOTE", "AI_DEV_KIT_CASCADE_REDIS_URL", "AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS"])
    delete env[name];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args, expected = 0) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result;
  };
  const version = run(cascade, ["--version"]).stdout.match(/cascade (\d+)\.(\d+)\.(\d+)/);
  assert(version && (+version[1] > 0 || +version[2] >= 7), "the real Cascade executable must be at least 0.7.0");
  if (storage === "git") run("git", ["init", "--bare", "-q", remote]);
  const project = (name, role = "orchestrator", lease) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, ".ai-dev-kit"), { recursive: true });
    run("git", ["-C", dir, "init", "-q", "-b", "main"]);
    const backend = storage === "file" ? `    storage_path: "${store}"\n`
      : `    git_remote: "${remote}"\n    git_cache: "${root}/cache-${name}"\n    namespace: team-contract\n`;
    fs.writeFileSync(path.join(dir, ".ai-dev-kit/profile.yml"), `coordination:\n  engine: cascade\n  role: ${role}\n  cascade:\n    storage: ${storage}\n${backend}${lease === undefined ? "" : `    lease_seconds: ${lease}\n`}`);
    return dir;
  };
  const args = (dir, agent, tail) => [laneScript, "--profile", path.join(dir, ".ai-dev-kit/profile.yml"), "--agent", agent, ...tail];
  const lane = (dir, agent, tail, expected = 0) => run(process.execPath, args(dir, agent, tail), expected).stdout;
  const nativeArgs = storage === "file" ? ["--storage", store]
    : ["--git-remote", remote, "--git-cache", path.join(root, "audit-cache"), "--namespace", "team-contract"];
  const native = (tail, expected = 0) => run(cascade, [...nativeArgs, ...tail], expected).stdout;
  const nodes = () => JSON.parse(native(["list-nodes"])).data.nodes;
  const graph = () => JSON.parse(fs.readFileSync(path.join(store, "graph.json"), "utf8"));
  const claim = (dir, agent, tail = []) => {
    const output = lane(dir, agent, ["claim", ...tail]);
    const token = output.match(/fencing_token:\s*(\d+)/)?.[1];
    assert(token, `a successful claim must return a fencing token: ${output}`);
    return { output, token };
  };
  const start = (dir, agent, tail) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args(dir, agent, tail), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const watchdog = setTimeout(() => child.kill("SIGTERM"), 30000);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(watchdog); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr, agent });
    });
  });
  return { root, bin, store, env, run, project, lane, native, nodes, graph, claim, start };
}

test("orchestrator open work reaches the worker pool while default publishing stays private", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker");
  f.lane(center, "planner", ["add", "--slug", "private-work"]);
  f.lane(center, "planner", ["add", "--slug", "pool-work", "--open", "--required-tier", "pro"]);
  const published = f.nodes();
  assert.equal(published.find(node => node.id === "private-work").reserved_for, "planner");
  assert.equal(published.find(node => node.id === "pool-work").reserved_for, null);
  assert.equal(published.find(node => node.id === "pool-work").required_tier, "pro");
  assert.equal(JSON.parse(f.lane(worker, "alice", ["claim", "--slug", "private-work"], 1)).code, "TASK_RESERVED");
  const claimed = f.claim(worker, "alice", ["--agent-tier", "pro"]);
  assert.match(claimed.output, /Task: pool-work/);
  assert.equal(f.graph().nodes["pool-work"].timeout, 1800);
  assert.equal(f.graph().nodes["private-work"].state, "READY");
  f.lane(worker, "alice", ["finish", "--slug", "pool-work", "--token", claimed.token, "--summary", "fixture work verified"]);
  assert.equal(f.graph().nodes["pool-work"].state, "COMPLETED");
});

test("explicit reserved-for uses native owner enforcement and preserves self-serve compatibility", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker"), self = f.project("self", "self-serve");
  f.lane(center, "planner", ["add", "--slug", "assigned-work", "--reserved-for", "alice"]);
  assert.equal(f.nodes()[0].reserved_for, "alice");
  assert.equal(JSON.parse(f.lane(worker, "bob", ["claim", "--slug", "assigned-work"], 1)).code, "TASK_RESERVED");
  assert.match(f.claim(worker, "alice").output, /Task: assigned-work/);
  f.lane(self, "solo", ["add", "--slug", "self-work"]);
  assert.match(f.claim(self, "solo", ["--slug", "self-work"]).output, /Task: self-work/);
});

test("claim and renew use finite leases, and release/reclaim fences the original owner", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker", 47);
  f.lane(center, "planner", ["add", "--slug", "lease-work", "--open"]);
  const first = f.claim(worker, "alice", ["--timeout", "5"]);
  assert.equal(f.graph().nodes["lease-work"].timeout, 5);
  const renewed = JSON.parse(f.lane(worker, "alice", ["renew", "--slug", "lease-work", "--token", first.token, "--timeout", "9"]));
  assert.equal(renewed.data.timeout, 9);
  assert.equal(f.graph().nodes["lease-work"].claim_token, Number(first.token));
  f.lane(worker, "alice", ["renew", "--slug", "lease-work", "--token", first.token]);
  assert.equal(f.graph().nodes["lease-work"].timeout, 47);
  assert.equal(JSON.parse(f.lane(worker, "bob", ["renew", "--slug", "lease-work", "--token", first.token], 1)).code, "WRONG_AGENT");
  assert.equal(JSON.parse(f.lane(worker, "bob", ["release", "--slug", "lease-work", "--token", first.token, "--reason", "not the owner"], 1)).code, "WRONG_AGENT");
  f.lane(worker, "alice", ["release", "--slug", "lease-work", "--token", first.token, "--reason", "worker stopped before implementation"]);
  assert.equal(f.graph().nodes["lease-work"].state, "READY");
  const second = f.claim(worker, "bob");
  assert(BigInt(second.token) > BigInt(first.token));
  assert.equal(f.graph().nodes["lease-work"].timeout, 47);
  for (const command of ["renew", "release", "finish"]) {
    const tail = [command, "--slug", "lease-work", "--token", first.token];
    if (command === "release") tail.push("--reason", "stale worker cancellation");
    assert.equal(JSON.parse(f.lane(worker, "alice", tail, 1)).code, "STALE_TOKEN");
  }
  f.lane(worker, "bob", ["finish", "--slug", "lease-work", "--token", second.token, "--fail", "--reason", "fixture acceptance failed"]);
  assert.equal(f.graph().nodes["lease-work"].state, "FAILED");
});

test("dependency contracts and every downstream delivery reach the real engine", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker");
  f.lane(center, "planner", ["add", "--slug", "implementation", "--open"]);
  for (const reviewer of ["review-a", "review-b"]) {
    f.lane(center, "planner", ["add", "--slug", reviewer, "--open", "--deps", "implementation", "--expectations", JSON.stringify([
      { node_id: "implementation", expectation: `${reviewer} needs a verified branch`, promise: `provide the test report to ${reviewer}` },
    ])]);
  }
  assert.equal(f.graph().edges.length, 2);
  assert.equal(JSON.parse(f.lane(worker, "reviewer", ["claim", "--slug", "review-a"], 1)).code, "TASK_NOT_READY");
  const claimed = f.claim(worker, "implementer");
  assert.match(claimed.output, /Task: implementation/);
  const finish = ["finish", "--slug", "implementation", "--token", claimed.token, "--summary", "two fixture reports verified"];
  assert.equal(JSON.parse(f.lane(worker, "implementer", finish, 1)).code, "UNADDRESSED_PROMISES");
  assert.equal(JSON.parse(f.lane(worker, "implementer", [...finish, "--deliveries", JSON.stringify({ "review-a": "report A verified" })], 1)).code, "UNADDRESSED_PROMISES");
  assert.equal(f.graph().nodes.implementation.state, "ACTIVE");
  const deliveries = { "review-a": "report A verified", "review-b": "report B verified" };
  f.lane(worker, "implementer", [...finish, "--deliveries", JSON.stringify(deliveries), "--critical", JSON.stringify({ fixture: true, branch: "codex/fixture-result" }), "--artifacts", "fixture report contents"]);
  const completed = f.graph().nodes.implementation;
  assert.equal(completed.state, "COMPLETED");
  assert.deepEqual(completed.context.provenance.deliverables, deliveries);
  assert.deepEqual(completed.context.critical, { fixture: true, branch: "codex/fixture-result" });
  assert.equal(completed.context.summary, "two fixture reports verified");
  const review = f.claim(worker, "reviewer", ["--slug", "review-a"]);
  assert.match(review.output, /report A verified/);
  assert.match(review.output, /two fixture reports verified/);
  assert.match(f.native(["inspect", "--task", "implementation"]), /fixture report contents/);
});

test("invalid flags, contracts, ownership declarations and budgets never invoke Cascade", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker"), self = f.project("self", "self-serve");
  const calls = path.join(f.root, "cascade-invocations");
  fs.unlinkSync(path.join(f.bin, "cascade"));
  fs.writeFileSync(path.join(f.bin, "cascade"), `#!/usr/bin/env node\nconst fs=require("node:fs"); const {spawnSync}=require("node:child_process"); fs.appendFileSync(${JSON.stringify(calls)}, "called\\n"); const result=spawnSync(${JSON.stringify(cascade)}, process.argv.slice(2), {stdio:"inherit"}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  const cases = [
    [worker, ["retry", "--slug", "work", "--failure-event", "failure", "--op-id", "retry-1", "--reason", "repair"]],
    [self, ["retry", "--slug", "work", "--failure-event", "failure", "--op-id", "retry-1", "--reason", "repair"]],
    [center, ["retry", "--slug", "work", "--failure-event", "failure", "--reason", "repair"]],
    [center, ["retry", "--slug", "work", "--op-id", "retry-1", "--reason", "repair"]],
    [center, ["retry", "--slug", "work", "--failure-event", "failure", "--op-id", "retry-1"]],
    [center, ["doctor"]],
    [center, ["doctor", "--python", "relative-python"]],
    [center, ["claim", "--dispatch", "dispatch.json"]],
    [center, ["add", "--slug", "work", "--unknown"]],
    [center, ["add", "extra", "--slug", "work"]],
    [center, ["add", "--slug", "work", "--slug", "other"]],
    [center, ["add", "--slug", "../work"]],
    [center, ["add", "--slug", "work", "--required-tier", "ultra"]],
    [center, ["add", "--slug", "work", "--open", "--reserved-for", "alice"]],
    [worker, ["add", "--slug", "work", "--open"]],
    [self, ["add", "--slug", "work", "--open"]],
    [self, ["add", "--slug", "work", "--reserved-for", "someone-else"]],
    [center, ["claim", "--required-tier", "pro"]],
    [center, ["claim", "--role", ""]],
    [center, ["claim", "--agent-tier", "ultra"]],
    [center, ["release", "--slug", "work", "--token", "1"]],
    [center, ["finish", "--slug", "work", "--token", "1", "--fail"]],
    [center, ["finish", "--slug", "work", "--token", "1", "--reason", "ignored reason"]],
    [center, ["finish", "--slug", "work", "--token", "1", "--fail", "--reason", "failure", "--summary", "must not be ignored"]],
    [center, ["add", "--slug", "work", "--deps", "upstream"]],
    [center, ["add", "--slug", "work", "--expectations", JSON.stringify([{ node_id: "unused", expectation: "x", promise: "y" }])]],
    [center, ["add", "--slug", "work", "--deps", "upstream", "--expectations", JSON.stringify([{ node_id: "upstream", expectation: "x", promise: "y", ignored: "field" }])]],
  ];
  for (const value of ["0", "-1", "NaN", "Infinity", "", "1e309"]) cases.push([center, ["claim", "--timeout", value]]);
  for (const value of ["0", "-1", "1.5", "NaN"]) cases.push([center, ["renew", "--slug", "work", "--token", value]]);
  for (const value of ["not-json", "null", "[]"]) cases.push([center, ["finish", "--slug", "work", "--token", "1", "--critical", value]]);
  for (const value of ["not-json", "[]", "{}", '{"review":""}', '{"../review":"text"}']) cases.push([center, ["finish", "--slug", "work", "--token", "1", "--deliveries", value]]);
  for (const [project, tail] of cases) {
    f.lane(project, "planner", tail, 1);
    assert(!fs.existsSync(calls), `invalid command invoked Cascade: ${tail.join(" ")}`);
  }
  const invalidProfile = f.project("invalid-profile", "worker", 0);
  f.lane(invalidProfile, "worker", ["claim"], 1);
  assert(!fs.existsSync(calls), "invalid profile lease invoked Cascade");
});

for (const storage of ["file", "git"]) {
  test(`${storage}: authorized exact-failure retry keeps history, peers and later claims intact`, t => {
    const f = fixture(t, storage), center = f.project("center"), worker = f.project("worker", "worker");
    f.lane(center, "planner", ["add", "--slug", "repair", "--reserved-for", "alice", "--required-tier", "pro"]);
    f.lane(center, "planner", ["add", "--slug", "unrelated", "--reserved-for", "bob"]);
    const first = f.claim(worker, "alice", ["--slug", "repair", "--agent-tier", "pro"]);
    f.lane(worker, "alice", ["finish", "--slug", "repair", "--token", first.token, "--fail", "--reason", "review found a content defect"]);
    const events = () => JSON.parse(f.native(["history"])).data.events;
    const before = events();
    const failure = before.findLast(event => event.type === "task_failed" && event.data.node_id === "repair");
    assert(failure?.id);
    const peer = f.nodes().find(node => node.id === "unrelated");
    const retry = ["retry", "--slug", "repair", "--failure-event", failure.id, "--op-id", "repair-attempt-1", "--reason", "existing permission: fix the reviewed defect"];
    const result = JSON.parse(f.lane(center, "planner", retry));
    assert.equal(result.success, true);
    assert.equal(result.data.already_applied, false);
    const ready = f.nodes().find(node => node.id === "repair");
    assert.equal(ready.state, "READY");
    assert.equal(ready.agent_id, undefined);
    assert.equal(ready.reserved_for, "alice");
    assert.equal(ready.required_tier, "pro");
    assert.deepEqual(events().slice(0, before.length), before);
    assert.equal(events().filter(event => event.type === "task_retried").length, 1);
    assert.deepEqual(f.nodes().find(node => node.id === "unrelated"), peer);
    const next = f.claim(worker, "alice", ["--slug", "repair", "--agent-tier", "pro"]);
    assert(BigInt(next.token) > BigInt(first.token));
    const repeated = JSON.parse(f.lane(center, "planner", retry));
    assert.equal(repeated.data.already_applied, true);
    assert.equal(f.nodes().find(node => node.id === "repair").state, "ACTIVE");
    assert.equal(events().filter(event => event.type === "task_retried").length, 1);
    f.lane(worker, "alice", ["finish", "--slug", "repair", "--token", next.token, "--fail", "--reason", "a new failure"]);
    const oldFailure = [...retry];
    oldFailure[oldFailure.indexOf("--op-id") + 1] = "repair-attempt-2";
    assert.equal(JSON.parse(f.lane(center, "planner", oldFailure, 1)).code, "INVALID_INPUT");
    assert.equal(f.nodes().find(node => node.id === "repair").state, "FAILED");
    assert.equal(events().filter(event => event.type === "task_retried").length, 1);
    assert.equal(JSON.parse(f.native(["verify-chain"])).success, true);
  });
}

test("explicit interpreter selects the checked runtime instead of a broken PATH launcher", t => {
  const python = process.env.CASCADE_PYTHON;
  assert(python && path.isAbsolute(python), "CASCADE_PYTHON must select the actual pinned runtime");
  const f = fixture(t), center = f.project("center");
  const before = f.nodes();
  fs.unlinkSync(path.join(f.bin, "cascade"));
  fs.writeFileSync(path.join(f.bin, "cascade"), "#!/bin/sh\nexit 92\n", { mode: 0o755 });
  fs.appendFileSync(path.join(center, ".ai-dev-kit/profile.yml"), "    min_version: >=0.7\n");
  f.lane(center, "planner", ["--python", python, "add", "--slug", "selected-runtime"]);
  assert.equal(f.nodes().length, before.length + 1);
  assert.equal(f.nodes()[0].id, "selected-runtime");
  assert.equal(f.nodes()[0].state, "READY");
});

test("the project's minimum runtime version blocks state access and writes", t => {
  const f = fixture(t), center = f.project("center");
  const before = f.nodes();
  const profile = path.join(center, ".ai-dev-kit/profile.yml");
  const configured = fs.readFileSync(profile, "utf8");
  for (const minimum of ["99.0.0", ">=99.0"]) {
    fs.writeFileSync(profile, configured + `    min_version: ${minimum}\n`);
    const rejected = f.run(process.execPath, [laneScript, "--profile", profile, "--agent", "planner", "add", "--slug", "wrong-runtime"], 1);
    assert.match(rejected.stderr, /below the project's cascade.min_version/);
    assert.equal(rejected.stdout, "");
    assert.deepEqual(f.nodes(), before);
  }
});

test("doctor uses the selected project center and keeps local dispatch errors separate", t => {
  const python = process.env.CASCADE_PYTHON;
  assert(python && path.isAbsolute(python), "CASCADE_PYTHON must select the actual pinned runtime");
  const f = fixture(t, "git"), center = f.project("center"), worker = f.project("worker", "worker");
  fs.appendFileSync(path.join(worker, ".ai-dev-kit/profile.yml"), "    min_version: >=0.7\n");
  f.lane(center, "planner", ["add", "--slug", "unchanged-task", "--open"]);
  const before = JSON.parse(f.native(["history"])).data.events;
  const checked = JSON.parse(f.lane(worker, "alice", ["--python", python, "doctor"]));
  assert.equal(checked.success, true);
  assert.equal(checked.scope, "entrypoint-only");
  assert.equal(checked.protocol.status, "compatible");
  assert.equal(checked.center.storage, "git");
  assert.equal(checked.center.graph_nodes, 1);
  assert.equal(checked.dispatch.status, "not_requested");
  const missing = JSON.parse(f.lane(worker, "another-session", ["--python", python, "doctor", "--dispatch", path.join(f.root, "missing.json")], 1));
  assert.equal(missing.success, false);
  assert.equal(missing.protocol.status, "compatible");
  assert.equal(missing.center.status, "ok");
  assert.equal(missing.dispatch.status, "error");
  assert.equal(missing.dispatch.execution, "not_run");
  assert(missing.errors.some(error => error.scope === "dispatch" && error.code === "FILE_MISSING"));
  assert.deepEqual(JSON.parse(f.native(["history"])).data.events, before);
  assert.equal(f.nodes()[0].state, "READY");
});

test("an empty worker pool preserves native NO_READY_TASKS without a phantom claim", t => {
  const f = fixture(t), center = f.project("center"), worker = f.project("worker", "worker");
  const empty = f.lane(worker, "worker", ["claim", "--agent-tier", "pro"], 1);
  assert.equal(JSON.parse(empty).code, "NO_READY_TASKS");
  assert.doesNotMatch(empty, /fencing_token:/);
  assert.deepEqual(f.nodes(), []);
  f.lane(center, "planner", ["add", "--slug", "hard-work", "--open", "--required-tier", "max"]);
  const mismatch = JSON.parse(f.lane(worker, "worker", ["claim", "--agent-tier", "pro"], 1));
  assert.equal(mismatch.code, "INSUFFICIENT_TIER");
  assert.equal(f.nodes()[0].state, "READY");
  assert.equal(f.nodes()[0].agent_id, undefined);
});

test("two real Git worker caches can race open work with exactly one owner", async t => {
  const f = fixture(t, "git"), center = f.project("center"), alice = f.project("alice", "worker"), bob = f.project("bob", "worker");
  f.lane(center, "planner", ["add", "--slug", "shared-work", "--open", "--required-tier", "pro"]);
  const claims = await Promise.all([
    f.start(alice, "alice", ["claim", "--agent-tier", "pro"]),
    f.start(bob, "bob", ["claim", "--agent-tier", "pro"]),
  ]);
  assert.deepEqual(claims.map(result => result.code).sort(), [0, 1], JSON.stringify(claims));
  const winner = claims.find(result => result.code === 0), loser = claims.find(result => result.code === 1);
  assert.equal(JSON.parse(loser.stdout).code, "NO_READY_TASKS");
  assert.equal(winner.signal, null);
  assert.equal(loser.signal, null);
  const token = winner.stdout.match(/fencing_token:\s*(\d+)/)?.[1];
  assert(token);
  const node = f.nodes()[0];
  assert.equal(node.id, "shared-work");
  assert.equal(node.agent_id, winner.agent);
  assert.equal(node.state, "ACTIVE");
  f.lane(winner.agent === "alice" ? alice : bob, winner.agent, ["finish", "--slug", "shared-work", "--token", token, "--summary", "local Git fixture completed"]);
  assert.equal(f.nodes()[0].state, "COMPLETED");
  assert.equal(JSON.parse(f.native(["verify-chain"])).success, true);
});
