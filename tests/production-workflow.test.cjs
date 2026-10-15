// Perspective: maintainers enabling the shipped bootstrap and worktree workflow.
// Invariant: reservation ownership is atomic across Git clients; reinstallation
// preserves coordination; test review covers every changed revision; linked
// worktrees read and mutate the same configured state.
// Goal: reproduce W1-W4 through real public commands, with no fake Cascade store.
// Migration: fresh profiles require >=0.8; explicit older profiles survive
// bootstrap unchanged. Keep this release integration gate on a real Cascade >=0.8
// executable via CASCADE_BIN. Only the concurrency barrier delays CLI output.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const kit = path.resolve(__dirname, "..");
const cascade = process.env.CASCADE_BIN;
assert(
  cascade && path.isAbsolute(cascade) && fs.existsSync(cascade),
  "CASCADE_BIN must name the real Cascade >=0.8 executable; this suite never skips or uses the fake CLI",
);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidk-production-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(cascade, path.join(bin, "cascade"));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.AI_DEV_KIT_CASCADE_GIT_REMOTE;
  delete env.AI_DEV_KIT_CASCADE_REDIS_URL;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (cmd, args, cwd = root, expected = 0, extraEnv = {}) => {
    const result = spawnSync(cmd, args, {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      expected,
      `${cmd} ${args.join(" ")}\n${result.stdout}${result.stderr}`,
    );
    return result.stdout + result.stderr;
  };
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const git = (project, ...args) => run("git", ["-C", project, ...args]);
  const commit = (project) => {
    git(project, "add", ".");
    git(
      project,
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
  };
  const project = (name, testPaths) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    commit(dir);
    run("bash", [
      path.join(kit, "bootstrap/init-skill.sh"),
      dir,
      "--harness",
      "none",
    ]);
    write(
      path.join(dir, ".gitignore"),
      fs.readFileSync(path.join(dir, ".gitignore"), "utf8") +
        "\n.ai-dev-kit/workflow/\n",
    );
    write(
      path.join(dir, ".ai-dev-kit/test-scope.json"),
      JSON.stringify(testPaths
        ? { schema_version: 1, paths: testPaths }
        : { schema_version: 1, no_tests_reason: "Coordination-only fixture; executable tests live in the kit integration suite." }) + "\n",
    );
    write(path.join(dir, ".ai-dev-kit/requirements.md"), "- [x] Exercise the real Cascade and Git protocol for this fixture.\n");
    write(path.join(dir, ".ai-dev-kit/gate-contract.json"), JSON.stringify({
      schema_version: 1,
      base_ref: "main",
      requirements: { mode: "global", ledger: ".ai-dev-kit/requirements.md" },
      preflight: { argv: [process.execPath, "-e", "process.exit(0)"], timeout_seconds: 10 },
    }) + "\n");
    commit(dir);
    return dir;
  };
  const lane = (project, agent, ...args) =>
    run("node", [
      path.join(kit, "scripts/cascade-lane.cjs"),
      "--profile",
      path.join(project, ".ai-dev-kit/profile.yml"),
      "--agent",
      agent,
      ...args,
    ]);
  const gate = (project, expected = 0) =>
    run(
      "bash",
      [
        path.join(kit, "scripts/skill-first-gate.sh"),
        "--phase",
        "preflight",
        "--project",
        project,
      ],
      root,
      expected,
    );
  const evidence = (project, cmd, expected = 0) =>
    run(
      "node",
      [
        path.join(kit, "scripts/test-review-evidence.cjs"),
        cmd,
        "--project",
        project,
      ],
      root,
      expected,
    );
  return {
    root,
    bin,
    env,
    run,
    write,
    git,
    commit,
    project,
    lane,
    gate,
    evidence,
  };
}

test("bootstrap defaults to Cascade >=0.8.0 and preserves an older Git profile byte for byte", (t) => {
  const f = fixture(t),
    p = f.project("bootstrap");
  const file = path.join(p, ".ai-dev-kit/profile.yml");
  assert.match(fs.readFileSync(file, "utf8"), /engine: cascade/);
  assert.match(fs.readFileSync(file, "utf8"), /^    min_version: ">=0\.8\.0"$/m);
  f.run("node", [
    path.join(kit, "scripts/set-coordination.cjs"),
    "--profile",
    file,
    "--storage",
    "git",
    "--git-remote",
    "ssh://example.invalid/production.git",
    "--namespace",
    "production",
    "--role",
    "worker",
    "--min-version",
    ">=0.7.0",
  ]);
  const before = fs.readFileSync(file, "utf8");
  assert.match(before, /^    min_version: ">=0\.7\.0"$/m);
  f.run("bash", [
    path.join(kit, "bootstrap/init-skill.sh"),
    p,
    "--harness",
    "none",
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  f.run("bash", [
    path.join(kit, "bootstrap/init-skill.sh"),
    p,
    "--harness",
    "none",
    "--coordination",
    "cascade",
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const error = f.run(
    "bash",
    [
      path.join(kit, "bootstrap/init-skill.sh"),
      p,
      "--harness",
      "none",
      "--coordination",
      "ledger",
    ],
    f.root,
    1,
  );
  assert.match(error, /explicit engine\/storage\/role migration/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("review gate rejects committed, staged, untracked, changed and wrong-branch test evidence", (t) => {
  const f = fixture(t),
    p = f.project("test-review", ["tests"]);
  f.git(p, "checkout", "-qb", "feature/review-work");
  f.lane(p, "review-agent", "add", "--slug", "review-work");
  f.lane(p, "review-agent", "claim", "--slug", "review-work");
  const committed = path.join(p, "tests/committed.test.js");
  f.write(
    committed,
    'const assert = require("node:assert/strict"); assert.equal(2 + 2, 4);\n',
  );
  f.commit(p);
  assert.match(f.gate(p, 2), /no unique content-bound receipt for feature\/review-work/);
  const report = JSON.parse(f.evidence(p, "paths")).report;
  f.write(
    report,
    "# Test Review\n\n- Status: approved\n- Reviewer: integration-reviewer\n\nAssertions and public behavior reviewed.\n",
  );
  assert.match(f.gate(p, 2), /no unique content-bound receipt/);
  f.evidence(p, "record");
  f.gate(p);
  const staged = path.join(p, "tests/staged.test.js");
  f.write(staged, "// reviewed staged version\n");
  f.git(p, "add", "tests/staged.test.js");
  assert.match(f.gate(p, 2), /receipt is stale/);
  f.evidence(p, "record");
  f.gate(p);
  // Restoring the worktree while changing only the index must invalidate review.
  f.write(staged, "// unreviewed index version\n");
  f.git(p, "add", "tests/staged.test.js");
  f.write(staged, "// reviewed staged version\n");
  assert.match(f.gate(p, 2), /receipt is stale/);
  f.evidence(p, "record");
  f.gate(p);
  f.write(
    path.join(p, "tests/untracked.test.js"),
    "// untracked contract test\n",
  );
  assert.match(f.gate(p, 2), /receipt is stale/);
  const snap = JSON.parse(f.evidence(p, "snapshot"));
  assert.deepEqual(
    snap.files.map((item) => item.path),
    [
      "tests/committed.test.js",
      "tests/staged.test.js",
      "tests/untracked.test.js",
    ],
  );
  f.evidence(p, "record");
  f.gate(p);
  f.write(committed, "// modified after review\n");
  assert.match(f.gate(p, 2), /receipt is stale/);
  f.evidence(p, "record");
  f.git(p, "checkout", "-qb", "feature/another-branch");
  assert.match(f.evidence(p, "check", 1), /no unique content-bound receipt for feature\/another-branch/);
});

for (const committed of [false, true]) {
  test(`review gate requires evidence for ${committed ? "committed" : "staged"} renames out of test paths`, (t) => {
    const f = fixture(t),
      p = f.project("rename-review", ["tests"]);
    f.write(
      path.join(p, "tests/critical.test.js"),
      'const assert = require("node:assert/strict"); assert.equal(2 + 2, 4);\n',
    );
    f.commit(p);
    f.git(p, "checkout", "-qb", "feature/rename-review");
    f.lane(p, "review-agent", "add", "--slug", "rename-review");
    f.lane(p, "review-agent", "claim", "--slug", "rename-review");
    fs.mkdirSync(path.join(p, "fixtures"));
    f.git(p, "mv", "tests/critical.test.js", "fixtures/sample.txt");
    if (committed) f.commit(p);
    const comparison = committed ? ["main", "HEAD"] : ["--cached"];
    assert.match(
      f.git(p, "diff", "--name-status", "--find-renames", ...comparison),
      /R100\s+tests\/critical\.test\.js\s+fixtures\/sample\.txt/,
      "fixture must exercise exact rename detection, not a changed test body",
    );
    const snap = JSON.parse(f.evidence(p, "snapshot"));
    assert.deepEqual(
      snap.files.map((item) => item.path),
      ["tests/critical.test.js"],
    );
    assert.equal(snap.files[0].worktree, null);
    assert.equal(snap.files[0].index, "");
    assert.match(f.evidence(p, "check", 1), /no unique content-bound receipt/);
    assert.match(f.gate(p, 2), /no unique content-bound receipt/);
    f.write(
      JSON.parse(f.evidence(p, "paths")).report,
      "# Test Review\n\n- Status: approved\n- Reviewer: integration-reviewer\n\nReviewed removal of the executable test from the test suite.\n",
    );
    assert.match(f.evidence(p, "check", 1), /no unique content-bound receipt/);
    f.evidence(p, "record");
    f.evidence(p, "check");
    f.gate(p);
  });
}

test("tracked-profile worktrees share the file store and the main-checkout Git overlay", (t) => {
  const f = fixture(t),
    p = f.project("main-checkout"),
    wt = path.join(f.root, "worktree");
  f.git(p, "worktree", "add", "-q", "-b", "feature/shared-work", wt, "main");
  f.lane(wt, "file-owner", "add", "--slug", "shared-work");
  f.lane(wt, "file-owner", "claim", "--slug", "shared-work");
  f.gate(wt);
  const local = JSON.parse(
    f.run(cascade, [
      "--storage",
      path.join(p, ".ai-dev-kit/cascade"),
      "list-nodes",
    ]),
  );
  assert.equal(local.data.nodes[0].id, "shared-work");
  assert.equal(local.data.nodes[0].reserved_for, "file-owner");
  assert.equal(fs.existsSync(path.join(wt, ".ai-dev-kit/cascade")), false);
  const remote = path.join(f.root, "overlay.git");
  f.git(p, "init", "--bare", "-q", remote);
  f.write(
    path.join(p, ".ai-dev-kit/profile.local.yml"),
    `coordination:\n  cascade:\n    storage: git\n    git_remote: "${remote}"\n    git_cache: "${f.root}/overlay-cache"\n    namespace: overlay-test\n`,
  );
  f.lane(wt, "git-owner", "add", "--slug", "shared-work");
  const claim = f.lane(wt, "git-owner", "claim", "--slug", "shared-work");
  f.gate(wt);
  const shared = JSON.parse(
    f.run(cascade, [
      "--git-remote",
      remote,
      "--git-cache",
      path.join(f.root, "inspect"),
      "--namespace",
      "overlay-test",
      "list-nodes",
    ]),
  );
  assert.equal(shared.data.nodes[0].reserved_for, "git-owner");
  assert.equal(shared.data.nodes[0].state, "ACTIVE");
  const token = claim.match(/fencing_token:\s*(\d+)/)?.[1];
  assert(token, "real claim must return a fencing token");
  f.lane(
    wt,
    "git-owner",
    "finish",
    "--slug",
    "shared-work",
    "--token",
    token,
    "--summary",
    "verified shared worktree state",
  );
  f.run("bash", [
    path.join(kit, "scripts/skill-first-gate.sh"),
    "--phase",
    "merge",
    "--project",
    wt,
  ]);
});

test("two real Git clients cannot reserve or claim the same canonical task", async (t) => {
  const f = fixture(t),
    remote = path.join(f.root, "center.git");
  f.run("git", ["init", "--bare", "-q", remote]);
  const projects = [f.project("alice"), f.project("bob")];
  projects.forEach((p, i) =>
    f.run("node", [
      path.join(kit, "scripts/set-coordination.cjs"),
      "--profile",
      path.join(p, ".ai-dev-kit/profile.yml"),
      "--storage",
      "git",
      "--git-remote",
      remote,
      "--git-cache",
      path.join(f.root, `cache-${i}`),
      "--namespace",
      "contention",
    ]),
  );
  // Both wrappers receive a real empty snapshot before either performs add.
  fs.unlinkSync(path.join(f.bin, "cascade"));
  f.write(
    path.join(f.bin, "cascade"),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(cascade)},process.argv.slice(2),{encoding:'utf8'});if(process.argv.includes('list-nodes')&&process.env.BARRIER_ROOT){fs.writeFileSync(process.env.BARRIER_ROOT+'/ready-'+process.pid,'');const until=Date.now()+15000;while(fs.readdirSync(process.env.BARRIER_ROOT).filter(x=>x.startsWith('ready-')).length<2){if(Date.now()>until)process.exit(97);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status);\n`,
  );
  fs.chmodSync(path.join(f.bin, "cascade"), 0o755);
  const adds = await Promise.all(
    projects.map(
      (p, i) =>
        new Promise((resolve) => {
          const child = spawn(
            "node",
            [
              path.join(kit, "scripts/cascade-lane.cjs"),
              "--profile",
              path.join(p, ".ai-dev-kit/profile.yml"),
              "--agent",
              i ? "bob" : "alice",
              "add",
              "--slug",
              "same-work",
            ],
            { env: { ...f.env, BARRIER_ROOT: f.root } },
          );
          let out = "";
          child.stdout.on("data", (data) => (out += data));
          child.stderr.on("data", (data) => (out += data));
          child.on("exit", (status) => resolve({ status, out }));
        }),
    ),
  );
  assert.deepEqual(
    adds.map((item) => item.status).sort(),
    [0, 1],
    JSON.stringify(adds),
  );
  const winner = adds[0].status === 0 ? "alice" : "bob",
    loser = winner === "alice" ? "bob" : "alice";
  const global = [
    "--git-remote",
    remote,
    "--git-cache",
    path.join(f.root, "inspect"),
    "--namespace",
    "contention",
  ];
  const graph = JSON.parse(f.run(cascade, [...global, "list-nodes"]));
  assert.equal(graph.data.nodes.length, 1);
  assert.equal(graph.data.nodes[0].id, "same-work");
  assert.equal(graph.data.nodes[0].reserved_for, winner);
  assert.match(
    f.run(
      cascade,
      [...global, "get-task", "--agent", loser, "--task", "same-work"],
      f.root,
      1,
    ),
    /TASK_RESERVED/,
  );
  assert.match(
    f.run(cascade, [
      ...global,
      "get-task",
      "--agent",
      winner,
      "--task",
      "same-work",
    ]),
    /Task: same-work/,
  );
});
