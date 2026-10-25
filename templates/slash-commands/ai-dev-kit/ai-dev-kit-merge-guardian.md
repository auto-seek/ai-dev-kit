# AI Dev Kit Merge Guardian

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill and read `references/implementation-discipline.md`,
`references/review-agents.md`, and `references/loop-workflow.md`.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Run the merge gate:

```bash
bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase merge --project "{{PROJECT_PATH}}"
```

Decide whether this branch may merge back to the configured `merge_policy.target_branch`.

Block if:

- branch/worktree does not follow the project GitFlow;
- the reservation is not merge-ready: the Cascade node is not `COMPLETED`, or a deprecated ledger-mode entry is not `ready-for-review`;
- the reservation lacks a bound `docs/working/` or `docs/decisions/` document, unless explicitly waived by the user;
- the bound design/decision document is missing or contradicted by the implementation;
- reserved scope is incomplete;
- placeholder, mock, fake, or unfinished production behavior remains;
- a transitional implementation, fallback degradation, obsolete compatibility
  shim, duplicated mature capability, speculative abstraction, or heavy defensive machinery remains;
- blocking findings are open;
- the tracked `.ai-dev-kit/gate-contract.json` is missing or invalid, selected
  requirements are unfinished, or the project preflight receipt no longer matches
  exact HEAD, branch/base, index/worktree and effective configuration; commit
  first and rerun preflight, never use a merge log as replacement evidence;
- under `receipt_binding: merge-base`, there is no integrate receipt for the
  current target commit and HEAD (or its merged tree differs from
  `git merge-tree`); the single integrator runs `--phase integrate`
  immediately before `--phase merge`, one queued branch at a time;
- tests used as evidence did not pass test-review, or the content-bound per-branch
  receipt from `scripts/test-review-evidence.cjs record` no longer matches the branch,
  target base, committed/index/worktree contents, untracked test inventory or
  the reviewed checkout's tracked `.ai-dev-kit/test-scope.json` policy;
- player-visible files changed (the contract's `player_review.paths`) and there
  is no passing player review from a different session bound to the current
  commit and tree, with its workstation evidence unchanged, nor a valid owner
  waiver (`references/player-review.md`; the merge gate prints the reason,
  including `invalid waiver <file>: <why>`);
- docs or development ledgers contradict implemented behavior;
- changed or affected comments materially mislead maintainers or API users
  (cite code/contract evidence and risk per `references/implementation-discipline.md`,
  not a wording preference; the shell gate does not judge comment quality);
- commits are incoherent or do not use conventional commit style.

When the gate prints `player review: WAIVED by owner <owner> — <reason> ...`,
the change merges without a player review. Say so near the top of the verdict:
`player review: WAIVED by <owner>: <reason>` with the candidate commit, so the
merge is not mistaken for a played one.

Return `MERGE READY` or `NOT READY` with blocking findings first.
