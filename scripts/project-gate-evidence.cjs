#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { stateRoot } = require("./project-state.cjs");

const contractPath = ".ai-dev-kit/gate-contract.json";
const workflowPath = ".ai-dev-kit/workflow";
// A busy exclusive resource or an unusable environment is retryable, not a
// verdict on the change. The helper exits with BLOCKED_EXIT so the shell gate
// can report it separately; no receipt is written in either case.
const BLOCKED_EXIT = 75;
class BlockedError extends Error {}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function git(project, args) {
  return execFileSync("git", ["--literal-pathspecs", "-C", project, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
}
function relativeFile(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a literal repository-relative file`);
  }
  return value;
}
function checkedStat(root, file) {
  const parts = file.split("/");
  for (let n = 1; n <= parts.length; n++) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, ...parts.slice(0, n))); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (n < parts.length && stat.isSymbolicLink()) throw new Error(`${file}: symlink parent is not allowed`);
    if (n === parts.length) return stat;
    if (!stat.isDirectory()) return null;
  }
}
function regularFile(root, file, required = true) {
  const stat = checkedStat(root, file);
  if (!stat) {
    if (!required) return null;
    throw new Error(`required file is missing: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${file} must be a regular file, not a symlink`);
  return fs.readFileSync(path.join(root, file));
}
function objectKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label}: invalid object or unsupported key`);
  }
}
function loadContract(project) {
  const content = regularFile(project, contractPath, false);
  if (!content) throw new Error(`${contractPath} is required; explicitly migrate requirements and project preflight argv (including existing profile.preflight.entrypoint); see docs/team-gate-migration.md`);
  const index = git(project, ["ls-files", "--stage", "-z", "--", contractPath]).split("\0").filter(Boolean);
  if (index.length !== 1 || !/^100(?:644|755) [0-9a-f]+ 0\t/.test(index[0])) {
    throw new Error(`${contractPath} must be a tracked, unconflicted stage-0 regular file; git add it before preflight`);
  }
  let contract;
  try { contract = JSON.parse(content.toString("utf8")); }
  catch { throw new Error(`${contractPath}: invalid JSON`); }
  objectKeys(contract, ["schema_version", "base_ref", "requirements", "preflight", "receipt_binding"], contractPath);
  if (contract.schema_version !== 1) throw new Error(`${contractPath}: schema_version must be 1`);
  if (![undefined, "target", "merge-base"].includes(contract.receipt_binding)) throw new Error(`${contractPath}: receipt_binding must be target or merge-base`);
  if (typeof contract.base_ref !== "string" || !contract.base_ref.trim() || contract.base_ref.startsWith("-") || /[\0\r\n]/.test(contract.base_ref)) {
    throw new Error(`${contractPath}: base_ref must name an explicit Git commit/ref`);
  }
  objectKeys(contract.requirements, ["mode", "ledger", "dir"], "requirements");
  if (!["task-sections", "task-files", "global"].includes(contract.requirements.mode)) throw new Error("requirements.mode must be task-sections, task-files or global");
  if (contract.requirements.mode === "task-files") {
    if (Object.hasOwn(contract.requirements, "ledger")) throw new Error("requirements.ledger is not used by task-files; set requirements.dir");
    if (contract.requirements.dir !== undefined) relativeFile(contract.requirements.dir, "requirements.dir");
  } else {
    if (Object.hasOwn(contract.requirements, "dir")) throw new Error("requirements.dir is only valid with mode task-files");
    relativeFile(contract.requirements.ledger, "requirements.ledger");
  }
  objectKeys(contract.preflight, ["argv", "timeout_seconds", "blocked_exit_codes", "task_args"], "preflight");
  if (!Array.isArray(contract.preflight.argv) || !contract.preflight.argv.length ||
      contract.preflight.argv.some(value => typeof value !== "string" || value.includes("\0")) || !contract.preflight.argv[0]) {
    throw new Error("preflight.argv must be a nonempty array of literal command arguments");
  }
  if (!Number.isSafeInteger(contract.preflight.timeout_seconds) || contract.preflight.timeout_seconds <= 0 || contract.preflight.timeout_seconds > 2147483) {
    throw new Error("preflight.timeout_seconds must be a positive integer within the process timer range");
  }
  const blocked = contract.preflight.blocked_exit_codes;
  if (blocked !== undefined && (!Array.isArray(blocked) || blocked.some(code => !Number.isSafeInteger(code) || code < 1 || code > 255))) {
    throw new Error("preflight.blocked_exit_codes must be an array of exit codes from 1 to 255");
  }
  if (contract.preflight.task_args !== undefined) {
    objectKeys(contract.preflight.task_args, ["dir", "required"], "preflight.task_args");
    if (contract.preflight.task_args.dir !== undefined) relativeFile(contract.preflight.task_args.dir, "preflight.task_args.dir");
    if (![undefined, true, false].includes(contract.preflight.task_args.required)) throw new Error("preflight.task_args.required must be true or false");
  }
  return contract;
}
function taskId(branch, label = "task-sections") {
  const match = branch.match(/^[A-Za-z0-9][A-Za-z0-9._-]*\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) throw new Error(`${label} requires a <owner-or-type>/<canonical-task-id> branch with exactly one prefix segment (for example fix/<id>, codex/<id> or <agent-id>/<id>)`);
  return match[1];
}
// Topic-specific verification arguments live in one tracked file per task, so
// parallel branches never rewrite the shared contract. The file must be tracked:
// integrate runs in a fresh merged checkout that only contains committed files,
// so an untracked or ignored task file would silently narrow its verification.
function taskArgs(project, contract, branch) {
  const config = contract.preflight.task_args;
  if (!config) return undefined;
  let task;
  try { task = taskId(branch, "preflight.task_args"); }
  catch (error) { if (config.required) throw error; return null; }
  const file = `${config.dir ?? ".ai-dev-kit/tasks"}/${task}.json`;
  const content = regularFile(project, file, false);
  if (content) {
    const index = git(project, ["ls-files", "--stage", "-z", "--", file]).split("\0").filter(Boolean);
    if (index.length !== 1 || !/^100(?:644|755) [0-9a-f]+ 0\t/.test(index[0])) {
      throw new Error(`${file} must be a tracked, unconflicted regular file; commit the task args file (untracked or ignored files are absent from the integrate checkout)`);
    }
  }
  if (!content) {
    if (config.required) throw new Error(`${file} is required by preflight.task_args for ${branch}`);
    return null;
  }
  let value;
  try { value = JSON.parse(content.toString("utf8")); }
  catch { throw new Error(`${file}: invalid JSON`); }
  objectKeys(value, ["args"], file);
  if (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error(`${file}: args must be an array of literal command arguments`);
  }
  return { path: file, args: value.args };
}
function projectCommand(contract, extra) {
  return { ...contract.preflight, argv: [...contract.preflight.argv, ...(extra?.args || [])] };
}
function markdownLines(body) {
  let fence = null;
  return body.split(/\r?\n/).map(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      return { line, fenced: true };
    }
    if (delimiter) { fence = delimiter[1]; return { line, fenced: true }; }
    return { line, fenced: false };
  });
}
function requirements(project, contract, branch) {
  let file = contract.requirements.ledger, task = null;
  if (contract.requirements.mode === "task-files") {
    // One requirements file per task: parallel branches never edit a shared ledger.
    task = taskId(branch, "task-files");
    file = `${contract.requirements.dir ?? "docs/tasks"}/${task}.md`;
    if (!checkedStat(project, file)) throw new Error(`${file}: task-files requires one requirements file for ${branch}`);
  }
  const body = regularFile(project, file).toString("utf8");
  let selected = body;
  if (contract.requirements.mode === "task-sections") {
    task = taskId(branch);
    const sections = [];
    let active = null;
    for (const { line, fenced } of markdownLines(body)) {
      const heading = !fenced && line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        active = { id: heading[1], lines: [] };
        sections.push(active);
      } else if (active) active.lines.push(line);
    }
    const matches = sections.filter(section => section.id === task);
    if (matches.length !== 1) throw new Error(`${file}: expected one unique ## ${task} requirements section for ${branch}, found ${matches.length}`);
    selected = matches[0].lines.join("\n");
  }
  const items = [];
  for (const { line, fenced } of markdownLines(selected)) {
    if (fenced) continue;
    const item = line.match(/^\s*- \[([^\]])\]\s*(.*)$/);
    if (item) items.push(item);
  }
  if (!items.length) throw new Error(`${file}: selected requirements must contain concrete checkbox items`);
  if (items.some(item => ![" ", "x", "~"].includes(item[1]) || !item[2].trim())) throw new Error(`${file}: requirements require [ ], [x], or [~] with concrete text`);
  if (items.some(item => item[1] === " ")) throw new Error(`${file}: unfinished requirements for ${task || "global scope"}`);
  if (items.some(item => item[1] === "~" && !/^deferred:\s*\S.*\|\s*owner:\s*\S.*$/i.test(item[2]))) throw new Error(`${file}: [~] requires deferred: reason | owner: identity after explicit approval`);
  return { path: file, mode: contract.requirements.mode, task_id: task, content_sha256: hash(selected) };
}
function profileSubtraction(profile) {
  const result = {};
  let active = false, seen = false;
  for (const raw of profile.split(/\r?\n/)) {
    if (/^subtraction:/.test(raw)) {
      if (seen || !/^subtraction:\s*(?:#.*)?$/.test(raw)) throw new Error("profile subtraction must be one block with scalar every_commits/gate_enabled");
      active = true; seen = true; continue;
    }
    if (/^[^\s#]/.test(raw)) active = false;
    if (!active) continue;
    if (/^\s+(every_commits|gate_enabled):/.test(raw) && !/^  (every_commits|gate_enabled):/.test(raw)) throw new Error("subtraction fields must be flat two-space-indented scalars");
    const match = raw.match(/^  (every_commits|gate_enabled):\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    if (Object.hasOwn(result, match[1])) throw new Error(`duplicate subtraction.${match[1]}`);
    result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (result.gate_enabled !== undefined && !["true", "false"].includes(result.gate_enabled)) throw new Error("subtraction.gate_enabled must be true or false");
  if (result.every_commits !== undefined && !/^\d+$/.test(result.every_commits)) throw new Error("subtraction.every_commits must be a nonnegative integer");
  return result;
}
function subtraction(project, shared, branch, base, override) {
  const profile = regularFile(shared, ".ai-dev-kit/profile.yml").toString("utf8");
  const config = profileSubtraction(profile);
  const raw = override ?? process.env.AI_DEV_KIT_SUBTRACTION_THRESHOLD ?? config.every_commits ?? "10";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("subtraction threshold must be a nonnegative safe integer; invalid input is not replaced with a default");
  const disabled = process.env.AI_DEV_KIT_DISABLE_SUBTRACTION_GATE === "1" || config.gate_enabled === "false" || Number(raw) === 0;
  const policy = { threshold: Number(raw), disabled };
  if (disabled) return { ...policy, debt: null, cleaned_commit: null };
  let clean = null, debt = Number(git(project, ["rev-list", "--count", `${base}..HEAD`]).trim());
  const log = regularFile(shared, `${workflowPath}/subtraction-log.md`, false)?.toString("utf8") || "";
  for (const line of log.split(/\r?\n/)) {
    const record = line.match(/^- \d{4}-\d{2}-\d{2} \| commit: ([0-9a-f]{7,40}) \| branch: ([^|]+?) \| scope: (\S.*?) \| mode: (propose|assisted|sweep)\s*$/);
    if (!record && line.split(" | ").includes(`branch: ${branch}`)) throw new Error(`malformed subtraction record for ${branch}`);
    if (!record || record[2] !== branch) continue;
    const commit = git(project, ["rev-parse", "--verify", `${record[1]}^{commit}`]).trim();
    const ancestor = git(project, ["merge-base", commit, "HEAD"]).trim();
    if (ancestor !== commit) continue;
    const count = Number(git(project, ["rev-list", "--count", `${commit}..HEAD`]).trim());
    if (count <= debt) { clean = commit; debt = count; }
  }
  if (debt > policy.threshold) throw new Error(`subtraction overdue: ${debt} commits on ${branch} (threshold ${policy.threshold}); run and record an actual branch clean pass`);
  return { ...policy, debt, cleaned_commit: clean };
}
function visible(file) { return file && file !== workflowPath && !file.startsWith(`${workflowPath}/`); }
// lenient (status only): requirement, subtraction and task-arg errors become
// { error } fields so a read-only report can show them instead of stopping.
function snapshot(project, override, lenient = false) {
  const attempt = read => {
    if (!lenient) return read();
    try { return read(); } catch (error) { return { error: error.message }; }
  };
  const shared = stateRoot(project);
  const branch = git(project, ["symbolic-ref", "--short", "HEAD"]).trim();
  const contract = loadContract(project);
  const head = git(project, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const target = git(project, ["rev-parse", "--verify", `${contract.base_ref}^{commit}`]).trim();
  const base = git(project, ["merge-base", target, head]).trim();
  const required = attempt(() => requirements(project, contract, branch));
  const cleaning = attempt(() => subtraction(project, shared, branch, base, override));
  const headEntries = git(project, ["ls-tree", "-r", "-z", "HEAD"]).split("\0").filter(Boolean);
  const baseEntries = git(project, ["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean);
  const indexEntries = git(project, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  const selected = entries => entries.filter(entry => visible(entry.slice(entry.indexOf("\t") + 1))).sort();
  const committed = selected(headEntries), index = selected(indexEntries);
  if (index.some(entry => !/^[0-9]+ [0-9a-f]+ 0\t/.test(entry))) throw new Error("project preflight requires an unconflicted index");
  const files = [...new Set([...committed, ...index].map(entry => entry.slice(entry.indexOf("\t") + 1)).concat(
    git(project, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(visible),
  ))].sort();
  const submodules = new Set([...selected(baseEntries), ...committed, ...index].filter(entry => entry.startsWith("160000 ")).map(entry => entry.slice(entry.indexOf("\t") + 1)));
  const dirty = git(project, ["diff", "--ignore-submodules=none", "--no-renames", "--name-only", "-z", base, "HEAD"]) +
    git(project, ["diff", "--ignore-submodules=none", "--no-renames", "--name-only", "-z", "HEAD"]) +
    git(project, ["diff", "--ignore-submodules=none", "--no-renames", "--cached", "--name-only", "-z"]);
  if (dirty.split("\0").some(file => submodules.has(file))) throw new Error("changed or dirty submodules require independent project preflight in the child repository");
  const worktree = files.map(file => {
    const stat = checkedStat(project, file);
    if (!stat) return [file, null];
    if (submodules.has(file)) return [file, "gitlink"];
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${file}: project input must be a regular file or symlink`);
    const type = stat.isSymbolicLink() ? "symlink" : "file";
    const content = stat.isSymbolicLink() ? fs.readlinkSync(path.join(project, file)) : fs.readFileSync(path.join(project, file));
    return [file, `${type}:${stat.mode & 0o111}:${hash(content)}`];
  });
  const config = {};
  for (const file of [".ai-dev-kit/profile.yml", ".ai-dev-kit/profile.local.yml"]) {
    const body = regularFile(shared, file, file.endsWith("/profile.yml"));
    config[file] = body ? hash(body) : null;
  }
  const result = { branch, base_ref: contract.base_ref, base_ref_commit: target, base_commit: base, head,
    requirements: required, subtraction: cleaning, shared_config: config,
    committed, index, worktree };
  // merge-base binding: target movement alone must not stale a branch receipt.
  // The integrate receipt carries the target commit instead.
  if (contract.receipt_binding === "merge-base") delete result.base_ref_commit;
  const extra = attempt(() => taskArgs(project, contract, branch));
  if (extra !== undefined) result.task_args = extra;
  return result;
}
function evidencePaths(shared, branch) {
  const directory = `${workflowPath}/preflight`, id = hash(branch);
  const files = { shared, directory, receipt: `${directory}/${id}.json`, log: `${directory}/${id}.log`,
    integrate: `${directory}/${id}.integrate.json`, integrateLog: `${directory}/${id}.integrate.log`,
    lock: `${workflowPath}/integrate.lock` };
  // The integrate lock is a directory; acquireIntegrateLock validates it.
  for (const file of [files.receipt, files.log, files.integrate, files.integrateLog]) {
    const stat = checkedStat(shared, file);
    if (stat && !stat.isFile()) throw new Error(`${file}: evidence must be a regular file`);
  }
  return files;
}
function evidenceFiles(project) {
  return evidencePaths(stateRoot(project), git(project, ["symbolic-ref", "--short", "HEAD"]).trim());
}
function invalidate(project) {
  const files = evidenceFiles(project);
  const receipt = path.join(files.shared, files.receipt);
  if (fs.existsSync(receipt)) fs.unlinkSync(receipt);
}
// null = no receipt; { invalid: true } = unreadable or not a passing preflight.
function readReceipt(files) {
  const raw = regularFile(files.shared, files.receipt, false);
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw.toString("utf8"));
    if (receipt.schema_version === 1 && receipt.phase === "preflight" && receipt.result === "pass" && receipt.snapshot) return receipt;
  } catch { /* reported as invalid below */ }
  return { invalid: true };
}
// Checked by status and before any project command runs. A full volume or a
// missing tool is retryable infrastructure trouble, not a verdict on the change.
function environment(shared) {
  const raw = process.env.AI_DEV_KIT_MIN_FREE_MB ?? "1024";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("AI_DEV_KIT_MIN_FREE_MB must be a nonnegative integer; invalid input is not replaced with a default");
  const volume = fs.statfsSync(shared);
  const free = Math.floor(Number(volume.bavail) * Number(volume.bsize) / 1048576), min = Number(raw);
  return { node: process.version, state_root: shared, free_mb: free, min_free_mb: min,
    problem: free < min ? `only ${free} MiB free on the volume of ${shared}; AI_DEV_KIT_MIN_FREE_MB requires ${min}` : null };
}
function requireEnvironment(shared) {
  const result = environment(shared);
  if (result.problem) throw new BlockedError(`environment check failed: ${result.problem}`);
}
function verifyPreflight(files, current) {
  const raw = regularFile(files.shared, files.receipt, false);
  if (!raw) throw new Error("no passing content-bound preflight receipt for this branch; run --phase preflight after the final commit");
  let receipt;
  try { receipt = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("preflight receipt is invalid JSON; run preflight again"); }
  if (receipt.schema_version !== 1 || receipt.phase !== "preflight" || receipt.result !== "pass" ||
      JSON.stringify(receipt.snapshot) !== JSON.stringify(current)) throw new Error("preflight receipt is stale for the current branch, base, HEAD, index, worktree, untracked inputs, requirements or configuration");
}
function targetCommit(project, contract) {
  return git(project, ["rev-parse", "--verify", `${contract.base_ref}^{commit}`]).trim();
}
// An integrate receipt is keyed by (target commit, branch HEAD, merged tree).
// It is fresh only for the target commit and HEAD that exist right now.
function integrateState(files, project, contract, current) {
  const raw = regularFile(files.shared, files.integrate, false);
  if (!raw) return { state: "missing", differs: [] };
  let receipt;
  try { receipt = JSON.parse(raw.toString("utf8")); } catch { return { state: "invalid", differs: [] }; }
  if (receipt.schema_version !== 1 || receipt.phase !== "integrate" || receipt.result !== "pass") return { state: "invalid", differs: [] };
  const differs = [];
  if (receipt.branch !== current.branch) differs.push("branch");
  if (receipt.target_commit !== targetCommit(project, contract)) differs.push("target_commit");
  if (receipt.head !== current.head) differs.push("head");
  return { state: differs.length ? "stale" : "fresh", differs, merged_tree: receipt.merged_tree };
}
// Recomputes the merge result integrate verified, without a checkout. Needs
// git >= 2.38 (merge-tree --write-tree); older git fails the merge gate
// explicitly instead of skipping the check.
function mergedTree(project, target, head) {
  const result = spawnSync("git", ["-C", project, "merge-tree", "--write-tree", target, head],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`merge-base binding needs git >= 2.38 (git merge-tree --write-tree) to recompute the integrated tree: ${String(result.error?.message || result.stderr).trim().split("\n")[0]}`);
  }
  if (result.status === 1) throw new Error("the branch now conflicts with the target (git merge-tree); rebase and rerun integrate");
  const tree = result.stdout.split("\n")[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("git merge-tree --write-tree returned no tree id");
  return tree;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
const LOCK_OWNER = "owner.json";
function integrateLease() {
  const raw = process.env.AI_DEV_KIT_INTEGRATE_LEASE_SECONDS ?? "7200";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 60) {
    throw new Error("AI_DEV_KIT_INTEGRATE_LEASE_SECONDS must be an integer of at least 60; invalid input is not replaced with a default");
  }
  return Number(raw) * 1000;
}
// null = no lock (released meanwhile). The owner file's mtime is the lease
// heartbeat; a lock without a readable owner falls back to the directory mtime
// and is identified by its inode, which its tombstone keeps allocated.
function readLockOwner(lock) {
  let stat;
  try { stat = fs.lstatSync(lock); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory()) throw new Error(`${lock} must be a directory (integrate lock); remove the legacy lock file once no integrator is running`);
  let owner = {}, mtimeMs = stat.mtimeMs;
  try {
    const file = path.join(lock, LOCK_OWNER);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") owner = parsed;
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT" && !fs.existsSync(lock)) return null;
  }
  const id = typeof owner.token === "string" && /^[0-9a-f-]{36}$/.test(owner.token) ? owner.token : `ino-${stat.ino}`;
  return { ...owner, id, mtimeMs };
}
// Remove tombstones, released and staging leftovers older than the lease.
function sweepLockLeftovers(lock, lease) {
  const parent = path.dirname(lock), prefix = `${path.basename(lock)}.`;
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(prefix) || !/^(stale|released|tmp)-/.test(name.slice(prefix.length))) continue;
    const entry = path.join(parent, name);
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (stat && Date.now() - stat.mtimeMs > lease) fs.rmSync(entry, { recursive: true, force: true });
  }
}
// Exclusive integrate lock in the shared state root: a directory holding
// owner.json, installed by atomically renaming a populated staging directory
// (so the lock is never empty). The holder refreshes owner.json's mtime; a lock
// is stale once that lease (AI_DEV_KIT_INTEGRATE_LEASE_SECONDS, default 7200)
// expires, or at once if its pid is gone on this host. Takeover renames the
// stale lock to a tombstone named after its owner. Every integrator that saw
// the same stale owner targets the same tombstone; only the first rename
// succeeds, later ones hit the non-empty tombstone and report BLOCKED. A fresh
// lock is therefore never moved aside and nothing is ever restored.
function acquireIntegrateLock(files, branch) {
  const lease = integrateLease();
  const lock = path.join(files.shared, files.lock), token = crypto.randomUUID();
  sweepLockLeftovers(lock, lease);
  const staging = `${lock}.tmp-${token}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(staging, LOCK_OWNER), JSON.stringify({ token, pid: process.pid, host: os.hostname(),
      branch, started_at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.renameSync(staging, lock); return lockHandle(lock, token, lease); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error.code)) throw error; }
      const owner = readLockOwner(lock);
      if (!owner) continue;
      const dead = owner.host === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !processAlive(owner.pid);
      if (!dead && Date.now() - owner.mtimeMs < lease) {
        throw new BlockedError(`integrate lock ${files.lock} is held by pid ${owner.pid ?? "?"} on ${owner.host ?? "?"} for ${owner.branch ?? "?"}; retry after it finishes`);
      }
      if (readLockOwner(lock)?.id !== owner.id) continue;
      const tomb = `${lock}.stale-${owner.id}`;
      try { fs.renameSync(lock, tomb); }
      catch (error) {
        if (error.code === "ENOENT") continue;
        if (["EEXIST", "ENOTEMPTY"].includes(error.code)) throw new BlockedError(`integrate lock ${files.lock} is being recovered by another integrator; retry`);
        throw error;
      }
      // Touch the tombstone so the sweep keeps it for a full lease.
      fs.writeFileSync(path.join(tomb, "taken"), `${token}\n`, { mode: 0o600 });
      console.error(`project-gate: recovered stale integrate lock of pid ${owner.pid ?? "?"} on ${owner.host ?? "?"} for ${owner.branch ?? "?"}`);
    }
    throw new BlockedError(`integrate lock ${files.lock} is contended; retry`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
function lockHandle(lock, token, lease) {
  const ownerFile = path.join(lock, LOCK_OWNER);
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(ownerFile, now, now); } catch { /* checked on release */ }
  }, Math.min(lease / 4, 300000));
  beat.unref();
  return () => {
    clearInterval(beat);
    // Move first, then verify inside the moved directory: checking the owner and
    // renaming separately could move away a lock another integrator took over
    // after our lease expired.
    const released = `${lock}.released-${token}`;
    try { fs.renameSync(lock, released); } catch (error) {
      if (error.code === "ENOENT") throw new Error("integrate lock was taken over while held (lease expired?)");
      throw error;
    }
    if (readLockOwner(released)?.token !== token) {
      // Not ours: put it back untouched (the target name is free unless a third
      // integrator raced in, in which case the moved lock stays for the sweep).
      try { fs.renameSync(released, lock); } catch { /* left for the lease sweep */ }
      throw new Error("integrate lock was taken over while held (lease expired?)");
    }
    fs.rmSync(released, { recursive: true, force: true });
  };
}
// Merge queue: verify the branch merged onto the CURRENT target in a temporary
// detached worktree, then sign (target commit, branch HEAD, merged tree).
async function integrate(project, contract, current, files) {
  if (contract.receipt_binding !== "merge-base") throw new Error("--phase integrate requires receipt_binding: merge-base in .ai-dev-kit/gate-contract.json");
  verifyPreflight(files, current);
  requireEnvironment(files.shared);
  fs.mkdirSync(path.join(files.shared, files.directory), { recursive: true });
  const release = acquireIntegrateLock(files, current.branch);
  let temp = null, checkout = null, added = false, cancelled = null;
  const interrupt = signal => { cancelled = signal; };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  const stopIfCancelled = () => { if (cancelled) throw new Error(`integrate cancelled by ${cancelled}`); };
  try {
    const receiptFile = path.join(files.shared, files.integrate);
    if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
    const target = targetCommit(project, contract);
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-integrate-")));
    checkout = path.join(temp, "checkout");
    git(project, ["worktree", "add", "--detach", "--quiet", checkout, target]);
    added = true;
    stopIfCancelled();
    try {
      // Throwaway merge commit in a detached checkout; fixed identity, no hooks or signing.
      git(checkout, ["-c", "user.name=AI Dev Kit integrate", "-c", "user.email=integrate@ai-dev-kit.invalid",
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "--quiet", current.head]);
    } catch (error) {
      if (git(checkout, ["ls-files", "--unmerged"]).trim()) {
        throw new Error(`merging ${current.branch} (${current.head.slice(0, 12)}) into ${contract.base_ref} (${target.slice(0, 12)}) conflicts; rebase required`);
      }
      throw new Error(`merging ${current.branch} into ${contract.base_ref} failed: ${String(error.stderr || error.message).trim()}`);
    }
    stopIfCancelled();
    const tree = git(checkout, ["rev-parse", "--verify", "HEAD^{tree}"]).trim();
    const merged = loadContract(checkout);
    const extra = taskArgs(checkout, merged, current.branch);
    // The merged checkout must verify at least what the branch receipt bound;
    // otherwise integrate could pass with a narrower argv than preflight.
    if (JSON.stringify(extra ?? null) !== JSON.stringify(current.task_args ?? null)) {
      throw new Error(`task args in the merged checkout (${JSON.stringify(extra ?? null)}) differ from the branch preflight receipt (${JSON.stringify(current.task_args ?? null)}); commit the task args file, rebase if the target changed preflight.task_args, and rerun preflight`);
    }
    const inputs = () => git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    const before = inputs();
    await runProject(checkout, projectCommand(merged, extra), path.join(files.shared, files.integrateLog));
    stopIfCancelled();
    if (inputs() !== before) throw new Error("integrated inputs changed while verification ran; inspect the project command and rerun integrate");
    if (targetCommit(project, contract) !== target || git(project, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== current.head) {
      throw new Error("target or branch moved while integrate ran; rerun integrate on the current target");
    }
    const receipt = { schema_version: 1, phase: "integrate", result: "pass", verified_at: new Date().toISOString(),
      branch: current.branch, base_ref: contract.base_ref, target_commit: target, head: current.head, merged_tree: tree,
      task_args: extra ?? null };
    const pending = path.join(files.shared, `${files.integrate}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(pending, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(pending, receiptFile);
    console.log(`integrate passed on ${contract.base_ref} ${target.slice(0, 12)} (merged tree ${tree.slice(0, 12)}); receipt: ${files.integrate}`);
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
    if (added) {
      try { git(project, ["worktree", "remove", "--force", "--force", checkout]); }
      catch { /* fall through to directory removal and prune */ }
    }
    if (temp) {
      try { fs.rmSync(temp, { recursive: true, force: true }); }
      catch (error) { console.error(`project-gate: warning: could not remove ${temp}: ${error.message}`); }
      try { git(project, ["worktree", "prune"]); } catch { /* best effort */ }
    }
    // Cleanup and release failures must neither mask the real error nor undo a written pass.
    try { release(); }
    catch (error) { console.error(`project-gate: warning: could not release integrate lock ${files.lock}: ${error.message}`); }
  }
}
// Names the snapshot keys (and up to five paths per file list) that differ.
function differences(recorded, current) {
  const out = [];
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  for (const key of new Set([...Object.keys(recorded || {}), ...Object.keys(current || {})])) {
    const before = recorded?.[key], after = current?.[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (Array.isArray(before) || Array.isArray(after)) {
      const name = entry => Array.isArray(entry) ? entry[0] : String(entry).slice(String(entry).indexOf("\t") + 1);
      const byPath = list => new Map((Array.isArray(list) ? list : []).map(entry => [name(entry), JSON.stringify(entry)]));
      const a = byPath(before), b = byPath(after);
      const paths = [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();
      out.push(paths.length ? `${key} (${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, +${paths.length - 5} more` : ""})` : key);
    } else if (plain(before) && plain(after)) {
      for (const sub of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[sub]) !== JSON.stringify(after[sub])) out.push(`${key}.${sub}`);
      }
    } else out.push(key);
  }
  return out;
}
function testReview(checkout) {
  // Subprocess boundary only: the test-review receipt format is owned by that CLI.
  const result = spawnSync(process.execPath, [path.join(__dirname, "test-review-evidence.cjs"), "check", "--project", checkout],
    { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { ok: false, detail: `test-review check could not run: ${result.error.message}` };
  if (result.status === 0) return { ok: true };
  return { ok: false, detail: (result.stderr || result.stdout).trim() || `test-review check exited ${result.status}` };
}
function blockingFindings(shared) {
  const body = regularFile(shared, `${workflowPath}/findings.jsonl`, false)?.toString("utf8") || "";
  return body.split(/\r?\n/).filter(line => /"severity"\s*:\s*"(critical|high)"/.test(line) && /"status"\s*:\s*"(open|blocked)"/.test(line)).length;
}
function checkoutStatus(checkout, branch, override, shared, findings) {
  const report = { branch, checkout, problems: [] };
  try {
    const current = snapshot(checkout, override, true);
    const files = evidencePaths(shared, branch);
    const recorded = readReceipt(files);
    const differs = recorded && !recorded.invalid ? differences(recorded.snapshot, current) : [];
    report.preflight = { state: !recorded ? "missing" : recorded.invalid ? "invalid" : differs.length ? "stale" : "fresh", differs };
    if (recorded?.verified_at) report.preflight.verified_at = recorded.verified_at;
    if (report.preflight.state !== "fresh") report.problems.push(`preflight receipt ${report.preflight.state}`);
    const contract = loadContract(checkout);
    if (contract.receipt_binding === "merge-base") {
      report.integrate = integrateState(files, checkout, contract, current);
      if (report.integrate.state !== "fresh") report.problems.push(`integrate receipt ${report.integrate.state}`);
    }
    const required = current.requirements;
    report.requirements = required.error ? { ok: false, detail: required.error } : { ok: true, path: required.path, task_id: required.task_id };
    if (required.error) report.problems.push(`requirements: ${required.error}`);
    const cleaning = current.subtraction;
    report.subtraction = cleaning.error ? { ok: false, detail: cleaning.error }
      : { ok: true, disabled: cleaning.disabled, debt: cleaning.debt, threshold: cleaning.threshold };
    if (cleaning.error) report.problems.push(cleaning.error);
    if (current.task_args?.error) report.problems.push(`task args: ${current.task_args.error}`);
    report.test_review = testReview(checkout);
    if (!report.test_review.ok) report.problems.push("test review not current");
  } catch (error) {
    report.error = error.message;
    report.problems.push(error.message);
  }
  if (findings) report.problems.push(`${findings} open critical/high findings`);
  report.merge_ready = report.problems.length === 0;
  return report;
}
function refStatus(shared, branch) {
  // No checkout: only the commits a receipt binds can be compared.
  const report = { branch, checkout: null, problems: [], merge_ready: null,
    note: "not checked out in any worktree; only branch HEAD and target binding compared" };
  try {
    const recorded = readReceipt(evidencePaths(shared, branch));
    if (!recorded || recorded.invalid) {
      report.preflight = { state: recorded ? "invalid" : "missing", differs: [] };
    } else {
      const head = git(shared, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).trim();
      const target = git(shared, ["rev-parse", "--verify", `${recorded.snapshot.base_ref}^{commit}`]).trim();
      const differs = [];
      if (Object.hasOwn(recorded.snapshot, "base_ref_commit") && recorded.snapshot.base_ref_commit !== target) differs.push("base_ref_commit");
      if (recorded.snapshot.base_commit !== git(shared, ["merge-base", target, head]).trim()) differs.push("base_commit");
      if (recorded.snapshot.head !== head) differs.push("head");
      report.preflight = { state: differs.length ? "stale" : "unverified", differs, verified_at: recorded.verified_at };
    }
    report.problems.push(`preflight receipt ${report.preflight.state}`);
  } catch (error) {
    report.error = error.message;
    report.problems.push(error.message);
  }
  return report;
}
function linkedCheckouts(project) {
  const checkouts = new Map();
  let current = null;
  for (const line of git(project, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && current) checkouts.set(line.slice("branch refs/heads/".length), current);
  }
  return checkouts;
}
function renderStatus(report) {
  const lines = [];
  const env = report.environment;
  lines.push(env.problem ? `environment: BLOCKED — ${env.problem}`
    : `environment: ok (node ${env.node}; ${env.free_mb} MiB free on ${env.state_root}, minimum ${env.min_free_mb})`);
  lines.push(`blocking findings: ${report.blocking_findings}`);
  for (const item of report.branches) {
    lines.push(`branch ${item.branch ?? "(detached HEAD)"} ${item.checkout ? `(${item.checkout})` : "(no checkout)"}`);
    if (item.error) lines.push(`  error: ${item.error}`);
    if (item.preflight) lines.push(`  preflight receipt: ${item.preflight.state}${item.preflight.differs.length ? ` — differs: ${item.preflight.differs.join(", ")}` : ""}`);
    if (item.integrate) lines.push(`  integrate receipt: ${item.integrate.state}${item.integrate.differs.length ? ` — differs: ${item.integrate.differs.join(", ")}` : ""}`);
    if (item.requirements) lines.push(`  requirements: ${item.requirements.ok ? `ok (${item.requirements.path}${item.requirements.task_id ? `, task ${item.requirements.task_id}` : ""})` : item.requirements.detail}`);
    if (item.subtraction) lines.push(`  subtraction: ${!item.subtraction.ok ? item.subtraction.detail : item.subtraction.disabled ? "gate disabled" : `debt ${item.subtraction.debt} of ${item.subtraction.threshold}`}`);
    if (item.test_review) lines.push(`  test review: ${item.test_review.ok ? "ok" : item.test_review.detail}`);
    if (item.note) lines.push(`  note: ${item.note}`);
    lines.push(`  merge readiness: ${item.merge_ready === null ? "unknown" : item.merge_ready ? "ready" : `not ready — ${item.problems.join("; ")}`}`);
  }
  lines.push("note: coordination state and design bindings are checked only by --phase merge");
  return lines.join("\n");
}
// Read-only: never revokes or writes receipts, logs or locks.
function status(project, override, options) {
  const shared = stateRoot(project);
  const report = { environment: null, blocking_findings: 0, branches: [] };
  try { report.environment = environment(shared); }
  catch (error) { report.environment = { problem: error.message }; }
  try { report.blocking_findings = blockingFindings(shared); }
  catch (error) { report.blocking_findings = `unreadable (${error.message})`; }
  const findings = typeof report.blocking_findings === "number" ? report.blocking_findings : 0;
  let branch = null;
  try { branch = git(project, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || null; } catch { branch = null; }
  report.branches.push(branch ? checkoutStatus(project, branch, override, shared, findings)
    : { branch: null, checkout: project, problems: ["detached HEAD has no branch receipt"], merge_ready: false });
  if (options["--all"]) {
    const checkouts = linkedCheckouts(project);
    const names = git(project, ["for-each-ref", "--format=%(refname)", "refs/heads"]).split("\n")
      .filter(Boolean).map(ref => ref.slice("refs/heads/".length)).sort();
    for (const name of names) {
      if (name === branch) continue;
      let recorded;
      try { recorded = checkedStat(shared, `${workflowPath}/preflight/${hash(name)}.json`); }
      catch (error) { report.branches.push({ branch: name, checkout: null, error: error.message, problems: [error.message], merge_ready: false }); continue; }
      if (!recorded) continue;
      const checkout = checkouts.get(name);
      report.branches.push(checkout ? checkoutStatus(checkout, name, override, shared, findings) : refStatus(shared, name));
    }
  }
  console.log(options["--json"] ? JSON.stringify(report, null, 2) : renderStatus(report));
}
async function runProject(project, config, file) {
  if (process.platform === "win32") throw new Error("project preflight requires a POSIX process-group runner");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  fs.fchmodSync(fd, 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(config.argv[0], config.argv.slice(1), {
        cwd: project, env: process.env, detached: true, stdio: ["ignore", fd, fd],
      });
      let stopped = null, grace;
      const signalGroup = signal => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      const stop = reason => {
        if (stopped) return;
        stopped = reason;
        signalGroup("SIGTERM");
        grace = setTimeout(() => signalGroup("SIGKILL"), 2000);
      };
      const interrupt = () => stop("cancelled");
      process.on("SIGTERM", interrupt);
      process.on("SIGINT", interrupt);
      const deadline = setTimeout(() => stop("timed out"), config.timeout_seconds * 1000);
      const cleanup = () => {
        clearTimeout(deadline); clearTimeout(grace);
        process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
        signalGroup("SIGKILL");
      };
      child.once("error", () => { cleanup(); reject(new Error("project preflight could not start; check configured argv and installed executable")); });
      child.once("exit", (code, signal) => {
        cleanup();
        if (!stopped && (config.blocked_exit_codes || []).includes(code)) {
          reject(new BlockedError(`project preflight reported a busy or unavailable resource (exit ${code}); private output: ${file}`));
        } else if (stopped || code !== 0) reject(new Error(`project preflight ${stopped || `failed (exit ${code}, signal ${signal || "none"})`}; private output: ${file}`));
        else resolve();
      });
    });
  } finally { fs.closeSync(fd); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let n = 0; n < args.length; n++) {
    if (["--all", "--json"].includes(args[n])) { options[args[n]] = true; continue; }
    if (!["--project", "--phase", "--subtraction-threshold"].includes(args[n]) || args[n + 1] === undefined) throw new Error("invalid project-gate argument");
    options[args[n]] = args[++n];
  }
  const project = path.resolve(options["--project"] || "."), override = options["--subtraction-threshold"];
  if (command === "status") { status(project, override, options); return; }
  if (command === "check" && options["--phase"] === "preflight") invalidate(project);
  const current = snapshot(project, override);
  if (command === "snapshot") { console.log(JSON.stringify(current, null, 2)); return; }
  if (command === "check") {
    if (current.subtraction.disabled) console.log("subtraction debt gate explicitly disabled by configuration");
    return;
  }
  const files = evidenceFiles(project);
  const contract = loadContract(project);
  if (command === "merge") {
    verifyPreflight(files, current);
    if (contract.receipt_binding === "merge-base") {
      const integration = integrateState(files, project, contract, current);
      if (integration.state === "missing") throw new Error("receipt_binding merge-base requires an integrate receipt for the current target; queue the branch for --phase integrate");
      if (integration.state === "invalid") throw new Error("integrate receipt is invalid; rerun --phase integrate");
      if (integration.state === "stale") throw new Error(`integrate receipt is stale (${integration.differs.join(", ")} changed); rerun --phase integrate on the current target`);
      const tree = mergedTree(project, targetCommit(project, contract), current.head);
      if (tree !== integration.merged_tree) throw new Error(`merged tree ${tree.slice(0, 12)} of the current target and HEAD differs from the integrate receipt (${String(integration.merged_tree).slice(0, 12)}); rerun --phase integrate`);
    }
    return;
  }
  if (command === "integrate") { await integrate(project, contract, current, files); return; }
  if (command !== "preflight") throw new Error("usage: project-gate-evidence.cjs check|snapshot|preflight|merge|integrate|status --project <checkout>");
  invalidate(project);
  requireEnvironment(files.shared);
  fs.mkdirSync(path.join(files.shared, files.directory), { recursive: true });
  await runProject(project, projectCommand(contract, current.task_args), path.join(files.shared, files.log));
  const after = snapshot(project, override);
  if (JSON.stringify(current) !== JSON.stringify(after)) throw new Error("project inputs changed while preflight ran; inspect the changes and rerun verification");
  evidenceFiles(project);
  const receipt = { schema_version: 1, phase: "preflight", result: "pass", verified_at: new Date().toISOString(), snapshot: after };
  const temp = path.join(files.shared, `${files.receipt}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, path.join(files.shared, files.receipt));
  console.log(`project preflight passed; content-bound receipt: ${files.receipt}`);
}
if (require.main !== module) {
  // Library use is limited to tests of the lock primitive.
  module.exports = { acquireIntegrateLock, BlockedError };
} else main().catch(error => {
  if (error instanceof BlockedError) {
    console.error(`project-gate: BLOCKED (retryable): ${error.message}`);
    process.exitCode = BLOCKED_EXIT;
    return;
  }
  console.error(`project-gate: ${error.message}`);
  process.exitCode = 1;
});
