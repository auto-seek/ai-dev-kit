# Test Review Evidence

Record test-review agent findings here when changed tests are used as verification evidence.

## Changed Test Files

- none yet

## Project Test Scope

- Validate the reviewed checkout's tracked `.ai-dev-kit/test-scope.json` against
  the test runner configuration, fixtures and full diff. Review policy changes
  even when no test file changes; an empty inventory is not proof of no tests.

## Reviewer Verdict

- Status: pending
- Reviewer: pending
- Date: YYYY-MM-DD

## Findings

- none yet

Bootstrap installs this template as `.ai-dev-kit/workflow/test-review-template.md`;
do not edit it in place. For each reviewed branch, copy it to the `report` path
printed by `node <kit>/scripts/test-review-evidence.cjs paths --project .` (or to
a private file). After actual review passes, set Status to approved, name the
reviewer, then run `node <kit>/scripts/test-review-evidence.cjs record --project .`
(add `--report <file>` for a private copy). Record stores the narrative and a
schema-3 receipt per branch in the main checkout's
`.ai-dev-kit/workflow/test-review/<branch-key>.{md,json}`, so parallel branches
do not invalidate each other. The receipt binds the verdict to the branch/base,
the stored narrative and every committed, staged, unstaged and untracked changed
test, plus historical/current scope policy identities. Re-review after content or
scope changes; old schema-1 receipts do not approve current evidence. A shared
`.ai-dev-kit/workflow/test-review.md` from older kits is never read as a
narrative; its receipt is accepted by `check` for one release only for its exact
branch and snapshot.
