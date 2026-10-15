// Perspective: the center publishing an employee's reviewed portal proposal.
// Invariant: exactly one bound implementation/review pair, or no graph change;
// existing leases, contracts and history survive publication and explicit readback.
// Goal: catch partial native publication, stale contracts and silent overwrites.
// Migration: keep these real Git/Cascade boundary tests with the publishing CLI.
"use strict";
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { nativeSpecs } = require("../scripts/cascade-portal.cjs");

const python = process.env.CASCADE_PYTHON;
assert(python && path.isAbsolute(python) && fs.existsSync(python),
  "CASCADE_PYTHON must name the explicit real Cascade 0.8 interpreter; this integration suite never skips or uses a fake adapter");
const script = path.resolve(__dirname, "../scripts/cascade-portal-publish.py");
const requestId = "fd123456-abcd-4abc-8abc-123456789abc";
const taskId = "portal-fd123456-abcd-4abc-8abc-123456789abc";
const reviewId = taskId + "-review";
const namespace = "portal-publish-test";
const nativeSetup = `
import sys
from cascade import CascadeClient
from cascade.storage.git_storage import GitStorage
from cascade.types import Contract
c = CascadeClient(GitStorage(sys.argv[1], namespace=sys.argv[2], cache_dir=sys.argv[3]))
for name in ('root', 'baseline', 'peer'):
    deps = {'root': Contract('Keep the approved baseline expectation', 'Keep the original baseline promise')} if name == 'baseline' else None
    assert c.add(name, deps=deps, required_tier='pro', reserved_for='other-worker' if name == 'peer' else None).success
claimed = c.claim('fixture-root', task_id='root', agent_tier='pro', timeout=1800)
assert claimed.success
completed = c.complete('root', agent_id='fixture-root', token=claimed.data['token'], critical={'keep': 'original'}, summary='keep summary', artifacts='keep artifact', deliverables={'baseline': 'Fixture-approved baseline receipt'})
assert completed.success, completed.message
assert c.claim('other-worker', task_id='peer', agent_tier='pro', timeout=1800).success
`;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...options });
}
function ok(result) { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout; }
function plan(tier = "lite") {
  return nativeSpecs({ id: requestId, state: "planned", version: 2, proposal: {
    title: "离线说明 🪷", goal: "让员工用已批准的旁车入口验证离线运行。",
    scope: ["完善五个现有说明文件"], nonGoals: ["不改业务代码、模型或生产配置"],
    acceptance: ["实际离线验证并独立复审，保留原门禁"], requiredTier: tier,
    baseSha: "1234567890abcdef1234567890abcdef12345678", dependencies: ["baseline"],
  } }, "root");
}
function fixture(t, value = plan()) {
  assert(path.isAbsolute(python), "CASCADE_PYTHON must name the explicit approved interpreter");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-portal-publish-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git"), specs = path.join(directory, "specs.json");
  const git = args => ok(run("git", ["--git-dir", remote, ...args]));
  ok(run("git", ["init", "--bare", "--quiet", remote]));
  const native = code => ok(run(python, ["-c", code, remote, namespace, path.join(directory, "setup-cache")]));
  native(nativeSetup);
  fs.writeFileSync(specs, JSON.stringify(value));
  const args = (cache = "publish-cache") => [script, "--remote", remote, "--namespace", namespace, "--root-task", "root",
    "--cache-dir", path.join(directory, cache), "--specs-file", specs,
    "--role", "orchestrator", "--actor", "codex-team-center"];
  const snapshot = () => ({
    ref: git(["rev-parse", `refs/heads/cascade-state/${namespace}`]).trim(),
    graph: JSON.parse(git(["show", `refs/heads/cascade-state/${namespace}:data/graph.json`])),
    events: git(["show", `refs/heads/cascade-state/${namespace}:data/events.jsonl`]).trim().split("\n").map(line => JSON.parse(line)),
  });
  return { directory, remote, specs, git, native, args, snapshot,
    publish: (cache, options) => run(python, args(cache), options),
    write: next => fs.writeFileSync(specs, typeof next === "string" ? next : JSON.stringify(next)),
  };
}
function checkUntouched(before, after) {
  for (const [id, node] of Object.entries(before.graph.nodes)) assert.deepEqual(after.graph.nodes[id], node);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.graph.epoch, before.graph.epoch);
  for (const edge of before.graph.edges) assert(after.graph.edges.some(item => JSON.stringify(item) === JSON.stringify(edge)));
}
function assertRejected(f, expected, options) {
  const before = f.snapshot(), result = f.publish(undefined, options);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, expected);
  assert.equal(result.stdout, "");
  assert.deepEqual(f.snapshot(), before, "a rejected publication must not change the remote state");
}

test("publisher version policy accepts the approved 0.8.0 and 0.8.1 releases and their local builds, not other releases or malformed labels", () => {
  const result = run(python, ["-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("publisher", sys.argv[1])
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
for value in ("0.8.0", "0.8.0+supervisor.1", "0.8.0+COMPANY-2_fix", "0.8.1", "0.8.1+supervisor.1"):
    publisher.check_runtime_version(value)
for value in ("0.7.9+supervisor.999", "0.8.2", "0.8.10", "0.9.0", "0.8.0rc1", "0.8.1rc1", "0.8.0.dev1", "0.8.1.post1", "0.8.0+", "0.8.1+", "0.8.0+bad..label", "0.8.1+bad/", "0.8.0garbage", "10.8.1", "0.8.1\\n"):
    try:
        publisher.check_runtime_version(value)
    except publisher.PublishError:
        pass
    else:
        raise AssertionError(value)
`, script]);
  ok(result);
});

describe("portal publisher with real native Cascade 0.8 and bare Git", () => {
  test("creates one complete pair in one native commit and preserves an ACTIVE peer", { timeout: 60000 }, t => {
    const p = plan(), f = fixture(t, p), before = f.snapshot();
    assert.deepEqual(before.graph.edges, [{ from: "root", to: "baseline",
      expectation: "Keep the approved baseline expectation", promise: "Keep the original baseline promise" }]);
    const output = JSON.parse(ok(f.publish())), after = f.snapshot();
    assert.deepEqual(output.taskIds, [taskId, reviewId]);
    assert.equal(output.proposalVersion, 2);
    assert.equal(output.proposalSha256, p.contract.proposalSha256);
    assert.equal(output.actor, "codex-team-center");
    assert.equal(output.alreadyPublished, false);
    assert.equal(output.readbackVerified, true);
    assert(!/token|claim_token/.test(JSON.stringify(output)));
    checkUntouched(before, after);
    assert.equal(Object.keys(after.graph.nodes).length, 5);
    assert.equal(after.graph.nodes[taskId].required_tier, "lite");
    assert.equal(Object.hasOwn(after.graph.nodes[taskId], "reserved_for"), false);
    assert.equal(after.graph.nodes[taskId].state, "PENDING");
    assert.equal(after.graph.nodes[reviewId].required_tier, "pro");
    assert.equal(after.graph.nodes[reviewId].reserved_for, "codex-team-center");
    assert.equal(after.graph.nodes[reviewId].state, "PENDING");
    assert.equal(after.graph.edges.length, before.graph.edges.length + 3);
    for (const spec of p.specs) for (const [dep, edge] of Object.entries(spec.deps)) {
      assert.deepEqual(after.graph.edges.find(item => item.from === dep && item.to === spec.node_id), { from: dep, to: spec.node_id, ...edge });
    }
    const events = after.events.slice(before.events.length);
    assert.deepEqual(events.map(e => [e.type, e.data.node_id]), [["node_added", taskId], ["node_added", reviewId]]);
    assert.equal(events[0].trace_id, events[1].trace_id);
    assert.equal(f.git(["rev-list", "--count", `${before.ref}..${after.ref}`]).trim(), "1");
    f.native(`
import sys
from cascade.storage.git_storage import GitStorage
from cascade.replay import replay, verify
s = GitStorage(sys.argv[1], namespace=sys.argv[2], cache_dir=sys.argv[3] + '-audit')
with s.lock():
    g, e = s.load(), s.events.read_all()
    assert s.events.verify_chain()[0]
    assert not verify(e, g, s.content)
    assert replay(e, s.content).contracts == g.contracts
`);
    const again = JSON.parse(ok(f.publish("independent-cache")));
    assert.equal(again.alreadyPublished, true);
    assert.deepEqual(f.snapshot(), after, "idempotency must not add an event or commit");
  });

  test("max-tier proposals retain max independent review", t => {
    const f = fixture(t, plan("max")); ok(f.publish());
    assert.equal(f.snapshot().graph.nodes[reviewId].required_tier, "max");
  });

  test("repeated full contracts can exceed the proposal POST size limit", t => {
    const proposal = plan().contract.proposal;
    proposal.goal = "完整方案".repeat(4000);
    const f = fixture(t, nativeSpecs({ id: requestId, state: "planned", version: 2, proposal }, "root"));
    assert(fs.statSync(f.specs).size > 128 * 1024);
    assert.equal(JSON.parse(ok(f.publish())).readbackVerified, true);
  });

  test("an existing implementation alone is rejected, never repaired implicitly", t => {
    const f = fixture(t);
    f.native(nativeSetup.split("for name")[0] + `assert c.add('${taskId}', required_tier='lite').success`);
    assertRejected(f, /Only one portal task exists/);
  });

  test("both matching IDs with a changed edge promise are not idempotent", t => {
    const f = fixture(t);
    f.native(nativeSetup.split("for name")[0] + `
import json
with open(${JSON.stringify(f.specs)}) as source:
    p = json.load(source)
p['specs'][0]['deps']['root']['promise'] = 'different promise'
for spec in p['specs']:
    spec['deps'] = {dep: Contract(**edge) for dep, edge in spec['deps'].items()}
assert c.add_batch(p['specs']).success
`);
    assertRejected(f, /Existing task dependencies or complete contracts differ/);
  });

  test("a revised proposal cannot overwrite the existing pair", t => {
    const f = fixture(t); ok(f.publish());
    const next = plan("max"); next.contract.proposalVersion = 3;
    // Obtain a new valid server payload, not an implementation-derived expected hash.
    const request = { id: requestId, state: "planned", version: 3, proposal: next.contract.proposal };
    f.write(nativeSpecs(request, "root"));
    assertRejected(f, /Existing task tier or reservation differs/);
  });

  test("missing upstream fails the entire native batch without publishing either node", t => {
    const next = plan();
    next.contract.proposal.dependencies = ["missing-upstream"];
    const f = fixture(t, nativeSpecs({ id: requestId, state: "planned", version: 2, proposal: next.contract.proposal }, "root"));
    assertRejected(f, /Native add_batch did not confirm publication \[BATCH_INVALID_SPEC\].*Dependency missing-upstream not found/);
  });

  test("invalid bindings and unreviewed spec fields fail before any Git write", t => {
    const f = fixture(t);
    for (const [name, change] of [
      ["uuid", p => { p.contract.requestId = "not-a-uuid"; }],
      ["version", p => { p.contract.proposalVersion = true; }],
      ["digest", p => { p.contract.proposalSha256 = "0".repeat(64); }],
      ["ids", p => { p.taskIds[0] = "arbitrary-task"; }],
      ["scope", p => { p.contract.proposal.scope = []; }],
      ["extra", p => { p.specs[0].dependents = { peer: {} }; }],
      ["reservation", p => { p.specs[1].reserved_for = "employee"; }],
      ["review-tier", p => { p.specs[1].required_tier = "lite"; }],
      ["expectation", p => { p.specs[0].deps.root.expectation = "summary only"; }],
      ["promise", p => { p.specs[1].deps[taskId].promise = "skip review"; }],
      ["dependencies", p => { delete p.specs[0].deps.baseline; }],
      ["root", p => { delete p.specs[0].deps.root; }],
      ["version-type", p => { p.contract.proposalVersion = "2"; }],
      ["uuid-type", p => { p.contract.requestId = []; }],
      ["title-type", p => { p.contract.proposal.title = { title: "text" }; }],
      ["goal-type", p => { p.contract.proposal.goal = 42; }],
      ["scope-type", p => { p.contract.proposal.scope = "scope"; }],
      ["entry-type", p => { p.contract.proposal.acceptance = [false]; }],
      ["tier-type", p => { p.contract.proposal.requiredTier = ["lite"]; }],
      ["base-type", p => { p.contract.proposal.baseSha = null; }],
      ["dependency-type", p => { p.contract.proposal.dependencies = [42]; }],
      ["unicode", p => { p.contract.proposal.goal = "bad\ud800"; }],
    ]) {
      const p = plan(); change(p); f.write(p);
      assertRejected(f, /cascade-portal-publish:/);
      assert(!fs.existsSync(path.join(f.directory, "publish-cache")), `${name} should be rejected before storage initialization`);
    }
    f.write('{"contract":{},"contract":{},"taskIds":[],"specs":[]}');
    assertRejected(f, /Duplicate JSON key/);
  });

  test("another existing node cannot replace the configured project root", t => {
    const f = fixture(t), proposal = plan().contract.proposal;
    f.write(nativeSpecs({ id: requestId, state: "planned", version: 2, proposal }, "peer"));
    assertRejected(f, /configured project root/);
    assert(!fs.existsSync(path.join(f.directory, "publish-cache")));
  });

  test("credential-bearing proposal URLs are rejected even with a valid canonical hash", t => {
    const f = fixture(t), proposal = plan().contract.proposal;
    proposal.goal = "Read https://alice:private-password@example.invalid/project";
    f.write(nativeSpecs({ id: requestId, state: "planned", version: 2, proposal }, "root"));
    const before = f.snapshot(), result = f.publish();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /credential-bearing URI/);
    assert(!result.stderr.includes("private-password"));
    assert.deepEqual(f.snapshot(), before);
    assert(!fs.existsSync(path.join(f.directory, "publish-cache")));
  });

  test("HTTPS username-only tokens and URI passwords never reach Git or error output", t => {
    const f = fixture(t), before = f.snapshot();
    for (const remote of ["https://private-token@example.invalid/project.git", "https://alice:private-password@example.invalid/project.git", "ssh://alice:private-password@example.invalid/project.git"]) {
      const args = f.args(); args[args.indexOf("--remote") + 1] = remote;
      const result = run(python, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Credential-bearing Git remote is forbidden/);
      assert(!/private-token|private-password/.test(result.stdout + result.stderr));
      assert.equal(result.stdout, "");
      assert.deepEqual(f.snapshot(), before);
      assert(!fs.existsSync(path.join(f.directory, "publish-cache")));
    }
  });

  test("runtime errors retain the cause but redact URI credentials", t => {
    const f = fixture(t), args = f.args();
    args[args.indexOf("--namespace") + 1] = "https://alice:private-password@example.invalid/project";
    const before = f.snapshot(), result = run(python, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ValueError: namespace is not a valid Git ref component/);
    assert(!result.stderr.includes("private-password"));
    assert.deepEqual(f.snapshot(), before);
    // Exercise the same formatter with the actionable URI-bearing error shape.
    const output = ok(run(python, ["-c", `
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('portal_publish', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.redact('Git denied https://alice:private-password@example.invalid/repo', incomplete=True))
`, script]));
    assert.equal(output.trim(), "Git denied https://<redacted>@example.invalid/repo");
  });

  test("worker role and wrong center actor are rejected without initializing storage", t => {
    const f = fixture(t), before = f.snapshot();
    for (const [flag, value] of [["--role", "worker"], ["--actor", "employee"]]) {
      const args = f.args(); args[args.indexOf(flag) + 1] = value;
      const result = run(python, args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.deepEqual(f.snapshot(), before);
    }
    assert(!fs.existsSync(path.join(f.directory, "publish-cache")));
  });

  test("Git directory overrides cannot redirect a publication into another checkout", t => {
    const f = fixture(t);
    assertRejected(f, /Unset inherited Git/, { env: { ...process.env, GIT_COMMON_DIR: f.remote } });
    assert(!fs.existsSync(path.join(f.directory, "publish-cache")));
  });

  test("independent concurrent callers never duplicate the native pair", { timeout: 60000 }, async t => {
    const f = fixture(t), before = f.snapshot();
    const execute = cache => new Promise((resolve, reject) => {
      const child = spawn(python, f.args(cache), { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
      child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
    });
    const results = await Promise.all([execute("race-a"), execute("race-b")]);
    assert(results.some(result => result.status === 0));
    for (const result of results) {
      assert([0, 1].includes(result.status), result.stderr);
      if (result.status === 1) assert.match(result.stderr, /Native add_batch did not confirm publication/);
    }
    const after = f.snapshot(); checkUntouched(before, after);
    assert.equal(Object.keys(after.graph.nodes).length, 5);
    assert.equal(after.events.length, before.events.length + 2);
    assert.equal(f.git(["rev-list", "--count", `${before.ref}..${after.ref}`]).trim(), "1");
    assert.equal(JSON.parse(ok(f.publish("race-readback"))).alreadyPublished, true);
    assert.deepEqual(f.snapshot(), after);
  });
});
