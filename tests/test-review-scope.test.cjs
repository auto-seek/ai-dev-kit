// Perspective: reviewers of projects whose test layouts are not language conventions.
// Invariant: the declared Git scope covers every changed revision, and neither a
// policy edit nor a stale receipt can silently remove work from required review.
// Goal: detect missed test changes, unsafe scope configuration, and cross-worktree
// policy leakage through the public evidence CLI against real temporary Git repos.
// Migration: retain these CLI contracts when the receipt or scope schema changes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const evidence = path.resolve(__dirname, "../scripts/test-review-evidence.cjs");
const scopeFile = ".ai-dev-kit/test-scope.json";
const reportFile = ".ai-dev-kit/workflow/test-review.md";
const receiptDirectory = ".ai-dev-kit/workflow/test-review";
const branchKey = (branch) => crypto.createHash("sha256").update(branch).digest("hex");
const pathsPolicy = (...paths) => ({ schema_version: 1, paths });
const noTests = {
  schema_version: 1,
  no_tests_reason: "Documentation-only fixture; executable checks live in the consuming repository.",
};

function fixture(t, policy = pathsPolicy("checks"), files = { "checks/contract.cs": "baseline\n" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-test-scope-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args, cwd = project, expected = 0, input) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", input });
    assert.equal(result.status, expected, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const git = (...args) => run("git", args);
  const write = (file, body, checkout = project) => {
    const absolute = path.join(checkout, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
  };
  const scope = (value, checkout = project) => write(scopeFile, JSON.stringify(value) + "\n", checkout);
  const commit = () => {
    git("add", "--all");
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture");
  };
  const exec = (args, checkout = project) =>
    spawnSync(process.execPath, [evidence, ...args, "--project", checkout], { encoding: "utf8" });
  const cli = (command, expected = 0, checkout = project, extra = []) => {
    const result = exec([command, ...extra], checkout);
    assert.equal(result.status, expected, `${command} --project ${checkout}\n${result.stdout}${result.stderr}`);
    return expected === 0 ? result.stdout : result.stderr;
  };
  const snapshot = (checkout = project) => JSON.parse(cli("snapshot", 0, checkout));
  const paths = (checkout = project) => JSON.parse(cli("paths", 0, checkout));
  let reviews = 0;
  const approve = (checkout = project, note = "Reviewed the fixture's exact public contract and content.") => {
    const narrative = path.join(root, `review-${reviews += 1}.md`);
    fs.writeFileSync(narrative, `# Test Review\n\n- Status: approved\n- Reviewer: scope-contract-reviewer\n\n${note}\n`);
    cli("record", 0, checkout, ["--report", narrative]);
    cli("check", 0, checkout);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Scope Contract");
  git("config", "user.email", "scope@example.invalid");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", ".ai-dev-kit/workflow/\n**/bin/\n**/obj/\n");
  write(".ai-dev-kit/profile.yml", "merge_policy:\n  target_branch: main\n");
  for (const [file, body] of Object.entries(files)) write(file, body);
  if (policy !== null) scope(policy);
  commit();
  git("switch", "-qc", "codex/scope-contract");
  return { root, project, run, git, write, scope, commit, exec, cli, snapshot, paths, approve };
}

function filePaths(snapshot) {
  return snapshot.files.map((file) => file.path);
}

test("literal project scope includes C#, arbitrary suffixes, extensionless fixtures and inline tests", (t) => {
  const f = fixture(t, pathsPolicy("FuSheng.Core.Tests", "spec data", "inline/source.rs", ":(glob)* space"), {
    "FuSheng.Core.Tests/PermyriadContractTests.cs": "original C# contract\n",
    "spec data/seed.fixture": "baseline fixture\n",
    "inline/source.rs": "inline test baseline\n",
    ":(glob)* space/odd[1].proof": "literal filename baseline\n",
    "outside.test.js": "outside the declared scope\n",
  });
  for (const file of ["FuSheng.Core.Tests/PermyriadContractTests.cs", "spec data/seed.fixture", "inline/source.rs", ":(glob)* space/odd[1].proof", "outside.test.js"]) {
    f.write(file, "candidate content\n");
  }
  f.write("spec data/no-extension", "untracked fixture\n");
  f.write("FuSheng.Core.Tests/bin/Generated.test.js", "ignored output\n");
  f.write("spec data/obj/generated.cs", "ignored output\n");
  const snap = f.snapshot();
  assert.deepEqual(filePaths(snap), [":(glob)* space/odd[1].proof", "FuSheng.Core.Tests/PermyriadContractTests.cs", "inline/source.rs", "spec data/no-extension", "spec data/seed.fixture"]);
  assert.equal(snap.scope_changed, false);
  assert.equal(snap.scope.path, scopeFile);
  for (const layer of ["base", "head", "index", "worktree"]) {
    assert.deepEqual(snap.scope[layer].policy, pathsPolicy("FuSheng.Core.Tests", "spec data", "inline/source.rs", ":(glob)* space"));
    assert.equal(typeof snap.scope[layer].identity, "string");
    assert(snap.scope[layer].identity.length > 0);
  }
  const special = snap.files.find((file) => file.path.startsWith(":"));
  assert(special.head.includes(":(glob)* space/odd[1].proof"), "literal metadata must retain the exact tracked path");
  assert(special.index.includes(":(glob)* space/odd[1].proof"));
});

test("base, HEAD, index and worktree policies union committed, staged and untracked test changes", (t) => {
  const f = fixture(t, pathsPolicy("base-only"), { "base-only/deleted.cs": "old test\n" });
  f.git("rm", "base-only/deleted.cs");
  f.write("head-only/committed.case", "committed test\n");
  f.scope(pathsPolicy("head-only"));
  f.commit();
  f.write("index-only/staged", "staged test\n");
  f.scope(pathsPolicy("index-only"));
  f.git("add", "--all");
  f.write("worktree-only/untracked.fixture", "untracked test\n");
  f.scope(pathsPolicy("worktree-only"));
  const snap = f.snapshot();
  assert.deepEqual(filePaths(snap), ["base-only/deleted.cs", "head-only/committed.case", "index-only/staged", "worktree-only/untracked.fixture"]);
  for (const [layer, root] of [["base", "base-only"], ["head", "head-only"], ["index", "index-only"], ["worktree", "worktree-only"]]) {
    assert.deepEqual(snap.scope[layer].policy, pathsPolicy(root));
    assert.equal(typeof snap.scope[layer].identity, "string");
  }
  assert.equal(snap.scope_changed, true);
  assert.equal(snap.files[0].worktree, null);
  assert.equal(snap.files[0].index, "");
  f.approve();
  f.write("index-only/staged", "unreviewed index content\n");
  f.git("add", "index-only/staged");
  f.write("index-only/staged", "staged test\n");
  assert.match(f.cli("check", 1), /stale/i);
});

test("scope-only byte changes need review and an index-only policy edit invalidates the receipt", (t) => {
  const f = fixture(t);
  const policy = JSON.stringify(pathsPolicy("checks"));
  f.write(scopeFile, policy + "\n\n");
  const snap = f.snapshot();
  assert.deepEqual(snap.files, []);
  assert.equal(snap.scope_changed, true);
  assert.match(f.cli("check", 1), /test-review|review|receipt/i);
  f.approve();
  const receipt = JSON.parse(fs.readFileSync(f.paths().receipt, "utf8"));
  assert.equal(receipt.schema, 3);
  assert.deepEqual(receipt.snapshot.scope, snap.scope);
  f.write(scopeFile, policy + "\n\n\n");
  f.git("add", scopeFile);
  f.write(scopeFile, policy + "\n\n");
  assert.match(f.cli("check", 1), /stale/i);
});

test("explicit no-tests policy is stable when unchanged but its reason is reviewed content", (t) => {
  const f = fixture(t, noTests, { "README.md": "documentation\n" });
  f.write("README.md", "updated documentation\n");
  assert.deepEqual(filePaths(f.snapshot()), []);
  assert.equal(f.snapshot().scope_changed, false);
  f.cli("check");
  f.scope({ ...noTests, no_tests_reason: "Documentation remains the only content in this project." });
  assert.equal(f.snapshot().scope_changed, true);
  f.cli("check", 1);
  f.approve();
});

for (const committed of [false, true]) {
  test(`${committed ? "committed" : "staged"} scope narrowing cannot hide a deleted test or a rename out`, (t) => {
    const f = fixture(t, pathsPolicy("checks"), {
      "checks/deleted.cs": "deleted test\n",
      "checks/renamed.cs": "renamed test\n",
      "retained/contract.fixture": "retained test\n",
    });
    f.git("rm", "checks/deleted.cs");
    fs.mkdirSync(path.join(f.project, "archive"));
    f.git("mv", "checks/renamed.cs", "archive/example.txt");
    f.scope(pathsPolicy("retained"));
    f.git("add", scopeFile);
    if (committed) f.commit();
    const comparison = committed ? ["main", "HEAD"] : ["--cached"];
    assert.match(f.git("diff", "--name-status", "--find-renames", ...comparison), /R100\s+checks\/renamed\.cs\s+archive\/example\.txt/);
    const snap = f.snapshot();
    assert.deepEqual(filePaths(snap), ["checks/deleted.cs", "checks/renamed.cs"]);
    assert(snap.files.every((file) => file.worktree === null && file.index === ""));
    f.cli("check", 1);
    f.approve();
  });
}

test("first enrollment permits absent historical scope but requires the declaration in stage zero", (t) => {
  const f = fixture(t, null);
  f.scope(pathsPolicy("checks"));
  f.write("checks/contract.cs", "candidate\n");
  assert.match(f.cli("snapshot", 1), /scope|index|stage|tracked/i);
  f.git("add", scopeFile);
  const snap = f.snapshot();
  assert.equal(snap.scope.base, null);
  assert.equal(snap.scope.head, null);
  assert.deepEqual(snap.scope.index.policy, pathsPolicy("checks"));
  assert.deepEqual(snap.scope.worktree.policy, pathsPolicy("checks"));
  assert.equal(snap.scope_changed, true);
  assert.deepEqual(filePaths(snap), ["checks/contract.cs"]);
  f.approve();
});

test("invalid policies report errors instead of silently declaring no tests", (t) => {
  const invalid = [
    ["malformed JSON", "{"],
    ["empty roots", JSON.stringify(pathsPolicy())],
    ["empty reason", JSON.stringify({ schema_version: 1, no_tests_reason: "  " })],
    ["mutually exclusive declarations", JSON.stringify({ ...noTests, paths: ["checks"] })],
    ["unmatched root", JSON.stringify(pathsPolicy("chekcs"))],
    ["traversal", JSON.stringify(pathsPolicy("../checks"))],
    ["absolute root", JSON.stringify(pathsPolicy("/checks"))],
    ["unsupported schema", JSON.stringify({ schema_version: 2, paths: ["checks"] })],
  ];
  for (const [label, body] of invalid) {
    const f = fixture(t);
    f.write(scopeFile, body);
    assert.match(f.cli("snapshot", 1), /scope|schema|JSON|path|reason/i, label);
  }
});

test("invalid historical JSON stays an error after a valid current replacement", (t) => {
  for (const layer of ["base", "head"]) {
    const f = fixture(t, layer === "base" ? null : pathsPolicy("checks"));
    if (layer === "base") f.git("switch", "main");
    f.write(scopeFile, "{ invalid historical JSON\n");
    f.commit();
    if (layer === "base") f.git("switch", "-qc", "codex/from-invalid-base");
    f.scope(pathsPolicy("checks"));
    f.git("add", scopeFile);
    assert.match(f.cli("snapshot", 1), /scope|JSON/i, layer);
  }
});

test("missing, deleted, symlinked and conflicted current scope cannot bypass review", (t) => {
  const mutations = [
    ["missing entirely", (f) => f.git("rm", scopeFile)],
    ["deleted only in worktree", (f) => fs.unlinkSync(path.join(f.project, scopeFile))],
    ["deleted from index", (f) => f.git("rm", "--cached", scopeFile)],
    ["symlink in worktree", (f) => {
      f.write("scope-copy.json", JSON.stringify(pathsPolicy("checks")));
      fs.unlinkSync(path.join(f.project, scopeFile));
      fs.symlinkSync("../scope-copy.json", path.join(f.project, scopeFile));
    }],
    ["symlink only in index", (f) => {
      f.write("scope-copy.json", JSON.stringify(pathsPolicy("checks")));
      fs.unlinkSync(path.join(f.project, scopeFile));
      fs.symlinkSync("../scope-copy.json", path.join(f.project, scopeFile));
      f.git("add", scopeFile);
      fs.unlinkSync(path.join(f.project, scopeFile));
      f.scope(pathsPolicy("checks"));
    }],
    ["unmerged index", (f) => {
      const blob = f.git("rev-parse", `HEAD:${scopeFile}`).trim();
      f.git("update-index", "--force-remove", scopeFile);
      f.run("git", ["update-index", "--index-info"], f.project, 0, `100644 ${blob} 2\t${scopeFile}\n100644 ${blob} 3\t${scopeFile}\n`);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const f = fixture(t);
    mutate(f);
    assert.match(f.cli("snapshot", 1), /scope|index|stage|regular|symlink|conflict/i, label);
  }
});

test("schema-one receipts cannot approve the new scope contract", (t) => {
  const f = fixture(t, pathsPolicy("tests"), { "tests/contract.test.js": "baseline\n" });
  f.write("tests/contract.test.js", "candidate\n");
  const legacy = { schema: 1, reviewer: "scope-contract-reviewer", reviewed_at: new Date().toISOString(), snapshot: f.snapshot() };
  f.write(reportFile, `# Test Review\n\n- Status: approved\n- Reviewer: scope-contract-reviewer\n\n<!-- ai-dev-kit-test-review:v1 -->\n\`\`\`json\n${JSON.stringify(legacy)}\n\`\`\`\n<!-- /ai-dev-kit-test-review -->\n`);
  assert.match(f.cli("check", 1), /receipt|schema|review/i);
});

test("linked worktree owns scope while the main checkout owns the profile and receipt", (t) => {
  const f = fixture(t, pathsPolicy("checks"), { "checks/contract.cs": "baseline\n", "Other.Tests/contract.cs": "baseline\n" });
  const linked = path.join(f.root, "linked");
  f.git("worktree", "add", "-q", "-b", "codex/linked-scope", linked, "main");
  f.scope(pathsPolicy("Other.Tests"), linked);
  f.run("git", ["add", scopeFile], linked);
  f.write("Other.Tests/contract.cs", "candidate\n", linked);
  f.write(".ai-dev-kit/profile.yml", "merge_policy:\n  target_branch: nonexistent-local-target\n", linked);
  f.write(scopeFile, "{ deliberately invalid scope in the other checkout\n");
  const snap = f.snapshot(linked);
  assert.equal(snap.base_ref, "main");
  assert.deepEqual(snap.scope.worktree.policy, pathsPolicy("Other.Tests"));
  assert.deepEqual(filePaths(snap), ["Other.Tests/contract.cs"]);
  f.approve(linked);
  const evidencePaths = f.paths(linked);
  for (const file of [evidencePaths.report, evidencePaths.receipt]) {
    assert.equal(fs.realpathSync(path.dirname(file)), fs.realpathSync(path.join(f.project, receiptDirectory)));
    assert(fs.existsSync(file));
    assert.equal(fs.existsSync(path.join(linked, receiptDirectory, path.basename(file))), false);
  }
});

test("parallel branches in linked worktrees own independent per-branch receipts", (t) => {
  const f = fixture(t);
  const checkouts = {};
  for (const name of ["x", "y"]) {
    const checkout = path.join(f.root, `linked-${name}`);
    f.git("worktree", "add", "-q", "-b", `codex/parallel-${name}`, checkout, "main");
    f.write("checks/contract.cs", `candidate ${name}\n`, checkout);
    checkouts[name] = checkout;
  }
  const { x, y } = checkouts;
  f.approve(x);
  f.approve(y);
  f.cli("check", 0, x);
  f.cli("check", 0, y);
  const px = f.paths(x), py = f.paths(y);
  assert.equal(path.basename(px.receipt), `${branchKey("codex/parallel-x")}.json`, "same branch key as per-branch preflight receipts");
  assert.equal(path.basename(py.receipt), `${branchKey("codex/parallel-y")}.json`);
  assert.equal(fs.existsSync(path.join(f.project, reportFile)), false, "per-branch recording must not write the legacy shared file");
  const yEvidence = [fs.readFileSync(py.receipt, "utf8"), fs.readFileSync(py.report, "utf8")];

  f.approve(x, "Re-reviewed the X contract after a second look.");
  assert.match(fs.readFileSync(px.report, "utf8"), /second look/);
  assert.deepEqual([fs.readFileSync(py.receipt, "utf8"), fs.readFileSync(py.report, "utf8")], yEvidence, "re-recording X must not touch Y");
  f.cli("check", 0, y);

  f.write("checks/contract.cs", "candidate x, unreviewed revision\n", x);
  assert.match(f.cli("check", 1, x), /stale/i);
  f.cli("check", 0, y);
  f.approve(x, "Reviewed the revised X contract.");

  fs.appendFileSync(px.report, "\nUnreviewed narrative edit.\n");
  assert.match(f.cli("check", 1, x), /stale/i, "the receipt binds its stored narrative");
  f.cli("check", 0, y);
});

test("legacy single-file receipt is accepted only for the exact current branch and snapshot", (t) => {
  const f = fixture(t);
  f.write("checks/contract.cs", "candidate\n");
  const reviewed = f.snapshot();
  const receipt = { schema: 2, reviewer: "legacy-reviewer", reviewed_at: new Date().toISOString(), snapshot: reviewed };
  const legacyBody = `# Test Review\n\n- Status: approved\n- Reviewer: legacy-reviewer\n\n<!-- ai-dev-kit-test-review:v2 -->\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n<!-- /ai-dev-kit-test-review -->\n`;
  f.write(reportFile, legacyBody);
  const accepted = f.exec(["check"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stderr, /^test-review: deprecated: accepted legacy single-file receipt[^\n]*\n$/);

  f.git("switch", "-qc", "codex/other-branch");
  assert.deepEqual({ ...f.snapshot(), branch: reviewed.branch }, reviewed, "only the branch differs");
  assert.match(f.cli("check", 1), /belongs to another branch/);
  f.git("switch", "-q", "codex/scope-contract");
  f.cli("check");

  f.write("checks/contract.cs", "unreviewed revision\n");
  assert.match(f.cli("check", 1), /stale/i);
  f.write("checks/contract.cs", "candidate\n");

  // The shared file may carry another branch's approval: record never reads it.
  assert.match(f.cli("record", 1), /requires --report <file> or this branch's narrative.*paths/);
  assert.equal(fs.existsSync(f.paths().receipt), false);
  assert.equal(fs.readFileSync(path.join(f.project, reportFile), "utf8"), legacyBody, "the legacy file is never modified");
  // Explicit migration: the reviewer places the narrative at the per-branch path.
  fs.mkdirSync(path.dirname(f.paths().report), { recursive: true });
  fs.writeFileSync(f.paths().report, legacyBody);
  f.cli("record");
  const stored = fs.readFileSync(f.paths().report, "utf8");
  assert.doesNotMatch(stored, /ai-dev-kit-test-review/, "stored narratives never carry receipts");
  assert.match(stored, /- Reviewer: legacy-reviewer/);
  const current = f.exec(["check"]);
  assert.deepEqual([current.status, current.stderr], [0, ""], "a per-branch receipt takes precedence without the notice");

  f.git("switch", "-q", "--detach");
  assert.match(f.cli("check", 1), /named branch/);
  assert.match(f.cli("paths", 1), /named branch/);
});

test("test symlinks bind their own target text without reading the external target", (t) => {
  const f = fixture(t);
  const external = path.join(f.root, "external.cs");
  fs.writeFileSync(external, "external version one\n");
  fs.symlinkSync(external, path.join(f.project, "checks/link.cs"));
  const before = f.snapshot();
  assert.deepEqual(filePaths(before), ["checks/link.cs"]);
  fs.writeFileSync(external, "external version two\n");
  assert.deepEqual(f.snapshot(), before, "external content is not part of the checkout's review identity");
  fs.unlinkSync(path.join(f.project, "checks/link.cs"));
  fs.symlinkSync(path.join(f.root, "different.cs"), path.join(f.project, "checks/link.cs"));
  assert.notEqual(f.snapshot().files[0].worktree, before.files[0].worktree);
});

test("a symlink parent cannot redirect a tracked test read outside the checkout", (t) => {
  const f = fixture(t);
  const external = path.join(f.root, "external-tests");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "contract.cs"), "not checkout content\n");
  fs.unlinkSync(path.join(f.project, "checks/contract.cs"));
  fs.rmdirSync(path.join(f.project, "checks"));
  fs.symlinkSync(external, path.join(f.project, "checks"));
  assert.match(f.cli("snapshot", 1), /symlink|parent|outside|checkout/i);
});

test("dirty and changed gitlinks require subrepository review even when Git is configured to ignore them", (t) => {
  const f = fixture(t, pathsPolicy("tests"), { "tests/contract.test.js": "baseline\n" });
  const source = path.join(f.root, "module-source");
  const nested = path.join(f.project, "tests/module");
  const commitModule = (checkout) => {
    f.run("git", ["add", "--all"], checkout);
    f.run("git", ["-c", "user.name=Submodule Contract", "-c", "user.email=submodule@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "module fixture"], checkout);
  };
  f.run("git", ["init", "-q", "-b", "main", source]);
  f.write("contract.case", "module baseline\n", source);
  commitModule(source);
  f.git("switch", "main");
  f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "tests/module");
  f.commit();
  f.git("switch", "-qc", "codex/gitlink-review");
  f.git("config", "diff.ignoreSubmodules", "all");
  f.write("tests/contract.test.js", "reviewed parent test\n");
  f.approve();
  f.write("contract.case", "unreviewed child test\n", nested);
  assert.match(f.cli("check", 1), /submodule|gitlink/i);
  assert.match(f.cli("snapshot", 1), /submodule|gitlink/i);
  commitModule(nested);
  f.git("add", "tests/module");
  assert.match(f.cli("snapshot", 1), /submodule|gitlink/i);
  assert.match(f.cli("check", 1), /submodule|gitlink/i);
});

test("narrative and profile symlinks, including their parents, cannot redirect review reads or writes", (t) => {
  const key = branchKey("codex/scope-contract");
  const narrativeFile = `${receiptDirectory}/${key}.md`;
  for (const location of ["report", "report-directory", "report-parent", "profile", "profile-parent"]) {
    const f = fixture(t, pathsPolicy("tests"), { "tests/contract.test.js": "baseline\n" });
    f.write("tests/contract.test.js", "candidate\n");
    const report = "# Test Review\n\n- Status: approved\n- Reviewer: scope-contract-reviewer\n\nExternal sentinel must not be changed.\n";
    f.write(narrativeFile, report);
    let sentinel;
    if (location === "report") {
      sentinel = path.join(f.root, "external-review.md");
      fs.renameSync(path.join(f.project, narrativeFile), sentinel);
      fs.symlinkSync(sentinel, path.join(f.project, narrativeFile));
    } else if (location === "report-directory") {
      const external = path.join(f.root, "external-review-directory");
      fs.renameSync(path.join(f.project, receiptDirectory), external);
      fs.symlinkSync(external, path.join(f.project, receiptDirectory));
      sentinel = path.join(external, `${key}.md`);
    } else if (location === "report-parent") {
      const external = path.join(f.root, "external-workflow");
      fs.renameSync(path.join(f.project, ".ai-dev-kit/workflow"), external);
      fs.symlinkSync(external, path.join(f.project, ".ai-dev-kit/workflow"));
      sentinel = path.join(external, `test-review/${key}.md`);
    } else if (location === "profile") {
      sentinel = path.join(f.root, "external-profile.yml");
      fs.renameSync(path.join(f.project, ".ai-dev-kit/profile.yml"), sentinel);
      fs.symlinkSync(sentinel, path.join(f.project, ".ai-dev-kit/profile.yml"));
    } else {
      const external = path.join(f.root, "external-kit-state");
      fs.renameSync(path.join(f.project, ".ai-dev-kit"), external);
      fs.symlinkSync(external, path.join(f.project, ".ai-dev-kit"));
      sentinel = path.join(external, `workflow/test-review/${key}.md`);
    }
    const before = fs.readFileSync(sentinel, "utf8");
    const result = spawnSync(process.execPath, [evidence, "record", "--project", f.project], { encoding: "utf8" });
    assert.equal(fs.readFileSync(sentinel, "utf8"), before, `${location}: record must not change an external sentinel`);
    assert.equal(fs.readdirSync(path.dirname(sentinel)).filter((name) => name.endsWith(".json")).length, 0, `${location}: no receipt written`);
    assert.equal(result.status, 1, `${location}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /symlink|regular|parent|checkout/i, location);
  }
});

test("repository-root scope excludes tracked workflow evidence so recording does not invalidate itself", (t) => {
  const f = fixture(t, pathsPolicy("."), { "component.contract": "baseline test\n" });
  f.git("switch", "main");
  f.write(".gitignore", "**/bin/\n**/obj/\n");
  f.write(reportFile, "# Tracked review report\n\n- Status: pending\n");
  f.write(".ai-dev-kit/workflow/gate-log.jsonl", "{\"baseline\":true}\n");
  f.commit();
  f.git("switch", "-qc", "codex/root-scope");
  assert(f.git("ls-files", "--", reportFile).includes(reportFile), "the fixture must track the report instead of hiding it with gitignore");
  f.write("component.contract", "candidate test\n");
  f.write(scopeFile, JSON.stringify(pathsPolicy(".")) + "\n\n");
  f.write(".ai-dev-kit/workflow/gate-log.jsonl", "{\"candidate\":true}\n");
  const snap = f.snapshot();
  assert.deepEqual(filePaths(snap), ["component.contract"]);
  assert.equal(snap.scope_changed, true);
  f.approve();
  f.write(".ai-dev-kit/workflow/gate-log.jsonl", "{\"post_review\":true}\n");
  f.cli("check");
  f.write("component.contract", "unreviewed test revision\n");
  assert.match(f.cli("check", 1), /stale/i);
});

test("workflow control directories and files cannot be declared as test roots", (t) => {
  const f = fixture(t);
  f.write(reportFile, "Control-plane review evidence.\n");
  f.git("add", "--force", reportFile);
  for (const root of [".ai-dev-kit/workflow", reportFile]) {
    f.scope(pathsPolicy(root));
    assert.match(f.cli("snapshot", 1), /reserved.*workflow evidence/i, root);
  }
});

test("matching only the scope declaration and control outputs does not make a test root valid", (t) => {
  for (const root of [scopeFile, ".ai-dev-kit"]) {
    const f = fixture(t, pathsPolicy(root), {
      ".gitignore": ".ai-dev-kit/profile.yml\n",
      [reportFile]: "Control-plane review evidence only.\n",
    });
    assert.deepEqual(f.git("ls-files", "--", ".ai-dev-kit").trim().split("\n"), [scopeFile, reportFile],
      "only policy and control output may be visible to Git under this root");
    assert.match(f.cli("snapshot", 1), /matches no test input files/i, root);
  }
});

test("real bootstrap requests missing scope without inventing it and preserves an existing declaration byte for byte", (t) => {
  const f = fixture(t, null);
  fs.unlinkSync(path.join(f.project, ".ai-dev-kit/profile.yml"));
  const args = [path.resolve(__dirname, "../bootstrap/init-skill.sh"), f.project, "--harness", "none"];
  const fresh = f.run("bash", args);
  assert.match(fresh, /Action required before preflight:.*test-scope\.json/);
  assert.match(fresh, /does not guess from languages or names/);
  assert.equal(fs.existsSync(path.join(f.project, scopeFile)), false);
  assert.equal(f.git("ls-files", "--", scopeFile), "");

  const original = Buffer.from('{\r\n  "paths" : [ "checks" ],\r\n  "schema_version" : 1\r\n}\r\n\r\n');
  f.write(scopeFile, original);
  f.git("add", scopeFile);
  const indexed = f.git("ls-files", "--stage", "--", scopeFile);
  const repeated = f.run("bash", args);
  assert.match(repeated, /Preserved project-owned.*test-scope\.json/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, scopeFile)), original);
  assert.equal(f.git("ls-files", "--stage", "--", scopeFile), indexed);
});
