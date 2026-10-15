// Perspective: teams handing verified Git changes from a worker to a merger.
// Invariant: only the selected requirements and the exact successfully validated
// checkout can authorize merge; configuration errors and process failures stay red.
// Goal: catch skipped project validation, stale receipts and cross-branch ledger debt.
// Migration: keep these public-command contracts alongside the shipped gate; all
// repositories, scripts, process groups and Git state below are real local fixtures.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");
const kit = path.resolve(__dirname, "..");
const gatePath = path.join(kit, "scripts/skill-first-gate.sh");
const helperPath = path.join(kit, "scripts/project-gate-evidence.cjs");
const workflow = ".ai-dev-kit/workflow";

function fixture(t, { mode = "task-sections", timeout = 10 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-team-gate-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AI_DEV_KIT_")) delete env[key];
  const write = (file, body, checkout = project) => {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file), body);
  };
  const run = (command, args, { cwd = project, expected = 0, extraEnv = {} } = {}) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const git = (...args) => run("git", args);
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=TeamGate", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  };
  git("init", "-q", "-b", "main");
  write(".gitignore", `${workflow}/\n`);
  write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nmerge_policy:\n  target_branch: main\nsubtraction:\n  every_commits: 2\n  gate_enabled: true\n");
  write(".ai-dev-kit/test-scope.json", JSON.stringify({ schema_version: 1, no_tests_reason: "Fixture-only project; the kit suite validates its gate and external script." }) + "\n");
  const contract = { schema_version: 1, base_ref: "main", requirements: { mode, ledger: `${workflow}/LEDGER.md` },
    preflight: { argv: [process.execPath, "verify.cjs", "argument with spaces", "$literal"], timeout_seconds: timeout } };
  const saveContract = () => write(".ai-dev-kit/gate-contract.json", JSON.stringify(contract, null, 2) + "\n");
  saveContract();
  write(`${workflow}/LEDGER.md`, "# Requirements\n\n## old-abandoned\n\n- [ ] Explicitly cancelled historical work\n\n## current\n\n- [x] Read and validate actual source contents\n");
  if (mode === "global") write(`${workflow}/LEDGER.md`, "- [x] Read and validate actual source contents\n");
  write("source.txt", "hello\n");
  write("verify.cjs", `const fs = require('node:fs');\nconst assert = require('node:assert/strict');\nassert.equal(fs.readFileSync('source.txt','utf8'),'hello\\n');\nassert.deepEqual(process.argv.slice(2), ['argument with spaces', '$literal']);\nfs.appendFileSync('${workflow}/executions.log', process.cwd()+'\\n');\nif(process.env.PROJECT_FAIL==='1'){console.error('private-test-secret');process.exit(73);}\nif(process.env.PROJECT_BUSY==='1'){console.error('exclusive resource lock is busy');process.exit(75);}\n`);
  commit();
  git("checkout", "-qb", "codex/current");
  const gate = (phase = "preflight", expected = 0, extraEnv = {}, extraArgs = [], checkout = project) =>
    run("bash", [gatePath, "--phase", phase, "--project", checkout, ...extraArgs], { expected, extraEnv });
  const helper = (command, expected = 0, extraArgs = []) => run(process.execPath,
    [helperPath, command, "--project", project, ...extraArgs], { expected });
  const receipt = (branch = "codex/current") => path.join(project, workflow, "preflight", crypto.createHash("sha256").update(branch).digest("hex") + ".json");
  return { root, project, env, write, run, git, commit, contract, saveContract, gate, helper, receipt };
}

test("missing tracked contract fails with explicit migration, including a legacy project entrypoint", t => {
  const f = fixture(t);
  f.git("rm", "-q", ".ai-dev-kit/gate-contract.json");
  fs.appendFileSync(path.join(f.project, ".ai-dev-kit/profile.yml"), "preflight:\n  entrypoint: verify.cjs\n");
  assert.match(f.gate("preflight", 2), /gate-contract.json is required.*profile.preflight.entrypoint/);
  assert.equal(fs.existsSync(path.join(f.project, workflow, "executions.log")), false);
  assert.equal(fs.existsSync(f.receipt()), false);
});

test("contract must be staged, unconflicted and a regular file", t => {
  const f = fixture(t);
  f.git("rm", "--cached", "-q", ".ai-dev-kit/gate-contract.json");
  assert.match(f.gate("preflight", 2), /tracked, unconflicted stage-0/);
  f.git("add", ".ai-dev-kit/gate-contract.json");
  const source = path.join(f.root, "external.json");
  fs.renameSync(path.join(f.project, ".ai-dev-kit/gate-contract.json"), source);
  fs.symlinkSync(source, path.join(f.project, ".ai-dev-kit/gate-contract.json"));
  assert.match(f.gate("preflight", 2), /must be a regular file/);
  fs.unlinkSync(path.join(f.project, ".ai-dev-kit/gate-contract.json"));
  fs.renameSync(source, path.join(f.project, ".ai-dev-kit/gate-contract.json"));
  const blob = f.git("hash-object", ".ai-dev-kit/gate-contract.json").trim();
  const input = `0 ${"0".repeat(40)}\t.ai-dev-kit/gate-contract.json\n100644 ${blob} 1\t.ai-dev-kit/gate-contract.json\n100644 ${blob} 2\t.ai-dev-kit/gate-contract.json\n`;
  const index = spawnSync("git", ["update-index", "--index-info"], { cwd: f.project, input, encoding: "utf8" });
  assert.equal(index.status, 0, index.stderr);
  assert.match(f.gate("preflight", 2), /tracked, unconflicted stage-0/);
});

test("task section binding preserves history without blocking completed current requirements", t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.project, workflow, "LEDGER.md"));
  f.gate();
  assert.deepEqual(fs.readFileSync(path.join(f.project, workflow, "LEDGER.md")), before);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt())).snapshot.requirements.task_id, "current");
});

test("missing, duplicate, empty and unfinished task sections remain blocking", t => {
  const f = fixture(t);
  for (const [ledger, error] of [
    ["## other\n- [x] Other work\n", /expected one unique ## current/],
    ["## current\n- [x] One\n## current\n- [x] Two\n", /found 2/],
    ["## current\nNo concrete acceptance requirements\n", /concrete checkbox/],
    ["## current\n- [ ] Required work remains\n", /unfinished requirements for current/],
    ["## current\n- [~] postponed\n", /requires deferred:/],
  ]) {
    f.write(`${workflow}/LEDGER.md`, ledger);
    assert.match(f.gate("preflight", 2), error);
  }
});

test("task-sections binds the second segment of any single-prefix branch", t => {
  const f = fixture(t);
  for (const branch of ["claude-fable-worker01/current", "feat/current"]) {
    f.git("checkout", "-qb", branch);
    f.gate();
    assert.equal(fs.existsSync(f.receipt(branch)), true);
  }
});

test("task-sections rejects a branch with more than one prefix segment before running the project command", t => {
  const f = fixture(t);
  f.git("checkout", "-qb", "codex/worker-1/current");
  assert.match(f.gate("preflight", 2), /exactly one prefix segment/);
  assert.equal(fs.existsSync(f.receipt("codex/worker-1/current")), false);
  assert.equal(fs.existsSync(path.join(f.project, workflow, "executions.log")), false);
  assert.match(f.gate("merge", 2), /exactly one prefix segment/);
});

test("legacy ledger own-match binds the second segment of any single-prefix branch", t => {
  const f = fixture(t);
  const reservation = slug => `## ${slug}\n\n- Status: active\n- Expected docs: none - fixture reservation without a design document\n\n`;
  f.write("docs/development/feature-ledger.md", `# Feature ledger\n\n${reservation("current")}${reservation("sibling")}`);
  f.commit();
  f.git("checkout", "-qb", "claude-fable-worker01/current");
  const merge = f.gate("merge", 2);
  assert.match(merge, /FAIL: current reservation 'current' is 'active', not ready-for-review/);
  assert.match(merge, /WARN: other reservation 'sibling' is 'active' \(not blocking this branch\)/);
  assert.doesNotMatch(merge, /feature ledger has entries not ready for merge/);
});

test("global requirements mode explicitly checks every section", t => {
  const f = fixture(t, { mode: "global" });
  f.write(`${workflow}/LEDGER.md`, "## old\n- [ ] Still required globally\n## current\n- [x] Done\n");
  assert.match(f.gate("preflight", 2), /unfinished requirements for global scope/);
});

test("task-files mode reads one requirements file per task instead of a shared ledger", t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.project, workflow, "LEDGER.md"));
  f.contract.requirements = { mode: "task-files", dir: "docs/tasks" };
  f.saveContract();
  assert.match(f.gate("preflight", 2), /docs\/tasks\/current.md: task-files requires one requirements file for codex\/current/);
  f.write("docs/tasks/current.md", "# current\n\n- [x] Validate the per-task requirements file\n");
  f.write("docs/tasks/sibling.md", "# sibling\n\n- [ ] Another agent's open work does not block this branch\n");
  f.gate();
  const bound = JSON.parse(fs.readFileSync(f.receipt())).snapshot.requirements;
  assert.deepEqual([bound.path, bound.mode, bound.task_id], ["docs/tasks/current.md", "task-files", "current"]);
  for (const [body, error] of [["- [ ] Reopened acceptance\n", /unfinished requirements for current/],
    ["- [~] postponed\n", /requires deferred:/], ["No concrete acceptance requirements\n", /concrete checkbox/]]) {
    f.write("docs/tasks/current.md", body);
    assert.match(f.gate("preflight", 2), error);
  }
  f.write("docs/tasks/current.md", "- [x] Default directory is docs/tasks\n");
  f.contract.requirements = { mode: "task-files" };
  f.saveContract();
  f.gate();
  for (const [requirements, error] of [[{ mode: "task-files", ledger: "docs/tasks/current.md" }, /not used by task-files/],
    [{ mode: "task-sections", ledger: `${workflow}/LEDGER.md`, dir: "docs/tasks" }, /only valid with mode task-files/],
    [{ mode: "task-files", files: [] }, /requirements: invalid object or unsupported key/], [{ mode: "per-task" }, /task-sections, task-files or global/]]) {
    f.contract.requirements = requirements;
    f.saveContract();
    assert.match(f.gate("preflight", 2), error);
  }
  f.contract.requirements = { mode: "task-files" };
  f.saveContract();
  f.git("checkout", "-qb", "codex/worker-1/current");
  assert.match(f.gate("preflight", 2), /task-files requires a <owner-or-type>\/<canonical-task-id> branch/);
});

test("fenced examples cannot create task sections or hide real open requirements", t => {
  const f = fixture(t);
  f.write(`${workflow}/LEDGER.md`, "# Ledger\n```text\n## current\n- [x] Example only\n```\n");
  assert.match(f.gate("preflight", 2), /expected one unique ## current/);
  f.write(`${workflow}/LEDGER.md`, "## current\n- [x] Real requirement\n```text\n~~~\n- [ ] Example remains inside backticks\n```\n");
  f.gate();
  fs.appendFileSync(path.join(f.project, workflow, "LEDGER.md"), "- [ ] Actual unfinished requirement outside the example\n");
  assert.match(f.gate("preflight", 2), /unfinished requirements/);
});

test("explicitly deferred requirements require a reason and owner, and remain bound", t => {
  const f = fixture(t);
  f.write(`${workflow}/LEDGER.md`, "## current\n- [~] deferred: user approved separate infrastructure delivery | owner: center\n");
  f.gate();
  f.write(`${workflow}/LEDGER.md`, "## current\n- [~] deferred: user approved separate infrastructure delivery\n");
  assert.match(f.gate("merge", 2), /requires deferred: reason \| owner: identity/);
});

test("real project failure is private, blocks receipt and revokes an earlier success", t => {
  const f = fixture(t);
  f.gate();
  assert.equal(fs.existsSync(f.receipt()), true);
  const output = f.gate("preflight", 2, { PROJECT_FAIL: "1" });
  assert.match(output, /project preflight failed \(exit 73/);
  assert.doesNotMatch(output, /private-test-secret/);
  assert.equal(fs.existsSync(f.receipt()), false);
  const log = f.receipt().replace(/\.json$/, ".log");
  assert.match(fs.readFileSync(log, "utf8"), /private-test-secret/);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.match(f.gate("merge", 2), /no passing content-bound preflight receipt/);
});

test("declared blocked exit codes report retryable BLOCKED without a receipt; real failures stay FAIL", t => {
  const f = fixture(t);
  assert.match(f.gate("preflight", 2, { PROJECT_BUSY: "1" }), /FAIL: project-gate: project preflight failed \(exit 75/);
  f.contract.preflight.blocked_exit_codes = [75];
  f.saveContract();
  f.gate();
  assert.equal(fs.existsSync(f.receipt()), true);
  const output = f.gate("preflight", 2, { PROJECT_BUSY: "1" });
  assert.match(output, /BLOCKED \(retryable\): project preflight reported a busy or unavailable resource \(exit 75\)/);
  assert.match(output, /skill-first gate BLOCKED \(retryable\)/);
  assert.doesNotMatch(output, /FAIL:|gate failed|gate passed/);
  assert.equal(fs.existsSync(f.receipt()), false);
  const log = fs.readFileSync(path.join(f.project, workflow, "gate-log.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(log.at(-1)).result, "blocked");
  assert.match(f.gate("preflight", 75, { PROJECT_BUSY: "1" }, ["--blocked-exit-code", "75"]), /BLOCKED \(retryable\)/);
  assert.match(f.gate("preflight", 9, { PROJECT_BUSY: "1", AI_DEV_KIT_BLOCKED_EXIT: "9" }), /BLOCKED \(retryable\)/);
  assert.equal(fs.existsSync(f.receipt()), false);
  assert.match(f.gate("merge", 2), /no passing content-bound preflight receipt/);
  assert.match(f.gate("preflight", 2, { PROJECT_FAIL: "1" }, ["--blocked-exit-code", "75"]), /project preflight failed \(exit 73/);
  for (const value of ["256", "0", "00", "7.5", "abc", ""]) {
    assert.match(f.gate("preflight", 2, {}, ["--blocked-exit-code", value]), /must be an integer exit code from 1 to 255/);
    if (value) assert.match(f.gate("integrate", 2, { AI_DEV_KIT_BLOCKED_EXIT: value }), /must be an integer exit code from 1 to 255/);
  }
  // Only preflight/integrate read the option: a bad loop-runner value cannot break stop or merge.
  f.gate();
  f.gate("merge", 0, { AI_DEV_KIT_BLOCKED_EXIT: "0" });
  f.gate("stop", 0, { AI_DEV_KIT_BLOCKED_EXIT: "abc" }, ["--blocked-exit-code", "0"]);
  f.contract.preflight.blocked_exit_codes = [0];
  f.saveContract();
  assert.match(f.gate("preflight", 2), /blocked_exit_codes must be an array/);
});

test("per-task args are appended in order after the stable argv and bound to the receipt", t => {
  const f = fixture(t);
  const argv = () => JSON.parse(fs.readFileSync(path.join(f.project, workflow, "argv.json"), "utf8"));
  const file = path.join(f.project, ".ai-dev-kit/tasks/current.json");
  f.write("record-argv.cjs", `require('node:fs').writeFileSync('${workflow}/argv.json', JSON.stringify(process.argv.slice(2)));\n`);
  f.contract.preflight.argv = [process.execPath, "record-argv.cjs", "--stable"];
  f.contract.preflight.task_args = { dir: ".ai-dev-kit/tasks", required: false };
  f.saveContract();
  f.gate();
  assert.deepEqual(argv(), ["--stable"]);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt())).snapshot.task_args, null);
  f.write(".ai-dev-kit/tasks/current.json", JSON.stringify({ args: ["--test", "z_last.py", "--test", "a first.py"] }) + "\n");
  f.write(".ai-dev-kit/tasks/sibling.json", JSON.stringify({ args: ["--test", "not-mine.py"] }) + "\n");
  f.commit();
  f.gate();
  assert.deepEqual(argv(), ["--stable", "--test", "z_last.py", "--test", "a first.py"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt())).snapshot.task_args,
    { path: ".ai-dev-kit/tasks/current.json", args: ["--test", "z_last.py", "--test", "a first.py"] });
  f.gate("merge");
  f.write(".ai-dev-kit/tasks/current.json", JSON.stringify({ args: ["--test", "narrower.py"] }) + "\n");
  assert.match(f.gate("merge", 2), /preflight receipt is stale/);
  for (const [body, error] of [["{", /current.json: invalid JSON/], [JSON.stringify({ args: "--test" }), /args must be an array/],
    [JSON.stringify({ args: [7] }), /args must be an array/], [JSON.stringify({ args: [], extra: 1 }), /current.json: invalid object or unsupported key/]]) {
    fs.writeFileSync(file, body);
    assert.match(f.gate("preflight", 2), error);
  }
  fs.unlinkSync(file);
  f.gate();
  f.contract.preflight.task_args.required = true;
  f.saveContract();
  assert.match(f.gate("preflight", 2), /current.json is required by preflight.task_args/);
  assert.equal(fs.existsSync(f.receipt()), false);
  for (const [config, error] of [[{ dir: "../outside" }, /task_args.dir must be a literal/], [{ required: "yes" }, /required must be true or false/], [{ files: [] }, /task_args: invalid object/]]) {
    f.contract.preflight.task_args = config;
    f.saveContract();
    assert.match(f.gate("preflight", 2), error);
  }
});

test("invalid command, missing executable and missing baseline are explicit failures", t => {
  const f = fixture(t);
  f.contract.preflight.argv = [];
  f.saveContract();
  assert.match(f.gate("preflight", 2), /preflight.argv must/);
  f.contract.preflight.argv = [path.join(f.root, "not-installed")];
  f.saveContract();
  assert.match(f.gate("preflight", 2), /could not start/);
  f.contract.base_ref = "refs/heads/missing-baseline";
  f.saveContract();
  assert.match(f.gate("preflight", 2), /project-gate:/);
  assert.equal(fs.existsSync(f.receipt()), false);
});

test("validation that changes production input cannot sign its changed result", t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.project, "verify.cjs"), "fs.writeFileSync('source.txt','changed by verification\\n');\n");
  assert.match(f.gate("preflight", 2), /inputs changed while preflight ran/);
  assert.equal(fs.existsSync(f.receipt()), false);
});

test("successful argv execution is content-bound and control-plane writes do not invalidate it", t => {
  const f = fixture(t);
  f.gate();
  assert.deepEqual(fs.readFileSync(path.join(f.project, workflow, "executions.log"), "utf8"), f.project + "\n");
  const receipt = fs.readFileSync(f.receipt());
  f.write(`${workflow}/loop-state.md`, "new coordination-only state\n");
  fs.appendFileSync(path.join(f.project, workflow, "LEDGER.md"), "\n## unrelated-worker\n- [ ] Their own work\n");
  f.gate("merge");
  assert.deepEqual(fs.readFileSync(f.receipt()), receipt);
  assert.deepEqual(fs.readFileSync(path.join(f.project, workflow, "executions.log"), "utf8"), f.project + "\n");
});

for (const change of ["worktree", "index-only", "untracked", "commit", "shared-profile", "contract", "requirements"]) {
  test(`preflight receipt rejects post-validation ${change} changes`, t => {
    const f = fixture(t);
    f.gate();
    if (change === "worktree") f.write("source.txt", "unvalidated\n");
    if (change === "index-only") {
      f.write("source.txt", "unvalidated index\n"); f.git("add", "source.txt"); f.write("source.txt", "hello\n");
    }
    if (change === "untracked") f.write("new-production.weird", "new executable behavior\n");
    if (change === "commit") f.commit();
    if (change === "shared-profile") fs.appendFileSync(path.join(f.project, ".ai-dev-kit/profile.yml"), "unrelated_setting: changed\n");
    if (change === "contract") { f.contract.preflight.timeout_seconds = 11; f.saveContract(); }
    if (change === "requirements") f.write(`${workflow}/LEDGER.md`, "## current\n- [x] Changed acceptance claim\n");
    assert.match(f.gate("merge", 2), /preflight receipt is stale/);
  });
}

test("moving the target ref invalidates receipt even when merge-base stays the same", t => {
  const f = fixture(t);
  f.gate();
  f.git("checkout", "-q", "main");
  f.commit();
  f.git("checkout", "-q", "codex/current");
  assert.match(f.gate("merge", 2), /preflight receipt is stale/);
});

function mergeBaseFixture(t) {
  const f = fixture(t);
  const runs = path.join(f.root, "integrate-runs.jsonl");
  f.git("checkout", "-q", "main");
  f.write("verify.cjs", `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ cwd: process.cwd(), files: fs.readdirSync('.').sort() }) + '\\n');\nif (fs.existsSync('broken.txt')) process.exit(9);\n`);
  f.contract.receipt_binding = "merge-base";
  f.contract.preflight.argv = [process.execPath, "verify.cjs"];
  f.saveContract();
  f.commit();
  f.git("checkout", "-q", "codex/current");
  f.git("merge", "-q", "--ff-only", "main");
  f.write("feature.txt", "branch work\n");
  f.commit();
  const onMain = (file, body) => { f.git("checkout", "-q", "main"); f.write(file, body); f.commit(); f.git("checkout", "-q", "codex/current"); };
  const runsLog = () => fs.readFileSync(runs, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const worktrees = () => f.git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length;
  const integrateReceipt = () => f.receipt().replace(/\.json$/, ".integrate.json");
  const lock = path.join(f.project, workflow, "integrate.lock");
  return { ...f, onMain, runsLog, worktrees, integrateReceipt, lock };
}

test("merge-base binding survives target moves and merge requires an integrate receipt for the current target", t => {
  const f = mergeBaseFixture(t);
  f.gate();
  const branchReceipt = fs.readFileSync(f.receipt());
  assert.equal(Object.hasOwn(JSON.parse(branchReceipt).snapshot, "base_ref_commit"), false);
  f.onMain("main-only.txt", "landed first\n");
  assert.match(f.gate("status"), /preflight receipt: fresh\n  integrate receipt: missing/);
  assert.match(f.gate("merge", 2), /requires an integrate receipt for the current target/);
  assert.match(f.gate("integrate"), /integrate passed on main/);
  const run = f.runsLog().at(-1);
  assert.notEqual(run.cwd, f.project);
  assert.ok(run.files.includes("main-only.txt") && run.files.includes("feature.txt"), JSON.stringify(run.files));
  assert.equal(fs.existsSync(run.cwd), false, "temporary integrate worktree was not removed");
  assert.equal(f.worktrees(), 1);
  assert.equal(fs.existsSync(f.lock), false);
  const signed = JSON.parse(fs.readFileSync(f.integrateReceipt()));
  assert.equal(signed.target_commit, f.git("rev-parse", "main").trim());
  assert.equal(signed.head, f.git("rev-parse", "HEAD").trim());
  assert.match(signed.merged_tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(fs.readFileSync(f.receipt()), branchReceipt);
  f.gate("merge");
  f.onMain("second.txt", "landed while queued\n");
  assert.match(f.gate("status"), /preflight receipt: fresh\n  integrate receipt: stale — differs: target_commit/);
  assert.match(f.gate("merge", 2), /integrate receipt is stale \(target_commit changed\)/);
  f.gate("integrate");
  f.gate("merge");
  f.commit();
  assert.match(f.gate("merge", 2), /preflight receipt is stale/);
});

test("integrate fails closed on conflicts, project failures, held locks and target binding, always removing its worktree", t => {
  const f = mergeBaseFixture(t);
  assert.match(f.gate("integrate", 2), /no passing content-bound preflight receipt/);
  f.gate();
  f.onMain("feature.txt", "conflicting target work\n");
  assert.match(f.gate("integrate", 2), /conflicts; rebase required/);
  assert.equal(f.worktrees(), 1);
  assert.equal(fs.existsSync(f.integrateReceipt()), false);
  assert.equal(fs.existsSync(f.lock), false);
  f.git("branch", "-f", "main", "main~1");
  f.onMain("broken.txt", "target change that breaks the merged result\n");
  assert.match(f.gate("integrate", 2), /project preflight failed \(exit 9/);
  assert.equal(fs.existsSync(f.runsLog().at(-1).cwd), false);
  assert.equal(f.worktrees(), 1);
  assert.equal(fs.existsSync(f.integrateReceipt()), false);
  f.git("branch", "-f", "main", "main~1");
  const seedLock = (owner, ageSeconds = 0) => {
    fs.mkdirSync(f.lock);
    const file = path.join(f.lock, "owner.json");
    fs.writeFileSync(file, JSON.stringify({ token: crypto.randomUUID(), host: os.hostname(), branch: "codex/other", ...owner }) + "\n");
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, when, when);
  };
  fs.writeFileSync(f.lock, "legacy lock file\n");
  assert.match(f.gate("integrate", 2), /integrate.lock must be a directory/);
  fs.unlinkSync(f.lock);
  seedLock({ pid: process.pid, token: "6f1d0a52-0000-4000-8000-000000000001" }, 60);
  assert.match(f.gate("integrate", 2), /BLOCKED \(retryable\): integrate lock .* held by pid \d+ on .* for codex\/other/);
  assert.match(fs.readFileSync(path.join(f.lock, "owner.json"), "utf8"), /6f1d0a52-0000-4000-8000-000000000001/);
  // The same live pid stops counting once its heartbeat lease expires (pid reuse cannot pin the lock).
  const expired = f.gate("integrate", 0, { AI_DEV_KIT_INTEGRATE_LEASE_SECONDS: "60" });
  assert.match(expired, /recovered stale integrate lock of pid \d+/);
  assert.equal(fs.existsSync(f.lock), false);
  const dead = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
  seedLock({ pid: dead });
  assert.match(f.gate("integrate"), /recovered stale integrate lock/);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.existsSync(f.integrateReceipt()), true);
  assert.match(f.gate("integrate", 2, { AI_DEV_KIT_INTEGRATE_LEASE_SECONDS: "5" }), /LEASE_SECONDS must be an integer of at least 60/);
  f.contract.receipt_binding = "target";
  f.saveContract();
  assert.match(f.gate("integrate", 2), /requires receipt_binding: merge-base/);
  f.contract.receipt_binding = "queue";
  f.saveContract();
  assert.match(f.gate("preflight", 2), /receipt_binding must be target or merge-base/);
});

test("integrate verifies the task args the branch receipt bound; untracked or ignored task files fail", t => {
  const f = mergeBaseFixture(t);
  f.write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nmerge_policy:\n  target_branch: main\nsubtraction:\n  gate_enabled: false\n");
  f.write(".gitignore", `${workflow}/\n.ai-dev-kit/tasks/ignored/\n`);
  f.contract.preflight.task_args = { dir: ".ai-dev-kit/tasks/ignored", required: false };
  f.saveContract();
  f.commit();
  // Ignored task file: absent from the merged checkout, so it must not be bound.
  f.write(".ai-dev-kit/tasks/ignored/current.json", JSON.stringify({ args: ["--test", "critical_test.py"] }) + "\n");
  assert.match(f.gate("preflight", 2), /ignored\/current.json must be a tracked.*commit the task args file/);
  assert.equal(fs.existsSync(f.receipt()), false);
  f.contract.preflight.task_args = { required: false };
  f.saveContract();
  f.write(".ai-dev-kit/tasks/current.json", JSON.stringify({ args: ["--wide"] }) + "\n");
  assert.match(f.gate("preflight", 2), /tasks\/current.json must be a tracked/);
  f.commit();
  // Tracked but locally edited: the receipt binds the edit, the merged checkout has the commit.
  f.write(".ai-dev-kit/tasks/current.json", JSON.stringify({ args: ["--edited"] }) + "\n");
  f.gate();
  assert.match(f.gate("integrate", 2), /task args in the merged checkout .*--wide.* differ from the branch preflight receipt .*--edited/);
  assert.equal(fs.existsSync(f.integrateReceipt()), false);
  assert.equal(f.worktrees(), 1);
  f.write(".ai-dev-kit/tasks/current.json", JSON.stringify({ args: ["--wide"] }) + "\n");
  f.gate();
  f.gate("integrate");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.integrateReceipt())).task_args, { path: ".ai-dev-kit/tasks/current.json", args: ["--wide"] });
  f.gate("merge");
  // Merge recomputes the merged tree; a receipt whose tree does not match is rejected.
  const signed = JSON.parse(fs.readFileSync(f.integrateReceipt()));
  fs.writeFileSync(f.integrateReceipt(), JSON.stringify({ ...signed, merged_tree: f.git("rev-parse", "main^{tree}").trim() }));
  assert.match(f.gate("merge", 2), /merged tree [0-9a-f]{12} of the current target and HEAD differs from the integrate receipt/);
});

test("concurrent stale-lock takeover never yields two integrate lock holders", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-lock-race-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, workflow), { recursive: true });
  const lock = path.join(root, workflow, "integrate.lock"), log = path.join(root, "holders.log");
  const dead = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
  const worker = `
    const fs = require("node:fs");
    const { acquireIntegrateLock } = require(${JSON.stringify(helperPath)});
    const start = Number(process.argv[1]);
    while (Date.now() < start) {}
    try {
      const release = acquireIntegrateLock({ shared: ${JSON.stringify(root)}, lock: "${workflow}/integrate.lock" }, "codex/w" + process.pid);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, at: Date.now(), event: "acquired" }) + "\\n");
      setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, at: Date.now(), event: "released" }) + "\\n"); release(); }, 700);
    } catch (error) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, event: error.constructor.name, message: error.message }) + "\\n");
    }`;
  for (let round = 0; round < 3; round++) {
    fs.rmSync(log, { force: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: crypto.randomUUID(), pid: dead, host: os.hostname(), branch: "codex/crashed" }) + "\n");
    const start = Date.now() + 600;
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", worker, String(start)], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", resolve);
    })));
    const events = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.event === "acquired").length, 1, JSON.stringify(events));
    assert.ok(events.filter(event => !["acquired", "released"].includes(event.event)).every(event => event.event === "BlockedError"), JSON.stringify(events));
    assert.equal(fs.existsSync(lock), false);
  }
});

test("releasing an integrate lock that was taken over leaves the new holder's lock in place", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-lock-release-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, workflow), { recursive: true });
  const lock = path.join(root, workflow, "integrate.lock");
  const { acquireIntegrateLock } = require(helperPath);
  const release = acquireIntegrateLock({ shared: root, lock: `${workflow}/integrate.lock` }, "codex/a");
  // Simulate another integrator taking over after our lease expired.
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  const other = { token: crypto.randomUUID(), pid: process.pid, host: os.hostname(), branch: "codex/b" };
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(other) + "\n");
  assert.throws(release, /taken over while held/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, other.token);
  assert.deepEqual(fs.readdirSync(path.join(root, workflow)).filter(name => name.startsWith("integrate.lock.released-")), []);
  // A lock that vanished entirely is also reported, never silently "released".
  fs.rmSync(lock, { recursive: true, force: true });
  const second = acquireIntegrateLock({ shared: root, lock: `${workflow}/integrate.lock` }, "codex/c");
  fs.rmSync(lock, { recursive: true, force: true });
  assert.throws(second, /taken over while held/);
});

function workflowState(directory) {
  const state = {};
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else state[file] = `${fs.statSync(path.join(directory, file)).mtimeMs}:${fs.readFileSync(path.join(directory, file), "utf8")}`;
    }
  };
  walk("");
  return state;
}

test("status is read-only and names the snapshot keys that made each receipt stale", t => {
  const f = fixture(t);
  let out = f.gate("status");
  assert.match(out, /environment: ok \(node v/);
  assert.match(out, /branch codex\/current \(/);
  assert.match(out, /preflight receipt: missing/);
  assert.match(out, /merge readiness: not ready — preflight receipt missing/);
  f.gate();
  out = f.gate("status");
  assert.match(out, /preflight receipt: fresh\n/);
  assert.match(out, /requirements: ok \(\.ai-dev-kit\/workflow\/LEDGER\.md, task current\)/);
  assert.match(out, /subtraction: debt 0 of 2/);
  assert.match(out, /test review: ok/);
  assert.match(out, /merge readiness: ready/);
  const linked = path.join(f.root, "linked"), gone = path.join(f.root, "gone");
  f.git("worktree", "add", "-qb", "codex/linked", linked, "main");
  f.write(`${workflow}/LEDGER.md`, "## linked\n- [x] Validate linked source\n", linked);
  f.gate("preflight", 0, {}, [], linked);
  f.git("worktree", "add", "-qb", "codex/gone", gone, "main");
  f.write(`${workflow}/LEDGER.md`, "## gone\n- [x] Validate removed checkout\n", gone);
  f.gate("preflight", 0, {}, [], gone);
  f.git("worktree", "remove", "--force", gone);
  f.git("branch", "codex/no-receipt", "main");
  out = f.gate("status", 0, {}, ["--all"]);
  assert.match(out, new RegExp(`branch codex/linked \\(${linked}\\)\\n  preflight receipt: fresh`));
  assert.match(out, /branch codex\/gone \(no checkout\)\n  preflight receipt: unverified/);
  assert.match(out, /merge readiness: unknown/);
  assert.doesNotMatch(out, /codex\/no-receipt/);
  f.git("checkout", "-q", "main"); f.commit(); f.git("checkout", "-q", "codex/current");
  f.write("source.txt", "edited after preflight\n");
  const before = workflowState(path.join(f.project, workflow));
  out = f.gate("status", 0, {}, ["--all"]);
  assert.match(out, /branch codex\/current \(.*\)\n  preflight receipt: stale — differs: base_ref_commit, worktree \(source\.txt\)/);
  assert.match(out, /branch codex\/linked \(.*\)\n  preflight receipt: stale — differs: base_ref_commit\n/);
  assert.match(out, /branch codex\/gone \(no checkout\)\n  preflight receipt: stale — differs: base_ref_commit\n/);
  const report = JSON.parse(f.gate("status", 0, {}, ["--json"]));
  assert.deepEqual(report.branches[0].preflight.differs, ["base_ref_commit", "worktree (source.txt)"]);
  assert.equal(report.branches[0].merge_ready, false);
  assert.deepEqual(workflowState(path.join(f.project, workflow)), before, "status must not write receipts, logs or locks");
  f.write(`${workflow}/LEDGER.md`, "## current\n- [ ] Reopened\n");
  assert.match(f.gate("status"), /requirements: .*unfinished requirements for current/);
});

test("environment self-check reports BLOCKED before the project command and in status", t => {
  const f = fixture(t);
  f.gate();
  const huge = { AI_DEV_KIT_MIN_FREE_MB: String(Number.MAX_SAFE_INTEGER) };
  assert.match(f.gate("status", 0, huge), /environment: BLOCKED — only \d+ MiB free on the volume of .*AI_DEV_KIT_MIN_FREE_MB requires/);
  const executions = fs.readFileSync(path.join(f.project, workflow, "executions.log"), "utf8");
  const out = f.gate("preflight", 2, huge);
  assert.match(out, /BLOCKED \(retryable\): environment check failed: only \d+ MiB free/);
  assert.doesNotMatch(out, /FAIL:/);
  assert.equal(fs.existsSync(f.receipt()), false);
  assert.equal(fs.readFileSync(path.join(f.project, workflow, "executions.log"), "utf8"), executions);
  f.gate("preflight", 64, huge, ["--blocked-exit-code", "64"]);
  assert.match(f.gate("preflight", 2, { AI_DEV_KIT_MIN_FREE_MB: "lots" }), /FAIL: .*AI_DEV_KIT_MIN_FREE_MB must be a nonnegative integer/);
  f.gate("preflight", 0, { AI_DEV_KIT_MIN_FREE_MB: "0" });
  const empty = fs.mkdtempSync(path.join(f.root, "no-node-"));
  const missing = f.run("/bin/bash", [gatePath, "--phase", "preflight", "--project", f.project], { expected: 2, extraEnv: { PATH: empty } });
  assert.match(missing, /BLOCKED \(retryable\): environment check failed: node is not on PATH/);
  assert.match(f.run("/bin/bash", [gatePath, "--phase", "status", "--project", f.project], { expected: 0, extraEnv: { PATH: empty } }), /environment: BLOCKED — node is not on PATH/);
});

test("old audit-log pass and optional-receipt profile flag cannot authorize a merge", t => {
  const f = fixture(t);
  f.write(`${workflow}/gate-log.jsonl`, JSON.stringify({ phase: "merge", result: "pass", branch: "codex/current", head: f.git("rev-parse", "HEAD").trim() }) + "\n");
  fs.appendFileSync(path.join(f.project, ".ai-dev-kit/profile.yml"), "gate:\n  require_preflight_receipt: false\n");
  assert.match(f.gate("merge", 2), /no passing content-bound preflight receipt/);
});

test("linked worktree uses its own tracked contract and project script with shared profile and receipt", t => {
  const f = fixture(t);
  const linked = path.join(f.root, "linked");
  f.git("worktree", "add", "-qb", "codex/linked", linked, "main");
  f.write(`${workflow}/LEDGER.md`, "## linked\n- [x] Validate linked source\n", linked);
  f.write("source.txt", "main is not the selected checkout\n");
  f.gate("preflight", 0, {}, [], linked);
  assert.equal(fs.existsSync(f.receipt("codex/linked")), true);
  assert.equal(fs.existsSync(path.join(linked, workflow, "preflight")), false);
  assert.equal(fs.readFileSync(path.join(linked, workflow, "executions.log"), "utf8"), linked + "\n");
});

test("subtraction uses its own block and rejects invalid threshold rather than weakening it", t => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) f.commit();
  fs.appendFileSync(path.join(f.project, ".ai-dev-kit/profile.yml"), "unrelated:\n  gate_enabled: false\n");
  assert.match(f.gate("preflight", 2), /subtraction overdue: 3/);
  assert.match(f.gate("preflight", 2, {}, ["--subtraction-threshold", "oops"]), /threshold must be a nonnegative/);
  assert.match(f.gate("preflight", 2, { AI_DEV_KIT_SUBTRACTION_THRESHOLD: "oops" }), /threshold must be a nonnegative/);
  f.write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nsubtraction:\n  every_commits: broken\n  gate_enabled: true\n");
  assert.match(f.gate("preflight", 2), /subtraction.every_commits must/);
});

test("another worker's clean append does not discard the valid current-branch record", t => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) f.commit();
  const own = f.git("rev-parse", "HEAD").trim();
  f.write(`${workflow}/subtraction-log.md`, `- 2026-09-07 | commit: ${own} | branch: codex/current | scope: . | mode: propose\n`);
  f.gate();
  f.git("checkout", "-qb", "codex/other", "main"); f.commit();
  const other = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "-q", "codex/current");
  fs.appendFileSync(path.join(f.project, workflow, "subtraction-log.md"), `- 2026-09-07 | commit: ${other} | branch: codex/other | scope: . | mode: propose\n`);
  f.gate("merge");
  assert.equal(JSON.parse(f.helper("snapshot")).subtraction.cleaned_commit, own);
});

test("malformed current-branch subtraction record fails instead of disappearing", t => {
  const f = fixture(t);
  f.write(`${workflow}/subtraction-log.md`, "- 2026-09-07 | commit: broken | branch: codex/current | scope: . | mode: propose\n");
  assert.match(f.gate("preflight", 2), /malformed subtraction record/);
});

test("evidence symlinks cannot redirect a preflight write outside shared workflow", t => {
  const f = fixture(t);
  const external = path.join(f.root, "external-evidence");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "sentinel"), "unchanged\n");
  fs.symlinkSync(external, path.join(f.project, workflow, "preflight"));
  assert.match(f.gate("preflight", 2), /symlink parent/);
  assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(external, "sentinel"), "utf8"), "unchanged\n");
});

test("real dirty and base-only deleted gitlinks cannot reuse parent project evidence", t => {
  const f = fixture(t);
  const child = path.join(f.root, "child");
  fs.mkdirSync(child);
  f.run("git", ["init", "-q", "-b", "main"], { cwd: child });
  f.write("value.txt", "child baseline\n", child);
  f.run("git", ["add", "."], { cwd: child });
  f.run("git", ["-c", "user.name=Child", "-c", "user.email=test@example.invalid", "commit", "-qm", "child baseline"], { cwd: child });
  f.git("checkout", "-q", "main");
  f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor");
  f.commit();
  f.git("checkout", "-qb", "codex/submodule");
  f.write(`${workflow}/LEDGER.md`, "## submodule\n- [x] Verify the parent project with its unchanged child baseline\n");
  f.gate();
  f.git("config", "diff.ignoreSubmodules", "all");
  f.write("vendor/value.txt", "unvalidated child edit\n");
  assert.match(f.gate("merge", 2), /dirty submodules require independent project preflight/);
  f.git("rm", "-q", "-f", "vendor");
  f.commit();
  assert.match(f.gate("preflight", 2), /changed or dirty submodules require independent project preflight/);
});

test("unrelated historical cleanup does not charge trunk history to a fresh branch", t => {
  const f = fixture(t);
  const old = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "-q", "main");
  for (let n = 0; n < 12; n++) f.commit();
  f.git("checkout", "-qb", "codex/fresh");
  f.write(`${workflow}/LEDGER.md`, "## fresh\n- [x] Fresh task\n");
  f.write(`${workflow}/subtraction-log.md`, `- 2026-08-23 | commit: ${old} | branch: codex/old | scope: . | mode: assisted\n`);
  f.commit();
  f.gate();
  assert.equal(JSON.parse(f.helper("snapshot")).subtraction.debt, 1);
});

function running(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith("Z");
}
function backgroundScript(wait) {
  return `const fs=require('node:fs'); const {spawn}=require('node:child_process');\nconst child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});\nfs.writeFileSync('${workflow}/background.pid',String(child.pid));\n${wait ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : "child.unref();"}\n`;
}
test("normal exit and deadline both clean background process groups", async t => {
  for (const wait of [false, true]) {
    await t.test(wait ? "timeout" : "normal exit", async childTest => {
      const f = fixture(childTest, { timeout: 1 });
      f.write("verify.cjs", backgroundScript(wait));
      const result = f.gate("preflight", wait ? 2 : 0);
      if (wait) assert.match(result, /project preflight timed out/);
      const pid = Number(fs.readFileSync(path.join(f.project, workflow, "background.pid"), "utf8"));
      for (let n = 0; n < 20 && running(pid); n++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(Boolean(running(pid)), false, `background process ${pid} survived`);
      assert.equal(fs.existsSync(f.receipt()), !wait);
    });
  }
});

test("SIGTERM cancels the project runner and its command group without signing a receipt", async t => {
  const f = fixture(t);
  f.write("verify.cjs", backgroundScript(true));
  const child = spawn(process.execPath, [helperPath, "preflight", "--project", f.project], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const pidFile = path.join(f.project, workflow, "background.pid");
  for (let n = 0; n < 100 && !fs.existsSync(pidFile); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(pidFile), true, output);
  child.kill("SIGTERM");
  const result = await exited;
  assert.equal(result.code, 1, output);
  assert.match(output, /project preflight cancelled/);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let n = 0; n < 20 && running(pid); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(Boolean(running(pid)), false);
  assert.equal(fs.existsSync(f.receipt()), false);
});
