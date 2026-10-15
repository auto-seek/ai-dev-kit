---
name: ai-dev-kit-merge-guardian
description: "User-invoked ai-dev-kit merge guardian workflow. Use when the user invokes /ai-dev-kit-merge-guardian or asks whether a feature branch can merge back to dev under ai-dev-kit loop rules."
---

# AI Dev Kit Merge Guardian

Use the `ai-dev-kit` skill first, then read
`../ai-dev-kit/references/implementation-discipline.md`,
`../ai-dev-kit/references/review-agents.md`, and
`../ai-dev-kit/references/loop-workflow.md`.

Arguments:

```text
$ARGUMENTS
```

Run the configured merge gate when the repository has ai-dev-kit installed:

```bash
bash <ai-dev-kit-path>/scripts/skill-first-gate.sh --phase merge --project .
```

Decide whether this branch may merge back to the configured `merge_policy.target_branch`.

Block if:

- branch/worktree does not follow the project GitFlow;
- the reservation is not marked ready: under `engine: ledger`, a `feature-ledger` entry not `ready-for-review`; under `engine: cascade`, the branch's node is not `COMPLETED` — lane owners finish through `scripts/cascade-lane.cjs finish --slug <slug> --token <fencing-token> --summary <report> --critical <evidence>`, using the identity and token returned by claim (the merge gate FAILs until the node is COMPLETED);
- the reservation lacks a bound `docs/working/` or `docs/decisions/` document, unless explicitly waived by the user;
- the bound design/decision document is missing or contradicted by the implementation;
- reserved scope is incomplete;
- placeholder, mock, fake, or unfinished production behavior remains;
- a transitional implementation, fallback degradation, obsolete compatibility
  shim, duplicated mature capability, speculative abstraction, or heavy defensive machinery remains;
- blocking findings are open;
- the tracked `.ai-dev-kit/gate-contract.json` is missing or invalid, selected
  requirements are unfinished, or the content-bound project preflight receipt
  does not match the exact current HEAD, branch/base, index/worktree and effective
  configuration; commit first, then rerun preflight, never use a merge log as proof;
- under `receipt_binding: merge-base`, there is no integrate receipt for the
  current target commit and HEAD (or its merged tree differs from
  `git merge-tree`); the single integrator runs `--phase integrate`
  (temporary merge onto the current target plus the project command) immediately
  before `--phase merge`, one queued branch at a time;
- tests used as evidence did not pass test-review, or the content-bound per-branch
  receipt from `scripts/test-review-evidence.cjs record` no longer matches the branch,
  target base, committed/index/worktree contents, untracked test inventory or
  the reviewed checkout's tracked `.ai-dev-kit/test-scope.json` policy;
- docs or development ledgers contradict implemented behavior;
- changed or affected comments materially mislead maintainers or API users
  (cite code/contract evidence and risk per `implementation-discipline.md`, not
  a wording preference; the shell gate does not judge comment quality);
- commits are incoherent or do not use conventional commit style.

When a decision needs a user waiver (e.g. a design-doc omission) or a finding deferral, ask per `../ai-dev-kit/references/asking-the-user.md` — surface the specific blocker and your recommended call, not an open-ended prompt.

Return `MERGE READY` or `NOT READY` with blocking findings first.
