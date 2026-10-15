#!/usr/bin/env node
// Git supplies the changed-file and blob contracts; SHA-256 binds untracked and
// working-tree content. A passing narrative alone cannot approve a new revision.
// Evidence lives per branch in the main checkout's .ai-dev-kit/workflow/test-review/.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { stateRoot } = require("./project-state.cjs");

function git(project, args) {
  return execFileSync("git", ["--literal-pathspecs", "-C", project, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const scopeFile = ".ai-dev-kit/test-scope.json";
const workflowDirectory = ".ai-dev-kit/workflow";
function isTestInput(file) {
  return file && file !== scopeFile && file !== workflowDirectory &&
    !file.startsWith(`${workflowDirectory}/`);
}

function parseScope(text, revision) {
  const source = `${scopeFile} (${revision})`;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema_version !== 1 ||
      Object.keys(value).some(key => !["schema_version", "paths", "no_tests_reason"].includes(key))) {
    throw new Error(`${source}: expected schema_version 1 with paths or no_tests_reason`);
  }
  if (Object.hasOwn(value, "no_tests_reason")) {
    if (Object.hasOwn(value, "paths") || typeof value.no_tests_reason !== "string" ||
        !value.no_tests_reason.trim()) {
      throw new Error(`${source}: no_tests_reason must be nonempty and cannot be combined with paths`);
    }
  } else if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some(file =>
    typeof file !== "string" || !file.trim() || file.includes("\0") || file.includes("\\") ||
    path.posix.isAbsolute(file) || path.win32.isAbsolute(file) ||
    (file !== "." && file.split("/").some(part => !part || part === "." || part === ".."))
  )) {
    throw new Error(`${source}: paths must contain nonempty repository-relative literal files/directories (no traversal)`);
  }
  if (value.paths?.some(file => file === workflowDirectory || file.startsWith(`${workflowDirectory}/`))) {
    throw new Error(`${source}: ${workflowDirectory} is reserved for workflow evidence, not test input`);
  }
  return value;
}

function identity(content, executable) {
  return `file:${executable}:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function checkedStat(project, file) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    let parent;
    try {
      parent = fs.lstatSync(path.join(project, ...parts.slice(0, i)));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (parent.isSymbolicLink()) {
      throw new Error(`cannot review ${file} through a symlink parent`);
    }
    if (!parent.isDirectory()) return null;
  }
  try {
    return fs.lstatSync(path.join(project, file));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function gitScope(project, revision, index = false) {
  const raw = git(project, index
    ? ["ls-files", "--stage", "-z", "--", scopeFile]
    : ["ls-tree", "-z", revision, "--", scopeFile]);
  if (!raw) return null;
  const entries = raw.split("\0").filter(Boolean);
  const fields = entries[0].split("\t", 1)[0].split(" ");
  if (entries.length !== 1 || !["100644", "100755"].includes(fields[0]) ||
      (index ? fields[2] !== "0" : fields[1] !== "blob")) {
    throw new Error(`${scopeFile} (${revision}): must be an unconflicted regular file, not a symlink or directory`);
  }
  const content = git(project, ["cat-file", "blob", fields[index ? 1 : 2]]);
  return {
    identity: identity(content, fields[0] === "100755" ? 0o111 : 0),
    policy: parseScope(content, revision),
  };
}

function scopeSnapshot(project, base) {
  const scope = {
    path: scopeFile,
    base: gitScope(project, base),
    head: gitScope(project, "HEAD"),
    index: gitScope(project, "index", true),
  };
  if (!scope.index) {
    throw new Error(`${scopeFile}: required tracked test scope is missing; declare the project's test files/directories and git add the file before review`);
  }
  const stat = checkedStat(project, scopeFile);
  if (!stat || !stat.isFile()) {
    throw new Error(`${scopeFile}: working tree must contain a regular file, not a missing file or symlink`);
  }
  const content = fs.readFileSync(path.join(project, scopeFile));
  scope.worktree = {
    identity: identity(content, stat.mode & 0o111),
    policy: parseScope(content.toString("utf8"), "worktree"),
  };
  return scope;
}
function snapshot(project) {
  const branch = git(project, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch === "HEAD") throw new Error("test review requires a named branch");
  const shared = stateRoot(project);
  const profileFile = path.join(shared, ".ai-dev-kit/profile.yml");
  const profileStat = checkedStat(shared, ".ai-dev-kit/profile.yml");
  if (profileStat && !profileStat.isFile()) throw new Error(".ai-dev-kit/profile.yml must be a regular file, not a symlink");
  const profile = profileStat
    ? fs.readFileSync(profileFile, "utf8")
    : "";
  const policy =
    profile.match(/^merge_policy:\s*\n((?:[ \t].*\n|\n)*)/m)?.[1] || "";
  let baseRef = policy.match(/^  target_branch:\s*["']?([^\s"'#]+)/m)?.[1];
  if (!baseRef) {
    baseRef = ["dev", "main", "master"].find((ref) => {
      try {
        git(project, ["rev-parse", "--verify", `refs/heads/${ref}`]);
        return true;
      } catch {
        return false;
      }
    });
  }
  if (!baseRef)
    throw new Error(
      "set merge_policy.target_branch to the review target branch",
    );
  // A configured missing ref is an error, not permission to compare another trunk.
  const base = git(project, ["merge-base", baseRef, "HEAD"]).trim();
  const scope = scopeSnapshot(project, base);
  // All roots are positive literals. Their union preserves historical scope
  // without letting a narrowed working-tree declaration hide removed tests.
  const roots = [...new Set([scope.base, scope.head, scope.index, scope.worktree]
    .flatMap(state => state?.policy.paths || []))];
  for (const root of roots) {
    const stat = checkedStat(project, root);
    if (stat?.isSymbolicLink()) throw new Error(`${scopeFile}: test root ${root} must not be a symlink`);
    const matches = git(project, ["ls-tree", "-r", "--name-only", "-z", base, "--", root]) +
      git(project, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", root]) +
      git(project, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", root]);
    if (!matches.split("\0").some(isTestInput)) throw new Error(`${scopeFile}: test root ${JSON.stringify(root)} matches no test input files; correct the literal path or explicitly declare no_tests_reason`);
  }
  // Review deletions as well as additions. Rename detection reports only the
  // destination with --name-only, which can hide a test moved outside test paths.
  const paths = new Set(
    roots.length ? [
      ...git(project, [
        "diff",
        "--ignore-submodules=none",
        "--no-renames",
        "--name-only",
        "-z",
        base,
        "HEAD",
        "--",
        ...roots,
      ]).split("\0"),
      ...git(project, [
        "diff",
        "--ignore-submodules=none",
        "--no-renames",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ...roots,
      ]).split("\0"),
      ...git(project, [
        "diff",
        "--ignore-submodules=none",
        "--no-renames",
        "--cached",
        "--name-only",
        "-z",
        "--",
        ...roots,
      ]).split("\0"),
      ...git(project, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...roots,
      ]).split("\0"),
    ].filter(isTestInput) : [],
  );
  const files = [...paths].sort().map((file) => {
    const absolute = path.join(project, file);
    const head = git(project, ["ls-tree", "-z", "HEAD", "--", file]);
    const index = git(project, ["ls-files", "--stage", "-z", "--", file]);
    const historical = git(project, ["ls-tree", "-z", base, "--", file]);
    if ([historical, head, index].some(entries => entries.split("\0").some(entry => entry.startsWith("160000 ")))) {
      throw new Error(`changed or dirty submodule ${file} requires independent test review in that repository`);
    }
    let worktree = null;
    const stat = checkedStat(project, file);
    if (stat && !stat.isDirectory()) {
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`test input ${file} must be a regular file or symlink`);
      const type = stat.isSymbolicLink() ? "symlink" : "file";
      const content = stat.isSymbolicLink()
        ? fs.readlinkSync(absolute)
        : fs.readFileSync(absolute);
      worktree = `${type}:${stat.mode & 0o111}:${crypto.createHash("sha256").update(content).digest("hex")}`;
    }
    return {
      path: file,
      head,
      index,
      worktree,
    };
  });
  const scope_changed = [scope.head, scope.index, scope.worktree]
    .some(state => state?.identity !== scope.base?.identity);
  return { branch, base_ref: baseRef, base_commit: base, scope, scope_changed, files };
}

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const legacyReportPath = `${workflowDirectory}/test-review.md`;
const evidenceDirectory = `${workflowDirectory}/test-review`;
const marker =
  /<!-- ai-dev-kit-test-review:v[12] -->\s*```json\n([\s\S]*?)\n```\s*<!-- \/ai-dev-kit-test-review -->/g;
function approvedReport(report, label) {
  const status = report.match(/^\s*- Status:\s*(\S+)\s*$/im)?.[1];
  const reviewer = report.match(/^\s*- Reviewer:\s*(.+?)\s*$/im)?.[1];
  if (
    status !== "approved" ||
    !reviewer ||
    /^(pending|unknown|none|<.*>)$/i.test(reviewer)
  ) {
    throw new Error(
      `${label} requires Status: approved and a named Reviewer after actual test review`,
    );
  }
  return reviewer;
}
function readRegular(root, file) {
  const stat = checkedStat(root, file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`${file} must be a regular file, not a symlink`);
  return fs.readFileSync(path.join(root, file), "utf8");
}
function writeAtomic(root, file, body) {
  const temp = path.join(root, `${file}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, body, { flag: "wx" });
  fs.renameSync(temp, path.join(root, file));
}
// Each branch owns its narrative and receipt, keyed exactly like the per-branch
// preflight receipts of project-gate-evidence.cjs (SHA-256 of the short branch
// name), so recording on one branch never invalidates another branch's review.
function evidenceFiles(project) {
  let branch;
  try {
    branch = git(project, ["symbolic-ref", "-q", "--short", "HEAD"]).trim();
  } catch (error) {
    if (error.status === 1) throw new Error("test review requires a named branch");
    throw error;
  }
  const shared = stateRoot(project);
  const key = hash(branch);
  const files = {
    shared,
    branch,
    report: `${evidenceDirectory}/${key}.md`,
    receipt: `${evidenceDirectory}/${key}.json`,
    legacy: legacyReportPath,
  };
  for (const file of [files.report, files.receipt]) {
    const stat = checkedStat(shared, file);
    if (stat && !stat.isFile()) throw new Error(`${file} must be a regular file, not a symlink`);
  }
  return files;
}
function record(current, files, reportArgument) {
  let text;
  let label;
  if (reportArgument !== undefined) {
    const absolute = path.resolve(reportArgument);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`--report ${reportArgument} does not exist`);
      throw error;
    }
    if (!stat.isFile()) throw new Error(`--report ${reportArgument} must be a regular file, not a symlink`);
    text = fs.readFileSync(absolute, "utf8");
    label = reportArgument;
  } else if ((text = readRegular(files.shared, files.report)) !== null) {
    label = files.report;
  } else {
    // The shared legacy test-review.md may hold another branch's approval, so it
    // is never a narrative source; compatibility covers legacy receipts in check only.
    throw new Error(
      `record requires --report <file> or this branch's narrative at ${files.report} (see test-review-evidence.cjs paths); the shared ${files.legacy} is not used`,
    );
  }
  // Stored narratives never carry receipts; the receipt is the sibling JSON file.
  const narrative = `${text.replace(marker, "").trimEnd()}\n`;
  const reviewer = approvedReport(narrative, label);
  fs.mkdirSync(path.join(files.shared, evidenceDirectory), { recursive: true });
  // Write the narrative first: an interrupted record leaves a hash mismatch, not approval.
  writeAtomic(files.shared, files.report, narrative);
  const receipt = {
    schema: 3,
    reviewer,
    reviewed_at: new Date().toISOString(),
    report_sha256: hash(narrative),
    snapshot: current,
  };
  writeAtomic(files.shared, files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `Recorded review of ${current.files.length} changed test files and project test scope for ${current.branch}; receipt: ${files.receipt}`,
  );
}
// One-release compatibility: a schema-2 receipt in the shared single file is
// accepted only when it is the exact snapshot of the current branch.
function checkLegacy(current, files) {
  const report = readRegular(files.shared, files.legacy);
  const matches = report === null ? [] : [...report.matchAll(marker)];
  if (matches.length !== 1) {
    throw new Error(
      `test review has no unique content-bound receipt for ${current.branch}; after actual review write \`- Status: approved\` and a named \`- Reviewer:\` in ${files.report} (or pass --report <file>), then run test-review-evidence.cjs record`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(matches[0][1]);
  } catch {
    throw new Error(`legacy receipt in ${files.legacy} is invalid JSON; review then run test-review-evidence.cjs record`);
  }
  if (receipt?.snapshot?.branch !== current.branch) {
    throw new Error(
      `test review has no content-bound receipt for ${current.branch}; the legacy single-file receipt in ${files.legacy} belongs to another branch; review then run test-review-evidence.cjs record`,
    );
  }
  const reviewer = approvedReport(report, files.legacy);
  if (
    receipt.schema !== 2 ||
    receipt.reviewer !== reviewer ||
    !Number.isFinite(Date.parse(receipt.reviewed_at)) ||
    JSON.stringify(receipt.snapshot) !== JSON.stringify(current)
  ) {
    throw new Error(
      "legacy test review receipt is stale or uses an unsupported schema; review the current committed, staged and untracked tests again and run test-review-evidence.cjs record",
    );
  }
  console.warn(
    `test-review: deprecated: accepted legacy single-file receipt in ${files.legacy} for ${current.branch}; run record to migrate to ${files.receipt}`,
  );
}
function check(current, files) {
  const raw = readRegular(files.shared, files.receipt);
  if (raw === null) {
    checkLegacy(current, files);
    return;
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    throw new Error(`test review receipt ${files.receipt} is invalid JSON; review then run test-review-evidence.cjs record`);
  }
  const narrative = readRegular(files.shared, files.report);
  if (narrative === null) {
    throw new Error(`test review receipt has no narrative ${files.report}; review then run test-review-evidence.cjs record`);
  }
  const reviewer = approvedReport(narrative, files.report);
  if (
    receipt?.schema !== 3 ||
    receipt.reviewer !== reviewer ||
    !Number.isFinite(Date.parse(receipt.reviewed_at)) ||
    receipt.report_sha256 !== hash(narrative) ||
    JSON.stringify(receipt.snapshot) !== JSON.stringify(current)
  ) {
    throw new Error(
      "test review receipt is stale or belongs to another branch/base; review the current committed, staged and untracked tests again",
    );
  }
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    "usage: test-review-evidence.cjs snapshot|paths|record|check --project <checkout> [--report <file> (record only)]";
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--project", "--report"].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage);
    options[args[i]] = args[i + 1];
  }
  if (options["--report"] !== undefined && command !== "record") throw new Error(usage);
  const project = path.resolve(options["--project"] ?? ".");
  if (command === "paths") {
    const files = evidenceFiles(project);
    console.log(JSON.stringify({
      branch: files.branch,
      report: path.join(files.shared, files.report),
      receipt: path.join(files.shared, files.receipt),
      legacy_report: path.join(files.shared, files.legacy),
    }, null, 2));
    return;
  }
  const current = snapshot(project);
  if (command === "snapshot") {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  if (!["record", "check"].includes(command)) throw new Error(usage);
  if (command === "check" && current.files.length === 0 && !current.scope_changed) return;
  const files = evidenceFiles(project);
  if (command === "record") record(current, files, options["--report"]);
  else check(current, files);
}
try {
  main();
} catch (error) {
  console.error(`test-review: ${error.message}`);
  process.exit(1);
}
