// Perspective: workers and gates running Cascade through Git or SSH subprocesses.
// Invariant: a cancelled command cannot keep writing after the supervisor returns;
// successful output and real failure codes survive, but URI credentials do not.
// Goal: catch the old 10-second Git deadline and incomplete process-group cleanup.
// Migration: keep these public CLI tests when process supervision changes. Only
// the external Cascade executable is a fixture; the supervisor and signals are real.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { settleFirstExec, settleGuard } = require("./fixtures/first-exec.cjs");

const supervisor = process.env.CASCADE_PROCESS_SCRIPT ||
  path.resolve(__dirname, "../scripts/cascade-process.cjs");
assert.notEqual(process.platform, "win32", "These POSIX process-group contracts require Linux/macOS; use WSL on Windows.");

function kill(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function fixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-cascade-process-"));
  const bin = path.join(root, "bin");
  const pidsFile = path.join(root, "pids.jsonl");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "cascade"), `#!/usr/bin/env node\n${settleGuard}\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_ROOT: root };
  delete env.AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS;
  settleFirstExec(path.join(bin, "cascade"), [], env);
  const children = new Set();
  const pids = () => fs.existsSync(pidsFile)
    ? fs.readFileSync(pidsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  const stop = () => {
    for (const { pid } of pids()) kill(pid);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) kill(-child.pid);
    }
  };
  t.after(() => {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = (args, extraEnv = {}, watchdogMs = 15000) => {
    const started = Date.now();
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      env: { ...env, ...extraEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "", stderr = "", result;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => {
        stop();
        reject(new Error(`supervisor did not return within ${watchdogMs} ms\n${stdout}${stderr}`));
      }, watchdogMs);
      child.once("error", error => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(watchdog);
        result = { code, signal, stdout, stderr, elapsed: Date.now() - started, returnedAt: Date.now() };
        resolve(result);
      });
    });
    return { child, done, get result() { return result; } };
  };
  return { root, bin, pids, start };
}

async function ready(f, running) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(f.root, "ready"))) {
    assert.equal(running.result, undefined, `supervisor returned before the external process tree was ready: ${JSON.stringify(running.result)}`);
    assert(Date.now() < deadline, "external process tree did not become ready");
    await delay(20);
  }
  assert.deepEqual(f.pids().map(({ role }) => role).sort(), ["child", "grandchild", "parent"]);
}

const processTree = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.env.FIXTURE_ROOT;
const role = process.argv[2] || "parent";
const file = name => path.join(root, name);
process.on("SIGTERM", () => {
  fs.appendFileSync(file(role + ".term"), String(Date.now()) + "\n");
  if (role === "parent" && process.env.PARENT_EXITS_ON_TERM === "1") process.exit(0);
});
fs.appendFileSync(file("pids.jsonl"), JSON.stringify({ role, pid: process.pid }) + "\n");
if (role !== "grandchild") {
  spawn(process.execPath, [__filename, role === "parent" ? "child" : "grandchild"], {
    env: process.env,
    stdio: "ignore",
  });
}
setInterval(() => {
  fs.appendFileSync(file(role + ".sentinel"), ".");
  if (role === "parent" && ["parent", "child", "grandchild"].every(name => fs.existsSync(file(name + ".sentinel")))) {
    fs.writeFileSync(file("ready"), "all three processes have installed TERM handlers and written a sentinel\n");
  }
}, 40);
`;

function processState(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  assert.ifError(result.error);
  assert([0, 1].includes(result.status), `cannot inspect fixture process ${pid}: ${result.stderr}`);
  return result.stdout.trim();
}

async function assertTreeStopped(f, result) {
  const processes = f.pids();
  assert.deepEqual(processes.map(({ role }) => role).sort(), ["child", "grandchild", "parent"]);
  const statesAtReturn = processes.map(({ role, pid }) => ({ role, state: processState(pid) }));
  const sentinels = () => processes.map(({ role }) => fs.readFileSync(path.join(f.root, `${role}.sentinel`), "utf8"));
  const before = sentinels();
  await delay(400);
  assert.deepEqual(sentinels(), before, "a cancelled Cascade descendant kept writing after the supervisor returned");
  for (const { role, state } of statesAtReturn) {
    // An orphan can briefly remain a zombie on Linux; it cannot execute or write.
    assert(state === "" || state.startsWith("Z"), `${role} was still running at supervisor return (ps stat: ${state})`);
  }
  for (const { role } of processes) {
    const termFile = path.join(f.root, `${role}.term`);
    assert(fs.existsSync(termFile), `${role} never received the process-group TERM`);
    const termAt = Number(fs.readFileSync(termFile, "utf8").trim().split("\n")[0]);
    assert(result.returnedAt - termAt >= 1800, `supervisor returned before the 2-second TERM grace elapsed for ${role}`);
  }
}

test("Git's default budget permits a real external CLI taking more than ten seconds", { timeout: 20000 }, async t => {
  const f = fixture(t, `setTimeout(() => console.log(JSON.stringify(process.argv.slice(2))), 11000);`);
  const argv = ["--git-remote", "ssh://example.invalid/team.git", "list-nodes", "--format", "json", "argument with spaces"];
  const result = await f.start(["--storage-kind", "git", "--", ...argv], {}, 17000).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), argv);
  assert.equal(result.stderr, "");
  assert(result.elapsed >= 10900, "the fixture did not actually exercise a command lasting over ten seconds");
});

test("an explicit short deadline returns 124 after the external CLI actually started", async t => {
  const f = fixture(t, String.raw`
const fs = require("node:fs"), path = require("node:path");
const file = name => path.join(process.env.FIXTURE_ROOT, name);
fs.appendFileSync(file("pids.jsonl"), JSON.stringify({ role: "parent", pid: process.pid }) + "\n");
// Initialization may outlast a subsecond deadline even for a valid executable.
setTimeout(() => {
  fs.writeFileSync(file("started"), String(process.pid));
  setInterval(() => {}, 100);
}, 800);
`);
  const result = await f.start(["--storage-kind", "git", "--timeout-seconds", "3", "--", "list-nodes"]).done;
  assert(fs.existsSync(path.join(f.root, "started")));
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /timed out/i);
  assert(result.elapsed >= 4800, "the requested deadline and cleanup grace were cut short");
  assert(result.elapsed < 8000, "the explicit deadline was not bounded");
  const pid = Number(fs.readFileSync(path.join(f.root, "started"), "utf8"));
  assert.equal(pid, f.pids()[0].pid);
  const state = processState(pid);
  assert(state === "" || state.startsWith("Z"), `external CLI survived the deadline: ${state}`);
});

test("the environment budget overrides both a longer and a shorter CLI budget", async t => {
  const f = fixture(t, `setTimeout(() => console.log("finished"), 500);`);
  const shorter = await f.start(["--storage-kind", "git", "--timeout-seconds", "5", "--", "list-nodes"], {
    AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS: "0.2",
  }).done;
  assert.equal(shorter.code, 124, shorter.stderr);
  assert.doesNotMatch(shorter.stdout, /finished/);
  const longer = await f.start(["--storage-kind", "file", "--timeout-seconds", "0.1", "--", "list-nodes"], {
    AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS: "2",
  }).done;
  assert.equal(longer.code, 0, longer.stderr);
  assert.equal(longer.stdout, "finished\n");
});

test("deadline cleanup kills TERM-ignoring parent, child and grandchild before returning", async t => {
  const f = fixture(t, processTree);
  const running = f.start(["--storage-kind", "git", "--timeout-seconds", "2", "--"]);
  await ready(f, running);
  const result = await running.done;
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.signal, null);
  await assertTreeStopped(f, result);
});

test("a parent exiting on TERM does not end cleanup while its descendants ignore TERM", async t => {
  const f = fixture(t, processTree);
  const running = f.start(["--storage-kind", "git", "--timeout-seconds", "2", "--"], { PARENT_EXITS_ON_TERM: "1" });
  await ready(f, running);
  const result = await running.done;
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.signal, null);
  await assertTreeStopped(f, result);
});

for (const [signal, expectedCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`external ${signal} returns ${expectedCode} only after process-group cleanup`, async t => {
    const f = fixture(t, processTree);
    const running = f.start(["--storage-kind", "redis", "--timeout-seconds", "10", "--"]);
    await ready(f, running);
    assert(running.child.kill(signal), `failed to send ${signal} to the supervisor`);
    const result = await running.done;
    assert.equal(result.code, expectedCode, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stderr, new RegExp(signal));
    await assertTreeStopped(f, result);
  });
}

test("external failure codes and separate streams survive cross-chunk URI credential redaction", async t => {
  const f = fixture(t, String.raw`
process.stdout.write("stdout-before\nht");
process.stderr.write("stderr-before\nrediss://__ERR_US");
setTimeout(() => {
  process.stdout.write("tps://__OUT_US");
  process.stderr.write("ER_C__:__ERR_PA");
}, 40);
setTimeout(() => {
  process.stdout.write("ER_A__:__OUT_PA");
  process.stderr.write("SS_D__@cache.invalid:6379/0\nstderr-after\n");
}, 80);
setTimeout(() => {
  process.stdout.write("SS_B__@example.invalid/team.git\nstdout-after\n");
  process.exitCode = 37;
}, 120);
`);
  const result = await f.start(["--storage-kind", "file", "--", "list-nodes"]).done;
  assert.equal(result.code, 37, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /stdout-before\nhttps:\/\/[^\n]*example\.invalid\/team\.git\nstdout-after\n/);
  assert.match(result.stderr, /stderr-before\nrediss:\/\/[^\n]*cache\.invalid:6379\/0\nstderr-after\n/);
  assert.doesNotMatch(result.stdout, /stderr-before|stderr-after/);
  assert.doesNotMatch(result.stderr, /stdout-before|stdout-after/);
  assert.doesNotMatch(result.stdout + result.stderr, /OUT_US|ER_A__|OUT_PA|SS_B__|ERR_US|ER_C__|ERR_PA|SS_D__/);
});

test("invalid CLI and environment budgets fail without starting Cascade", async t => {
  const f = fixture(t, `require("node:fs").writeFileSync(require("node:path").join(process.env.FIXTURE_ROOT, "started"), "yes");`);
  for (const value of ["0", "-1", "NaN", "Infinity", "-Infinity", "not-a-number", "", "1e309"]) {
    for (const source of ["argument", "environment"]) {
      const args = ["--storage-kind", "git", "--timeout-seconds", source === "argument" ? value : "5", "--", "list-nodes"];
      const env = source === "environment" ? { AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS: value } : {};
      const result = await f.start(args, env).done;
      assert.notEqual(result.code, 0, `${source} budget ${JSON.stringify(value)} was accepted`);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /timeout|budget/i);
      assert(!fs.existsSync(path.join(f.root, "started")), `Cascade started with invalid ${source} budget ${JSON.stringify(value)}`);
    }
  }
});

test("a deadline cannot expose URI credentials truncated before the at-sign", async t => {
  const f = fixture(t, `process.stdout.write("https://__CUT_USER__:__CUT_PASSWORD__"); setInterval(() => {}, 100);`);
  const result = await f.start(["--storage-kind", "git", "--timeout-seconds", "3", "--", "list-nodes"]).done;
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.signal, null);
  assert(result.elapsed >= 4800, "the redaction deadline and cleanup grace were cut short");
  assert(result.elapsed < 8000, "the redaction deadline was not bounded");
  assert.match(result.stdout, /https:\/\/<redacted>/);
  assert.doesNotMatch(result.stdout + result.stderr, /__CUT_USER__|__CUT_PASSWORD__/);
});

test("successful JSON keeps host-only URLs and structure while removing actual userinfo", async t => {
  const f = fixture(t, `console.log(JSON.stringify({success:true,data:{url:"https://example.invalid",email:"reviewer@example.invalid",private:"https://__JSON_USER__:__JSON_PASSWORD__@example.invalid/path"}}));`);
  const result = await f.start(["--storage-kind", "git", "--", "list-nodes"]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {success:true,data:{url:"https://example.invalid",email:"reviewer@example.invalid",private:"https://<redacted>@example.invalid/path"}});
  assert.doesNotMatch(result.stdout, /__JSON_USER__|__JSON_PASSWORD__/);
});

test("output overflow discards captured partial credentials and fails the command", async t => {
  const f = fixture(t, `process.stdout.write("https://__OVERFLOW_USER__:__OVERFLOW_PASSWORD__" + "x".repeat(9 * 1024 * 1024)); setInterval(() => {}, 100);`);
  const result = await f.start(["--storage-kind", "git", "--timeout-seconds", "10", "--", "list-nodes"]).done;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /output exceeded 8 MiB/);
  assert.doesNotMatch(result.stderr, /__OVERFLOW_USER__|__OVERFLOW_PASSWORD__/);
});

test("successful CLI exit also stops its background writer before returning", async t => {
  const f = fixture(t, String.raw`
const fs = require("node:fs"), path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const marker = path.join(root, "background.sentinel");
if (process.argv[2] === "background") {
  fs.appendFileSync(path.join(root, "pids.jsonl"), JSON.stringify({role:"background",pid:process.pid}) + "\n");
  fs.writeFileSync(marker, ".");
  setInterval(() => fs.appendFileSync(marker, "."), 30);
} else {
  require("node:child_process").spawn(process.execPath, [__filename, "background"], {stdio:"inherit"});
  const ready = setInterval(() => {
    if (fs.existsSync(marker)) { clearInterval(ready); console.log("result complete"); process.exit(0); }
  }, 10);
}
`);
  const result = await f.start(["--storage-kind", "git", "--timeout-seconds", "5", "--"]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "result complete\n");
  const before = fs.readFileSync(path.join(f.root, "background.sentinel"), "utf8");
  assert(before.length > 0, "the background process never ran");
  await delay(300);
  assert.equal(fs.readFileSync(path.join(f.root, "background.sentinel"), "utf8"), before);
  const state = processState(f.pids()[0].pid);
  assert(state === "" || state.startsWith("Z"), `background writer survived: ${state}`);
});

// Perspective: password-verifier callers supplying confidential stdin.
// Invariant: exact bytes reach EOF without entering argv, and early pipe close
// cannot crash the parent or leak those bytes into supervisor diagnostics.
// Goal: verify the real subprocess transport, including EPIPE and timeout.
// Migration: retain when adding other confidential process inputs.
test("optional stdin preserves exact bytes and tolerates a verifier closing early", async () => {
  const { runProcess } = require("../scripts/cascade-process.cjs");
  const secret = Buffer.from(" synthetic password with spaces ");
  const result = await runProcess(process.execPath, ["-e", "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(String(Buffer.concat(b).length)))"], { timeoutSeconds: 5, input: secret });
  assert.equal(result.code, 0); assert.equal(result.stdout, String(secret.length)); assert.equal(result.stderr, "");
  const early = await runProcess(process.execPath, ["-e", "process.stdin.destroy();process.exit(3)"], { timeoutSeconds: 5, input: Buffer.alloc(1024 * 1024, 120) });
  assert.equal(early.code, 3); assert.equal(early.stdout, ""); assert.equal(early.stderr, "");
});
