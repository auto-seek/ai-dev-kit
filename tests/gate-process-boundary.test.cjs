// Perspective: callers cancelling the public shell gate by its process ID.
// Invariant: cancellation reaches detached command groups before the shell exits;
// stderr diagnostics cannot corrupt a successful stdout JSON protocol.
// Goal: prevent orphaned work, post-cancellation receipts and false JSON failures.
// Migration: keep these integration tests at the shell/Node boundary. Only the
// external Cascade command and project validator are fixtures, never the gate.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { settleFirstExec, settleGuard } = require("./fixtures/first-exec.cjs");
const kit = path.resolve(__dirname, "..");
const gate = path.join(kit, "scripts/skill-first-gate.sh");

function kill(pid, signal = "SIGKILL") {
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function state(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  assert.ifError(result.error);
  assert([0, 1].includes(result.status), result.stderr);
  return result.stdout.trim();
}
function fixture(t, mode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-shell-boundary-")));
  const project = path.join(root, "project"), bin = path.join(root, "bin");
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_MODE: mode };
  for (const key of Object.keys(env)) if (key.startsWith("AI_DEV_KIT_")) delete env[key];
  const children = new Set();
  const pids = () => fs.existsSync(path.join(root, "pids.jsonl"))
    ? fs.readFileSync(path.join(root, "pids.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const cleanup = () => {
    for (const { pid } of pids()) kill(pid);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) kill(-child.pid);
  };
  t.after(() => { cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, body, base = project) => {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    fs.writeFileSync(path.join(base, file), body);
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: project, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  };
  write("tree.cjs", `
const fs=require('node:fs'),path=require('node:path');const {spawn}=require('node:child_process');
const root=process.env.FIXTURE_ROOT,role=['child','grandchild'].includes(process.argv[2])?process.argv[2]:'parent',file=name=>path.join(root,name);
process.on('SIGTERM',()=>fs.appendFileSync(file(role+'.term'),'TERM\\n'));
process.on('SIGINT',()=>fs.appendFileSync(file(role+'.term'),'INT\\n'));
fs.appendFileSync(file('pids.jsonl'),JSON.stringify({role,pid:process.pid})+'\\n');
if(role!=='grandchild')spawn(process.execPath,[__filename,role==='parent'?'child':'grandchild'],{stdio:'ignore',env:process.env});
setInterval(()=>{fs.appendFileSync(file(role+'.writes'),'.');if(['parent','child','grandchild'].every(name=>fs.existsSync(file(name+'.writes'))))fs.writeFileSync(file('ready'),'ready');},40);
`, root);
  const launchTree = `require(${JSON.stringify(path.join(root, "tree.cjs"))});`;
  write("cascade", `#!/usr/bin/env node
${settleGuard}
const version=process.argv.includes('--version');
if((version&&process.env.FIXTURE_MODE==='version')||(!version&&process.env.FIXTURE_MODE==='list')){${launchTree}}
else if(version){if(process.env.FIXTURE_MODE==='warning')console.error('warning: version transport diagnostic');console.log('cascade 0.7.0');}
else{console.error('warning: transport diagnostic https://user:fixture-secret@example.invalid/team.git');console.log('{"success":true,"data":{"nodes":[]}}');if(process.env.FIXTURE_MODE==='failure')process.exitCode=37;}
`, bin);
  fs.chmodSync(path.join(bin, "cascade"), 0o755);
  settleFirstExec(path.join(bin, "cascade"), [], env);
  write("validate.cjs", mode === "project" ? launchTree : "require('node:fs').writeFileSync('.ai-dev-kit/workflow/validated','yes');\n");
  write(".gitignore", ".ai-dev-kit/workflow/\n.ai-dev-kit/cascade/\n");
  write(".ai-dev-kit/profile.yml", `coordination:\n  engine: ${mode === "project" ? "ledger" : "cascade"}\n  cascade:\n    storage: file\n    storage_path: .ai-dev-kit/cascade\n    min_version: 0.7.0\n    command_timeout_seconds: 20\nsubtraction:\n  every_commits: 10\n`);
  write(".ai-dev-kit/test-scope.json", JSON.stringify({ schema_version: 1, no_tests_reason: "External command boundary fixture; tests reside in the kit suite." }) + "\n");
  write("requirements.md", "- [x] Exercise the selected external command protocol\n");
  write(".ai-dev-kit/gate-contract.json", JSON.stringify({ schema_version: 1, base_ref: "main",
    requirements: { mode: "global", ledger: "requirements.md" },
    preflight: { argv: [process.execPath, "validate.cjs"], timeout_seconds: 20 } }) + "\n");
  run("git", ["init", "-q", "-b", "main"]); run("git", ["add", "."]);
  run("git", ["-c", "user.name=Boundary", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const start = () => {
    const child = spawn("bash", [gate, "--phase", "preflight", "--project", project], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "", result;
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => { cleanup(); reject(new Error(`shell gate did not return: ${stdout}${stderr}`)); }, 15000);
      child.once("error", error => { clearTimeout(watchdog); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(watchdog); result = { code, signal, stdout, stderr }; resolve(result); });
    });
    return { child, done, get result() { return result; } };
  };
  return { root, project, env, run, start, pids };
}

for (const mode of ["project", "version", "list"]) {
  for (const [signal, expected] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    test(`public Bash PID ${signal} cancels ${mode} and all detached descendants before returning`, async t => {
      const f = fixture(t, mode), running = f.start();
      for (let n = 0; n < 250 && !fs.existsSync(path.join(f.root, "ready")); n++) {
        assert.equal(running.result, undefined, JSON.stringify(running.result)); await delay(20);
      }
      assert(fs.existsSync(path.join(f.root, "ready")), "the external process tree never became ready");
      assert.deepEqual(f.pids().map(item => item.role).sort(), ["child", "grandchild", "parent"]);
      const cancelledAt = Date.now();
      assert(running.child.kill(signal), `could not send ${signal} to the shell PID`);
      const result = await running.done;
      assert.equal(result.code, expected, result.stdout + result.stderr);
      assert.equal(result.signal, null, "the shell must handle the signal, forward it and wait for cleanup");
      assert(Date.now() - cancelledAt >= 1800, "shell returned before the TERM grace and group cleanup");
      const contents = () => f.pids().map(({ role }) => fs.readFileSync(path.join(f.root, `${role}.writes`), "utf8"));
      const before = contents();
      for (const { pid } of f.pids()) {
        const observed = state(pid);
        assert(observed === "" || observed.startsWith("Z"), `descendant ${pid} remained executable`);
      }
      await delay(250);
      assert.deepEqual(contents(), before, "a command wrote after the cancelled shell returned");
      const receipts = path.join(f.project, ".ai-dev-kit/workflow/preflight");
      assert(!fs.existsSync(receipts) || !fs.readdirSync(receipts).some(file => file.endsWith(".json")), "cancelled preflight signed a receipt");
      assert.doesNotMatch(result.stdout, /skill-first gate passed/);
    });
  }
}

test("successful stdout JSON and version remain valid with separately reported stderr warnings", async t => {
  const f = fixture(t, "warning");
  const result = await f.start().done;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /version transport diagnostic/);
  assert.match(result.stdout, /transport diagnostic/);
  assert.doesNotMatch(result.stdout + result.stderr, /invalid JSON|fixture-secret/);
  assert.equal(fs.readFileSync(path.join(f.project, ".ai-dev-kit/workflow/validated"), "utf8"), "yes");
});

test("external failure keeps its exit and redacted diagnostics instead of parsing stdout as success", async t => {
  const f = fixture(t, "failure");
  const result = await f.start().done;
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /list-nodes failed \(exit 37\)/);
  assert.match(result.stdout, /transport diagnostic/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
  assert.equal(fs.existsSync(path.join(f.project, ".ai-dev-kit/workflow/validated")), false);
});
