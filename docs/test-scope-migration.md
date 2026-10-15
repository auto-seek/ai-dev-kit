---
type: runbook
status: active
owner: ai-dev-kit
created_at: 2026-09-06
last_verified_at: 2026-09-07
related_paths:
  - scripts/test-review-evidence.cjs
  - bootstrap/init-skill.sh
  - skills/ai-dev-kit/references/test-review.md
truth_sources: [code, tests]
---

# Test scope in 0.12

The kit no longer guesses test files from languages, extensions or directory
names. The project owns `.ai-dev-kit/test-scope.json`; Git supplies path matching
and content identities. No additional package or runner adapter is required.

## Enroll a project

Inspect the project's actual test commands, test-runner configuration, source
layout and fixtures. Declare the files/directories that carry its test contracts.
For example, a mixed C#/Python project may use:

```json
{
  "schema_version": 1,
  "paths": [
    "Project.Core.Tests",
    "Project.Sidecar.Tests",
    "Project.Tools.Tests",
    "sidecar/tests"
  ]
}
```

These are **literal repository-relative roots**, not globs or Git magic. A
directory includes its descendants of every language, extension and filename.
Include fixtures and helpers; include source files containing inline tests.
Use `/` separators without empty, `.` or `..` components; `.` alone explicitly
selects the whole repository. Special characters are literal, not pattern syntax.
Every root must match a tracked historical/current file or a visible candidate;
misspelled or empty roots fail instead of reporting no tests.

Gitignored untracked build output is not included. A real test source that is
ignored must be explicitly added to Git before review. Tracked files remain in
scope even if a later ignore rule matches them. Changed or dirty submodules in
scope fail explicitly, even when Git is configured to ignore submodule changes;
review the child repository independently. A test symlink binds only its target
text, not external content. Scope roots and policy cannot be symlinks.

`.ai-dev-kit/workflow/` is reserved for generated review and gate evidence, not
tests. It is excluded even under `paths: ["."]`, so recording a receipt does not
invalidate itself. Declaring this directory or a child directly is an error.
The scope file is bound separately as policy. A root matching only these control
files is not a valid test root; keep test sources and fixtures elsewhere.

Add the declaration to Git before taking a snapshot:

```bash
git add .ai-dev-kit/test-scope.json
node <kit>/scripts/test-review-evidence.cjs snapshot --project .
```

If the project ignores all of `.ai-dev-kit/`, deliberately track only this policy
with `git add -f .ai-dev-kit/test-scope.json`, or adjust its ignore rule to permit
the file. Do not expose profile.local.yml, credentials or runtime state.
The declaration must be a stage-0 regular file and remain valid in the working
tree. Commit it with the change that introduces or migrates the test layout.

Projects genuinely without tests can instead declare:

```json
{
  "schema_version": 1,
  "no_tests_reason": "This repository contains translations only; executable tests are maintained in the consuming application."
}
```

The reason must be specific and verified by the reviewer, not copied to silence
a failure. It is mutually exclusive with `paths`. When tests are introduced,
replace the declaration with their actual roots in the same change. This is a
reviewed project contract, not an authentication boundary: an incorrect scope
can omit tests, so reviewers must compare the declaration to the whole diff and
the actual runner configuration. Kit cannot prove arbitrary code is not a test.

## Review and migration

1. Bootstrap installs/refreshes the kit and preserves any existing scope byte for
   byte. Missing scope produces an explicit setup instruction; no guessed policy
   or automatic no-tests exception is created.
2. Add a valid declaration to the index. A missing base/HEAD declaration is
   recorded as absent, allowing migration; any present historical policy must
   be valid. Current index/worktree deletion, conflicts and invalid/symlink
   policy fail explicitly. All available revisions contribute their test roots.
3. Inspect the snapshot and review the actual tests and scope. Scope comes from
   the reviewed checkout, including a linked worktree, not the main checkout.
4. Write the named, approved review narrative, then run `record --report` and
   `check`. Record stores the narrative and receipt per branch in the main
   checkout's `.ai-dev-kit/workflow/test-review/<branch-key>.{md,json}`
   (`<branch-key>` is the SHA-256 of the short branch name, as for preflight
   receipts; `paths` prints both), so other branches and worktrees keep their
   own valid reviews. The shared profile still selects the comparison branch.
   Profile, narrative and receipt must be regular files; symlinks in their paths
   are rejected before read/write.

```bash
node <kit>/scripts/test-review-evidence.cjs record --project . --report <narrative.md>
node <kit>/scripts/test-review-evidence.cjs check --project .
```

Schema-3 receipts bind policy identities from merge-base, HEAD, index and working
tree, changed test identities and the stored narrative's SHA-256. For one
release, a schema-2 receipt left in the legacy single file
`.ai-dev-kit/workflow/test-review.md` still passes when the branch has no
per-branch receipt and it matches the current branch and snapshot exactly;
`check` prints a one-line deprecation notice. It never approves another
branch, and `record` never reads it as a narrative: copy the reviewed narrative
to the `paths` report location or pass `--report`. Historical and current
positive roots are combined, so narrowing the current policy cannot hide removals or moves out
of an old test directory. Policy changes need review even with zero changed test
files. Configuration, staging, branch/base or subsequent content edits invalidate
the receipt. Unchanged scope with no changed tests does not require a new review.

Old schema-1 approval is not sufficient for a change requiring review. Perform
the review and record a new receipt; do not rewrite its schema number by hand.
Stop hooks remain light; enrollment and evidence are checked by preflight/merge.
Other mandatory project checks remain independent and are not waived by a valid
test receipt.
