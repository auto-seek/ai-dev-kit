// Perspective: an agent that claims a Linux workstation container to run and
// inspect a GUI program without touching the host's screen, focus or pointer.
// Invariant: ws-run gives the command a private X screen, returns its exit code
// and records it in ws-run.json; a timeout or exit stops the command's whole
// process group; an OOM kill is not reported as a timeout; ws-input and
// ws-shot act on that private screen only.
// Pools: scripts/resource-lock.cjs claims, runs, reclaims and releases real
// containers of this image with the declared limits.
// Goal: keep the workstation entry contract that pool semantics build on honest.
// Migration: needs Docker and a base image built from
// templates/workstation/base, named by WORKSTATION_IMAGE; missing prerequisites
// fail instead of skipping. Containers, Xvfb and XTEST input are all real.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const image = process.env.WORKSTATION_IMAGE;
assert.ok(image, "Set WORKSTATION_IMAGE to an image built from templates/workstation/base (see templates/workstation/README.md).");
assert.equal(spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status, 0, `Docker image ${image} is not available.`);
const user = `${process.getuid()}:${process.getgid()}`;

function outDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-workstation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}

function run(out, args, extra = []) {
  return docker(["run", "--rm", "--user", user, ...extra, "-v", `${out}:/ws/out`, image, ...args]);
}

function record(out, sub = "") {
  return JSON.parse(fs.readFileSync(path.join(out, sub, "ws-run.json"), "utf8"));
}

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function session(t, out) {
  const name = `aidk-ws-test-${process.pid}-${Date.now()}`;
  const started = docker(["run", "-d", "--name", name, "--user", user, "-v", `${out}:/ws/out`, image, "--screen", "640x480x24"]);
  assert.equal(started.status, 0, started.stderr);
  t.after(() => docker(["rm", "-f", name]));
  const exec = command => docker(["exec", name, ...command]);
  for (let i = 0; i < 100 && exec(["xdpyinfo"]).status !== 0; i++) spawnSync("sleep", ["0.1"]);
  assert.equal(exec(["xdpyinfo"]).status, 0, "session screen did not come up");
  return exec;
}

test("a batch run returns the command's code on a private screen and records it", t => {
  const out = outDir(t);
  const script = 'test "$DISPLAY" = :99 && xdpyinfo | grep -q "800x600 pixels" && test -w "$HOME" && exit 7';
  const result = run(out, ["--screen", "800x600x24", "--shot", "final", "--", "bash", "-c", script, "--looks-like-a-flag"]);
  assert.equal(result.status, 7, result.stderr);
  const outcome = record(out);
  assert.equal(outcome.exit, 7);
  assert.equal(outcome.timed_out, false);
  assert.equal(outcome.screen, "800x600x24");
  assert.deepEqual(outcome.command, ["bash", "-c", script, "--looks-like-a-flag"]);
  assert.equal(typeof outcome.duration_s, "number");
  assert.equal(typeof outcome.container.memory_peak_bytes, "number");
  assert.deepEqual(pngSize(path.join(out, "final.png")), [800, 600]);
});

test("a timeout stops the whole command group and is recorded as a timeout", t => {
  const out = outDir(t);
  const exec = session(t, out);
  const result = exec(["ws-run", "--out", "/ws/out/slow", "--timeout", "1", "--",
    "bash", "-c", "sleep 300 & echo $! > /ws/out/slow-child; sleep 300"]);
  assert.equal(result.status, 124, result.stderr);
  const outcome = record(out, "slow");
  assert.equal(outcome.timed_out, true);
  assert.ok(outcome.duration_s >= 1 && outcome.duration_s < 15, `duration ${outcome.duration_s}`);
  const child = fs.readFileSync(path.join(out, "slow-child"), "utf8").trim();
  assert.notEqual(exec(["kill", "-0", child]).status, 0, "background child survived the timeout");
  assert.equal(exec(["xdpyinfo"]).status, 0, "the session screen must outlive one batch command");
});

test("background processes do not outlive a command that exits", t => {
  const out = outDir(t);
  const exec = session(t, out);
  const result = exec(["ws-run", "--out", "/ws/out/quick", "--", "bash", "-c", "sleep 300 & echo $! > /ws/out/quick-child"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record(out, "quick").timed_out, false);
  const child = fs.readFileSync(path.join(out, "quick-child"), "utf8").trim();
  assert.notEqual(exec(["kill", "-0", child]).status, 0, "background child survived its command");
});

test("injected keys and clicks reach the focused window on the private screen", t => {
  const out = outDir(t);
  const script = [
    "set -e",
    "xev -geometry 300x200+0+0 -event keyboard -event button > /ws/out/xev.log &",
    'ws-input wait "Event Tester" 10 > /dev/null',
    'ws-input focus "Event Tester" > /dev/null',
    "ws-input key a ctrl+s Escape",
    "ws-input click 50 60",
    "sleep 0.5",
    "ws-shot /ws/out/screen.png",
  ].join("\n");
  const result = run(out, ["--screen", "640x480x24", "--", "bash", "-c", script]);
  assert.equal(result.status, 0, result.stderr);
  const events = fs.readFileSync(path.join(out, "xev.log"), "utf8").split(/\n(?=\S)/);
  const keys = events.filter(e => e.startsWith("KeyPress")).map(e => e.match(/keysym 0x[0-9a-f]+, (\w+)/)[1]);
  assert.deepEqual(keys, ["a", "Control_L", "s", "Escape"]);
  const clicks = events.filter(e => e.startsWith("ButtonPress"));
  assert.equal(clicks.length, 1);
  assert.match(clicks[0], /root:.*\(50,60\)/s);
  assert.match(clicks[0], /button 1,/);
  assert.deepEqual(pngSize(path.join(out, "screen.png")), [640, 480]);
});

test("an out-of-memory kill is reported as such, not as a timeout", t => {
  const out = outDir(t);
  const result = run(out, ["--timeout", "60", "--", "bash", "-c", "head -c 1G /dev/zero | tail > /dev/null"],
    ["--memory", "64m", "--memory-swap", "64m"]);
  assert.equal(result.status, 137, result.stderr);
  const outcome = record(out);
  assert.equal(outcome.timed_out, false);
  assert.ok(outcome.container.oom_kills >= 1, `oom_kills ${outcome.container.oom_kills}`);
});

test("usage errors exit 2 without running anything", t => {
  const out = outDir(t);
  for (const args of [["--timeout", "soon", "--", "true"], ["--screen", "big", "--", "true"], ["--shot", "../x", "--", "true"]]) {
    assert.equal(run(out, args).status, 2, args.join(" "));
  }
  assert.equal(fs.existsSync(path.join(out, "ws-run.json")), false);
  assert.equal(docker(["run", "--rm", "--entrypoint", "ws-shot", image]).status, 2);
  assert.equal(docker(["run", "--rm", "--entrypoint", "ws-input", image, "click", "x", "1"]).status, 2);
});

const lock = path.resolve(__dirname, "../scripts/resource-lock.cjs");

function pool(t, settings = {}) {
  const root = outDir(t);
  fs.mkdirSync(path.join(root, ".ai-dev-kit"));
  fs.writeFileSync(path.join(root, ".ai-dev-kit", "workstations.json"), JSON.stringify({
    schema_version: 1,
    pools: { ws: { image, start: ["bash", "-c"], slots: 2, cpus: 1, memory: "256m", screen: "640x480x24", ...settings } },
  }));
  const cli = (command, rest) => {
    const result = spawnSync(process.execPath, [lock, command, "--root", root, ...rest], { cwd: root, encoding: "utf8", timeout: 120000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const claim = rest => {
    const result = cli("claim", ["--pool", "ws", ...rest]);
    assert.equal(result.code, 0, result.stderr);
    const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    t.after(() => docker(["rm", "-f", fields.workstation]));
    return fields;
  };
  return { root, cli, claim };
}

const exists = name => docker(["inspect", name]).status === 0;

test("a claimed workstation is a new container with the pool's limits, and release removes it", t => {
  const p = pool(t);
  const first = p.claim(["--label", "limits"]);
  const inspect = docker(["inspect", first.workstation, "--format",
    '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.Config.User}} {{index .Config.Labels "ai-dev-kit.workstation.slot"}}']);
  assert.equal(inspect.stdout.trim(), `1000000000 268435456 268435456 ${user} ${first.slot}`);
  const dirty = docker(["exec", first.workstation, "ws-run", "--", "bash", "-c",
    'xdpyinfo | grep -q "640x480 pixels" && test -w /ws/out && touch /tmp/left-behind']);
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.equal(p.cli("release", ["--pool", "ws", "--token", first.token]).code, 0);
  assert.equal(exists(first.workstation), false, "release removes the container");
  const next = p.claim(["--label", "clean"]);
  assert.notEqual(next.workstation, first.workstation);
  assert.equal(docker(["exec", next.workstation, "test", "!", "-e", "/tmp/left-behind"]).status, 0, "the next holder starts clean");
  assert.equal(p.cli("release", ["--pool", "ws", "--token", next.token]).code, 0);
});

test("a killed owner's workstation is removed and the slot is handed on", async t => {
  const p = pool(t, { slots: 1 });
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const gone = new Promise(resolve => owner.on("exit", resolve));
  const victim = p.claim(["--owner-pid", String(owner.pid), "--label", "victim"]);
  owner.kill("SIGKILL");
  await gone;
  const next = p.claim(["--wait", "30", "--label", "next"]);
  assert.equal(next.slot, "0");
  assert.equal(exists(victim.workstation), false);
  assert.equal(exists(next.workstation), true);
  assert.equal(p.cli("release", ["--pool", "ws", "--token", victim.token]).code, 1);
  assert.equal(p.cli("release", ["--pool", "ws", "--token", next.token]).code, 0);
});

test("run --pool runs the start command on a workstation and removes it afterwards", t => {
  const p = pool(t);
  const ok = p.cli("run", ["--pool", "ws", "--", 'xdpyinfo | grep -q "640x480 pixels" && echo ran > /ws/out/ran']);
  assert.equal(ok.code, 0, ok.stderr);
  const outs = path.join(p.root, ".ai-dev-kit", "pools", "ws", "out");
  assert.deepEqual(fs.readdirSync(outs).map(token => fs.readFileSync(path.join(outs, token, "ran"), "utf8")), ["ran\n"]);
  assert.equal(p.cli("run", ["--pool", "ws", "--", "exit 3"]).code, 3);
  const id = docker(["ps", "-a", "--filter", "label=ai-dev-kit.workstation", "--format", "{{.Names}}"]).stdout;
  assert.doesNotMatch(id, /-ws-\d-/, "no workstation of this pool is left behind");
});

test("a pool needing more memory than Docker has is refused before anything starts", t => {
  const total = Number(docker(["info", "--format", "{{.MemTotal}}"]).stdout.trim());
  const p = pool(t, { slots: 2, memory: String(total) });
  const result = p.cli("claim", ["--pool", "ws", "--wait", "0"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /more than the [\d.]+ GiB Docker can use; lower slots or memory in .*workstations\.json, or give Docker more memory/);
});

test("status reports Docker's real disk; prune removes a stray workstation but never a held one", t => {
  const p = pool(t);
  const held = p.claim(["--label", "held"]);
  const id = require("node:crypto").createHash("sha256").update(path.resolve(p.root)).digest("hex").slice(0, 8);
  const stray = `aidk-ws-${id}-ws-1-stray0`;
  assert.equal(docker(["run", "-d", "--name", stray, "--label", `ai-dev-kit.workstation=${id}/ws`, "--label", "ai-dev-kit.workstation.slot=1", image]).status, 0);
  t.after(() => docker(["rm", "-f", stray]));
  const report = JSON.parse(p.cli("status", ["--pool", "ws", "--json"]).stdout);
  assert.ok(report.docker.disk.vm.free > 0 && report.docker.disk.vm.used > 0, JSON.stringify(report.docker.disk));
  assert.match(report.docker.containers.find(row => row.name === held.workstation).writable, /^[\d.]+k?B|^[\d.]+[kMG]B$/);
  assert.equal(report.docker.containers.find(row => row.name === stray).matches, false);
  const pruned = p.cli("prune", ["--pool", "ws"]);
  assert.equal(pruned.code, 0, pruned.stderr);
  assert.match(pruned.stdout, new RegExp(`removed workstation ${stray} \\(running, held by no slot\\)`));
  assert.equal(exists(stray), false);
  assert.equal(exists(held.workstation), true);
  assert.equal(p.cli("release", ["--pool", "ws", "--token", held.token]).code, 0);
});

test("a claim needing more free disk than there is exits 75 before anything starts", t => {
  const p = pool(t, { min_free_disk: "100000g" });
  const result = p.cli("claim", ["--pool", "ws", "--wait", "0"]);
  assert.equal(result.code, 75);
  assert.match(result.stderr, /BLOCKED \(retryable\): pool ws needs 100000\.00 GiB free \(min_free_disk\) but Docker's disk has [\d.]+ GiB free and the host disk at .* has [\d.]+ GiB free/);
});
