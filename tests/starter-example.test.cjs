// Perspective: a maintainer onboarding a project by following
// skills/ai-dev-kit/references/workstation-onboarding.md with the example in
// templates/workstation/examples/starter.
// Invariant: the example's files work with the kit as they ship: the pool
// loads; a claim from an unprepared checkout is refused with the pool's
// prepare text; tools/prepare.sh imports on the host, clones the import cache
// from a checkout with the same assets.lock and refuses one with another lock;
// a claim from a prepared checkout starts a workstation with the declared
// limits and environment; tools/check.sh runs the focus-steal scan; the gate
// contract makes a player-visible change wait for a review or a listed owner's
// waiver.
// Goal: keep the guide's example honest, so a project that copies it starts
// from a configuration the kit accepts.
// Migration: the example is copied into a temporary Git repository and driven
// through the real scripts and gate; only the Docker CLI is tests/fake-docker.cjs.
// tests/starter-workstation.test.cjs plays the same example on real Docker.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const kit = path.resolve(__dirname, "..");
const example = path.join(kit, "templates/workstation/examples/starter");
const resourceLock = path.join(kit, "scripts/resource-lock.cjs");
const reviewTool = path.join(kit, "scripts/player-review.cjs");
const gatePath = path.join(kit, "scripts/skill-first-gate.sh");
const fakeDocker = path.join(__dirname, "fake-docker.cjs");
const IMAGE = "ai-dev-kit/workstation-base:local";

function starter(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-starter-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.cpSync(example, project, { recursive: true });
  const dockerState = path.join(root, "docker");
  fs.mkdirSync(dockerState);
  fs.writeFileSync(path.join(dockerState, "images.txt"), `${IMAGE}\n`);
  const env = { ...process.env, AI_DEV_KIT: kit, AI_DEV_KIT_DOCKER: fakeDocker, FAKE_DOCKER_STATE: dockerState };
  for (const key of Object.keys(env)) if (/^AI_DEV_KIT_(?!DOCKER$)/.test(key) || key === "CLAUDE_CODE_SESSION_ID") delete env[key];
  const run = (command, args, { cwd = project, expected = 0, extraEnv = {} } = {}) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const write = (file, body, cwd = project) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), body);
  };
  const git = (args, cwd = project) => run("git", args, { cwd });
  const commit = (message, cwd = project) => {
    git(["add", "."], cwd);
    git(["-c", "user.name=Starter", "-c", "user.email=starter@example.invalid", "commit", "-qm", message], cwd);
  };
  git(["init", "-q", "-b", "main"]);
  // What bootstrap/init-skill.sh and the project's test policy add.
  write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nmerge_policy:\n  target_branch: main\nsubtraction:\n  gate_enabled: false\n");
  write(".ai-dev-kit/test-scope.json", `${JSON.stringify({ schema_version: 1, no_tests_reason: "The example's checks are tools/check.sh." })}\n`);
  write(".ai-dev-kit/workflow/LEDGER.md", "- [x] The menu starts a game\n");
  commit("starter example");
  const lock = (command, args, opts = {}) => run(process.execPath, [resourceLock, command, ...args], opts);
  const calls = () => fs.readFileSync(path.join(dockerState, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, project, run, write, git, commit, lock, calls };
}

test("the example's pool loads and refuses a claim until the checkout is prepared on the host", t => {
  const s = starter(t);
  const status = s.lock("status", ["--pool", "starter", "--no-docker"]);
  assert.match(status, /starter/);
  const refused = s.lock("claim", ["--pool", "starter", "--wait", "0"], { expected: 1 });
  assert.match(refused, /lacks game\/\.import\/lock\.sha256, which pool starter requires; prepare it on the host, not in a workstation: on the host: tools\/prepare\.sh \[--from <another checkout with the same assets\.lock>\]; nothing ran/);
  assert.ok(!s.calls().some(call => call[0] === "run" && call.includes("-d")), "no workstation starts for an unprepared checkout");
});

test("prepare imports once, clones the cache for a checkout with the same lock and imports for another lock", t => {
  const s = starter(t);
  assert.match(s.run("bash", ["tools/prepare.sh"]), /^prepare: game\/\.import ready \(imported; 1 imported\)$/m);
  assert.match(s.run("bash", ["tools/prepare.sh"]), /^prepare: game\/\.import is current$/m);
  assert.equal(fs.readFileSync(path.join(s.project, "game/.import/title.txt.imported"), "utf8").split("\n")[1], "Starter");

  const second = path.join(s.root, "second");
  s.git(["worktree", "add", "-q", "-b", "codex/second", second]);
  assert.match(s.run("bash", ["tools/prepare.sh", "--from", s.project], { cwd: second }), /prepare: game\/\.import ready \(cloned from .*project; 0 imported\)/);
  for (const file of ["lock.sha256", "title.txt.imported"]) {
    assert.equal(fs.readFileSync(path.join(second, "game/.import", file), "utf8"), fs.readFileSync(path.join(s.project, "game/.import", file), "utf8"));
  }

  const third = path.join(s.root, "third");
  s.git(["worktree", "add", "-q", "-b", "codex/third", third]);
  s.write("game/assets/title.txt", "Starter Deluxe\n", third);
  assert.match(s.run("bash", ["tools/prepare.sh"], { cwd: third, expected: 1 }), /prepare: game\/assets\/title\.txt does not match assets\.lock; pull the assets again/);
  const hash = require("node:crypto").createHash("sha256").update("Starter Deluxe\n").digest("hex");
  s.write("assets.lock", `title.txt ${hash}\n`, third);
  const out = s.run("bash", ["tools/prepare.sh", "--from", s.project], { cwd: third });
  assert.match(out, /has no import cache for this assets\.lock; importing/);
  assert.match(out, /prepare: game\/\.import ready \(imported; 1 imported\)/);
  assert.equal(fs.readFileSync(path.join(third, "game/.import/title.txt.imported"), "utf8").split("\n")[1], "Starter Deluxe");
});

test("a claim from a prepared checkout starts a workstation with the example's limits, environment and start command", t => {
  const s = starter(t);
  s.run("bash", ["tools/prepare.sh"]);
  const claimed = s.lock("claim", ["--pool", "starter", "--wait", "0", "--label", "menu capture"]);
  const value = key => claimed.match(new RegExp(`^${key}=(.*)$`, "m"))[1];
  const started = s.calls().find(call => call[0] === "run" && call.includes("-d"));
  const flag = name => started[started.indexOf(name) + 1];
  assert.equal(flag("--cpus"), "1");
  assert.equal(flag("--memory"), String(512 * 1024 * 1024));
  assert.equal(flag("--memory-swap"), flag("--memory"));
  assert.equal(flag("-w"), s.project);
  assert.ok(started.includes("WS_PLAY_SUMMARY=tools/ws-summary.sh"), started.join(" "));
  assert.deepEqual(started.slice(-3), [IMAGE, "--screen", "1280x720x24"]);
  const claim = JSON.parse(fs.readFileSync(path.join(value("out"), "claim.json"), "utf8"));
  assert.deepEqual([claim.pool, claim.screen, claim.start, claim.label], ["starter", "1280x720x24", ["game/start.sh"], "menu capture"]);
  assert.match(value("exec"), /ws-run --timeout 300 -- game\/start\.sh$/);
  s.lock("release", ["--pool", "starter", "--token", value("token")]);
  assert.ok(!fs.existsSync(path.join(s.root, "docker/containers", `${value("workstation")}.json`)), "release removes the workstation");
});

test("the example's check runs the focus-steal scan, which reports a host input call by file and line", t => {
  const s = starter(t);
  assert.match(s.run("bash", ["tools/check.sh"]), /^focus-steal-scan: 0 violations in 0 of 5 files \(3 allowed\)$/m);
  s.write("tools/raise.sh", "#!/bin/bash\nset -e\nxdotool search --name Starter windowactivate\n");
  assert.match(s.run("bash", ["tools/check.sh"], { expected: 1 }), /^tools\/raise\.sh:3:1: x11\.xdotool — on the host xdotool moves the real pointer/m);
});

test("the example's contract holds a player-visible change until a review or a listed owner's waiver", t => {
  const s = starter(t);
  s.git(["checkout", "-qb", "codex/menu"]);
  s.write("game/menu.txt", "Start Game\nOptions\nQuit\n");
  s.commit("add an options button");
  const gate = (phase, expected = 0) => s.run("bash", [gatePath, "--phase", phase, "--project", s.project], { expected });
  assert.match(gate("preflight"), /^WARN: player review: player-visible files changed \(1: game\/menu\.txt\) but no player review is filed/m);
  assert.match(gate("merge", 2), /^FAIL: player review: player-visible files changed \(1: game\/menu\.txt\)/m);
  const review = (args, session, expected = 0) =>
    s.run(process.execPath, [reviewTool, ...args, "--project", s.project], { expected, extraEnv: { AI_DEV_KIT_SESSION_ID: session } });
  const request = review(["request", "--goal", "Start a game from the menu", "--focus", "The menu offers Options"], "author-session");
  const playtest = fs.readFileSync(request.match(/^playtest=(\S+)$/m)[1], "utf8");
  assert.match(playtest, /docs\/qa\/player-rubric\.md/);
  assert.match(playtest, /docs\/design\/menu\.md/);
  assert.match(playtest, /starter/);
  assert.match(review(["waive", "--owner", "someone", "--reason", "fine"], "owner-session", 1), /owner "someone" is not listed in player_review\.owners of main \(listed: lead-designer\)/);
  const waived = review(["waive", "--owner", "lead-designer", "--reason", "Button label only; checked in the menu design review"], "owner-session");
  s.git(["add", waived.match(/^waiver=(\S+)$/m)[1]]);
  s.git(["-c", "user.name=Starter", "-c", "user.email=starter@example.invalid", "commit", "-qm", "waive the menu review"]);
  gate("preflight");
  assert.match(gate("merge"), /^WARN: player review: WAIVED by owner lead-designer — Button label only; checked in the menu design review/m);
});
