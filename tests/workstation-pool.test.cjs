// Perspective: many agents on one machine sharing a pool of N Docker
// workstations declared in .ai-dev-kit/workstations.json.
// Invariant: a workstation is never handed to two holders at once and at most
// N are held; every claim gets a new container and release or reclaim removes
// it; only the holder's token releases; a dead or expired holder is reclaimed
// and the reclaim is reported; waiters past --wait exit 75 without a ticket;
// configuration errors (including more memory than Docker has) exit 2; the
// exclusive lock of the same name is independent of the pool.
// Goal: replace the single real-screen queue with parallel workstations
// without giving up the lock's fairness and crash safety.
// Migration: real CLI processes, process groups and signals; only the Docker
// CLI is the tests/fake-docker.cjs fixture. tests/workstation.test.cjs runs the
// container side against real Docker.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const script = path.resolve(__dirname, "../scripts/resource-lock.cjs");
const gateEvidence = path.resolve(__dirname, "../scripts/project-gate-evidence.cjs");
const fakeDocker = path.resolve(__dirname, "fake-docker.cjs");
const TOKEN = /^token=(\d{12}-[0-9a-f]{16})$/m;

const WORKER = `"use strict";
const fs = require("node:fs");
const [log, id, ms] = process.argv.slice(2);
fs.appendFileSync(log, id + " start " + process.env.WS_CONTAINER + "\\n");
setTimeout(() => { fs.appendFileSync(log, id + " end " + process.env.WS_CONTAINER + "\\n"); }, Number(ms));
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function kill(pid, signal = "SIGKILL") {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function waitFor(predicate, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

function fixture(t, pool = {}, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-pool-"));
  const dockerState = path.join(root, "docker");
  const worker = path.join(root, "worker.cjs");
  const log = path.join(root, "events.log");
  fs.mkdirSync(dockerState);
  fs.writeFileSync(path.join(dockerState, "images.txt"), "ws-image:test\n");
  fs.writeFileSync(worker, WORKER);
  const children = new Set();
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) kill(-child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, AI_DEV_KIT_DOCKER: fakeDocker, FAKE_DOCKER_STATE: dockerState };
  const writeConfig = (poolSettings, more = {}) => {
    fs.mkdirSync(path.join(root, ".ai-dev-kit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ai-dev-kit", "workstations.json"), JSON.stringify({
      schema_version: 1, pools: { ws: { image: "ws-image:test", start: [process.execPath, worker], ...poolSettings } }, ...more,
    }));
  };
  writeConfig(pool, extra);
  const args = (command, rest) => [script, command, "--root", root, ...rest];
  const cli = (command, rest, extraEnv = {}) => {
    const result = spawnSync(process.execPath, args(command, rest), { cwd: root, encoding: "utf8", timeout: 60000, env: { ...env, ...extraEnv } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const start = (command, rest, extraEnv = {}) => {
    const child = spawn(process.execPath, args(command, rest), { cwd: root, detached: true, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    // "close" also waits for descendants holding the pipes; "exit" reaps the process itself.
    const exited = new Promise(resolve => child.on("exit", resolve));
    return { child, done, exited };
  };
  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    children.add(child);
    return child;
  };
  const status = (rest = []) => JSON.parse(cli("status", ["--pool", "ws", "--json", ...rest]).stdout);
  const containers = () => fs.existsSync(path.join(dockerState, "containers"))
    ? fs.readdirSync(path.join(dockerState, "containers")).map(name => name.replace(/\.json$/, "")).sort() : [];
  const calls = () => fs.readFileSync(path.join(dockerState, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const poolFiles = () => fs.readdirSync(path.join(root, ".ai-dev-kit", "pools", "ws")).filter(name => !["out", "reclaimed.jsonl"].includes(name));
  return { root, log, worker, writeConfig, cli, start, sleeper, status, containers, calls, events, poolFiles, dockerState };
}

const slotOf = container => Number(container.match(/-ws-(\d+)-[0-9a-f]{6}$/)[1]);
const claimed = result => {
  const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.match(result.stdout, TOKEN);
  return fields;
};

test("a burst of runs shares three workstations without ever giving one to two runs", async t => {
  const f = fixture(t, { slots: 3 });
  const ids = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const runs = ids.map(id => f.start("run", ["--pool", "ws", "--label", id, "--", f.log, id, "150"]));
  for (const run of runs) assert.equal((await run.done).code, 0);
  const active = new Map();
  let most = 0;
  for (const line of f.events()) {
    const [id, phase, container] = line.split(" ");
    const slot = slotOf(container);
    if (phase === "start") {
      assert.ok(!active.has(slot), `slot ${slot} given to ${id} while ${active.get(slot)} holds it: ${f.events().join(", ")}`);
      active.set(slot, id);
      most = Math.max(most, active.size);
    } else {
      assert.equal(active.get(slot), id);
      active.delete(slot);
    }
  }
  assert.equal(f.events().length, ids.length * 2);
  assert.ok(most >= 2 && most <= 3, `at most three, and runs did overlap (${most})`);
  const started = f.calls().filter(call => call[0] === "run" && call.includes("-d")).map(call => call[call.indexOf("--name") + 1]);
  assert.equal(new Set(started).size, ids.length, "each run gets a new container");
  assert.deepEqual(f.containers(), [], "release removes every container");
  assert.deepEqual(f.poolFiles(), []);
});

test("simultaneous claims hand each workstation out once and the rest exit 75 after --wait", async t => {
  const f = fixture(t, { slots: 3 });
  const claims = Array.from({ length: 6 }, (_, i) => f.start("claim", ["--pool", "ws", "--wait", "2", "--label", `c${i}`]));
  const results = await Promise.all(claims.map(claim => claim.done));
  const won = results.filter(result => result.code === 0).map(claimed);
  const lost = results.filter(result => result.code !== 0);
  assert.deepEqual(won.map(fields => Number(fields.slot)).sort(), [0, 1, 2]);
  assert.equal(new Set(won.map(fields => fields.workstation)).size, 3);
  assert.equal(lost.length, 3);
  for (const result of lost) {
    assert.equal(result.code, 75, result.stderr);
    assert.match(result.stderr, /BLOCKED \(retryable\): pool ws has no free workstation after 2s \(3 of 3 held/);
  }
  assert.deepEqual(f.status().slots.map(slot => slot.state), ["holding", "holding", "holding"]);
  assert.equal(f.status().queue.length, 0);
  assert.deepEqual(f.containers(), won.map(fields => fields.workstation).sort());
  for (const fields of won) {
    assert.match(fields.exec, new RegExp(`exec ${fields.workstation} ws-run --timeout 1800 -- `));
    assert.equal(f.cli("release", ["--pool", "ws", "--token", fields.token]).code, 0);
  }
  assert.deepEqual(f.containers(), []);
  assert.deepEqual(f.status().slots.map(slot => slot.state), ["free", "free", "free"]);
});

test("only the first waiter in line assigns, and a live holder's workstation is never freed", async t => {
  const f = fixture(t, { slots: 2 });
  const dir = path.join(f.root, ".ai-dev-kit", "pools", "ws");
  fs.mkdirSync(dir, { recursive: true });
  // Tickets owned by this live test process: a holder of slot 0 and a waiter queued before any real claim.
  const ticket = (seq, label) => {
    const token = `${String(seq).padStart(12, "0")}-${"cd".repeat(8)}`;
    fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({
      pid: process.pid, host: os.hostname(), label, created_at: Date.now(), max_hold_ms: 600000,
    }));
    return token;
  };
  const holder = ticket(1, "live holder");
  const container = "aidk-ws-fixture-ws-0-cdcdcd";
  fs.mkdirSync(path.join(f.dockerState, "containers"), { recursive: true });
  fs.writeFileSync(path.join(f.dockerState, "containers", `${container}.json`), JSON.stringify({ name: container, labels: {} }));
  fs.writeFileSync(path.join(dir, "slot-0.json"), JSON.stringify({
    token: holder, container, label: "live holder", pid: process.pid, host: os.hostname(), claimed_at: Date.now(),
  }));
  const waiter = ticket(2, "earlier waiter");

  const behind = f.cli("claim", ["--pool", "ws", "--wait", "2", "--label", "behind"]);
  assert.equal(behind.code, 75, "a free slot still goes to the earlier waiter first");
  fs.unlinkSync(path.join(dir, `${waiter}.json`));
  const second = claimed(f.cli("claim", ["--pool", "ws", "--wait", "2", "--label", "second"]));
  assert.equal(second.slot, "1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "slot-0.json"), "utf8")).token, holder);
  assert.ok(f.containers().includes(container), "a live holder's container is never removed");

  fs.unlinkSync(path.join(dir, `${holder}.json`));
  const third = f.cli("claim", ["--pool", "ws", "--wait", "2", "--label", "third"]);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(claimed(third).slot, "0");
  assert.match(third.stderr, new RegExp(`removed workstation ${container} \\(slot 0 of pool ws, "live holder"\\): its holder ticket is gone`));
  assert.ok(!f.containers().includes(container));
  for (const fields of [second, claimed(third)]) assert.equal(f.cli("release", ["--pool", "ws", "--token", fields.token]).code, 0);
});

test("a release slowed in docker rm never removes the slot handed on meanwhile", async t => {
  const f = fixture(t, { slots: 1 });
  const owner = f.sleeper();
  const first = claimed(f.cli("claim", ["--pool", "ws", "--owner-pid", String(owner.pid), "--label", "first"]));
  kill(owner.pid);
  await waitFor(() => !alive(owner.pid), "the owner to die");
  // The owner is gone, so the next claim reclaims "first" while its own release is still removing the container.
  const release = f.start("release", ["--pool", "ws", "--token", first.token], { FAKE_DOCKER_RM_DELAY_MS: "2000" });
  await waitFor(() => f.calls().some(call => call[0] === "rm" && call.includes(first.workstation)), "the release to start removing its container");
  const next = f.cli("claim", ["--pool", "ws", "--wait", "20", "--label", "next"]);
  assert.equal(next.code, 0, next.stderr);
  await release.done;
  const slot = JSON.parse(fs.readFileSync(path.join(f.root, ".ai-dev-kit", "pools", "ws", "slot-0.json"), "utf8"));
  assert.equal(slot.token, claimed(next).token, "the slot handed to next must survive the slow release");
  assert.equal(f.status().slots[0].label, "next");
  assert.equal(f.cli("claim", ["--pool", "ws", "--wait", "0", "--label", "third"]).code, 75, "slot 0 must not be handed out twice");
  assert.deepEqual(f.containers(), [claimed(next).workstation]);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", claimed(next).token]).code, 0);
});

test("only the holder's own token releases a workstation", async t => {
  const f = fixture(t, { slots: 1 }, {});
  f.writeConfig({ slots: 1 }, {});
  const config = JSON.parse(fs.readFileSync(path.join(f.root, ".ai-dev-kit", "workstations.json"), "utf8"));
  config.pools.other = { ...config.pools.ws };
  fs.writeFileSync(path.join(f.root, ".ai-dev-kit", "workstations.json"), JSON.stringify(config));
  const first = claimed(f.cli("claim", ["--pool", "ws", "--label", "first"]));
  const forged = "000000000001-0123456789abcdef";
  const wrong = f.cli("release", ["--pool", "ws", "--token", forged]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /is not held/);
  const otherPool = f.cli("release", ["--pool", "other", "--token", first.token]);
  assert.equal(otherPool.code, 1);
  assert.equal(f.status().slots[0].label, "first");
  assert.equal(f.cli("release", ["--pool", "ws", "--token", first.token]).code, 0);
  const second = claimed(f.cli("claim", ["--pool", "ws", "--label", "second"]));
  assert.equal(second.slot, "0");
  const stale = f.cli("release", ["--pool", "ws", "--token", first.token]);
  assert.equal(stale.code, 1, "an old token must not release the next holder's workstation");
  assert.equal(f.status().slots[0].label, "second");
  assert.deepEqual(f.containers(), [second.workstation]);
  const status = f.cli("status", ["--pool", "ws"]).stdout + f.cli("status", ["--pool", "ws", "--json"]).stdout;
  assert.ok(!status.includes(second.token), "status must not reveal tokens");
  assert.equal(f.cli("release", ["--pool", "ws", "--token", second.token]).code, 0);
});

test("a killed holder's workstation is reclaimed, removed and recorded", async t => {
  const f = fixture(t, { slots: 1 });
  const owner = f.sleeper();
  const victim = claimed(f.cli("claim", ["--pool", "ws", "--owner-pid", String(owner.pid), "--label", "victim"]));
  kill(owner.pid);
  await waitFor(() => !alive(owner.pid), "owner to die");
  const next = f.cli("claim", ["--pool", "ws", "--wait", "10", "--label", "next"]);
  assert.equal(next.code, 0, next.stderr);
  const fields = claimed(next);
  assert.notEqual(fields.workstation, victim.workstation);
  assert.match(next.stderr, new RegExp(`reclaimed workstation slot 0 of pool ws from "victim": owner pid ${owner.pid} is gone`));
  assert.match(next.stderr, new RegExp(`removed workstation ${victim.workstation} \\(slot 0 of pool ws, "victim"\\)`));
  assert.deepEqual(f.containers(), [fields.workstation]);
  assert.deepEqual(f.status().recent.map(event => event.event), ["reclaimed", "freed"]);
  const late = f.cli("release", ["--pool", "ws", "--token", victim.token]);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /was reclaimed at .*owner pid \d+ is gone/);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", fields.token]).code, 0);
});

test("an expired lease is reclaimed loudly even while its owner runs, and renew prevents that", async t => {
  const f = fixture(t, { slots: 1 });
  const owner = f.sleeper();
  const expired = claimed(f.cli("claim", ["--pool", "ws", "--owner-pid", String(owner.pid), "--max-hold", "1", "--label", "slow"]));
  const next = f.cli("claim", ["--pool", "ws", "--wait", "10", "--label", "next"]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stderr, new RegExp(`reclaimed workstation slot 0 of pool ws from "slow": not refreshed for \\d+s \\(max-hold 1s\\) while owner pid ${owner.pid} was still running`));
  const renewLate = f.cli("renew", ["--pool", "ws", "--token", expired.token]);
  assert.equal(renewLate.code, 1);
  assert.match(renewLate.stderr, /was reclaimed at .*while owner pid \d+ was still running/);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", claimed(next).token]).code, 0);

  const kept = claimed(f.cli("claim", ["--pool", "ws", "--owner-pid", String(owner.pid), "--max-hold", "2", "--label", "renewing"]));
  const waiter = f.start("claim", ["--pool", "ws", "--wait", "4", "--label", "impatient"]);
  const renewals = [];
  while (waiter.child.exitCode === null) {
    renewals.push(f.cli("renew", ["--pool", "ws", "--token", kept.token]).code);
    await delay(400);
  }
  assert.equal((await waiter.done).code, 75);
  assert.ok(renewals.length >= 5 && renewals.every(code => code === 0), renewals.join(","));
  assert.equal(f.status().slots[0].label, "renewing");
  assert.equal(f.cli("release", ["--pool", "ws", "--token", kept.token]).code, 0);
});

test("a waiter past --wait leaves no ticket; the exclusive lock of the same name is independent", async t => {
  const f = fixture(t, { slots: 1 });
  const holder = claimed(f.cli("claim", ["--pool", "ws", "--label", "holder"]));
  const screen = f.cli("acquire", ["--name", "ws", "--wait", "0", "--label", "real screen"]);
  assert.equal(screen.code, 0, "the real-screen lock does not wait on the pool");
  const began = Date.now();
  const waiter = f.cli("claim", ["--pool", "ws", "--wait", "1", "--label", "waiter"]);
  assert.equal(waiter.code, 75);
  assert.ok(Date.now() - began < 8000);
  assert.deepEqual(f.poolFiles().filter(name => name.endsWith(".json") && !name.startsWith("slot-")), [`${holder.token}.json`]);
  const all = f.cli("status", []).stdout;
  assert.match(all, /^ {2}lock ws: holding by "real screen" pid - for \d+s$/m);
  assert.match(all, /^ {2}pool ws: 1 of 1 workstations held, 0 waiting/m);
  assert.equal(f.cli("release", ["--name", "ws", "--token", screen.stdout.trim()]).code, 0);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", holder.token]).code, 0);
});

test("status shows each workstation's holder, hold time, lease, waiting time and a long-hold reminder", async t => {
  const f = fixture(t, { slots: 1, max_hold_seconds: 600 });
  const holder = claimed(f.cli("claim", ["--pool", "ws", "--label", "holder"]));
  const waiter = f.start("claim", ["--pool", "ws", "--wait", "30", "--label", "waiter"]);
  await waitFor(() => f.status().queue.length === 1, "the waiter to queue");
  await delay(1200);
  const report = f.status(["--warn-hold", "1"]);
  const [slot] = report.slots;
  assert.equal(slot.state, "holding");
  assert.equal(slot.label, "holder");
  assert.equal(slot.workstation, holder.workstation);
  assert.ok(slot.held_s >= 1 && slot.over_warn, JSON.stringify(slot));
  assert.ok(slot.lease_left_s > 590 && slot.lease_left_s <= 600, JSON.stringify(slot));
  assert.equal(report.queue[0].label, "waiter");
  assert.ok(report.queue[0].waited_s >= 1);
  const text = f.cli("status", ["--pool", "ws", "--warn-hold", "1"]).stdout;
  assert.match(text, /^pool ws: 1 of 1 workstations held, 1 waiting, longest \d+s/m);
  assert.match(text, new RegExp(`^ {2}slot 0 {2}holding {2}${holder.workstation} {2}"holder" no owner pid, held \\d+s, lease 9m\\d\\ds left {2}! held over 1s`, "m"));
  assert.match(text, /^ {2}waiting {2}pid \d+ {2}waited \d+s {2}waiter/m);
  assert.doesNotMatch(f.cli("status", ["--pool", "ws"]).stdout, /! held over/, "default reminder is 30 minutes");
  assert.equal(f.cli("release", ["--pool", "ws", "--token", holder.token]).code, 0);
  const second = claimed(await waiter.done);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", second.token]).code, 0);
});

test("the gate's local status lists the real-screen lock and every workstation", async t => {
  const f = fixture(t, { slots: 2 });
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const holder = claimed(f.cli("claim", ["--pool", "ws", "--label", "visual pass"]));
  const screen = f.cli("acquire", ["--name", "godot", "--label", "host window"]);
  const result = spawnSync(process.execPath, [gateEvidence, "status", "--project", f.root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^resources on this machine \(not reported to the center\):$/m);
  assert.match(result.stdout, /^ {2}lock godot: holding by "host window" pid - for \d+s$/m);
  assert.match(result.stdout, /^ {2}pool ws: 1 of 2 workstations held, 0 waiting/m);
  assert.match(result.stdout, /^ {4}slot 0 {2}holding .*"visual pass"/m);
  assert.match(result.stdout, /^ {4}slot 1 {2}free$/m);
  const json = JSON.parse(spawnSync(process.execPath, [gateEvidence, "status", "--project", f.root, "--json"], { encoding: "utf8" }).stdout);
  assert.equal(json.resources.pools[0].slots[0].label, "visual pass");
  f.cli("release", ["--name", "godot", "--token", screen.stdout.trim()]);
  f.cli("release", ["--pool", "ws", "--token", holder.token]);
});

test("a killed run keeps its workstation while its command runs, then the next claim reclaims it", async t => {
  const f = fixture(t, { slots: 1 });
  const run = f.start("run", ["--pool", "ws", "--label", "orphan", "--", f.log, "O", "1500"]);
  await waitFor(() => f.events().includes(`O start ${f.containers()[0]}`), "the command to start");
  kill(run.child.pid);
  await run.exited;
  const early = f.cli("claim", ["--pool", "ws", "--wait", "0", "--label", "early"]);
  assert.equal(early.code, 75, "the orphaned command still holds the workstation");
  const after = f.cli("claim", ["--pool", "ws", "--wait", "10", "--label", "after"]);
  assert.equal(after.code, 0, after.stderr);
  assert.ok(f.events().some(line => line.startsWith("O end")), "the command finished before the reclaim");
  assert.match(after.stderr, /reclaimed workstation slot 0 of pool ws from "orphan": owner pid \d+ is gone/);
  assert.deepEqual(f.containers(), [claimed(after).workstation]);
  f.cli("release", ["--pool", "ws", "--token", claimed(after).token]);
});

test("configuration errors exit 2 with a clear message and claim nothing", async t => {
  const f = fixture(t);
  const claim = () => f.cli("claim", ["--pool", "ws", "--wait", "0"]);
  const cases = [
    [{ slots: 0 }, /pools\.ws\.slots must be a whole number from 1 to 64/],
    [{ memory: "lots" }, /pools\.ws\.memory must be at least 64m/],
    [{ slot: 2 }, /unknown setting slot in pools\.ws/],
    [{ start: [] }, /pools\.ws\.start must be a non-empty list/],
    [{ screen: "big" }, /pools\.ws\.screen must look like 1920x1080x24/],
    [{ slots: 4 }, /the pools may use 10\.00 GiB of memory \(ws: 4 × 2\.50 GiB\), more than the 7\.65 GiB Docker can use; lower slots or memory in .*workstations\.json, or give Docker more memory/],
    [{ cpus: 12 }, /pool ws gives each workstation 12 CPUs but Docker has 10/],
  ];
  for (const [settings, message] of cases) {
    f.writeConfig(settings);
    const result = claim();
    assert.equal(result.code, 2, `${JSON.stringify(settings)}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  f.writeConfig({});
  assert.match(f.cli("claim", ["--pool", "nope"]).stderr, /declares no pool "nope" \(declared: ws\)/);
  fs.writeFileSync(path.join(f.root, ".ai-dev-kit", "workstations.json"), "{");
  assert.match(claim().stderr, /invalid JSON/);
  fs.rmSync(path.join(f.root, ".ai-dev-kit", "workstations.json"));
  const missing = claim();
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no workstation pools are declared: .*workstations\.json does not exist/);
  assert.equal(fs.existsSync(path.join(f.root, ".ai-dev-kit", "pools", "ws")), false);

  f.writeConfig({});
  const defaults = f.cli("claim", ["--pool", "ws"]);
  assert.equal(defaults.code, 0, `the defaults (3 × 2.5 GiB) fit an 8 GB Docker VM: ${defaults.stderr}`);
  const started = f.calls().filter(call => call[0] === "run" && call.includes("-d")).pop();
  assert.deepEqual(["--cpus", "--memory", "--memory-swap"].map(flag => started[started.indexOf(flag) + 1]), ["3", "2684354560", "2684354560"]);
  assert.ok(started.includes("LP_NUM_THREADS=3"));
  f.cli("release", ["--pool", "ws", "--token", claimed(defaults).token]);

  f.writeConfig({ image: "missing:1" });
  const noImage = claim();
  assert.equal(noImage.code, 1);
  assert.match(noImage.stderr, /image missing:1 of pool ws is not available locally/);
  fs.writeFileSync(path.join(f.root, "Dockerfile"), "FROM scratch\n");
  f.writeConfig({ image: "built:1", build: { dockerfile: "Dockerfile" } });
  const built = f.cli("claim", ["--pool", "ws"]);
  assert.equal(built.code, 0, built.stderr);
  assert.ok(f.calls().some(call => call[0] === "build" && call.includes("built:1") && call.includes(path.join(f.root, "Dockerfile"))));
  f.cli("release", ["--pool", "ws", "--token", claimed(built).token]);
});

test("a claim is refused before anything starts when Docker's or the host's free disk is short", async t => {
  const f = fixture(t, { slots: 1, min_free_disk: "5g" });
  const low = f.cli("claim", ["--pool", "ws", "--wait", "0"], { FAKE_DOCKER_DISK_FREE_KB: String(2 * 1024 * 1024) });
  assert.equal(low.code, 75);
  assert.match(low.stderr, /BLOCKED \(retryable\): pool ws needs 5\.00 GiB free \(min_free_disk\) but Docker's disk has 2\.00 GiB free; free space \(resource-lock\.cjs prune --pool ws/);
  assert.equal(fs.existsSync(path.join(f.root, ".ai-dev-kit", "pools", "ws")), false, "no ticket, no state");
  assert.deepEqual(f.containers(), []);
  f.writeConfig({ slots: 1, min_free_disk: "100000g" });
  const host = f.cli("run", ["--pool", "ws", "--", f.log, "never", "0"]);
  assert.equal(host.code, 75);
  assert.match(host.stderr, /the host disk at .* has [\d.]+ GiB free/);
  assert.deepEqual(f.events(), []);
  f.writeConfig({ slots: 1, min_free_disk: "0" });
  const earlier = f.calls().length;
  const unchecked = f.cli("claim", ["--pool", "ws"], { FAKE_DOCKER_DISK_FREE_KB: "1" });
  assert.equal(unchecked.code, 0, "min_free_disk 0 turns the check off");
  assert.ok(!f.calls().slice(earlier).some(call => call.includes("--entrypoint")));
  f.cli("release", ["--pool", "ws", "--token", claimed(unchecked).token]);
});

test("prune removes only workstations no slot holds, superseded images the pool built, and old unheld evidence", async t => {
  const f = fixture(t, { slots: 2 });
  fs.writeFileSync(path.join(f.root, "Dockerfile"), "FROM scratch\n");
  f.writeConfig({ slots: 2, image: "built:2", build: { dockerfile: "Dockerfile" } });
  const held = claimed(f.cli("claim", ["--pool", "ws", "--label", "held"]));
  const label = fs.readFileSync(path.join(f.dockerState, "images.txt"), "utf8").split("\n").find(line => line.startsWith("built:2\t")).split("\t")[1];
  assert.match(label, /^ai-dev-kit\.workstation\.image=[0-9a-f]{8}\/ws$/);
  fs.appendFileSync(path.join(f.dockerState, "images.txt"), `built:1\t${label}\nother:1\n`);
  const project = label.split("=")[1].split("/")[0];
  const stray = `aidk-ws-${project}-ws-1-dead00`;
  fs.writeFileSync(path.join(f.dockerState, "containers", `${stray}.json`), JSON.stringify({
    name: stray, image: "built:2", labels: { "ai-dev-kit.workstation": `${project}/ws`, "ai-dev-kit.workstation.slot": "1" },
  }));
  const out = path.join(f.root, ".ai-dev-kit", "pools", "ws", "out");
  const old = path.join(out, "000000000009-0123456789abcdef");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "shot.png"), Buffer.alloc(100000));
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(path.join(out, held.token), tenDaysAgo, tenDaysAgo);

  const dry = f.cli("prune", ["--pool", "ws", "--dry-run", "--evidence-days", "7"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`would remove workstation ${stray} \\(running, held by no slot\\)`));
  assert.match(dry.stdout, /would remove image built:1 \(built for this pool, no longer configured\)/);
  assert.match(dry.stdout, /would remove evidence .*000000000009-0123456789abcdef/);
  assert.ok(f.containers().includes(stray) && fs.existsSync(old));

  const pruned = f.cli("prune", ["--pool", "ws", "--evidence-days", "7"]);
  assert.equal(pruned.code, 0, pruned.stderr);
  assert.deepEqual(f.containers(), [held.workstation], "the held workstation stays");
  const images = fs.readFileSync(path.join(f.dockerState, "images.txt"), "utf8");
  assert.ok(!images.includes("built:1") && images.includes("built:2") && images.includes("other:1"), images);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(out, held.token)), true, "evidence of a held claim stays, however old");
  assert.match(pruned.stdout, /^free disk: host [\d.]+ GiB -> [\d.]+ GiB, Docker [\d.]+ GiB -> [\d.]+ GiB/m);
  assert.match(f.cli("prune", ["--pool", "ws"]).stdout, /^pool ws: nothing to remove$/m);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", held.token]).code, 0);
});

test("status reports actual disk use: Docker and host free space, image, writable layers and evidence", async t => {
  const f = fixture(t, { slots: 1 });
  const held = claimed(f.cli("claim", ["--pool", "ws"]));
  fs.writeFileSync(path.join(held.out, "shot.png"), Buffer.alloc(200000));
  const report = f.status();
  assert.equal(report.docker.disk.vm.free, 419430400 * 1024);
  assert.ok(report.docker.disk.host.free > 0);
  assert.equal(report.docker.disk.image.size, "1.81GB");
  assert.equal(report.docker.containers[0].writable, "4.05MB");
  assert.equal(report.evidence.runs, 1);
  assert.ok(report.evidence.allocated_bytes >= 200000, JSON.stringify(report.evidence));
  const text = f.cli("status", ["--pool", "ws"]).stdout;
  assert.match(text, /^disk: Docker [\d.]+ GiB used, 400\.00 GiB free; host [\d.]+ GiB free at .*; claims need 5\.00 GiB free on both$/m);
  assert.match(text, /^ {2}image ws-image:test: 1\.81GB \(Docker's count, one copy for every workstation\)$/m);
  assert.match(text, new RegExp(`^ {2}workstation ${held.workstation}: 4\\.05MB writable layer \\(running\\)$`, "m"));
  assert.match(text, /^ {2}evidence .*: 1 run\(s\), 0\.00 GiB allocated$/m);
  f.cli("release", ["--pool", "ws", "--token", held.token]);
});

test("a checkout lacking what the pool requires is refused with the host-side preparation hint", async t => {
  const f = fixture(t, { slots: 1, requires: ["Game/.godot/imported", "Game/assets"], prepare: "pull assets, then cp -c -R the import cache of a checkout with the same lock" });
  const result = f.cli("run", ["--pool", "ws", "--", f.log, "never", "0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /checkout .* lacks Game\/\.godot\/imported, Game\/assets, which pool ws requires; prepare it on the host, not in a workstation: pull assets, then cp -c -R the import cache/);
  assert.deepEqual(f.events(), []);
  assert.equal(fs.existsSync(path.join(f.root, ".ai-dev-kit", "pools", "ws")), false);
  fs.mkdirSync(path.join(f.root, "Game", ".godot", "imported"), { recursive: true });
  fs.mkdirSync(path.join(f.root, "Game", "assets"));
  assert.equal(f.cli("run", ["--pool", "ws", "--", f.log, "ran", "0"]).code, 0);
  f.writeConfig({ requires: ["../outside"] });
  assert.match(f.cli("claim", ["--pool", "ws"]).stderr, /requires must list paths inside the checkout/);
});

test("slot-mutex markers of reused pids or past the backstop age are removed; a live holder's marker is honored", async t => {
  const f = fixture(t, { slots: 1 });
  const dir = path.join(f.root, ".ai-dev-kit", "pools", "ws");
  fs.mkdirSync(dir, { recursive: true });
  const start = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();
  assert.ok(start, "ps reports this process's start time");
  // Markers owned by this live test process, as a holder inside the mutex would leave them.
  const marker = (hex, started, ageMs) => {
    const file = path.join(dir, `mutex-${hex.repeat(16)}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), started }));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const before = "Thu Jan  1 00:00:00 1970";

  const live = marker("a", start, 10000);
  const blocked = f.cli("claim", ["--pool", "ws", "--wait", "2", "--label", "blocked"]);
  assert.equal(blocked.code, 75, blocked.stderr);
  assert.match(blocked.stderr, new RegExp(`the slot mutex is held by pid ${process.pid}\\)`));
  assert.ok(fs.existsSync(live), "the marker of a live holder with its own start time stays");
  fs.unlinkSync(live);

  const young = marker("b", before, 0);
  assert.equal(f.cli("claim", ["--pool", "ws", "--wait", "2"]).code, 75, "a marker younger than 5 s is not checked for a reused pid");
  assert.ok(fs.existsSync(young));
  fs.unlinkSync(young);

  const reused = marker("c", before, 10000);
  const afterReuse = f.cli("claim", ["--pool", "ws", "--wait", "5", "--label", "after reuse"]);
  assert.equal(afterReuse.code, 0, afterReuse.stderr);
  assert.match(afterReuse.stderr, new RegExp(`removed slot-mutex marker mutex-c{16}\\.json of pid ${process.pid}: its holder can no longer act`));
  assert.equal(fs.existsSync(reused), false);
  assert.equal(f.cli("release", ["--pool", "ws", "--token", claimed(afterReuse).token]).code, 0);

  const expired = marker("d", start, 31 * 60000);
  const afterBackstop = f.cli("claim", ["--pool", "ws", "--wait", "5", "--label", "after backstop"]);
  assert.equal(afterBackstop.code, 0, afterBackstop.stderr);
  assert.equal(fs.existsSync(expired), false, "a marker not refreshed for 30 minutes is removed even if its pid looks alive");
  assert.equal(f.cli("release", ["--pool", "ws", "--token", claimed(afterBackstop).token]).code, 0);
});
