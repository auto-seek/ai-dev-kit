#!/usr/bin/env node
// Player review: an independent, player's-eye acceptance of player-visible
// changes. The author's session files a playtest request bound to the exact
// candidate (commit, tree, asset lock). A different session plays that
// candidate on a claimed workstation through ws-play, writes a report, and
// files it with the claim's evidence. The gate then requires, for a change that
// touches the project's player-visible paths, a passing report bound to the
// current commit and tree whose evidence still matches its manifest.
// Sessions are told apart by harness session ids: this stops a session from
// approving its own work by mistake; it is not authentication.
// Requests and receipts live in the main checkout's .ai-dev-kit/player-review/;
// the evidence stays in the workstation claim's directory, which prune keeps
// until the receipt's keep_until.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { stateRoot } = require("./project-state.cjs");
const { loadContract } = require("./project-gate-evidence.cjs");

const DIR = path.join(".ai-dev-kit", "player-review");
const ID = /^[0-9a-f]{12}-[0-9a-f]{6}$/;
const SESSION = /^[\w.:@-]{4,128}$/;
const VERDICTS = ["pass", "fail", "incomplete"];
const DEFAULT_KEEP_DAYS = 30;
const BLOCK = 1, USAGE = 2, WARN = 3;
const USAGE_TEXT = `usage:
  player-review.cjs request --goal <text> --focus <text> [--focus <text>]... [--start <text>]
                            [--max-steps <n>] [--max-minutes <n>] [--pool <pool>] [--session <id>] [--project <dir>]
  player-review.cjs file --request <id> --evidence <claim out dir> [--session <id>] [--project <dir>]
  player-review.cjs check [--phase preflight|merge] [--project <dir>]
  player-review.cjs status [--json] [--project <dir>]
sessions: --session, else AI_DEV_KIT_SESSION_ID, else CLAUDE_CODE_SESSION_ID
exit: 0 ok; 1 refused or blocked; 2 usage; 3 warning (check --phase preflight)`;

class UsageError extends Error {}
class Refusal extends Error {}

const sha256 = body => crypto.createHash("sha256").update(body).digest("hex");
const short = sha => sha.slice(0, 12);

function git(project, args, encoding = "utf8") {
  return execFileSync("git", ["--literal-pathspecs", "-C", project, ...args], {
    encoding, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { command, focus: [] };
  const valued = {
    "--goal": "goal", "--start": "start", "--max-steps": "maxSteps", "--max-minutes": "maxMinutes",
    "--pool": "pool", "--session": "session", "--project": "project", "--request": "request",
    "--evidence": "evidence", "--phase": "phase",
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json") { options.json = true; continue; }
    if (rest[i] === "--focus") {
      if (i + 1 >= rest.length) throw new UsageError("missing value for --focus");
      options.focus.push(rest[++i]);
      continue;
    }
    const key = valued[rest[i]];
    if (!key) throw new UsageError(`unknown option: ${rest[i]}`);
    if (i + 1 >= rest.length) throw new UsageError(`missing value for ${rest[i]}`);
    options[key] = rest[++i];
  }
  if (!["request", "file", "check", "status"].includes(command)) throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  if (options.phase !== undefined && !["preflight", "merge"].includes(options.phase)) throw new UsageError("--phase must be preflight or merge");
  options.project = path.resolve(options.project ?? ".");
  return options;
}

// The harness's own session id: Claude Code exports CLAUDE_CODE_SESSION_ID;
// other harnesses pass --session or set AI_DEV_KIT_SESSION_ID.
function session(flag) {
  const id = flag ?? process.env.AI_DEV_KIT_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new UsageError("no session id: pass --session <this session's id> or set AI_DEV_KIT_SESSION_ID");
  if (!SESSION.test(id)) throw new UsageError("a session id is 4 to 128 letters, digits or . _ : @ -");
  return id;
}

function reviewRoot(project, create) {
  const dir = path.join(stateRoot(project), DIR);
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
    // Requests and receipts are machine-local; keep them out of every commit.
    try { fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeJson(file, value) {
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, file);
}

function settings(project) {
  const contract = loadContract(project);
  return contract.player_review ? { ...contract.player_review, base_ref: contract.base_ref } : null;
}

function candidate(project, conf) {
  const commit = git(project, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const tree = git(project, ["rev-parse", "--verify", "HEAD^{tree}"]).trim();
  const branch = git(project, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || null;
  let lock = null;
  if (conf.lock) {
    let body;
    try { body = git(project, ["show", `${commit}:${conf.lock}`], "buffer"); }
    catch { throw new Refusal(`player_review.lock ${conf.lock} is not in commit ${short(commit)}`); }
    lock = { path: conf.lock, sha256: sha256(body) };
  }
  return { commit, tree, branch, assets_lock: lock };
}

const under = (file, root) => file === root || file.startsWith(`${root}/`);

function playerVisible(conf, files) {
  return [...new Set(files)].filter(file => conf.paths.some(root => under(file, root)) &&
    !(conf.exclude ?? []).some(root => under(file, root))).sort();
}

// Player-visible files the branch changed against the merge base, and those
// with uncommitted changes (which no commit-bound review can cover).
function changes(project, conf) {
  const head = git(project, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const target = git(project, ["rev-parse", "--verify", `${conf.base_ref}^{commit}`]).trim();
  const base = git(project, ["merge-base", target, head]).trim();
  const committed = git(project, ["diff", "--no-renames", "--name-only", "-z", base, head]).split("\0").filter(Boolean);
  const pending = git(project, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])
    .split("\0").filter(Boolean).map(entry => entry.slice(3));
  return { committed: playerVisible(conf, committed), pending: playerVisible(conf, pending) };
}

const listed = files => `${files.length}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}`;

function renderPlaytest(sheet, file) {
  const lock = sheet.candidate.assets_lock;
  return [
    `# Playtest ${sheet.id}`,
    "",
    "You are the player reviewer for this build. Follow the player-review role in the",
    "ai-dev-kit skill (`references/player-review.md`): play only through the workstation,",
    "never read source code or diffs.",
    "",
    "## Goal",
    "",
    sheet.goal,
    "",
    "## Start from",
    "",
    sheet.start,
    "",
    "## Watch for",
    "",
    ...sheet.focus.map(item => `- ${item}`),
    "",
    "## Limits",
    "",
    `- At most ${sheet.limits.max_steps} steps and ${sheet.limits.max_minutes} minutes of play.`,
    "",
    "## Build under test",
    "",
    `- Commit ${sheet.candidate.commit}${sheet.candidate.branch ? ` (${sheet.candidate.branch})` : ""}`,
    `- Tree ${sheet.candidate.tree}`,
    `- Assets ${lock ? `${lock.path} sha256 ${lock.sha256}` : "not pinned by a lock file"}`,
    `- Workstation pool: ${sheet.pool ?? "none declared; use the project's own channel"}`,
    "",
    "## You may read",
    "",
    ...(sheet.rubric ? [`- Scoring rubric: ${sheet.rubric}`] : ["- No scoring rubric is declared; score with the template's criteria."]),
    ...sheet.specs.map(spec => `- Design or art specification: ${spec}`),
    "",
    "## When done",
    "",
    "Write `review/report.md` and `review/report.json` in the claim's `out` directory",
    "from the templates, release the workstation, then file it:",
    "",
    "```bash",
    `node <kit>/scripts/player-review.cjs file --request ${sheet.id} --evidence <claim out dir>`,
    "```",
    "",
    `Request file: ${file}`,
    "",
  ].join("\n");
}

function request(options) {
  const conf = settings(options.project);
  if (!conf) throw new UsageError(".ai-dev-kit/gate-contract.json declares no player_review");
  const author = session(options.session);
  if (!options.goal?.trim()) throw new UsageError("request needs --goal: what a player should try to do");
  if (!options.focus.length || options.focus.some(item => !item.trim())) throw new UsageError("request needs at least one --focus: a player-visible change to watch, in a player's words");
  const limit = (raw, fallback, flag) => {
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new UsageError(`${flag} must be a positive whole number`);
    return Number(raw);
  };
  const { pending } = changes(options.project, conf);
  if (pending.length) throw new Refusal(`commit the player-visible changes first; a review is bound to a commit (${listed(pending)})`);
  const build = candidate(options.project, conf);
  const id = `${short(build.commit)}-${crypto.randomBytes(3).toString("hex")}`;
  const sheet = {
    schema_version: 1, id, created_at: new Date().toISOString(), author_session: author, candidate: build,
    pool: options.pool ?? conf.pool ?? null, goal: options.goal.trim(), start: options.start?.trim() || "a new game",
    focus: options.focus.map(item => item.trim()),
    limits: { max_steps: limit(options.maxSteps, 60, "--max-steps"), max_minutes: limit(options.maxMinutes, 30, "--max-minutes") },
    rubric: conf.rubric ?? null, specs: conf.specs ?? [],
  };
  const dir = path.join(reviewRoot(options.project, true), id);
  fs.mkdirSync(dir);
  writeJson(path.join(dir, "playtest.json"), sheet);
  fs.writeFileSync(path.join(dir, "playtest.md"), renderPlaytest(sheet, path.join(dir, "playtest.json")));
  process.stdout.write(`request=${id}\nplaytest=${path.join(dir, "playtest.md")}\n` +
    `Start a new session as the player reviewer (references/player-review.md) and give it the playtest file.\n`);
}

function readLines(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Refusal(`${file} line ${index + 1} is not JSON`); }
  });
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files;
}

const textList = (value, field) => {
  if (!Array.isArray(value) || value.some(item => !item || typeof item.text !== "string" || !item.text.trim())) {
    throw new Refusal(`report.json ${field} must be a list of { "step": <n or null>, "text": "..." } (empty when nothing to report)`);
  }
};

function checkReport(report, sheet, reviewer) {
  if (!report) throw new Refusal("review/report.json is missing or not JSON; start from templates/player-review/report.json");
  if (report.schema_version !== 1) throw new Refusal("report.json schema_version must be 1");
  if (report.request !== sheet.id) throw new Refusal(`report.json is for request ${report.request}, not ${sheet.id}`);
  if (report.candidate?.commit !== sheet.candidate.commit || report.candidate?.tree !== sheet.candidate.tree) {
    throw new Refusal(`report.json candidate does not match the request (${short(sheet.candidate.commit)} / tree ${short(sheet.candidate.tree)})`);
  }
  if (report.reviewer?.session !== reviewer) throw new Refusal(`report.json reviewer.session must be this session (${reviewer})`);
  if (typeof report.reviewer?.harness !== "string" || !report.reviewer.harness.trim()) throw new Refusal("report.json reviewer.harness must name the harness (claude, codex, gemini, ...)");
  if (!VERDICTS.includes(report.verdict)) throw new Refusal(`report.json verdict must be one of ${VERDICTS.join(", ")}`);
  if (typeof report.summary !== "string" || !report.summary.trim()) throw new Refusal("report.json summary must say what happened in a few sentences");
  if (typeof report.feelings !== "string" || !report.feelings.trim()) throw new Refusal("report.json feelings must give the player's impression");
  textList(report.stuck, "stuck");
  textList(report.confusing, "confusing");
  textList(report.spec_mismatches, "spec_mismatches");
  if (!report.scores || typeof report.scores !== "object" || Array.isArray(report.scores) || !Object.keys(report.scores).length ||
      Object.values(report.scores).some(score => typeof score !== "number" && typeof score !== "string")) {
    throw new Refusal("report.json scores must map each rubric criterion to a score");
  }
}

function file(options) {
  if (!ID.test(options.request ?? "")) throw new UsageError("file needs --request <id> as printed by request");
  if (!options.evidence) throw new UsageError("file needs --evidence <the claim's out directory>");
  const root = reviewRoot(options.project, false);
  const sheet = readJson(path.join(root, options.request, "playtest.json"));
  if (!sheet) throw new Refusal(`no playtest request ${options.request} in ${root}`);
  const reviewer = session(options.session);
  if (reviewer === sheet.author_session) {
    throw new Refusal(`this session (${reviewer}) requested the review; a player review must come from a different session`);
  }
  const evidence = path.resolve(options.evidence);
  const claim = readJson(path.join(evidence, "claim.json"));
  if (!claim?.workstation) {
    throw new Refusal(`${evidence} has no claim.json: play on a workstation claimed with resource-lock.cjs claim --pool and file the out directory it printed`);
  }
  const reviewDir = path.join(evidence, "review");
  const report = readJson(path.join(reviewDir, "report.json"));
  checkReport(report, sheet, reviewer);
  const human = path.join(reviewDir, "report.md");
  if (!fs.existsSync(human) || !fs.readFileSync(human, "utf8").trim()) throw new Refusal("review/report.md is missing or empty; start from templates/player-review/report.md");
  const stepsFile = path.join(reviewDir, "steps.jsonl");
  if (!fs.existsSync(stepsFile)) throw new Refusal("review/steps.jsonl is missing: play through ws-play, which records every step");
  const steps = readLines(stepsFile);
  if (!steps.length) throw new Refusal("review/steps.jsonl has no steps");
  for (const step of steps) {
    if (step.shot && !fs.existsSync(path.join(evidence, step.shot))) throw new Refusal(`step ${step.n} names screenshot ${step.shot}, which is missing`);
  }
  // Everything a later check verifies, except the manifest and the keep marker.
  const files = walk(evidence).filter(name => !["review/manifest.json", "review/filed.json"].includes(name)).sort();
  const manifest = {
    schema_version: 1, request: sheet.id, candidate: sheet.candidate, verdict: report.verdict,
    author_session: sheet.author_session, reviewer_session: reviewer, reviewer_harness: report.reviewer.harness,
    workstation: {
      pool: claim.pool ?? null, slot: claim.slot ?? null, name: claim.workstation, image: claim.image ?? null,
      image_id: claim.image_id ?? null, screen: claim.screen ?? null, start: claim.start ?? null,
    },
    steps: steps.length, created_at: new Date().toISOString(),
    files: files.map(name => {
      const body = fs.readFileSync(path.join(evidence, name));
      return { path: name, bytes: body.length, sha256: sha256(body) };
    }),
  };
  writeJson(path.join(reviewDir, "manifest.json"), manifest);
  let keepDays = DEFAULT_KEEP_DAYS;
  try { keepDays = settings(options.project)?.keep_days ?? DEFAULT_KEEP_DAYS; } catch { /* contract errors are the gate's to report */ }
  const filedAt = new Date();
  const keepUntil = new Date(filedAt.getTime() + keepDays * 86400000).toISOString();
  const receipt = {
    schema_version: 1, request: sheet.id, candidate: sheet.candidate, verdict: report.verdict,
    author_session: sheet.author_session, reviewer_session: reviewer, evidence,
    manifest_sha256: sha256(fs.readFileSync(path.join(reviewDir, "manifest.json"))),
    filed_at: filedAt.toISOString(), keep_until: keepUntil,
  };
  writeJson(path.join(root, sheet.id, "receipt.json"), receipt);
  // resource-lock.cjs prune keeps this evidence until keep_until.
  writeJson(path.join(reviewDir, "filed.json"), { request: sheet.id, keep_until: keepUntil });
  process.stdout.write(`filed ${report.verdict} player review ${sheet.id} for ${short(sheet.candidate.commit)}; ` +
    `${steps.length} steps, ${files.length} evidence files; evidence kept until ${keepUntil.slice(0, 10)}\n`);
}

function receipts(root) {
  let names;
  try { names = fs.readdirSync(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter(name => ID.test(name)).map(name => readJson(path.join(root, name, "receipt.json"))).filter(Boolean)
    .sort((a, b) => String(b.filed_at).localeCompare(String(a.filed_at)));
}

// Why a filed receipt cannot authorize this candidate, or null.
function problem(receipt, build) {
  const id = receipt.request;
  if (receipt.verdict !== "pass") {
    const report = readJson(path.join(receipt.evidence ?? "", "review", "report.json"));
    return `player review ${id} concluded "${receipt.verdict}"${report?.summary ? `: ${report.summary.trim().split("\n")[0]}` : ""}; ` +
      "address what it reports, then request a review of the new commit";
  }
  if (receipt.candidate?.tree !== build.tree) return `player review ${id} was bound to tree ${short(String(receipt.candidate?.tree))}, but HEAD's tree is ${short(build.tree)}`;
  if (!receipt.author_session || !receipt.reviewer_session || receipt.author_session === receipt.reviewer_session) {
    return `player review ${id} did not come from a session other than the author's`;
  }
  const manifestFile = path.join(receipt.evidence ?? "", "review", "manifest.json");
  let manifestBody;
  try { manifestBody = fs.readFileSync(manifestFile); } catch { return `the evidence of player review ${id} is gone (${manifestFile}); file the review again from its claim's out directory`; }
  if (sha256(manifestBody) !== receipt.manifest_sha256) return `the manifest of player review ${id} changed after filing`;
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  if (!manifest.files.some(entry => entry.path === "claim.json")) return `player review ${id} does not cite a workstation claim`;
  for (const entry of manifest.files) {
    let body;
    try { body = fs.readFileSync(path.join(receipt.evidence, entry.path)); } catch { return `evidence file ${entry.path} of player review ${id} is missing`; }
    if (sha256(body) !== entry.sha256) return `evidence file ${entry.path} of player review ${id} changed after filing`;
  }
  return null;
}

// { required, state, detail, receipt } for the checkout's current candidate.
function evaluate(project) {
  const conf = settings(project);
  if (!conf) return { required: false, state: "not configured", detail: null };
  const { committed, pending } = changes(project, conf);
  const visible = [...new Set([...committed, ...pending])];
  if (!visible.length) return { required: false, state: "not required", detail: "no player-visible changes" };
  const build = candidate(project, conf);
  const all = receipts(reviewRoot(project, false));
  const mine = all.filter(receipt => receipt.candidate?.commit === build.commit);
  if (pending.length) {
    return { required: true, state: "uncommitted", detail: `uncommitted player-visible changes (${listed(pending)}) are not covered by any review; commit them and request a review` };
  }
  if (!mine.length) {
    const older = all.find(receipt => build.branch && receipt.candidate?.branch === build.branch);
    return {
      required: true, state: older ? "stale" : "missing",
      detail: older
        ? `the latest player review (${older.request}) is bound to ${short(older.candidate.commit)}, but HEAD is ${short(build.commit)}; request a review of the current commit`
        : `player-visible files changed (${listed(committed)}) but no player review is filed for ${short(build.commit)}; ` +
          "have a different session review it (player-review.cjs request, then the reviewer files the report)",
    };
  }
  const reason = problem(mine[0], build);
  return reason
    ? { required: true, state: mine[0].verdict === "pass" ? "invalid" : "failed", detail: reason, receipt: mine[0] }
    : { required: true, state: "passed", detail: `${mine[0].request} by session ${mine[0].reviewer_session} for ${short(build.commit)} (${listed(committed)})`, receipt: mine[0] };
}

function check(options) {
  // The project gate loads the same contract and reports its errors; failing
  // here first would name the player review as the cause and hide that report.
  try { settings(options.project); } catch { return 0; }
  const result = evaluate(options.project);
  if (!result.required || result.state === "passed") {
    if (result.state === "passed") process.stdout.write(`player review: passed — ${result.detail}\n`);
    return 0;
  }
  process.stdout.write(`player review: ${result.detail}\n`);
  return options.phase === "preflight" ? WARN : BLOCK;
}

function status(options) {
  const result = evaluate(options.project);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n`
    : `player review: ${result.state}${result.detail ? ` — ${result.detail}` : ""}\n`);
}

module.exports = { evaluate };

if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.command === "request") request(options);
    else if (options.command === "file") file(options);
    else if (options.command === "check") process.exitCode = check(options);
    else status(options);
  } catch (error) {
    process.stderr.write(`player-review: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE_TEXT}\n`);
    process.exitCode = error instanceof UsageError ? USAGE : BLOCK;
  }
}
