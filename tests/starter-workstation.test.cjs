// Perspective: a project that copied templates/workstation/examples/starter
// and follows the onboarding guide on a machine with Docker.
// Invariant: the example's capture script claims a real workstation, captures
// the game's menu at the pool's screen size and releases the container; a
// reviewer session plays the example through ws-play (focus, keys,
// screenshots, the project's UI summary), files a report with that evidence,
// and the gate then lets the player-visible change merge.
// Goal: prove the guide's whole path on real containers, not only its
// configuration.
// Migration: needs Docker and a base image built from templates/workstation/base
// (with ws-play), named by WORKSTATION_IMAGE; missing prerequisites fail. The
// example's image name is replaced by that image; everything else ships as is.
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

const image = process.env.WORKSTATION_IMAGE;
assert.ok(image, "Set WORKSTATION_IMAGE to an image built from templates/workstation/base (see templates/workstation/README.md).");
assert.equal(spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status, 0, `Docker image ${image} is not available.`);

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function starter(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-starter-ws-")));
  const project = path.join(root, "project");
  fs.cpSync(example, project, { recursive: true });
  t.after(() => {
    // Release removes workstations; this covers a test that failed while holding one.
    const outs = path.join(project, ".ai-dev-kit/pools/starter/out");
    for (const dir of fs.existsSync(outs) ? fs.readdirSync(outs) : []) {
      try { spawnSync("docker", ["rm", "-f", JSON.parse(fs.readFileSync(path.join(outs, dir, "claim.json"), "utf8")).workstation], { stdio: "ignore" }); } catch { /* no claim */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, AI_DEV_KIT: kit };
  for (const key of Object.keys(env)) if (key.startsWith("AI_DEV_KIT_") || key === "CLAUDE_CODE_SESSION_ID") delete env[key];
  const run = (command, args, { expected = 0, session } = {}) => {
    const result = spawnSync(command, args, { cwd: project, env: session ? { ...env, AI_DEV_KIT_SESSION_ID: session } : env, encoding: "utf8", timeout: 180000 });
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), body);
  };
  const commit = message => {
    run("git", ["add", "."]);
    run("git", ["-c", "user.name=Starter", "-c", "user.email=starter@example.invalid", "commit", "-qm", message]);
    return run("git", ["rev-parse", "HEAD"]).trim();
  };
  const config = JSON.parse(fs.readFileSync(path.join(project, ".ai-dev-kit/workstations.json"), "utf8"));
  config.pools.starter.image = image;
  write(".ai-dev-kit/workstations.json", `${JSON.stringify(config, null, 2)}\n`);
  write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nmerge_policy:\n  target_branch: main\nsubtraction:\n  gate_enabled: false\n");
  write(".ai-dev-kit/test-scope.json", `${JSON.stringify({ schema_version: 1, no_tests_reason: "The example's checks are tools/check.sh." })}\n`);
  write(".ai-dev-kit/workflow/LEDGER.md", "- [x] The menu starts a game\n");
  run("git", ["init", "-q", "-b", "main"]);
  commit("starter example");
  run("bash", ["tools/prepare.sh"]);
  return { project, run, write, commit };
}

test("the example's capture script records the menu on a workstation and releases it", t => {
  const s = starter(t);
  const out = s.run("bash", ["tools/capture.sh"]).match(/^evidence=(.+)$/m)[1];
  assert.deepEqual(pngSize(path.join(out, "menu.png")), [1280, 720]);
  const claim = JSON.parse(fs.readFileSync(path.join(out, "claim.json"), "utf8"));
  assert.equal(claim.image, image);
  assert.equal(spawnSync("docker", ["container", "inspect", claim.workstation], { stdio: "ignore" }).status, 1, "the workstation was removed");
});

test("a reviewer plays the example through ws-play, files the report, and the change merges", t => {
  const s = starter(t);
  s.run("git", ["checkout", "-qb", "codex/menu"]);
  s.write("game/menu.txt", "Start Game\nOptions\nQuit\n");
  const head = s.commit("add an options button");
  const request = s.run(process.execPath, [reviewTool, "request", "--goal", "Start a game from the menu", "--focus", "The menu offers Options"], { session: "author-session" });
  const id = request.match(/^request=(\S+)$/m)[1];

  const claimed = s.run(process.execPath, [resourceLock, "claim", "--pool", "starter", "--wait", "120", "--label", `player review ${id}`]);
  const value = key => claimed.match(new RegExp(`^${key}=(.*)$`, "m"))[1];
  const ws = value("workstation"), out = value("out");
  const exec = args => s.run("docker", ["exec", ws, ...args]);
  s.run("docker", ["exec", "-d", ws, "ws-run", "--timeout", "300", "--", "game/start.sh"]);
  exec(["ws-input", "wait", "starter", "30"]);
  exec(["ws-play", "--note", "look at the menu", "focus", "starter"]);
  assert.match(exec(["ws-play", "summary"]), /window "Starter" at 0,0, 480x160/);
  const menuShot = exec(["ws-play", "shot", "menu"]).trim().split("\n")[0];
  assert.deepEqual(pngSize(path.join(out, menuShot)), [1280, 720]);
  exec(["ws-play", "--note", "press Start Game, the default button", "key", "Return"]);
  exec(["ws-input", "wait", "playing", "30"]);
  assert.match(exec(["ws-play", "summary"]), /window "Starter: playing"/);
  s.run(process.execPath, [resourceLock, "release", "--pool", "starter", "--token", value("token")]);

  const steps = fs.readFileSync(path.join(out, "review/steps.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(steps.map(step => step.verb), ["focus", "summary", "shot", "key", "summary"]);
  const tree = s.run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  fs.writeFileSync(path.join(out, "review/report.md"), `# Player review ${id}: pass\n\nThe menu shows Start Game, Options and Quit; Return started a game.\n`);
  fs.writeFileSync(path.join(out, "review/report.json"), JSON.stringify({
    schema_version: 1, request: id, candidate: { commit: head, tree }, reviewer: { session: "reviewer-session", harness: "test" },
    verdict: "pass", summary: "The menu shows Start Game, Options and Quit; Return started a game.",
    stuck: [], confusing: [], spec_mismatches: [], feelings: "Plain and quick.", scores: { clarity: 5, response: 5, finish: 4 },
  }, null, 2));
  assert.match(s.run(process.execPath, [reviewTool, "file", "--request", id, "--evidence", out], { session: "reviewer-session" }),
    new RegExp(`filed pass player review ${id} for ${head.slice(0, 12)}; 5 steps`));
  const gate = phase => s.run("bash", [gatePath, "--phase", phase, "--project", s.project]);
  gate("preflight");
  assert.match(gate("merge"), /player review: passed/);
});
