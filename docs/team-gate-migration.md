---
type: runbook
status: active
owner: ai-dev-kit-maintainers
created_at: 2026-09-07
last_verified_at: 2026-10-06
related_paths:
  - scripts/skill-first-gate.sh
  - scripts/project-gate-evidence.cjs
  - tests/team-gate-contract.test.cjs
truth_sources:
  - scripts/project-gate-evidence.cjs
  - tests/team-gate-contract.test.cjs
---

# Team gate migration

Preflight now executes the project's actual validation command. Merge requires
a matching, successful preflight after the final commit. Old gate-log entries,
the former three-commit allowance and `gate.require_preflight_receipt: false`
cannot authorize a merge. Stop stays light: it does not run project validation
or query coordination.

## Declare the project contract

Create and stage `.ai-dev-kit/gate-contract.json` in the reviewed checkout:

```json
{
  "schema_version": 1,
  "base_ref": "dev",
  "requirements": {
    "mode": "task-sections",
    "ledger": ".ai-dev-kit/workflow/LEDGER.md"
  },
  "preflight": {
    "argv": ["bash", "eng/ai-dev-kit/team-preflight.sh"],
    "timeout_seconds": 900
  }
}
```

Use the project's real target ref, not an example branch created to satisfy
the tool. Missing refs, missing/invalid contracts, unresolved index conflicts,
symlink contracts and unstaged new contracts fail. Existing configuration is
not overwritten. The new contract must be reviewed with the code; declaring a
weaker command is not a substitute for satisfying the project's requirements.

`argv` is a literal argument array, executed without shell expansion in the
reviewed checkout. If shell behavior is needed, use an explicit checked-in
wrapper. The wrapper must invoke the real project health gate and preserve its
failure. For example, a project whose existing gate requires a baseline and a
verified scanner can use:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT_BASELINE_REF:?set the explicitly selected baseline ref}"
: "${VERIFIED_GITLEAKS:?set the verified scanner executable path}"
exec bash eng/ai-dev-kit/preflight.sh "$PROJECT_BASELINE_REF" "$VERIFIED_GITLEAKS"
```

Those environment values are operator inputs: the Kit does not discover a
scanner, approve its provenance, guess a baseline, or expand variable templates.
Do not put secrets in tracked argv. An old `profile.preflight.entrypoint` does
not run by itself; migrate it to this explicit command contract. There is no
command or missing-configuration fallback.

Commands have a deadline and a two-second termination grace period. Cancellation
and timeout terminate the POSIX command group; background processes remaining
after the command exits are killed. Missing executables and nonzero exits
fail preflight. Command output stays in a mode-600 log under the shared
`.ai-dev-kit/workflow/preflight/` directory; the gate prints the log path rather
than potentially sensitive subprocess output. Review that private log for the
actual error. The runner is not a sandbox: execute only project commands and
dependencies you are authorized to run.

## Bind requirements without rewriting history

Under `task-sections`, a task branch is `<owner-or-type>/example-task`: exactly
one prefix segment (`fix/`, `codex/`, an agent id) followed by the canonical task
id. `fix/example-task`, `codex/example-task` and `alice/example-task` all require
exactly one `## example-task` section in the declared ledger; a third segment
such as `codex/example-task/worker-1` is rejected. The file is read from the
reviewed checkout, not another worktree.
It must contain concrete checkbox requirements. Open `[ ]` items, missing or
duplicate sections and empty sections block readiness. Only actually verified
items become `[x]`; deferred `[~]` items require `deferred: <reason> | owner:
<identity>` following user approval.

```markdown
## example-task

- [x] The project command validates the changed behavior and its error path.
- [x] The independent test review is complete.
```

`global` is a separate explicit mode which checks the entire declared ledger.
It is appropriate when every requirement in that file belongs to the current
delivery. There is no inference from `abandoned`, `blocked`, dates or another
owner's name. A project opting into task sections must review that scoping
decision; old global requirements cannot disappear through an implicit default.
Preserve historical records and their actual unresolved/cancelled status. The
global critical/high findings gate remains in force regardless of ledger mode.

## Preflight and handoff

Commit the final code, tests, configuration and documentation first. Review
tests and record their content-bound approval, then run:

```bash
bash <kit>/scripts/skill-first-gate.sh --phase preflight --project .
```

Preflight revokes this branch's previous receipt at the beginning. Only after
the Kit checks and the project command succeed is a new receipt written. A
failed rerun cannot leave an earlier success usable. The snapshot must also
remain unchanged during execution; formatters or generators which change
inputs require inspection and another validation run.

The receipt binds the branch, explicit target ref and its commit, merge base,
exact HEAD, committed/index/worktree content, Git-visible untracked files,
executable modes, selected requirements and shared main profile/local-profile
hashes (merge-queue mode drops the target commit; see below). No filename extension or language is excluded. Gitignored untracked
outputs and the reserved `.ai-dev-kit/workflow/` control directory are not
production inputs; do not store production source there. The selected ledger
content is separately bound even when the file is inside that directory.
Changed or dirty gitlinks require independent child-repository validation.

Receipt files are branch-specific, stored in the main checkout's shared
workflow directory. A linked worktree uses its own contract, ledger and project
command, while retaining the shared profile and evidence location. The receipt
contains content hashes, not the contents of a local credentials overlay.

Finish the Cascade task with the claimed owner and fencing token, then run:

```bash
bash <kit>/scripts/skill-first-gate.sh --phase merge --project .
```

Merge rechecks requirements, coordination, test review and subtraction, and
requires the same preflight snapshot. It does not rerun the project command or
issue its own authorization receipt. A new commit, staged-only edit, untracked
source, changed configuration or moved target ref requires fresh preflight
(in merge-queue mode a moved target requires a fresh integrate instead).
Do not append a docs-only commit after preflight and assume it is exempt.

Receipts are local workflow evidence, not signed attestations or protection
against someone with permission to rewrite the repository and evidence. They
bind Git-visible inputs and configured policy, not arbitrary external services,
environment changes or mutable tools outside the checkout. Keep provenance and
environment checks in the project's real validation command.

## Subtraction across workers

The existing flat `subtraction:` profile block retains `every_commits` and
`gate_enabled`. Only that block is read. Invalid thresholds and booleans fail;
they are not replaced with defaults. Precedence remains CLI threshold, then
`AI_DEV_KIT_SUBTRACTION_THRESHOLD`, profile, then the documented default of 10.
An explicit zero, `gate_enabled: false`, or
`AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1` is reported as disabled, not mistaken for
evidence that a clean pass occurred.

Debt starts at the configured target merge-base. A recorded clean must name the
current branch and a resolvable ancestor commit; the most recent applicable
record is selected from the whole shared log. Another worker's append cannot
erase it. Older trunk or unrelated-branch passes do not charge inherited trunk
history to a fresh branch. Log only a real reviewed pass:

```text
- YYYY-MM-DD | commit: <commit-sha> | branch: codex/example-task | scope: <reviewed scope> | mode: propose
```

The gate measures cadence; it does not validate the human review narrative or
delete anything. Subtraction still requires the existing evidence-based clean
workflow, including what was inspected and deliberately retained.

## Options for many parallel agents

Every option in this section is opt-in. A contract without these keys behaves
exactly as described above; unknown keys are still rejected.

### Retryable BLOCKED results

A project command that serializes an exclusive resource (one GPU, one game
engine lock, one device) should not turn "resource busy" into a failed
verification. Declare the exit codes that mean "not attempted, try again":

```json
"preflight": {
  "argv": ["python3", "scripts/preflight_gate.py"],
  "timeout_seconds": 900,
  "blocked_exit_codes": [75]
}
```

When the command exits with a listed code, the gate prints
`BLOCKED (retryable): <reason>`, writes no receipt (the branch's previous
receipt was already revoked at the start of preflight), logs `blocked` in
`gate-log.jsonl` and exits 2. Exit 2 keeps harness hooks blocking exactly as for
FAIL. A loop runner that wants to distinguish the cases passes
`--blocked-exit-code <n>` (or sets `AI_DEV_KIT_BLOCKED_EXIT=<n>`; the flag wins)
and requeues on that code. `<n>` must be an integer from 1 to 255 (0 would make
BLOCKED look like a pass and is rejected). Only `preflight` and `integrate` read
the flag and the variable; `stop`, `merge` and `status` ignore them, so a loop
runner's environment can never break those phases. Every other nonzero exit,
timeout or cancellation stays a FAIL. Only declare codes your wrapper actually
reserves for contention; a test runner that also uses the code for real
failures would hide them.

### Per-task verification arguments

Do not rewrite the shared contract's `argv` for each topic: parallel branches
then conflict on one file. Keep the stable command in the contract and put the
topic-specific selection in one tracked file per task:

```json
"preflight": {
  "argv": ["python3", "scripts/preflight_gate.py"],
  "timeout_seconds": 900,
  "task_args": { "dir": ".ai-dev-kit/tasks", "required": false }
}
```

The task id comes from the branch exactly as in `task-sections`
(`<owner-or-type>/<task-id>`). If `<dir>/<task-id>.json` exists it must be
`{"args": ["--test", "tests/test_example.py"]}`; those literal strings are
appended, in order, after the stable argv. A malformed file fails. A missing
file (or a branch without the task shape) fails only when `required` is true;
`dir` defaults to `.ai-dev-kit/tasks` and `required` to false. The file must be
tracked (in the index, normally committed): an untracked or ignored task file
fails with "commit the task args file", because the integrate checkout only
contains committed files and would otherwise run a narrower command. Do not
put `dir` under an ignored directory. The file is a normal reviewed input: its
content is part of the receipt snapshot, and the parsed args are additionally
bound as `task_args`, so editing it after preflight stales the receipt.
Integrate fails unless the merged checkout's task args equal the ones the
branch receipt bound. Review the selection with the code; the gate does not
judge whether the selected tests cover the change.

### One requirements file per task

`task-sections` keeps every task in one ledger, so parallel branches edit the
same file and conflict at merge. `task-files` uses the same branch-to-task
binding and checkbox rules, but reads `<dir>/<task-id>.md`:

```json
"requirements": { "mode": "task-files", "dir": "docs/tasks" }
```

`dir` defaults to `docs/tasks`; `ledger` is not accepted in this mode, and
`dir` is not accepted in the others. The whole file is the task's section:
headings are allowed, fenced examples are ignored, it must contain concrete
checkboxes, `[ ]` blocks readiness and `[~]` needs the same deferral note. A
missing file fails. Other tasks' files never affect this branch. Keep the files
after merge as the historical record, or delete them in a reviewed change.

### Read-only status and environment self-check

An orchestrator needs to know which branches lack or have stale receipts
without rerunning anything:

```bash
bash <kit>/scripts/skill-first-gate.sh --phase status --project . [--all] [--json]
```

Status never revokes or writes receipts, logs or locks, does not apply the
findings gate, and exits 0 unless the gate itself crashes. For the current
branch it reports the preflight receipt as `missing`, `invalid`, `fresh` or
`stale` and names the snapshot keys that differ (for file lists, up to five
paths, for example `worktree (src/app.py)` or `base_ref_commit`), the selected
requirements, subtraction debt, the test-review result (from the
`test-review-evidence.cjs check` CLI, run as a subprocess) and a merge-readiness
summary with its reasons. `--all` adds every local branch that has a receipt:
branches checked out in some worktree get the full report from that checkout;
branches without a checkout are compared only by branch HEAD, merge base and
target binding and reported as `unverified` when those still match. `--json`
prints the same report as one JSON document. Coordination state and design
bindings are not queried; `--phase merge` remains the authority. Status also
lists the project's exclusive locks and workstation pools on this machine
(holders, hold times, waiters and how long they waited, long-hold reminders)
without changing them or querying Docker; nothing is reported to the center.

The environment self-check runs in status and immediately before preflight and
integrate run the project command: node must be on `PATH`, and the volume
holding the shared state root must have at least `AI_DEV_KIT_MIN_FREE_MB` MiB
available (default 1024; `0` disables the disk threshold; an invalid value
fails rather than falling back). A failing check before preflight or integrate
is BLOCKED (retryable) with the reason, using the same exit-code rules as
above, and the project command does not start. This catches the classic
night-loop stall of a full disk or missing runtime as a retryable condition
instead of a red verification. FUSE, network and some container volumes can
report zero or misleading free space through `statfs`; if the check blocks on
such a volume although space is available, set `AI_DEV_KIT_MIN_FREE_MB=0` for
that environment.

### Merge-queue mode: `receipt_binding: merge-base`

By default (`"receipt_binding": "target"`, or the key absent) the receipt binds
the target ref's commit, so every merge into the target stales every other
ready branch and each one reruns preflight: with N ready branches that is
O(N²) project runs. Merge-queue mode splits the evidence in two:

- The branch preflight receipt omits the target commit. It still binds the
  merge base, exact HEAD, index, worktree, untracked inputs, requirements,
  task args and the shared profile hashes, so it stays fresh while other
  branches land and goes stale only when this branch's own inputs change.
- `--phase integrate` proves the branch against the target as it is now. It is
  accepted only in merge-base mode and requires a fresh branch receipt and the
  same requirements/coordination/test-review checks as merge. Under an
  exclusive lock it creates a temporary detached worktree at the current
  target commit, merges the branch HEAD with `--no-ff --no-edit` (a conflict
  fails with "rebase required"), runs the merged checkout's preflight argv plus
  its task args there (which must equal the task args the branch receipt
  bound), and writes an integrate receipt bound to the target commit, branch
  HEAD and merged tree. The temporary worktree is always removed, on success,
  failure or cancellation. The project command must leave the merged
  checkout's Git-visible inputs unchanged and the target and branch must not
  move while it runs.
- The integrate checkout is a fresh `git worktree add --detach`: it contains
  committed files only. Ignored or untracked files of the branch checkout
  (virtualenvs, `node_modules`, `.env`, build caches, generated fixtures) are
  absent and submodules are not initialised. The project command must
  bootstrap what it needs or reference shared tooling by absolute path; it
  must not depend on state that only exists in a worker's checkout.
- The lock is the directory `.ai-dev-kit/workflow/integrate.lock` in the shared
  state root, installed atomically with an `owner.json` (token, pid, host,
  branch). The holder refreshes the owner file's mtime as a heartbeat. A lock
  is stale once that lease expires (`AI_DEV_KIT_INTEGRATE_LEASE_SECONDS`,
  default 7200, minimum 60) or immediately when its pid is gone on the same
  host; a live holder reports BLOCKED. Recovery renames the stale lock to a
  tombstone named after its owner token, so integrators racing to recover the
  same stale lock cannot both win and a fresh lock is never moved or restored.
  Tombstones are swept after one lease. Anything other than a directory at the
  lock path fails until it is removed.
  Release moves the lock aside before checking its owner, so a holder whose
  lease expired never removes a successor's lock. The heartbeat cannot fire
  while a synchronous git step (worktree add, merge) runs, so keep the lease
  well above the longest such step on your repository.
- In merge-base mode `--phase merge` requires both a fresh branch receipt and
  an integrate receipt for the current target commit and HEAD, and recomputes
  the merge with `git merge-tree --write-tree <target> <HEAD>`; the tree must
  equal the receipt's `merged_tree`. This needs git 2.38 or newer: older git
  fails the merge gate with an explicit message rather than skipping the
  check. Any target movement after integration requires integrating again.

The intended flow has many workers and one integrator:

1. Each worker commits, records test review and runs `--phase preflight` in its
   own worktree, then finishes its coordination task and enqueues the branch.
   Target movement no longer invalidates this work.
2. One integrator takes queued branches strictly one at a time. For the queue
   head it runs, from that branch's checkout,
   `skill-first-gate.sh --phase integrate --project <branch-checkout>`, then
   `--phase merge`, then performs the actual `git merge --no-ff` into the
   target from the main checkout (the resulting tree should equal the receipt's
   `merged_tree`). Only the queue head ever verifies against the latest target.
3. A conflict sends the branch back to its worker for a rebase (which changes
   HEAD and therefore needs a new preflight). BLOCKED means retry later.

Do not run several integrators in parallel: the lock makes them wait rather
than race, and each merge would anyway stale the others' integrate receipts.
Each landing costs one integrate run (plus reruns when a conflict or failure
sends a branch back), instead of a fresh preflight on every ready branch after
every landing.

Example contract for a many-agent setup:

```json
{
  "schema_version": 1,
  "base_ref": "main",
  "receipt_binding": "merge-base",
  "requirements": { "mode": "task-files", "dir": "docs/tasks" },
  "preflight": {
    "argv": ["python3", "scripts/preflight_gate.py"],
    "timeout_seconds": 900,
    "blocked_exit_codes": [75],
    "task_args": { "dir": ".ai-dev-kit/tasks", "required": true }
  }
}
```

With this contract a task branch `agent-17/fix-save-crash` adds
`docs/tasks/fix-save-crash.md` (its checkboxes) and
`.ai-dev-kit/tasks/fix-save-crash.json` (its test selection) and never edits a
shared file; the wrapper exits 75 when its exclusive resource is busy; a loop
runner uses `--blocked-exit-code 75` to requeue, `--phase status --all --json`
to find branches that need work, and a single integrator to land them.

## Implementation and verification boundary

The implementation reuses `project-state.cjs` for worktree ownership, Git's
tree/index/blob contracts, Node's JSON/crypto/filesystem APIs and POSIX process
groups. The prior test-review snapshot supplied the existing content-binding
pattern. A tracked JSON contract avoids adding a bespoke YAML parser or runtime
dependency to bootstrap-installed scripts. Only the existing flat subtraction
scalar block is read from YAML; it is not a general YAML configuration engine.

`tests/team-gate-contract.test.cjs` uses real disposable Git repositories and
real external validation scripts. It tests observed failures, not a fake
project validator or mocked storage. Existing coordination and test-scope
suites remain separate gates and must also pass after their fixture enrollment.
