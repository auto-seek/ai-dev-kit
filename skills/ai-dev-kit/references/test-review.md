# Test Review Agent

Use this whenever tests are created, modified, used as merge evidence, or cited as proof that behavior works.

## Stance

Default to skepticism. A test file is not trustworthy merely because it passes. It may be asserting implementation details, over-mocking reality, missing the failure path, or passing without exercising the changed behavior.

## Required Test Contract

Each test file should explain:

- Perspective: who cares about the behavior;
- Invariant: what must remain true independent of implementation;
- Goal: what regression or failure this prevents;
- Migration: where this test belongs over time.

The contract must be meaningful, not decorative. Reject vague goals such as "works correctly".
Write it in plain language tied to actual assertions. Apply the comment
guidance in `implementation-discipline.md`; keep useful test intent and required
contract fields, but do not narrate every assertion or claim untested behavior.

## Review Checklist

- Does the test describe a real behavior or invariant?
- Would the test fail for the bug/regression it claims to prevent?
- Is the assertion non-vacuous?
- Is it testing public behavior, protocol, state transition, storage effect, rendering, or user-visible output instead of internal calls?
- Does it avoid mocking the project code under test?
- Are stubs limited to external services such as LLMs, payment providers, third-party APIs, or network boundaries?
- Does storage use a real adapter, in-memory implementation, or temp directory rather than a fake storage object?
- Do fixtures state the boundaries they create?
- Are edge cases covered where the changed behavior is risky?
- Does the test avoid copying production logic into the assertion?
- If a snapshot is used, is it stable and meaningful?
- If test code changes with production code, are both in the same commit or production comes first?

## Prompt For A Test Reviewer

```text
You are the test-review agent. Treat the test files as untrusted until proven useful.

Review the changed tests and the production behavior they claim to verify.
Use real file reads, graph lookups, test output, and code inspection. Do not rely on the implementing agent's summary.

For each changed test file:
1. Validate the test contract: Perspective, Invariant, Goal, Migration.
2. Identify whether the test proves behavior or merely mirrors implementation.
3. Check if mocks/stubs hide the actual integration path.
4. Check whether the test would fail for the regression it claims to prevent.
5. Report missing or weak assertions.

Return findings first:
- severity: critical | high | medium | low
- file:line
- issue
- evidence
- required fix

If no blocking issues exist, say what residual risk remains.
```

## Project-owned test scope

Before reviewing, inspect the reviewed checkout's tracked
`.ai-dev-kit/test-scope.json` and compare it to the actual test commands, runner
configuration, fixtures and full branch diff. It declares `schema_version: 1`
and a nonempty `paths` array of literal repository-relative files/directories.
All extensions and filenames under those roots are included. Inline tests
require declaring their source files or directories. There is no language/name
allowlist, glob inference or automatic no-tests exception.

Missing, invalid, conflicted or symlink scope fails, as does a declaration not
yet added to the index. Unstaged edits to an indexed declaration remain reviewed
content. A genuinely test-free project may declare a verified `no_tests_reason`
instead of `paths`;
that policy itself must be reviewed. Gitignored untracked outputs are excluded;
ignored test sources must first be added to Git. Bootstrap preserves existing
policy and tells unenrolled projects to configure it. See the kit's
`docs/test-scope-migration.md` for examples and migration instructions.

`.ai-dev-kit/workflow/` is reserved for review/gate output and never treated as
test input, including under a repository-root scope. Declaring it or a child
directly is an error. Changed or dirty submodules require independent review in
the child repository; a parent gitlink is not proof of reviewed child content.

Scope belongs to the reviewed branch, including linked worktrees. Shared main
profile and receipt storage do not override it. Review policy changes even
when no test file changed; an incorrect declaration can omit tests and cannot
be justified merely because the snapshot is empty.

## Content-bound evidence

Review the full branch diff from `merge_policy.target_branch`, including
committed, staged, unstaged and untracked tests. Inspect the exact inventory with
`node <kit>/scripts/test-review-evidence.cjs snapshot --project .`.

After the review passes, write `- Status: approved` and `- Reviewer: <identity>`
plus the substantive findings in this branch's narrative: copy the installed
`.ai-dev-kit/workflow/test-review-template.md` to the `report` path printed by
`test-review-evidence.cjs paths --project .`, or to a private file passed with
`--report`. Then bind it to the reviewed content:

```bash
node <kit>/scripts/test-review-evidence.cjs record --project . --report <narrative.md>
```

Evidence is per branch, stored in the MAIN checkout's
`.ai-dev-kit/workflow/test-review/<branch-key>.md` (narrative copy) and
`<branch-key>.json` (receipt), where `<branch-key>` is the SHA-256 of the short
branch name — the same key as per-branch preflight receipts.
`test-review-evidence.cjs paths --project .` prints both locations; without
`--report`, `record` reuses the branch's stored narrative. Recording replaces
only the current branch's evidence, so parallel branches and linked worktrees
never invalidate each other. A named branch is required (detached HEAD fails).

Schema-3 receipts record branch/base, each changed test's Git
HEAD/index/worktree identity, policy identities from merge-base, HEAD, index
and working tree, and the SHA-256 of the stored narrative. Historical and
current positive roots are combined so scope narrowing does not hide removed
tests. Both readiness gates validate the current branch's receipt only.
Old schema-1 approval requires actual renewed review, not a manual schema edit.
A changed index, untracked test, new branch, changed base, edited narrative or
post-review edit invalidates it. A policy change also invalidates it. Review the
new content before recording another receipt. A passing narrative from an older
revision is insufficient. Commit test changes before the final review/record
step; later docs-only commits do not change the test identities. The old
`AI_DEV_KIT_ALLOW_UNREVIEWED_TESTS` bypass is removed.

Deprecated for one release: when a branch has no per-branch receipt, a schema-2
receipt in the legacy single file `.ai-dev-kit/workflow/test-review.md` is
accepted only if it matches the current branch and snapshot exactly, with a
one-line deprecation notice; a legacy receipt for another branch never counts.
That file is never read as a narrative: `record` requires `--report` or the
branch's stored narrative, because the shared file may hold another branch's
approval.

## Blocking Criteria

Block merge evidence when:

- tests are the only verification but are vacuous or implementation-only;
- tests mock the project code being verified;
- tests lack a meaningful contract in a project that requires contracts;
- the changed behavior has no test or credible substitute verification;
- fixtures create a fake world that bypasses the bug path.
