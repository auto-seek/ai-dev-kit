// Perspective: workers and coordinators checking the interpreter they will use.
// Invariant: local configuration failures preserve successful protocol evidence;
// self-checks read real existing graphs/history without claiming or changing work.
// Goal: detect unreadable retry history, accidental center creation, stale Git
// snapshots, leaked configuration secrets and execution disguised as validation.
// Migration: keep this real-backend contract with the doctor entrypoint; require
// an explicit pinned CASCADE_PYTHON and never replace Cascade with project mocks.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const python = process.env.CASCADE_PYTHON;
const doctorScript = process.env.CASCADE_DOCTOR_SCRIPT || path.resolve(__dirname, "../scripts/cascade-doctor.py");
assert(python && path.isAbsolute(python) && fs.existsSync(python), "CASCADE_PYTHON must name the real pinned Cascade >=0.8 interpreter; this suite never skips or fakes the engine");

function fixture(t, backend = "file") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-doctor-"));
  const store = path.join(root, "state"), remote = path.join(root, "center.git");
  const cache = path.join(root, "doctor-cache"), namespace = "doctor-contract";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of ["PYTHONPATH", "AI_DEV_KIT_CASCADE_GIT_REMOTE", "AI_DEV_KIT_CASCADE_REDIS_URL"])
    delete env[name];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args, expected = 0) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result;
  };
  const minimum = run(python, ["-B", "-c", "import cascade; from cascade.events import EventType; assert tuple(map(int, cascade.__version__.split('+', 1)[0].split('.'))) >= (0,8,0); assert EventType('task_retried').value == 'task_retried'"]);
  assert.equal(minimum.stderr, "");
  if (backend === "git") run("git", ["init", "--bare", "--quiet", remote]);
  const base = backend === "file" ? ["--storage", store] : ["--git-remote", remote, "--git-cache", cache, "--namespace", namespace];
  const nativeBase = backend === "file" ? base : ["--git-remote", remote, "--git-cache", path.join(root, "native-cache"), "--namespace", namespace];
  const native = tail => run(python, ["-B", "-m", "cascade.cli", ...nativeBase, ...tail]).stdout;
  const stateRef = `refs/heads/cascade-state/${namespace}`;
  const read = name => backend === "file" ? fs.readFileSync(path.join(store, name), "utf8")
    : run("git", ["--git-dir", remote, "show", `${stateRef}:data/${name}`]).stdout;
  const events = () => read("events.jsonl").trim().split("\n").map(line => JSON.parse(line));
  const snapshot = () => backend === "file"
    ? JSON.stringify(fs.readdirSync(store, { recursive: true }).sort().filter(name => fs.statSync(path.join(store, name)).isFile()).map(name => [name, fs.readFileSync(path.join(store, name)).toString("base64")]))
    : run("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
  const doctor = (tail = [], expected = 0, selection = base) => {
    const result = run(python, ["-B", doctorScript, "--agent", "doctor-agent", ...selection, ...tail], expected);
    assert.equal(result.stderr, "", "doctor must expose only its structured report, not native command logs");
    return { report: JSON.parse(result.stdout), output: result.stdout };
  };
  const seed = () => {
    native(["add-node", "--id", "retry-work"]);
    native(["add-node", "--id", "peer-work"]);
    const claim = native(["get-task", "--task", "retry-work", "--agent", "fixture-worker", "--timeout", "1800"]);
    const token = claim.match(/fencing_token:\s*(\d+)/)?.[1];
    assert(token, claim);
    native(["finish-task", "--task", "retry-work", "--agent", "fixture-worker", "--token", token, "--fail", "--reason", "fixture acceptance failed"]);
    const failure = events().find(event => event.type === "task_failed");
    assert(failure);
    native(["retry-task", "--task", "retry-work", "--agent", "fixture-center", "--failure-event", failure.id, "--reason", "fixture retry authorized", "--op-id", "fixture-retry-once"]);
    native(["get-task", "--task", "peer-work", "--agent", "peer-worker", "--timeout", "1800"]);
    assert.equal(events().filter(event => event.type === "task_retried").length, 1);
  };
  const dispatch = (change = () => {}) => {
    const marker = path.join(root, "dispatch-command-executed");
    const command = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'not allowed')`];
    const document = {
      coordination: { git_remote: remote, namespace, cache_dir: path.join(root, "worker-cache") },
      task: { id: "retry-work", prompt: "private prompt bearer abc-secret-do-not-print", allowed_paths: ["src/**"], validation_commands: [command], preflight_command: command, timeout_seconds: 120 },
      repository: { remote, base_ref: "a".repeat(40), base_branch: "main", bootstrap_commands: [command] },
      harness: { command, auth_command: command, version_command: command },
      worker: { agent_id: "doctor-agent", agent_tier: "pro", workspace_root: path.join(root, "workspace"), lease_seconds: 180, renew_interval_seconds: 30 },
      publication: { remote, branch_prefix: "codex/worker" },
    };
    change(document);
    const file = path.join(root, `dispatch-${crypto.randomUUID()}.json`);
    const raw = JSON.stringify(document);
    fs.writeFileSync(file, raw);
    return { file, raw, marker, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
  };
  return { root, store, remote, cache, namespace, base, stateRef, env, run, native, read, events, snapshot, doctor, seed, dispatch };
}

test("runtime version policy accepts release-local builds and rejects malformed or prerelease suffixes", () => {
  const result = spawnSync(python, ["-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("doctor", sys.argv[1])
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)
for value in ("0.8.0", "0.8.0+supervisor.1", "0.8.0+COMPANY-2_fix"):
    assert doctor.version_tuple(value) == (0, 8, 0), value
assert doctor.version_tuple("0.7.9+supervisor.999") < (0, 8, 0)
assert doctor.version_tuple(">=0.8", minimum=True) == (0, 8, 0)
for value in ("0.8.0+", "0.8.0+bad..label", "0.8.0+bad/", "0.8.0garbage", "0.8.0rc1", "0.8.0.dev1", "0.8.0+_bad", "０.8.0"):
    try:
        doctor.version_tuple(value)
    except doctor.CheckError as error:
        assert error.code == "INVALID_VERSION"
    else:
        raise AssertionError(value)
try:
    doctor.version_tuple(">=0.8.0+local", minimum=True)
except doctor.CheckError as error:
    assert error.code == "INVALID_VERSION"
else:
    raise AssertionError("minimum constraints must remain public release versions")
`, doctorScript], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("real file retry history proves this runtime's capability without mutating work", t => {
  const f = fixture(t);
  f.seed();
  const before = f.snapshot(), graph = JSON.parse(f.read("graph.json"));
  const { report } = f.doctor();
  assert.equal(report.schema_version, 1);
  assert.equal(report.success, true);
  assert.equal(report.scope, "entrypoint-only");
  assert.equal(report.runtime.status, "ok");
  assert.equal(report.runtime.sys_executable, python);
  assert.equal(report.runtime.sys_prefix, path.dirname(path.dirname(python)));
  assert.match(report.runtime.module_path, /cascade\/__init__\.py$/);
  assert.equal(report.runtime.required_version, "0.8.0");
  const metadata = JSON.parse(f.run(python, ["-B", "-c", "import importlib.metadata as m; print(m.distribution('cascade-auto').read_text('direct_url.json'))"]).stdout);
  // The runtime under test may be a reviewed wheel or the documented pinned Git install.
  if (metadata.vcs_info) {
    assert.equal(report.runtime.source.kind, "vcs");
    assert.equal(report.runtime.source.commit_id, metadata.vcs_info.commit_id.toLowerCase());
  } else {
    assert.equal(report.runtime.source.kind, "archive");
    assert.equal(report.runtime.source.sha256, metadata.archive_info.hashes.sha256.toLowerCase());
  }
  assert.equal(Object.hasOwn(report.runtime.source, "url"), false);
  assert.equal(report.protocol.status, "compatible");
  assert.equal(report.protocol.task_retried, true);
  assert.match(report.protocol.scope, /other machines and running processes are not checked/);
  assert.deepEqual(report.center, { status: "ok", storage: "file", graph_nodes: 2, event_count: 6, event_chain_valid: true, task_retried_events: 1 });
  assert.deepEqual(report.dispatch, { status: "not_requested", execution: "not_run" });
  assert.match(report.limitations, /do not prove harness execution, business readiness, authorization/);
  assert.deepEqual(report.errors, []);
  assert.equal(f.snapshot(), before);
  assert.equal(graph.nodes["retry-work"].state, "READY");
  assert.equal(graph.nodes["peer-work"].state, "ACTIVE");
  assert.equal(f.doctor(["--min-version", ">= 0.7.0"]).report.runtime.required_version, "0.8.0");
  assert.equal(f.doctor(["--min-version", ">=0.7"]).report.runtime.required_version, "0.8.0");
  assert.equal(f.snapshot(), before);
});

test("Git doctor refreshes an existing cache and leaves business state and remote refs unchanged", t => {
  const f = fixture(t, "git");
  f.seed();
  assert.equal(f.doctor().report.center.event_count, 6);
  f.native(["add-node", "--id", "new-remote-work"]);
  const before = f.snapshot(), graph = f.read("graph.json"), events = f.read("events.jsonl");
  const { report } = f.doctor();
  assert.equal(report.center.storage, "git");
  assert.equal(report.center.graph_nodes, 3);
  assert.equal(report.center.event_count, 7);
  assert.equal(report.center.task_retried_events, 1);
  assert.equal(report.center.event_chain_valid, true);
  assert.equal(f.snapshot(), before, "no state, lease or other remote ref may be left changed");
  assert.equal(f.read("graph.json"), graph);
  assert.equal(f.read("events.jsonl"), events);
});

test("valid native dispatch is hashed and matched but none of its commands run", t => {
  const f = fixture(t, "git");
  f.seed();
  const dispatch = f.dispatch(), before = f.snapshot();
  const { report, output } = f.doctor(["--dispatch", dispatch.file]);
  assert.equal(report.success, true);
  assert.deepEqual(report.dispatch, { status: "valid", execution: "not_run", sha256: dispatch.sha256, native_config_valid: true, center_matches: true, agent_matches: true });
  assert.equal(fs.existsSync(dispatch.marker), false);
  assert.equal(fs.existsSync(path.join(f.root, "workspace")), false);
  assert.equal(fs.readFileSync(dispatch.file, "utf8"), dispatch.raw);
  assert.equal(f.snapshot(), before);
  assert.doesNotMatch(output, /abc-secret-do-not-print|writeFileSync|bootstrap_commands|validation_commands/);
});

test("schema-valid dispatch may name an unavailable harness without claiming execution readiness", t => {
  const f = fixture(t, "git");
  f.seed();
  const dispatch = f.dispatch(doc => {
    doc.harness.command = ["nonexistent-harness-for-doctor", "-c", "arbitrary-language-body"];
    doc.harness.auth_command = ["sh", "scripts/not-a-known-whitelist-entry.sh"];
  });
  const { report } = f.doctor(["--dispatch", dispatch.file]);
  assert.equal(report.dispatch.status, "valid");
  assert.equal(report.dispatch.execution, "not_run");
  assert.equal(fs.existsSync(dispatch.marker), false);
});

test("missing, malformed and native-schema-invalid dispatch retain successful protocol and center checks", t => {
  const f = fixture(t, "git");
  f.seed();
  const bad = f.dispatch(doc => { doc.task.timeout_seconds = false; });
  const malformed = path.join(f.root, "malformed.json");
  fs.writeFileSync(malformed, '{"private":"Bearer secret-malformed-config", broken');
  for (const [file, code] of [[path.join(f.root, "missing.json"), "FILE_MISSING"], [bad.file, "DISPATCH_INVALID"], [malformed, "DISPATCH_INVALID"]]) {
    const before = f.snapshot();
    const { report, output } = f.doctor(["--dispatch", file], 1);
    assert.equal(report.success, false);
    assert.equal(report.runtime.status, "ok");
    assert.equal(report.protocol.status, "compatible");
    assert.equal(report.center.status, "ok");
    assert.equal(report.dispatch.status, "error");
    assert.equal(report.dispatch.execution, "not_run");
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].scope, "dispatch");
    assert.equal(report.errors[0].code, code);
    if (file === bad.file)
      assert.equal(report.errors[0].message, "Native dispatch validation: task.timeout_seconds must be a positive finite number");
    if (file === malformed)
      assert.match(report.errors[0].message, /^Dispatch JSON at line 1, column \d+: Expecting property name enclosed in double quotes\.$/);
    if (file !== path.join(f.root, "missing.json"))
      assert.equal(report.dispatch.sha256, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    assert.equal(f.snapshot(), before);
    assert.doesNotMatch(output, /abc-secret-do-not-print|secret-malformed-config/);
  }
});

test("dispatch rejects another center namespace, remote or agent without executing any commands", t => {
  const f = fixture(t, "git");
  f.seed();
  for (const [change, code] of [
    [doc => { doc.coordination.namespace = "another-center"; }, "DISPATCH_CENTER_MISMATCH"],
    [doc => { doc.coordination.git_remote = path.join(f.root, "other.git"); }, "DISPATCH_CENTER_MISMATCH"],
    [doc => { doc.worker.agent_id = "another-agent"; }, "DISPATCH_AGENT_MISMATCH"],
  ]) {
    const dispatch = f.dispatch(change), before = f.snapshot();
    const { report } = f.doctor(["--dispatch", dispatch.file], 1);
    assert.equal(report.protocol.status, "compatible");
    assert.equal(report.center.status, "ok");
    assert.equal(report.dispatch.native_config_valid, true);
    assert.equal(report.dispatch.status, "error");
    assert.equal(report.errors[0].code, code);
    assert.equal(fs.existsSync(dispatch.marker), false);
    assert.equal(f.snapshot(), before);
  }
});

test("missing file graph and missing formal Git state refuse implicit center creation", t => {
  const f = fixture(t);
  const missing = f.doctor([], 1).report;
  assert.equal(missing.errors[0].code, "CENTER_MISSING");
  assert.equal(fs.existsSync(f.store), false);
  const abbreviated = f.doctor(["--min-version", ">=999.0"], 1).report;
  assert.equal(abbreviated.runtime.required_version, "999.0.0");
  assert.equal(abbreviated.errors[0].code, "RUNTIME_TOO_OLD");
  assert.equal(abbreviated.center.status, "not_checked");
  assert.equal(fs.existsSync(f.store), false);
  const g = fixture(t, "git"), before = g.snapshot();
  const report = g.doctor([], 1).report;
  assert.equal(report.errors[0].code, "CENTER_MISSING");
  assert.equal(report.center.status, "error");
  assert.equal(g.snapshot(), before);
  assert.equal(fs.existsSync(g.cache), false, "absent formal state must fail before constructing native Git storage");
  f.seed();
  fs.unlinkSync(path.join(f.store, "graph.json"));
  const orphaned = f.snapshot();
  assert.equal(f.doctor([], 1).report.errors[0].code, "CENTER_MISSING");
  assert.equal(f.snapshot(), orphaned, "remaining history must not be used to regenerate a missing graph");
});

test("a tampered middle event fails native chain verification without replaying or repairing the graph", t => {
  const f = fixture(t);
  f.seed();
  const entries = f.events();
  entries[2].data.injected = "private-event-data-do-not-print";
  fs.writeFileSync(path.join(f.store, "events.jsonl"), entries.map(event => JSON.stringify(event)).join("\n") + "\n");
  const before = f.snapshot();
  const { report, output } = f.doctor([], 1);
  assert.equal(report.runtime.status, "ok");
  assert.equal(report.center.status, "error");
  assert.equal(report.errors[0].code, "EVENT_CHAIN_INVALID");
  assert.equal(f.snapshot(), before);
  assert.doesNotMatch(output, /private-event-data-do-not-print/);
});

test("unknown historical event and damaged graph fail closed without leaking their contents", t => {
  for (const damage of ["event", "graph"]) {
    const f = fixture(t);
    f.seed();
    if (damage === "event") {
      const events = f.events();
      events[0].type = "unknown-event-with-private-secret";
      fs.writeFileSync(path.join(f.store, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    } else {
      const graph = JSON.parse(f.read("graph.json"));
      graph.nodes["retry-work"].state = "unknown-state-with-private-secret";
      fs.writeFileSync(path.join(f.store, "graph.json"), JSON.stringify(graph));
    }
    const before = f.snapshot();
    const { report, output } = f.doctor([], 1);
    assert.equal(report.center.status, "error");
    assert.equal(report.errors[0].scope, "center");
    assert.equal(report.errors[0].error_type, "StorageCorruptionError");
    assert.equal(f.snapshot(), before);
    assert.doesNotMatch(output, /with-private-secret/);
  }
});

test("minimum version is enforced before touching center and malformed constraints are input failures", t => {
  const f = fixture(t);
  const { report } = f.doctor(["--min-version", ">=999.0.0"], 1);
  assert.equal(report.runtime.required_version, "999.0.0");
  assert.equal(report.runtime.status, "error");
  assert.equal(report.protocol.status, "error");
  assert.equal(report.center.status, "not_checked");
  assert.equal(report.errors[0].code, "RUNTIME_TOO_OLD");
  assert.equal(fs.existsSync(f.store), false);
  const invalid = f.doctor(["--min-version", ">=0.8.0 || token=private-constraint"], 1);
  assert.equal(invalid.report.errors[0].scope, "input");
  assert.equal(invalid.report.errors[0].code, "INVALID_VERSION");
  assert.doesNotMatch(invalid.output, /private-constraint/);
});

test("credential-bearing unreachable Git and native invalid config errors never expose secrets", t => {
  const f = fixture(t);
  const selection = ["--git-remote", "http://alice:password-super-private@127.0.0.1:1/center.git?token=query-private", "--git-cache", f.cache, "--namespace", "doctor-contract"];
  const unreachable = f.doctor([], 1, selection);
  assert.equal(unreachable.report.errors[0].scope, "center");
  assert.equal(unreachable.report.errors[0].code, "CENTER_UNREACHABLE");
  assert.doesNotMatch(unreachable.output, /alice|password-super-private|query-private|http:\/\//);
  f.seed();
  for (const change of [
    doc => { doc.worker.agent_tier = "plain-secret-tier-input"; },
    doc => { doc.repository.remote = "http://[bracket-host-private]/project.git"; },
  ]) {
    const dispatch = f.dispatch(change);
    const invalid = f.doctor(["--dispatch", dispatch.file], 1);
    assert.equal(invalid.report.dispatch.status, "error");
    assert.equal(invalid.report.errors[0].scope, "dispatch");
    assert.doesNotMatch(invalid.output, /plain-secret-tier-input|abc-secret-do-not-print|bracket-host-private/);
  }
});
