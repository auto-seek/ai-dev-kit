// Perspective: a team whose player-visible changes must be accepted by someone
// who plays the build, not by the session that wrote it.
// Invariant: when a branch touches the contract's player_review.paths, merge
// needs the latest player review filed for the exact HEAD commit and tree to
// pass, to come from a session other than the author's, and to cite workstation
// evidence that still matches its manifest; preflight only warns; every other
// state blocks with its own reason.
// Goal: catch self-review, reviews of an older build, failing verdicts,
// tampered or missing evidence and unreviewed uncommitted changes before merge.
// Migration: real Git repositories, the real gate and player-review.cjs; only
// the project's evidence files (screenshots, steps, claim) are fixtures, as a
// reviewer on a workstation would leave them.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const kit = path.resolve(__dirname, "..");
const gatePath = path.join(kit, "scripts/skill-first-gate.sh");
const reviewPath = path.join(kit, "scripts/player-review.cjs");
const resourceLock = path.join(kit, "scripts/resource-lock.cjs");
const workflow = ".ai-dev-kit/workflow";
const AUTHOR = "author-session-1", REVIEWER = "reviewer-session-2";

function fixture(t, playerReview = { paths: ["game"], exclude: ["game/testing"], lock: "assets.lock", pool: "godot" }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-player-review-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AI_DEV_KIT_") || key === "CLAUDE_CODE_SESSION_ID") delete env[key];
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), body);
  };
  const run = (command, args, { expected = 0, extraEnv = {} } = {}) => {
    const result = spawnSync(command, args, { cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8" });
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const git = (...args) => run("git", args);
  const commit = (message = "fixture") => {
    git("add", ".");
    git("-c", "user.name=PlayerReview", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  write(".gitignore", `${workflow}/\n`);
  write(".ai-dev-kit/profile.yml", "coordination:\n  engine: ledger\nmerge_policy:\n  target_branch: main\nsubtraction:\n  gate_enabled: false\n");
  write(".ai-dev-kit/test-scope.json", JSON.stringify({ schema_version: 1, no_tests_reason: "Fixture-only project; the kit suite validates the player review gate." }) + "\n");
  const contract = { schema_version: 1, base_ref: "main", requirements: { mode: "global", ledger: `${workflow}/LEDGER.md` },
    preflight: { argv: [process.execPath, "-e", "0"], timeout_seconds: 30 }, player_review: playerReview };
  const saveContract = () => write(".ai-dev-kit/gate-contract.json", JSON.stringify(contract, null, 2) + "\n");
  saveContract();
  write(`${workflow}/LEDGER.md`, "- [x] Fixture requirement\n");
  write("game/menu.txt", "Start\n");
  write("game/testing/probe.txt", "probe\n");
  write("assets.lock", "sword: 1\n");
  write("docs/notes.txt", "notes\n");
  // resource-lock.cjs writes this when it creates the pools directory.
  write(".ai-dev-kit/pools/.gitignore", "*\n");
  commit("base");
  git("checkout", "-qb", "codex/current");
  const gate = (phase, expected = 0) => run("bash", [gatePath, "--phase", phase, "--project", project], { expected });
  const review = (args, { session, expected = 0 } = {}) =>
    run(process.execPath, [reviewPath, ...args, "--project", project], { expected, extraEnv: session ? { AI_DEV_KIT_SESSION_ID: session } : {} });
  const request = () => {
    const out = review(["request", "--goal", "Open the menu and start a game", "--focus", "The start button reads Start Game"], { session: AUTHOR });
    return out.match(/^request=(\S+)$/m)[1];
  };
  // What a reviewer leaves in a claim's out directory after playing through ws-play.
  const evidence = (id, { verdict = "pass", reviewer = REVIEWER, claim = true, candidate = null } = {}) => {
    const sheet = JSON.parse(fs.readFileSync(path.join(project, ".ai-dev-kit/player-review", id, "playtest.json"), "utf8"));
    const out = path.join(project, ".ai-dev-kit/pools/godot/out", `000000000001-${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`);
    fs.mkdirSync(path.join(out, "review/shots"), { recursive: true });
    if (claim) {
      fs.writeFileSync(path.join(out, "claim.json"), JSON.stringify({ schema_version: 1, pool: "godot", slot: 0, workstation: "aidk-ws-test-godot-0-abcdef",
        image: "example/godot:1", image_id: "sha256:1234", screen: "1920x1080x24", start: ["godot", "--rendering-method", "forward_plus"] }));
    }
    fs.writeFileSync(path.join(out, "review/shots/0001.png"), "png bytes");
    fs.writeFileSync(path.join(out, "review/steps.jsonl"), JSON.stringify({ n: 1, verb: "click", args: ["10", "10"], exit: 0, shot: "review/shots/0001.png" }) + "\n");
    fs.writeFileSync(path.join(out, "review/report.md"), `# Player review ${id}: ${verdict}\n`);
    fs.writeFileSync(path.join(out, "review/report.json"), JSON.stringify({
      schema_version: 1, request: id, candidate: candidate ?? { commit: sheet.candidate.commit, tree: sheet.candidate.tree },
      reviewer: { session: reviewer, harness: "test" }, verdict,
      summary: verdict === "pass" ? "Started a game from the menu." : "The start button does nothing.",
      stuck: [], confusing: [], spec_mismatches: [], feelings: "Plain.", scores: { clarity: 4 },
    }));
    return out;
  };
  const file = (id, out, { session = REVIEWER, expected = 0 } = {}) =>
    review(["file", "--request", id, "--evidence", out], { session, expected });
  return { root, project, write, git, commit, contract, saveContract, gate, review, request, evidence, file };
}

test("a change outside the player-visible paths needs no player review", t => {
  const f = fixture(t);
  f.write("docs/notes.txt", "more notes\n");
  f.write("game/testing/probe.txt", "excluded from player review\n");
  f.commit("docs");
  f.gate("preflight");
  const merge = f.gate("merge");
  assert.doesNotMatch(merge, /player review/);
});

test("a player-visible change without a review warns at preflight and blocks merge", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  const head = f.commit("rename start");
  const preflight = f.gate("preflight");
  assert.match(preflight, new RegExp(`^WARN: player review: player-visible files changed \\(1: game/menu.txt\\) but no player review is filed for ${head.slice(0, 12)}`, "m"));
  assert.match(preflight, /gate passed with warnings/);
  assert.match(f.gate("merge", 2), new RegExp(`^FAIL: player review: player-visible files changed \\(1: game/menu.txt\\) but no player review is filed for ${head.slice(0, 12)}`, "m"));
  const status = f.gate("status");
  assert.match(status, /player review: missing — player-visible files changed/);
  assert.match(status, /merge readiness: not ready — .*player review missing/);
});

test("a passing review from another session, bound to HEAD with intact evidence, lets merge pass", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  const head = f.commit("rename start");
  const id = f.request();
  const sheet = JSON.parse(fs.readFileSync(path.join(f.project, ".ai-dev-kit/player-review", id, "playtest.json"), "utf8"));
  assert.equal(sheet.candidate.commit, head);
  assert.equal(sheet.candidate.tree, f.git("rev-parse", "HEAD^{tree}").trim());
  assert.equal(sheet.candidate.assets_lock.path, "assets.lock");
  assert.equal(sheet.author_session, AUTHOR);
  assert.equal(sheet.pool, "godot");
  assert.match(fs.readFileSync(path.join(f.project, ".ai-dev-kit/player-review", id, "playtest.md"), "utf8"), /The start button reads Start Game/);
  const out = f.evidence(id);
  assert.match(f.file(id, out), new RegExp(`filed pass player review ${id} for ${head.slice(0, 12)}; 1 steps, 5 evidence files; evidence kept until`));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "review/manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map(entry => entry.path), ["claim.json", "review/report.json", "review/report.md", "review/shots/0001.png", "review/steps.jsonl"]);
  assert.equal(manifest.workstation.image_id, "sha256:1234");
  assert.deepEqual(manifest.workstation.start, ["godot", "--rendering-method", "forward_plus"]);
  f.gate("preflight");
  assert.match(f.gate("merge"), new RegExp(`player review: passed — ${id} by session ${REVIEWER} for ${head.slice(0, 12)}`));
  assert.match(f.gate("status"), /merge readiness: ready/);
  assert.equal(fs.readFileSync(path.join(f.project, ".ai-dev-kit/player-review/.gitignore"), "utf8"), "*\n");
});

test("the author's session cannot file the review, and a forged receipt from it still blocks", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  const out = f.evidence(id, { reviewer: AUTHOR });
  assert.match(f.file(id, out, { session: AUTHOR, expected: 1 }), /this session \(author-session-1\) requested the review; a player review must come from a different session/);
  const receipt = { schema_version: 1, request: id, candidate: JSON.parse(fs.readFileSync(path.join(f.project, ".ai-dev-kit/player-review", id, "playtest.json"))).candidate,
    verdict: "pass", author_session: AUTHOR, reviewer_session: AUTHOR, evidence: out, manifest_sha256: "0", filed_at: new Date().toISOString() };
  fs.writeFileSync(path.join(f.project, ".ai-dev-kit/player-review", id, "receipt.json"), JSON.stringify(receipt));
  f.gate("preflight");
  assert.match(f.gate("merge", 2), new RegExp(`FAIL: player review: player review ${id} did not come from a session other than the author's`));
  assert.match(f.review(["file", "--request", id, "--evidence", out], { expected: 2 }), /no session id: pass --session/);
});

test("a review of an earlier commit is stale once the branch moves on", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  const first = f.commit("rename start");
  const id = f.request();
  f.file(id, f.evidence(id));
  f.write("game/menu.txt", "Start New Game\n");
  const second = f.commit("rename again");
  f.gate("preflight");
  assert.match(f.gate("merge", 2), new RegExp(`FAIL: player review: the latest player review \\(${id}\\) is bound to ${first.slice(0, 12)}, but HEAD is ${second.slice(0, 12)}`));
});

test("fail and incomplete verdicts block with the report's summary; a later failing review replaces a pass", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const failing = f.request();
  f.file(failing, f.evidence(failing, { verdict: "fail" }));
  f.gate("preflight");
  assert.match(f.gate("merge", 2), new RegExp(`FAIL: player review: player review ${failing} concluded "fail": The start button does nothing\\.`));
  const incomplete = f.request();
  f.file(incomplete, f.evidence(incomplete, { verdict: "incomplete" }));
  assert.match(f.gate("merge", 2), new RegExp(`player review ${incomplete} concluded "incomplete"`));
  const passing = f.request();
  f.file(passing, f.evidence(passing));
  assert.match(f.gate("merge"), new RegExp(`player review: passed — ${passing}`));
  const later = f.request();
  f.file(later, f.evidence(later, { verdict: "fail" }));
  assert.match(f.gate("merge", 2), new RegExp(`player review ${later} concluded "fail"`));
});

test("evidence that changed, disappeared or lost its manifest after filing blocks merge", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  const out = f.evidence(id);
  f.file(id, out);
  f.gate("preflight");
  fs.writeFileSync(path.join(out, "review/shots/0001.png"), "other bytes");
  assert.match(f.gate("merge", 2), new RegExp(`evidence file review/shots/0001.png of player review ${id} changed after filing`));
  fs.writeFileSync(path.join(out, "review/shots/0001.png"), "png bytes");
  f.gate("merge");
  fs.rmSync(path.join(out, "claim.json"));
  assert.match(f.gate("merge", 2), new RegExp(`evidence file claim.json of player review ${id} is missing`));
  fs.rmSync(out, { recursive: true });
  assert.match(f.gate("merge", 2), new RegExp(`the evidence of player review ${id} is gone`));
});

test("filing refuses evidence without a workstation claim, a report for another build, or an incomplete report", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  assert.match(f.file(id, f.evidence(id, { claim: false }), { expected: 1 }), /has no claim.json: play on a workstation claimed with resource-lock.cjs claim --pool/);
  assert.match(f.file(id, f.evidence(id, { candidate: { commit: "0".repeat(40), tree: "1".repeat(40) } }), { expected: 1 }), /report.json candidate does not match the request/);
  const out = f.evidence(id);
  const report = JSON.parse(fs.readFileSync(path.join(out, "review/report.json"), "utf8"));
  delete report.scores;
  fs.writeFileSync(path.join(out, "review/report.json"), JSON.stringify(report));
  assert.match(f.file(id, out, { expected: 1 }), /scores must map each rubric criterion to a score/);
  fs.rmSync(path.join(out, "review/shots/0001.png"));
  report.scores = { clarity: 3 };
  fs.writeFileSync(path.join(out, "review/report.json"), JSON.stringify(report));
  assert.match(f.file(id, out, { expected: 1 }), /step 1 names screenshot review\/shots\/0001.png, which is missing/);
  assert.equal(fs.existsSync(path.join(f.project, ".ai-dev-kit/player-review", id, "receipt.json")), false);
});

test("uncommitted player-visible changes are refused by request and block the check", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  f.file(id, f.evidence(id));
  f.write("game/menu.txt", "Start Game!\n");
  f.write("game/new.txt", "untracked\n");
  assert.match(f.review(["request", "--goal", "g", "--focus", "f"], { session: AUTHOR, expected: 1 }),
    /commit the player-visible changes first; a review is bound to a commit \(2: game\/menu.txt, game\/new.txt\)/);
  assert.match(f.review(["check", "--phase", "merge"], { expected: 1 }), /uncommitted player-visible changes \(2: game\/menu.txt, game\/new.txt\) are not covered by any review/);
  assert.match(f.review(["check", "--phase", "preflight"], { expected: 3 }), /uncommitted player-visible changes/);
});

test("a receipt bound to another tree of the same commit name is refused", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  f.file(id, f.evidence(id));
  const file = path.join(f.project, ".ai-dev-kit/player-review", id, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.candidate.tree = "f".repeat(40);
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.match(f.review(["check", "--phase", "merge"], { expected: 1 }), /was bound to tree ffffffffffff, but HEAD's tree is [0-9a-f]{12}/);
});

test("an invalid player_review contract fails the gate with the setting named", t => {
  const f = fixture(t, { paths: [] });
  f.commit("invalid");
  assert.match(f.gate("preflight", 2), /player_review.paths must list the roots of player-visible files/);
  f.contract.player_review = { paths: ["game"], keep_days: 0 };
  f.saveContract();
  f.commit("invalid keep");
  assert.match(f.gate("preflight", 2), /player_review.keep_days must be a whole number of days from 1 to 3650/);
  f.contract.player_review = { paths: ["game"], colour: "red" };
  f.saveContract();
  f.commit("unknown key");
  assert.match(f.gate("preflight", 2), /player_review: invalid object or unsupported key/);
  f.contract.player_review = { paths: ["../outside"] };
  f.saveContract();
  f.commit("outside");
  assert.match(f.gate("preflight", 2), /player_review.paths entries must be a literal repository-relative file/);
});

test("prune keeps a filed review's evidence until keep_until and removes it after", t => {
  const f = fixture(t);
  f.write("game/menu.txt", "Start Game\n");
  f.commit("rename start");
  const id = f.request();
  const out = f.evidence(id);
  f.file(id, out);
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(out, old, old);
  const prune = extra => spawnSync(process.execPath, [resourceLock, "prune", "--root", f.project, "--pool", "godot", "--dry-run", "--evidence-days", "1", ...extra],
    { encoding: "utf8", env: { ...process.env, AI_DEV_KIT_DOCKER: path.join(__dirname, "fake-docker.cjs"), FAKE_DOCKER_STATE: path.join(f.root, "docker") } });
  const kept = prune([]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, new RegExp(`kept evidence .*: player review ${id} until \\d{4}-\\d{2}-\\d{2}`));
  const filed = path.join(out, "review/filed.json");
  fs.writeFileSync(filed, JSON.stringify({ request: id, keep_until: new Date(Date.now() - 1000).toISOString() }));
  fs.utimesSync(out, old, old);
  assert.match(prune([]).stdout, /would remove evidence .*000000000001-/);
});
