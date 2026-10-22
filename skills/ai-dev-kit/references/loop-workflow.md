# Loop Worktree Workflow

Use this for loop mode, long-running feature work, or multiple workers collaborating in the same repository.

Resolve `merge_policy.target_branch` from the main-checkout profile before
using the GitFlow commands below. Examples call the integration trunk `dev`;
substitute the configured branch (including `main` or `master`) throughout.
Fresh bootstrap selects an existing conventional trunk. Do not create a second
integration branch merely to copy an example literally.

## Clarify Before Looping

A loop amplifies whatever it starts from: a vague goal produces many iterations of wrong or low-value work. Clarify requirements before the first iteration — a lightweight brainstorming pass — and do not start looping until the scope is concrete.

Establish from the user's request and existing approved task contract:

- the user-visible or system behavior that "done" means (acceptance criteria);
- scope and explicit non-goals;
- known constraints, dependencies, and data/contract boundaries;
- how the result will be verified (tests, flows, commands).

Reuse an already-approved scope, acceptance criteria and verification method;
do not ask for them again on each conversation or iteration. Ask only unresolved,
decision-changing gaps. When clarification is needed, use the harness's available
brainstorming skill or the smallest useful question set. The result feeds the
reservation (Goal/Scope/Non-goals/Expected tests) and bound design document
`docs/working/<slug>.md`. Only reserve and start once those requirements exist.

Implementation corrections, failing-test fixes and independent-review feedback
within that contract are normal work, not new approval requests. Scope, permission
or acceptance changes still need the relevant decision. A terminal FAILED task
uses only the center's explicitly authorized retry scope; this rule does not
permit worker graph mutation, expired-lease recovery or blind external-write retries.

### Question Quality

Apply the general question-quality rules in `asking-the-user.md` — research first, only decision-changing questions, carry your own default to confirm, concrete options, one batched round, blockers separated from discoverables. The loop layers the domain template below on top of them.

### Question Template

Resolve each dimension from available evidence; ask only the gaps. Outcome and
verification must be grounded in the request or approved contract, not invented.

1. **Outcome / acceptance** — "When this is done, what can a user or the system do that they can't today? Which single behavior proves it works?"
2. **Boundary / non-goals** — "What is explicitly out of scope for this round, so the loop doesn't sprawl?" (offer the boundary you inferred and ask to confirm)
3. **Reuse / integration** — "Is there an existing `<module/util/service you found>` I should extend instead of building new, and where does this plug in?" (name what the codegraph/search surfaced)
4. **Constraints / contracts** — "Any data shapes, APIs, compatibility, performance, or security limits this must respect?" (infer from code, confirm)
5. **Verification** — "How will we confirm each iteration is correct — which tests, flows, or commands?" (binds to `Expected tests`)


## Autonomous Target Selection (`--discovery` / `--ev`)

Both flags ask the loop to choose its own next target instead of receiving one from the user. They are concrete intents — neither is an alias for empty arguments, and neither bypasses reservation, design-doc binding, worktree isolation, subtraction cadence, test-review, findings, or merge-readiness rules. They share one selection machinery (gate, inputs, priority order, plan format) and differ only in autonomy profile:

| | `--discovery` (conservative) | `--ev` (evolution) |
|---|---|---|
| Intent | a safe next action | an aggressive self-evolution pass |
| Target size | L1/L2 only; if the best candidate is L3+ or needs product direction, stop with a planning note | L1-L5; L3+ should usually stop after reservation/design unless the user already authorized that scope; L5 never edits production code |
| Long-lived evolution state | never creates or updates | may create/update rotation or cadence state, only after the plan and only when the selected work needs it |
| Module rotation / L5 cadence targets | not eligible | eligible only when existing state files (`docs/evolve-module-rotation.md`, `.ai-dev-kit/workflow/discovery-rotation.md`, `.ai-dev-kit/workflow/evolution-cadence.md`, or a project evolution ledger) explicitly show they are due — never invented because the mode was invoked |
| Plan tag | `DISCOVERY_PLAN` | `EV_PLAN` |

### Shared Gate

Before reading backlog or choosing a target, check the tracked worktree:

```bash
git status --porcelain=v1 -uno
```

If tracked files are dirty, stop and report the dirty paths. Do not inspect for a new target and do not try to repair unrelated work. Untracked files do not block selection unless the project explicitly tracks them as workflow state.

Then record the runner and health posture (both modes — the priority order below puts a red health gate first, so both modes must actually look at it):

```text
RUNNER_DECISION runner=<autoseek|claude-code|codex|generic>
HEALTH_DECISION status=<green|yellow|red|unknown> evidence=<command or reason>
```

Use the cheapest health signal the repo declares (health-gate script, required test command, CI manifest); report `unknown` with a reason when none exists. If health is red, the first eligible target is the smallest fix that makes the gate green again — do not start speculative work while known health is red. Under `--discovery`, if that smallest fix is larger than L2, stop with a planning note instead.

### Shared Inputs

Use bounded, repository-local read-only probes. Prefer these sources, stopping as soon as one concrete candidate is clear:

1. active reservations in `docs/development/feature-ledger.md` or the fallback `.ai-dev-kit/workflow/feature-ledger.md`;
2. workflow state such as `.ai-dev-kit/workflow/findings.jsonl`, `.ai-dev-kit/workflow/LEDGER.md`, `docs/improvements.md`, and recent preflight/test-review notes;
3. recent failing or skipped project health commands declared in repo instructions or manifests;
4. TODO/FIXME/deprecated-path evidence only when it points to a small verifiable behavior change;
5. documentation drift discovered from current docs versus public entry points.

Do not wander outside the current repository, the user's home directory, `/tmp`, or the internet. External source absorption is a separate, explicitly scoped workflow and must not be silently mixed into autonomous selection.

### Shared Priority Order

Treat the feature ledger and workflow ledgers as the requirements pool: unless the health gate is red, prefer continuing an unfinished reserved requirement over inventing a new target. Choose at most one candidate, by this order:

1. red health gate or failing required command;
2. active reservation, unfinished requirement, or stale workflow ledger item;
3. accepted blocking finding — it may outrank a reservation only when fixing it is the smallest path to unblock that reservation, review, or merge readiness;
4. (`--ev` only) module rotation target, when rotation state already exists;
5. (`--ev` only) L5 strategic/planning cadence, when existing evolution state explicitly shows it is due;
6. stale documented workflow or documentation drift;
7. small missing test-backed behavior;
8. low-risk cleanup, only when it removes real confusion and has verification.

Every candidate must also satisfy all of: a user-visible, workflow, API, or documented behavior outcome; verifiable with the repository's real tests, build, lint, or a focused command; no overlap with another active reservation; representable as one `feature/<slug>` or `fix/<slug>` branch; no new product direction, license judgment, credential changes, remote service changes, or destructive cleanup.

If no candidate satisfies the rules, stop cleanly with a short candidate report: what was checked, why each candidate was rejected, and whether a planning-only follow-up would be useful.

### L1-L5 Sizing

Classify the selected target before writing:

- `L1`: small docs, comments, warnings, obvious cleanup;
- `L2`: small behavior fix, focused refactor, missing test-backed path;
- `L3`: new module/API shape or cross-module change;
- `L4`: major subsystem or architecture change;
- `L5`: planning/strategy only, producing docs and follow-up candidates.

Default to `L1` or `L2`. `--discovery` must not select above `L2`.

### Plan Before Writes

Before reserving, creating docs, creating rotation state, creating a branch/worktree, editing files, installing dependencies, committing, or pushing, print the mode's plan (`DISCOVERY_PLAN` or `EV_PLAN`) containing:

- `runner` and `health`;
- `level`: L1-L5 with rationale;
- `candidate`: the selected feature/fix/planning slug;
- `selection_evidence`: files, commands, findings, ledger entries, or rotation signals;
- `rejected_candidates`: at least the notable candidates rejected and why;
- `goal`, `scope`, and `non_goals`;
- `verification`: required commands and review gates;
- `reservation_path`, `design_doc`, `branch`, and `worktree`;
- `state_updates`: rotation or cadence files that will be created/updated; must be `none` under `--discovery`;
- `review_focus`: what the reviewer must challenge, including whether the evidence actually supports the selected target.

After the plan, the target is locked: implement it, shrink its scope, or abandon cleanly — do not switch targets without printing a new plan and explaining why the previous target was abandoned. Then continue with the normal reservation and design-document binding rules; an autonomously selected target gets no exemptions from them.

### Boundaries (both modes)

- do not auto-merge;
- do not push unless explicitly requested or the project policy already requires it;
- do not copy external project code, prompts, docs, naming, dependencies, or layout;
- do not run destructive cleanup as part of target selection;
- do not commit placeholders, mocks, unfinished paths, stale docs, or unreviewed tests.

## Branch Rules

- `dev` is the development trunk.
- Start features from `dev` as `feature/<short-name>`.
- Start fixes from `dev` as `fix/<short-name>` unless the project explicitly requires hotfix flow.
- Do not implement directly on `dev`, `main`, or `master`.
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.

## Reservation Before Work

Before implementation, reserve the feature in the development branch documentation.

Default file:

```text
docs/development/feature-ledger.md
```

Fallback:

```text
.ai-dev-kit/workflow/feature-ledger.md
```

If the reservation file does not exist, create it with a short heading and append the first entry. This doc is part of the development workflow, not optional scratch.

### Reservation Entry

```markdown
## <feature-or-fix-slug>

- Status: reserved | active | blocked | ready-for-review | merged | abandoned
- Owner: <human-or-agent/session>
- Branch: feature/<slug>
- Worktree: ../<repo>-<slug>
- Created: YYYY-MM-DD
- Goal: <what user-visible or system behavior will be complete>
- Scope:
  - <paths, modules, workflows likely touched>
- Non-goals:
  - <explicitly out of scope>
- Expected tests:
  - <test files or test flows>
- Expected docs:
  - docs/working/<slug>.md
  - <other docs that must be created or updated>
- Coordination notes:
  - <overlap, dependencies, blockers>
```

Multiple workers must inspect existing active reservations before claiming work. If another worker owns overlapping files, APIs, docs, or data contracts, pause and coordinate instead of racing.

The ledger is read in full by every worker on every claim check, so it
must stay small: as part of each `/ai-dev-kit-clean` pass, move entries
whose Status has been `merged` or `abandoned` for more than 7 days to
`docs/development/feature-ledger-archive.md` (same entry format, newest
first). The gates only inspect the live ledger; the archive is history.

## Design Document Binding

Every non-trivial loop reservation must bind to a feature design document before implementation starts.

Required path:

```text
docs/working/<feature-or-fix-slug>.md
```

If the project already has an accepted decision for the work, bind the reservation to:

```text
docs/decisions/<feature-or-fix-slug>.md
```

Rules:

- `Expected docs` must include at least one path under `docs/working/` or `docs/decisions/`.
- The bound document must exist before coding starts.
- Use `.ai-dev-kit/docs/document-template.md` when creating the document.
- The document must have frontmatter with `type`, `status`, `owner`, `created_at`, `last_verified_at`, `related_paths`, and `truth_sources`.
- Drafts and brainstorms stay in `docs/working/`; accepted decisions move to `docs/decisions/`.
- Update `.ai-dev-kit/docs/registry.yml` when creating, moving, superseding, or archiving the bound document.
- Trivial work may omit a design document only when the user explicitly approves the omission and the feature-ledger entry records `Expected docs: none - <reason>`.

Preflight and merge review must block if the reservation lacks this binding, the bound document is missing, or the document contradicts the implemented behavior.

## Worktree Setup

From a clean repository:

```bash
git fetch origin
git switch dev
git pull --ff-only
git worktree add ../<repo>-<slug> -b feature/<slug> dev
cd ../<repo>-<slug>
```

If `origin/dev` is the authoritative source and local `dev` is stale:

```bash
git worktree add ../<repo>-<slug> -b feature/<slug> origin/dev
```

## Choose Your Loop Driver

This kit defines the loop *discipline* — clarification, reservation, worktree isolation, subtraction cadence, and the preflight/merge gates — independent of any harness. It does not ship a loop engine. The agent selects the iteration mechanism its own harness provides and runs the discipline on top of it.

Pick the driver available in your runtime; this list is illustrative, not exhaustive:

- AutoSeek: its native loop runner.
- Claude Code: the `/loop` command, the ralph-loop plugin, or background tasks / scheduled wake-ups.
- Codex: its own loop/automation mechanism.
- No loop engine available: run the loop manually as a sequential cycle — reserve, implement a coherent checkpoint, commit, honor the subtraction cadence, and re-enter until the reserved scope is complete.

Whatever the driver:

- the reservation, design-doc binding, and worktree must exist before the first iteration;
- every iteration commits coherent checkpoints and keeps the reservation, design doc, tests, and findings current;
- the subtraction cadence and the preflight/merge gates apply regardless of which engine drives the iterations;
- never wire destructive cleanup or auto-merge into the loop's stop hook.

## Loop State & Idle Protocol

A loop iteration must be resumable by an agent with no memory of the
previous one (context compaction, session restart, a different worker
picking up). The ledger records requirements; it does not record position.
Keep position in `.ai-dev-kit/workflow/loop-state.md`, updated every
iteration:

```markdown
- updated_at: <ISO timestamp>
- slice: <feature-or-fix-slug or none>
- phase: selecting | reserved | implementing | verifying | merging | idle
- next_action: <the single next concrete step>
- blocked_on: <what, or none>
```

This file is effort-local workflow state (gitignored with the rest of
`.ai-dev-kit/workflow/`), costs a few lines per iteration, and turns
"where was I" from an archaeology pass over ledgers and diffs into one
read.

Idle protocol: when autonomous selection finds no eligible candidate,
record `phase: idle` with the candidate report, and after two consecutive
idle iterations back off — lengthen the loop interval, or stop and notify
the user — instead of burning an iteration per minute re-scanning an
unchanged repository. New user input, a red health gate, or repository
changes reset the idle count.

## Sizing The Ceremony (L1 micro path)

The loop's artifact set (reservation + design doc + worktree + gates) is
sized for L2+ work. For genuinely small L1 work — docs, comments, an
obvious one-file fix — the full ceremony can exceed the change itself.
The sanctioned light path:

- the ledger entry is NEVER waived (it is the concurrency mutex);
- the design doc may be waived with `Expected docs: none - <reason>`
  (the gate accepts this form);
- the worktree may be skipped only when the change is docs-only and the
  tracked trunk is clean;
- tests/gates still run when production behavior is touched.

If an "L1" grows mid-flight (touches a second module, needs a real test
contract), stop and upgrade it to the full path before continuing.

## During The Loop

- Keep `.ai-dev-kit/workflow/LEDGER.md` updated for large/risky work.
- Keep the feature-ledger entry status current.
- Keep the bound `docs/working/` or `docs/decisions/` document current with implementation reality.
- Update docs as the implementation changes reality.
- Commit coherent checkpoints on the feature branch.
- Do not commit local telemetry, scratch files, generated graph caches, or agent private state unless the project explicitly tracks them.

## Subtraction Cadence (Required)

Loop work accumulates dead, duplicate, placeholder, and low-quality code over iterations. To keep the branch elegant, a subtraction pass is **required on a cadence** — not optional cleanup whenever you feel like it.

Rule: at most **N commits** (default 10, configurable) may land on a feature branch without a recorded `/ai-dev-kit-clean` pass (see `references/subtraction.md`). The preflight and merge gates enforce this: they FAIL when commits since the last recorded clean exceed the threshold, so a reservation cannot reach `ready-for-review`/merge with overdue subtraction debt.

After each `/ai-dev-kit-clean` pass, append one line to `.ai-dev-kit/workflow/subtraction-log.md` recording the date and HEAD commit:

```text
- YYYY-MM-DD | commit: <sha> | branch: <branch> | scope: <scope> | mode: <mode>
```

Run the pass on the feature branch itself, against its own diff: the gate counts only records for the branch it checks. A pass that finds no candidates is valid and quick — record it with `(none)` in `scope:` and stop rather than inventing work (see `references/subtraction.md`, "No-candidate pass").

The gate only **checks** this log; it never deletes. Destructive deletion stays the explicit, evidence-gated `/ai-dev-kit-clean` pass and must never run inside the loop's stop hook. The threshold is set per project in `.ai-dev-kit/profile.yml` (`subtraction.every_commits`, scaled by enforcement profile: light 15 / balanced 10 / strict 5) and resolves as `--subtraction-threshold <n>` > `AI_DEV_KIT_SUBTRACTION_THRESHOLD` > profile > default 10. Disable with threshold 0, `AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1`, or `subtraction.gate_enabled: false`.

## Parallel Workers

- Read-only workers may share a worktree.
- Parallel editing workers must use separate worktrees.
- Do not let two workers edit the same file set unless one is explicitly the integrator.
- Worker output must name changed paths, verification evidence, unresolved risks, and docs touched.

## Exclusive Resources And Retryable Blocks

Some verification needs a resource only one process may use at a time: a single
GUI game-engine instance, a display used for screenshots, a device, a
license-limited tool. With many agents, a non-blocking lock that exits "busy, try
next round" turns every agent into a spinner. Project wrappers should queue on the
kit's `scripts/resource-lock.cjs` instead:

```bash
node "<kit>/scripts/resource-lock.cjs" run --name godot --label "feature/<slug> visual pass" \
  --wait 1800 -- <verification command...>
```

- One queue per project: tickets live in the main checkout's shared state root
  (`.ai-dev-kit/locks/<name>/`, which ignores itself in Git) and resolve the same
  way from every linked worktree. `--project <dir>` selects the project; `--root`
  is for tests.
- Waiters are served in arrival order and poll with backoff of at most one second.
  `run` starts the command in its own process group, forwards SIGINT/SIGTERM/SIGHUP,
  stops leftover descendants when the command exits, releases, and exits with the
  command's code (128+N after signal N, 127 when it cannot start).
- Still queued after `--wait` seconds (default 1800; `0` tries once, `inf` waits
  forever): exit 75 without running the command and without leaving a ticket. Keep
  `--wait` below any outer deadline (for example the gate contract's
  `preflight.timeout_seconds`) so the caller sees 75 instead of a timeout kill.
- Wrap the outermost entrypoint only. The lock is not re-entrant: a nested `run`
  or `acquire` of the same resource (compared by real path, so symlinked roots
  count) from inside the guarded command exits 2 instead of deadlocking on itself.
- Hand-off between waiters polls with backoff of up to about 1s, so the lock suits
  engine- or GUI-scale jobs (seconds to minutes), not thousands of tiny ones.
- Shell scripts that cannot wrap one command use a token:

  ```bash
  token=$(node "<kit>/scripts/resource-lock.cjs" acquire --name godot --owner-pid $$) || exit $?
  trap 'node "<kit>/scripts/resource-lock.cjs" release --name godot --token "$token"' EXIT
  ```

- Reclaim: a ticket whose owner pid is gone on the same host is reclaimed at once,
  unless its command's process group is still alive (an orphaned engine keeps the
  lock). A ticket not refreshed within `--max-hold` seconds (default 3600) is
  reclaimed on any host. `run` refreshes its ticket while it waits and runs; an
  `acquire` ticket is never refreshed, so max-hold is its lease, and without
  `--owner-pid` the lease is the only way it expires.
- `status --name <res> [--json]` lists the holder and queue with labels, pids,
  worktree paths and ages, plus any stale tickets.
- Limits: the shared state root must be on a local filesystem; macOS/Linux only.
  This is cooperative exclusion: processes that bypass the wrapper are not
  constrained, so checks such as "no leftover engine process" stay inside the
  guarded command.

### Workstation Pools

A GUI check that can run on a private virtual screen (a Linux workstation
container, see the kit's `templates/workstation/README.md`) does not need the
host screen. Declare a pool of interchangeable workstations so agents run such
checks in parallel; keep the exclusive lock (for example `--name godot`) for work
that needs the host screen. Pools and locks are independent, even with the same
name.

Declare pools in the tracked `.ai-dev-kit/workstations.json`, read from the main
checkout (relative paths resolve against the project root):

```json
{
  "schema_version": 1,
  "warn_hold_seconds": 1800,
  "pools": {
    "godot": {
      "image": "example/workstation-godot:1",
      "build": { "dockerfile": "tools/workstation/Dockerfile" },
      "slots": 3, "cpus": 3, "memory": "2.5g", "screen": "3840x2160x24",
      "mounts": [{ "source": "~/.nuget/packages", "target": "/nuget-fallback", "readonly": true }],
      "env": { "NUGET_FALLBACK_PACKAGES": "/nuget-fallback" },
      "start": ["godot", "--path", "Game", "--audio-driver", "Dummy",
                "--rendering-method", "forward_plus", "--rendering-driver", "vulkan", "--"],
      "timeout_seconds": 1800, "max_hold_seconds": 3600
    }
  }
}
```

- `image` is required; `build` builds it when it is missing (bump the tag when
  the Dockerfile changes). `start` is the argv every run begins with. Defaults are
  3 slots of 3 CPUs and 2.5g each (three 4K Godot runs fit an 8 GB Docker VM),
  `screen` 1920x1080x24, `user` `"host"` (run as your uid), `min_free_disk` 5g,
  `timeout_seconds` 1800, `max_hold_seconds` 3600, `warn_hold_seconds` 1800.
- A claim exits 2 with the numbers when slots × memory over all pools exceeds the
  memory Docker can use, or `cpus` exceeds Docker's CPUs; other configuration
  errors also exit 2 and name the setting.

```bash
# One run: claim, run start + args on the workstation's screen, release.
node "<kit>/scripts/resource-lock.cjs" run --pool godot --wait 1800 -- --panels /ws/out/panels

# Several steps (screenshots, injected input): claim, use, release.
out=$(node "<kit>/scripts/resource-lock.cjs" claim --pool godot --owner-pid $$ --label "feature/<slug>") || exit $?
token=$(printf '%s\n' "$out" | sed -n 's/^token=//p')
ws=$(printf '%s\n' "$out" | sed -n 's/^workstation=//p')
docker exec "$ws" ws-run --timeout 1800 -- <start...> <args...>
docker exec "$ws" ws-shot /ws/out/now.png
node "<kit>/scripts/resource-lock.cjs" release --pool godot --token "$token"
```

- `claim` prints `token`, `slot`, `workstation` (the container), `out` (the
  evidence directory mounted at `/ws/out`) and ready `exec`, `renew` and `release`
  commands (`--json` for one JSON object). The worktree is mounted at its own
  path and is the working directory.
- Queueing is the lock's: first come, first served, `--wait` then exit 75 without
  a ticket. Holders do not block waiters; at most `slots` are held.
- Only the claim's token renews or releases it. Status never prints tokens, and
  an old token cannot release the workstation that was handed on.
- Every claim starts a new container from the image; release and reclaim remove
  it. Nothing from an earlier holder survives.
- Reclaim: a claim whose `--owner-pid` is gone, or a `run` whose runner is gone
  once its `docker exec` has ended, is reclaimed at the next claim. So is a claim
  not renewed within its lease (`--max-hold`, default `max_hold_seconds`), even if
  its owner still runs: that reclaim is printed, logged in the pool's
  `reclaimed.jsonl` and shown by status, and the late holder's `renew`/`release`
  says it was reclaimed. Agents whose shell ends between tool calls claim without
  `--owner-pid` and call `renew` within the lease.
- `status --pool <pool> [--json]` lists each workstation's holder, hold time and
  remaining lease, waiters and how long they have waited, a reminder when a hold
  exceeds `warn_hold_seconds` (`--warn-hold <s>` overrides), recent reclaims, and
  Docker's memory fit and containers that no slot holds. `status` without
  `--name`/`--pool`, and `skill-first-gate.sh --phase status`, list every lock and
  pool of the project on this machine. Nothing is reported to the center.
- Disk: workstations share the image and bind-mount the agent's own checkout, so
  assets and engine import caches are never copied into Docker; each running
  workstation adds only its writable layer (about 4 MB measured for a 4K Godot
  run). Before a claim, `claim` and `run` check that Docker's disk and the host
  disk both have `min_free_disk` free (on Docker Desktop the VM disk is a sparse
  file on the host disk) and otherwise exit 75 without a ticket. `status --pool`
  shows Docker's used and free space, the image, each workstation's writable
  layer and the evidence directories' allocated size, all as actual use (df,
  allocated blocks), not apparent file sizes.
- `prune --pool <pool> [--dry-run] [--evidence-days <n>]` removes workstation
  containers that no slot holds, images the pool built (`build`) that are no
  longer configured and no container uses, and, with `--evidence-days`, evidence
  directories of claims that are no longer held and older than n days. It never
  removes a held workstation, an image it did not build, or project files;
  clean checkouts and build output with the project's own tools.
- Checkouts: a new checkout does not need its own engine import. Clone the
  import cache of an already-imported checkout of the same asset version
  copy-on-write (`cp -c -R` on APFS, `cp --reflink=always -R` on Btrfs/XFS) and
  let the engine verify it; measured for Godot 4.7: macOS and Linux imports are
  byte-identical, the clone costs about 1 MiB of real disk, and the follow-up
  import finishes in about 4 s without rewriting anything.

### Exit 75 means BLOCKED (retryable)

Exit code 75 (`EX_TEMPFAIL`) means the work did not run because a shared
resource was busy; it is not a verdict on the change. Project wrappers and
preflight commands should return 75 only for that case and keep real failures on
other non-zero codes. Agents treat 75 as "retry later": record `blocked_on` in
loop state, back off, and retry, rather than "fixing" a red result. Declare the
code in the gate contract's `preflight.blocked_exit_codes`: a listed exit code from
the project argv (or a failed environment self-check such as low disk) is reported
as `BLOCKED (retryable)`, writes no receipt, and is never a pass. The gate still
exits 2 by default so harness hooks stay blocking; loop runners pass
`--blocked-exit-code 75` (or set `AI_DEV_KIT_BLOCKED_EXIT=75`) to tell BLOCKED apart
from FAIL. See `docs/team-gate-migration.md`. A contract without the field reports
75 as an ordinary failure.

## Scaling To Many Agents

Checklist before running dozens of agents against one repository:

- **Per-branch receipts.** One task, one branch, one owner. Preflight receipts
  are keyed by branch and test-review evidence is bound to its branch, so two
  agents sharing a branch overwrite or revoke each other's evidence.
- **Per-task files instead of shared ledgers.** Put task detail in per-task files
  (`docs/working/<slug>.md`, the task's own requirements section) and keep shared
  ledgers to one short entry per task. Many agents appending to one region of one
  file serialize on merge conflicts.
- **A single integrator.** One agent or human merges into the target branch, one
  candidate at a time, rerunning the merge gate on the updated base. Workers
  deliver branches; they do not merge.
- **Queued exclusive resources.** Every scarce resource goes through
  `resource-lock.cjs`; 75 means retry later, not failure. Move GUI checks that do
  not need the host screen to a workstation pool so they run in parallel.
- **Read-only roles do not need worktrees.** Reviewers, researchers and status
  checkers read an existing checkout (or `git show <ref>:<path>`); only editing
  workers get a worktree.
- **Disk headroom.** Each worktree duplicates the tree plus its dependencies and
  build caches (`node_modules`, virtualenvs, engine import caches). Budget for
  the peak worktree count, keep free space for builds, and remove merged
  worktrees promptly (`git worktree remove`, then `git worktree prune`).

## Merge Back To Dev

Merge only complete, reviewed functionality.

Required before merge:

- reservation status is `ready-for-review`;
- implementation is complete for the reserved scope;
- no production placeholder, fake, mock, or unfinished path remains;
- tests passed and test-review accepted the tests used as evidence;
- docs reflect actual behavior;
- the bound design/decision document exists and matches the implemented behavior;
- blocking findings are closed or explicitly deferred by the user;
- branch is up to date with `dev`;
- merge can be fast-forwarded or reviewed according to project policy.
