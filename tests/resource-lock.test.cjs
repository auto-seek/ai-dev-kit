// Perspective: many agents and worktrees of one project sharing a single scarce
// resource (a GUI engine instance, a display used for visual verification).
// Invariant: at most one command holds a resource; waiters run in arrival order;
// a waiter past --wait exits 75 without running or leaving a ticket; a dead or
// expired holder is reclaimed, but an orphaned command group still holds it.
// Goal: replace "busy, try next round" spinning with a fair queue that cannot
// hand the resource to two users or leak it after signals and crashes.
// Migration: keep these public CLI tests when the lock storage changes. The
// lock, processes and signals are real; only the guarded commands are fixtures.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const script = path.resolve(__dirname, "../scripts/resource-lock.cjs");
assert.notEqual(process.platform, "win32", "These POSIX process-group contracts require Linux/macOS; use WSL on Windows.");

const WORKER = `"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [log, id, ms, mode] = process.argv.slice(2);
const pids = [process.pid];
if (mode === "grandchild") pids.push(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid);
fs.writeFileSync(log + "." + id + ".pids.tmp", JSON.stringify(pids));
fs.renameSync(log + "." + id + ".pids.tmp", log + "." + id + ".pids");
fs.appendFileSync(log, id + " start\\n");
setTimeout(() => { fs.appendFileSync(log, id + " end\\n"); process.exit(0); }, Number(ms));
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function kill(pid, signal = "SIGKILL") {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-resource-lock-"));
  const worker = path.join(root, "worker.cjs");
  const log = path.join(root, "events.log");
  fs.writeFileSync(worker, WORKER);
  const runners = new Set();
  const workerPids = id => {
    try { return JSON.parse(fs.readFileSync(`${log}.${id}.pids`, "utf8")); } catch { return null; }
  };
  t.after(() => {
    for (const child of runners) if (child.exitCode === null && child.signalCode === null) kill(-child.pid);
    for (const file of fs.readdirSync(root)) {
      if (file.endsWith(".pids")) for (const pid of JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))) { kill(-pid); kill(pid); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lockArgs = (command, extra) => [script, command, "--root", root, "--name", "engine", ...extra];
  const start = (command, extra, argv = null) => {
    const child = spawn(process.execPath, [...lockArgs(command, extra), ...(argv ? ["--", ...argv] : [])], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    runners.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const watchdog = setTimeout(() => kill(-child.pid), 30000);
    const done = new Promise(resolve => child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    }));
    // The guarded command inherits the runner's pipes: "close" waits for it too.
    const exited = new Promise(resolve => child.on("exit", resolve));
    return { child, done, exited };
  };
  const runWorker = (id, ms, extra = [], mode) =>
    start("run", ["--label", id, ...extra], [process.execPath, worker, log, id, String(ms), ...(mode ? [mode] : [])]);
  const cli = (command, extra) => {
    const result = spawnSync(process.execPath, lockArgs(command, extra), { cwd: root, encoding: "utf8", timeout: 30000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const status = () => JSON.parse(cli("status", ["--json"]).stdout);
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const lockFiles = () => fs.readdirSync(path.join(root, ".ai-dev-kit", "locks", "engine")).sort();
  return { root, start, runWorker, cli, status, events, workerPids, lockFiles };
}

test("three queued runners hold the resource one at a time in arrival order; status reports them", async t => {
  const f = fixture(t);
  // A must still hold when both text and JSON status are read under heavy load.
  const a = f.runWorker("A", 3000);
  await waitFor(() => f.status().holder?.state === "holding", "A to hold");
  const b = f.runWorker("B", 100);
  await waitFor(() => f.status().queue.length === 1, "B to queue");
  const c = f.runWorker("C", 100);
  const snapshot = await waitFor(() => { const s = f.status(); return s.queue.length === 2 && s; }, "C to queue");

  assert.deepEqual([snapshot.holder, ...snapshot.queue].map(entry => [entry.label, entry.state]),
    [["A", "holding"], ["B", "waiting"], ["C", "waiting"]]);
  assert.equal(snapshot.holder.pid, a.child.pid);
  assert.equal(snapshot.queue[1].pid, c.child.pid);
  assert.ok(snapshot.holder.held_s >= 0 && snapshot.queue[0].age_s >= 0);
  const text = f.cli("status", []).stdout;
  assert.match(text, /^engine: holding by "A" \(pid \d+\), 2 waiting$/m);
  assert.match(text, /waiting\s+pid \d+\s+queued [\d.]+s\s+C/);

  for (const { done } of [a, b, c]) assert.equal((await done).code, 0);
  assert.deepEqual(f.events(), ["A start", "A end", "B start", "B end", "C start", "C end"]);
  assert.equal(f.status().holder, null);
  assert.match(f.cli("status", []).stdout, /^engine: free$/m);
});

function assertNoOverlap(seen, ids) {
  assert.equal(seen.length, ids.length * 2, seen.join(", "));
  for (let i = 0; i < seen.length; i += 2) {
    const [id, phase] = seen[i].split(" ");
    assert.equal(phase, "start");
    assert.equal(seen[i + 1], `${id} end`, `overlap in ${seen.join(", ")}`);
  }
  assert.deepEqual(seen.filter(line => line.endsWith(" start")).map(line => line.split(" ")[0]).sort(), [...ids].sort());
}

test("a simultaneous burst of runners never overlaps", async t => {
  const f = fixture(t);
  const ids = ["P", "Q", "R", "S", "T", "U"];
  const runs = ids.map(id => f.runWorker(id, 40));
  for (const { done } of runs) assert.equal((await done).code, 0);
  assertNoOverlap(f.events(), ids);
  assert.deepEqual(f.lockFiles(), []);
});

test("stress: fourteen concurrent runners hold the resource strictly one at a time", async t => {
  const f = fixture(t);
  const ids = Array.from({ length: 14 }, (_, index) => `S${index}`);
  const runs = ids.map(id => f.runWorker(id, 15, ["--wait", "60"]));
  for (const { done } of runs) {
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
  }
  assertNoOverlap(f.events(), ids);
  assert.deepEqual(f.lockFiles(), []);
});

test("a claimed ticket blocks even a lower-numbered waiter (late ticket after a stalled chooser)", async t => {
  const f = fixture(t);
  const dir = path.join(f.root, ".ai-dev-kit", "locks", "engine");
  fs.mkdirSync(dir, { recursive: true });
  const fake = (seq, label) => {
    const token = `${String(seq).padStart(12, "0")}-${"ab".repeat(8)}`;
    fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({
      pid: process.pid, host: os.hostname(), label, created_at: Date.now(), max_hold_ms: 600000,
    }));
    return token;
  };
  const first = fake(1, "queued-first");
  const waiter = f.runWorker("W", 0, ["--wait", "3"]);
  await waitFor(() => f.status().queue[0]?.label === "W", "W to queue behind the first ticket");
  // A higher-numbered ticket that has already claimed the resource, as when a
  // chooser stalled past the announcement timeout; W becomes the lowest ticket.
  const late = fake(3, "claimed-holder");
  fs.writeFileSync(path.join(dir, `${late}.held`), JSON.stringify({ held_at: Date.now() }));
  fs.unlinkSync(path.join(dir, `${first}.json`));

  const result = await waiter.done;
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /still held by "claimed-holder"/);
  assert.equal(f.workerPids("W"), null, "a lower-numbered waiter ran while another ticket held the resource");
});

test("a waiter past --wait exits 75 without running and leaves no ticket", async t => {
  const f = fixture(t);
  const holder = f.runWorker("H", 20000);
  await waitFor(() => f.status().holder?.state === "holding", "H to hold");
  const before = f.lockFiles();
  const started = Date.now();
  const waiter = await f.runWorker("W", 0, ["--wait", "1"]).done;

  assert.equal(waiter.code, 75);
  assert.match(waiter.stderr, /BLOCKED \(retryable\): engine is still held by "H" pid \d+ after 1s; command not run/);
  assert.ok(Date.now() - started >= 900, "gave up before --wait elapsed");
  assert.equal(f.workerPids("W"), null, "the blocked command ran");
  assert.deepEqual(f.lockFiles(), before);
  assert.equal(f.status().queue.length, 0);
  kill(holder.child.pid, "SIGTERM");
  await holder.done;
});

test("a killed runner's ticket is kept while its command group lives, then reclaimed", async t => {
  const f = fixture(t);
  const holder = f.runWorker("H", 20000);
  const [workerPid] = await waitFor(() => f.workerPids("H"), "H to start");
  kill(holder.child.pid, "SIGKILL");
  await holder.exited;

  const orphaned = f.status();
  assert.equal(orphaned.holder?.label, "H", "the orphaned command still uses the resource");
  assert.equal((await f.runWorker("W1", 0, ["--wait", "1"]).done).code, 75);

  kill(-workerPid);
  await waitFor(() => !alive(workerPid), "orphaned command to die");
  const next = await f.runWorker("W2", 0, ["--wait", "10"]).done;
  assert.equal(next.code, 0);
  assert.match(next.stderr, /reclaimed \d{12}-[0-9a-f]{16} \("H" pid \d+\): owner pid \d+ is gone/);
  assert.deepEqual(f.events(), ["H start", "W2 start", "W2 end"]);
  assert.deepEqual(f.lockFiles(), []);
});

test("acquire/release tokens queue with run and expire after max-hold", async t => {
  const f = fixture(t);
  const first = f.cli("acquire", ["--label", "script", "--owner-pid", String(process.pid)]);
  assert.equal(first.code, 0, first.stderr);
  const token = first.stdout.trim();
  assert.match(token, /^\d{12}-[0-9a-f]{16}$/);
  assert.equal(f.status().holder.label, "script");
  assert.equal((await f.runWorker("W", 0, ["--wait", "0"]).done).code, 75);
  assert.equal(f.cli("release", ["--token", token]).code, 0);
  assert.equal(f.status().holder, null);
  const again = f.cli("release", ["--token", token]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /not found/);

  const lease = f.cli("acquire", ["--label", "forgotten", "--max-hold", "1"]);
  assert.equal(lease.code, 0, lease.stderr);
  const started = Date.now();
  const next = f.cli("acquire", ["--label", "next", "--wait", "10"]);
  assert.equal(next.code, 0, next.stderr);
  assert.ok(Date.now() - started >= 500, "lease was reclaimed before max-hold");
  assert.match(next.stderr, /reclaimed .*"forgotten".*max-hold 1s/);
  assert.equal(f.status().holder.label, "next");
  assert.equal(f.cli("release", ["--token", lease.stdout.trim()]).code, 1);
});

test("run propagates exit codes, kills leftover descendants and rejects nested run/acquire (symlinked root too)", async t => {
  const f = fixture(t);
  assert.equal((await f.start("run", [], [process.execPath, "-e", "process.exit(7)"]).done).code, 7);
  assert.equal((await f.start("run", [], [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"]).done).code, 143);
  const missing = await f.start("run", [], [path.join(f.root, "no-such-command")]).done;
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /cannot start/);

  assert.equal((await f.runWorker("G", 50, [], "grandchild").done).code, 0);
  const [, grandchild] = f.workerPids("G");
  assert.equal(alive(grandchild), false, "a background descendant outlived the released lock");

  const alias = path.join(os.tmpdir(), `aidk-resource-lock-alias-${process.pid}-${Date.now()}`);
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.rmSync(alias, { force: true }));
  const inner = [
    ["run", "--root", alias, "--name", "engine", "--wait", "1", "--", process.execPath, "-e", "0"],
    ["acquire", "--root", f.root, "--name", "engine", "--wait", "1"],
  ];
  for (const args of inner) {
    const nested = await f.start("run", ["--label", "outer"], [process.execPath, script, ...args]).done;
    assert.equal(nested.code, 2, nested.stderr);
    assert.match(nested.stderr, new RegExp(`nested ${args[0]} of "engine" inside a command holding it would wait on itself`));
  }
  assert.deepEqual(f.lockFiles(), []);
});

test("SIGTERM to a holding runner stops the whole command group and releases the lock", async t => {
  const f = fixture(t);
  const holder = f.runWorker("H", 20000, [], "grandchild");
  const pids = await waitFor(() => f.workerPids("H"), "H to start");
  const waiter = f.runWorker("W", 0, ["--wait", "10"]);
  await waitFor(() => f.status().queue.length === 1, "W to queue");

  kill(holder.child.pid, "SIGTERM");
  const result = await holder.done;
  assert.equal(result.code, 143);
  for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} survived the runner`);
  assert.equal((await waiter.done).code, 0);
  assert.deepEqual(f.events(), ["H start", "W start", "W end"]);
  assert.deepEqual(f.lockFiles(), []);
});
