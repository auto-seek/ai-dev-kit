# Quick Checklist (the 90% path)

Compact operating card for a normal reserved slice. Deep rules and
rationale live in the other references — read them when a step is
ambiguous or contested, not on every iteration.

## Per slice

1. Check active claims: `cascade list-nodes` (engine=cascade, 0.8.0+) —
   no overlap. (Deprecated ledger mode: read
   `docs/development/feature-ledger.md`; migrate via
   `/ai-dev-kit-cascade-init`.)
2. Reserve: in the default self-serve role use `scripts/cascade-lane.cjs add
   --slug <slug> [--required-tier lite|pro|max]`, producing
   canonical `<slug>` with native `reserved_for=<agent>` (Cascade >=0.7.0).
   An orchestrator instead publishes shared DAG nodes for a
   worker pool. L1 may waive the design doc (`none - <reason>`).
3. Bind `docs/working/<slug>.md` with full frontmatter (skip only under
   an L1 waiver).
4. Worktree from the configured `merge_policy.target_branch`:
   `git worktree add ../<repo>-<slug> -b feature/<slug> <target-branch>`.
   Any single prefix segment works (`fix/<slug>`, `codex/<slug>`, `<agent-id>/<slug>`);
   the gate binds the second segment to the task.
5. Before code, apply `implementation-discipline.md`: search existing project
   and mature dependency/framework capabilities; record the reuse decision;
   reject transitional paths, fallback degradation, obsolete compatibility,
   speculative abstraction, and heavy defensive machinery.
6. Implement with tests and plain, accurate comments for maintainers. Explain
   non-obvious constraints, not the edit history or obvious code; preserve API
   docs and required directives. Contract assertions pin literals — never derive
   the expected value from the implementation's own constants.
   If the slice adds or changes user-facing text, apply `plain-language.md`:
   delete text the user doesn't need, then list the remaining strings for review.
7. Commit, THEN mutation spot-checks (2-3 hand mutations must go red;
   `git checkout` in the loop destroys uncommitted work).
8. Validate the reviewed checkout's tracked `.ai-dev-kit/test-scope.json` against
   the actual test layout; configure and stage it if absent (never guess from
   language). Review scope changes plus committed, staged, unstaged and untracked
   test changes against the target branch.
   Set the named review verdict to `approved`, then bind it to the actual content
   with `node <kit>/scripts/test-review-evidence.cjs record --project . --report <narrative.md>`
   (stored per branch, so other branches' reviews stay valid).
   Read the tracked `gate-contract.json` and its selected requirements; commit
   all final code/docs, then run `--phase preflight`. It executes the declared
   project argv and writes the exact-HEAD/content receipt merge requires.
   A later commit or input/config change requires preflight again.
9. Finish the claimed Cascade node with the same agent/fencing token and
   verification evidence; run `--phase merge`; merge from the MAIN repo
   (never from inside the worktree being removed); remove the worktree.
10. Respect the subtraction cadence — record `/ai-dev-kit-clean` passes in
   `.ai-dev-kit/workflow/subtraction-log.md` before debt exceeds the
   threshold.

## L1 micro path

For genuinely small work (docs, comments, one-file obvious fix): a Cascade
reservation is still required (it is the mutex), the design doc is waivable
via `none - <reason>`, and the worktree is optional when the change is
docs-only and the trunk is clean. Everything else above still applies.

## Delegation

Coordinator reserves/merges; delegates implement in worktrees and never
mutate shared coordination state. Full protocol: `delegation.md`.

## Loop iterations

Update `.ai-dev-kit/workflow/loop-state.md` every iteration (see
`loop-workflow.md` "Loop State & Idle Protocol"). Two consecutive
no-candidate iterations → back off instead of spinning.
