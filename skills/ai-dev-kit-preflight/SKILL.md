---
name: ai-dev-kit-preflight
description: "User-invoked ai-dev-kit preflight workflow. Use when the user invokes /ai-dev-kit-preflight or asks to check readiness before ending work, review implementation evidence, run quality gates, or prepare a branch for review."
---

# AI Dev Kit Preflight

Use the `ai-dev-kit` skill first. Read `.ai-dev-kit/profile.yml`,
`../ai-dev-kit/references/implementation-discipline.md`, and the other relevant
ai-dev-kit references before deciding readiness.

Arguments:

```text
$ARGUMENTS
```

Complete the implementation, applicable validation and independent reviews,
then commit all intended code and documentation before the final preflight.
Read the reviewed checkout's tracked `.ai-dev-kit/gate-contract.json`: it names
the approved base ref, requirements scope and literal project verification argv.
Missing enrollment requires an explicit migration, not a guessed or no-op command.
Run the configured preflight gate when the repository has ai-dev-kit installed:

```bash
bash <ai-dev-kit-path>/scripts/skill-first-gate.sh --phase preflight --project .
```

This gate also fails on overdue subtraction debt — too many commits since the last recorded `/ai-dev-kit-clean` pass. If it does, run `/ai-dev-kit-clean` on this branch, log the pass for this branch in `.ai-dev-kit/workflow/subtraction-log.md` (a pass with no candidates is recorded with `(none)` in its scope), and retry.

The gate executes the declared project command, then records a content-bound
preflight receipt only if every check passes and inputs remain unchanged.
It does not invent missing build, lint, test or E2E coverage: include applicable
checks in the project-owned entrypoint. A merge needs this exact-HEAD receipt;
any later commit, index/worktree change, base-ref change or effective-config
change requires a new preflight. Merge never renews a receipt by itself.

Opt-in contract options for many parallel agents (see
`docs/team-gate-migration.md` in the kit): `BLOCKED (retryable)` means a declared
busy-resource exit code or a failed environment check (node, free disk); no
receipt was written, so retry later instead of treating it as a verification
failure. Topic-specific test selection belongs in the task's own committed
`preflight.task_args` file and requirements in its `task-files` file, not in the
shared contract or ledger. `--phase status [--all] [--json]` reports, read-only,
which receipts are missing or stale and why, and which locks and workstations
are held on this machine. Under `receipt_binding: merge-base`
target movement does not stale this receipt; a single integrator runs
`--phase integrate` before merge.

Review touched comments using `implementation-discipline.md`: plain, verified
context for maintainers, with useful API docs and directives preserved. Block
materially misleading explanations with code/contract evidence; wording-only
preferences are non-blocking. The shell gate does not judge comment quality.

Review changed user-facing text and the final report using `plain-language.md`.
UI text that is unnecessary, explanatory where no explanation is needed, uses
marketing or AI-flavored wording, or names the same thing inconsistently is a
finding; so is a report that hides the cause or overstates what was verified.

Use review agents according to the skill:

- changed tests: test-review agent;
- changed docs or behavior documented elsewhere: doc-curator or fact reviewer;
- public API, shared utility, module boundary, or new abstraction: architecture reviewer;
- new or changed user-facing text (UI copy, errors, notifications): copy reviewer;
- merge preparation: merge guardian.

Test review covers the target-branch diff and committed/staged/untracked tests.
Require the reviewed checkout's tracked `.ai-dev-kit/test-scope.json`; validate
its literal roots or explicit no-tests reason and review policy changes. Do not
substitute language detection or a main-checkout policy. See `test-review.md`.
After actual approval, the reviewer records a content-bound receipt with
`node <kit>/scripts/test-review-evidence.cjs record --project . --report <narrative.md>`;
a stale or missing receipt for the current branch blocks readiness. Main-checkout
config applies in every linked worktree; test-review evidence is stored there per
branch, so other branches' recordings never invalidate it.

Return `READY` only when the reservation (a `feature-ledger` entry under `engine: ledger`, or the claimed Cascade node under `engine: cascade`), findings, tests, docs, and implementation are all consistent, and the implementation contains no transitional path, fallback degradation, unjustified compatibility residue, missed reuse, speculative abstraction, or heavy defensive machinery. Under `engine: cascade` the branch's node should be `ACTIVE` (claimed) at preflight; at the ready→merge handoff a lane owner records completion through `scripts/cascade-lane.cjs finish --slug <slug> --token <fencing-token> --critical <evidence>`, using the identity and token returned by claim, which the merge gate then verifies. Otherwise return blocking findings first.
