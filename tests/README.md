# tests/ — cascade coordination test net

Repo-internal test suite (not shipped to plugin users). It guards
`scripts/skill-first-gate.sh`'s cascade coordination branch — the highest-risk
shell in the kit — against regressions, and gives the cascade write-loop work a
foundation to build on.

## Run

```bash
npm test          # scope + team contracts + full shell gate suite
npm run test:fast # skip the shell suite's explicit timeout case
npm run test:review # language-neutral scope and receipt contracts with real Git
npm run test:team # real process groups, project validation and shell cancellation
bash tests/run-gate-tests.sh
CASCADE_BIN=/absolute/path/to/cascade npm run test:integration
CASCADE_PYTHON=/absolute/path/to/cascade-0.8.1/bin/python npm run test:portal-integration
WORKSTATION_IMAGE=ai-dev-kit/workstation-base:local npm run test:workstation
```

`npm run build` runs the fast suite as its final step, so the pre-commit gate
now fails on a broken cascade branch.

Use Node >=24.21.0. Portal tests use the real built-in SQLite API, not a mock.
The portal's native publication suite additionally requires a fixed Cascade
0.8.0 or 0.8.1 Python environment; missing prerequisites fail instead of silently skipping.

## Files

- **`cascade-portal.test.cjs`** — real temporary Git snapshots, HTTP requests and
  SQLite files test identity/Origin boundaries, request versions and frozen
  dispatch, exact contract readback, published candidate SHA, uploads/ranges,
  manifest-bound feedback, restart and corrupted-storage refusal. These snapshot
  fixtures do not claim to validate native Cascade event transactions.
- **`cascade-portal-publish.test.cjs`** — real Cascade 0.8 Git storage validates
  atomic implementation/review publication, contract-bound idempotent readback,
  conflicting/partial-node refusal and malformed-plan rejection. It is isolated
  from company business namespaces and does not run a worker or a game.
- **`cascade-portal-client.test.cjs`** — real HTTPS with an explicitly trusted
  temporary CA, the actual client CLI and native Cascade Git storage exercise
  TLS/authentication rejection, repository binding before freeze, publication
  readback and duplicate publication without new writes. The test proxy models
  the trusted-header boundary; deployment still needs actual Nginx verification.

- **`test-review-scope.test.cjs`** — real Git tests for project-owned literal
  test roots, arbitrary languages/names, historical scope narrowing, policy-only
  review, invalid configuration, linked-worktree policies, per-branch schema-3
  receipts across parallel linked worktrees and one-release legacy receipt
  compatibility.
No Cascade executable or test-framework plugin is needed for this suite.

- **`team-gate-contract.test.cjs`** — explicit tracked project validation argv,
  task/global requirements, exact-HEAD/content receipts, failed-rerun revocation,
  worktree ownership and branch-specific subtraction. Also the opt-in many-agent
  options: retryable BLOCKED exits, per-task args, task-files requirements,
  read-only status (including low-disk and missing-node environment checks) and
  merge-base binding with real temporary-worktree integrate runs, conflicts,
  task-arg binding, merged-tree recompute and lease-lock recovery (including
  concurrent stale takeover). Uses real Git and command fixtures; a no-op project command
  does not prove production readiness.
- **`cascade-process.test.cjs`** — real child/grandchild processes, long successful
  commands, deadlines, cancellation, normal-exit background cleanup and redaction.
  Only the external CLI is a fixture; no local supervisor behavior is mocked.
- **`gate-process-boundary.test.cjs`** — directly signals the public Bash PID and
  checks all command groups stop before return, without a post-cancellation receipt.
  Separately checks successful stderr diagnostics cannot corrupt stdout JSON.
- **`resource-lock.test.cjs`** (in `test:team`) — real runners, process groups and
  signals against `scripts/resource-lock.cjs` in a temporary `--root`: FIFO order
  of three queued runners and a simultaneous burst without overlap, `--wait`
  timeout exit 75 without running or leaving a ticket, a killed runner's orphaned
  command still holding until its group dies, acquire/release tokens and the
  max-hold lease, exit-code propagation, descendant cleanup, nested-run refusal and
  SIGTERM releasing the lock. Only the guarded commands are fixtures.
- **`cascade-lane-team.test.cjs`** — real Cascade file/bare-Git open/private pool
  publication, finite lease/renew/release, stale tokens, required deliveries and
  two-cache contention, failure-bound retry/idempotency and explicit runtime
  selection. Part of `test:integration`, requiring the real Cascade 0.8
  `CASCADE_BIN` and its `CASCADE_PYTHON` interpreter.
- **`cascade-doctor.test.cjs`** — actual-runtime, file/bare-Git self-checks,
  existing-center checks and dispatch errors without business mutations or
  executing dispatch commands. Runs in `test:integration` with the same pinned
  `CASCADE_PYTHON`; successful protocol checks do not certify business readiness.

- **`fake-cascade`** — a small, stateful stand-in for the `cascade-auto` CLI. It
  implements only the subcommands the gate and the write-loop use
  (`add-node`/`get-task`/`finish-task`/`list-nodes`/`remove-node`/`history`) and
  pins the consumer-facing shape for narrow fault-injection tests. This fixture
  alone cannot discover upstream contract drift; the real integration suite
  exercises the released CLI boundary. Fault injection via env:
  - `FAKE_CASCADE_VERSION=<x.y|none>` — make `--version` print a version;
    default is 0.7.0 and `none` reproduces the old unsupported flag shape.
  - `FAKE_CASCADE_MODE=ok|fail|hang|badjson|nosuccess` — inject storage
    failures, timeouts, and malformed output for fail-closed tests.
  - `FAKE_CASCADE_EXPECT_GIT_REMOTE` / `FAKE_CASCADE_EXPECT_GIT_CACHE` — pin
    the Git backend flags resolved by the gate and lane wrapper.
- **`fixtures/first-exec.cjs`** — runs a freshly written fixture executable once
  before a test puts it under a seconds-scale deadline. macOS Gatekeeper blocks the
  first exec of a new script while `syspolicyd` looks up a notarization ticket online
  (0.1-4.4 s measured); without settling, the portal verifier-timeout case and the
  supervisor-deadline cases time the host instead of their subject.
- **`run-gate-tests.sh`** — the runner. `GATE=<path>` overrides which gate build
  to test (used to prove the net catches the original bug against the old gate);
  `FAST=1` skips the slow timeout case.
- **`production-workflow.test.cjs`** — release integration using real Cascade
  >=0.8.0 (`CASCADE_BIN` is required; dependencies never silently skip). Real
  bootstrap defaults and byte-for-byte older-profile preservation,
  committed/staged/untracked review evidence (including
  exact renames moving tests outside test paths), tracked
  worktrees with file/Git overlay, two-cache Git reservation contention and
  wrong-owner refusal regressions cover W1-W4. All state uses temp repositories.
- **`lease-redis-test.sh`** (`npm run test:lease`) — verifies the atomic
  orchestrator election in `scripts/cascade-lease.sh` against a real redis
  (acquire/renew/release CAS, mutual exclusion, clean handoff, unreachable-redis
  failure). Kept out of the default suite because it needs `redis-server` +
  the redis Python client; missing dependencies fail instead of skipping.
- **`workstation.test.cjs`** (`npm run test:workstation`) — the Linux workstation
  entry contract in `templates/workstation/base` with real containers, Xvfb and
  XTEST input: exit-code passthrough and `ws-run.json`, timeout stopping the whole
  command group, no surviving background children, injected keys and clicks
  reaching the focused window, OOM kills not reported as timeouts, usage errors.
  Pool cases claim real containers through `resource-lock.cjs`: declared CPU,
  memory, swap and user limits, a new container per claim with nothing left from
  the previous holder, removal on release and after the owner is killed,
  `run --pool` exit codes and evidence, `claim.json` with the image id and the
  session's screen recorded by `ws-run`, `ws-play` steps with verified
  screenshot hashes, refusal of a pool needing more memory
  than Docker has, status of Docker's real disk, prune removing a stray but never
  a held workstation, and exit 75 when free disk is short. Needs Docker and a
  base image named by `WORKSTATION_IMAGE`; fails without them.
- **`player-review.test.cjs`** (in `test:team`) — real Git fixture repositories,
  the real gate and `scripts/player-review.cjs`, with only the reviewer's
  evidence files as fixtures: no review is needed outside `player_review.paths`
  (or under `exclude`); a player-visible change without a review warns at
  preflight and fails merge and status; a passing review from another session
  bound to HEAD passes; the author's session cannot file, and a forged receipt
  still blocks; a review of an earlier commit is stale; `fail` and `incomplete`
  block with the report's summary and a later failing review replaces a pass;
  changed, missing or deleted evidence blocks; filing refuses evidence without
  a workstation claim, a report for another build or an incomplete report;
  uncommitted player-visible changes are refused and block; a receipt for
  another tree is refused; invalid `player_review` settings fail the gate;
  prune keeps filed evidence until `keep_until`; an owner's waiver of the exact
  candidate passes merge and shows as WAIVED in merge and status; the author's
  session cannot waive, and a waiver it signed blocks; an owner missing from
  the target branch's `owners` (even when the branch lists it) and an empty
  reason are refused and block; a later change or another tree voids a waiver;
  and `waive` refuses a commit without a playtest request or an ignored waiver
  path.
- **`workstation-pool.test.cjs`** (in `test:team`) — real CLI processes against
  workstation pools in `scripts/resource-lock.cjs`, with `fake-docker.cjs` standing
  in for the Docker CLI only: a burst of nine runs on three workstations never
  shares one, simultaneous claims hand out each slot once and the rest exit 75,
  only the first waiter in line assigns and a live holder's workstation is never
  freed (both checked by planted tickets), only the holder's token releases,
  killed holders and expired leases are reclaimed with a printed, logged reason
  while `renew` keeps a lease, an orphaned `run` keeps its slot until its command
  ends, the same-named exclusive lock stays independent, status and the gate's
  `--phase status` show holders, hold and wait times and the long-hold reminder,
  configuration errors (including memory beyond Docker's) exit 2, a short
  Docker or host disk stops a claim with 75 before any state, prune removes only
  unheld workstations, superseded images the pool built and old unheld evidence,
  status reports disk use, a checkout lacking the pool's `requires` is refused
  with its `prepare` hint, and a release slowed in `docker rm` while its ticket
  is reclaimed never deletes the slot handed on meanwhile (this case failed
  before the slot mutex), and planted slot-mutex markers show that a live
  holder's marker is honored, a marker younger than 5 s is not checked, and a
  marker whose pid now has another start time or that is older than 30 minutes
  is removed (these failed on 0.21.0, whose claim waited out the mutex).

## Coverage

- **Regression**: a cascade CLI with no parseable `--version` produces a
  controlled gate failure rather than the `set -e` shell crash shipped in 0.8.0.
- **Fail-closed matrix**: CLI unavailable, invalid config, storage failure,
  timeout, and malformed output all block readiness without crashing.
- **min_version**: below/unparseable blocks; in range is quiet.
- **Claim/finish contract**: `get-task` emits a numeric `fencing_token`;
  `finish-task` requires that token and rejects a different agent.
- **Capability routing**: `pro` workers skip/refuse `max` work, while a `max`
  worker can claim it; untiered tasks remain backward compatible.
- **Merge/preflight node-state rule**: merge FAILs on a non-`COMPLETED` branch
  node; unmatched feature slugs fail closed; trunk branches remain unscoped.
- **`set-coordination.cjs`**: idempotent for both bare and inline-commented
  `coordination:` headings.
- **Reservation + capability routing**: canonical IDs persist `reserved_for` and `required_tier`,
  under-tier owners are refused, and worker-pool claims skip harder shared work
  while still finding an eligible task later in the READY set.
- **Git storage wiring**: project remote names resolve to URLs/paths, relative
  caches resolve from the shared main checkout, and gate/lane invoke the same
  native ownership contract. Both the real integration suite and Cascade's
  storage tests cover the Git transaction boundary.
- **Implementation-discipline distribution**: real project installs for Codex,
  Claude, and generic preserve the full canonical reference and related skills;
  each source/installed-slash implementation, preflight, and merge entrypoint
  loads it. These checks verify delivery, not subjective comment quality.
  Comment examples and review thresholds also need scenario-based agent review.


## Isolated portal UI fixture

Run `node tests/fixtures/portal-ui.cjs` with the project's pinned Node runtime.
It starts a loopback-only preview at `http://127.0.0.1:4328`, backed by a newly
created temporary bare Git repository and real portal SQLite database. Use
`PORTAL_UI_PORT=4329 node tests/fixtures/portal-ui.cjs --empty` for initial empty
and failure states. The console identifies the owned data and control paths.
No production remote, account, credentials or database is used.

The fixture is a browser test harness, not an automated pass/fail suite. Its
examples are labeled local UI verification and its only default artifact is a
text explanation. They are not candidate game evidence. The root's `control.json`
can set `getError: true`, `postDelayMs: 18000`, or
`dropReplyResponseOnce: true` to check read failures, write-in-progress behavior,
and a reply that reaches SQLite but loses its response. Clear controls with `{}`.
Reviewers should verify actual rendered behavior and database outcomes; a fixture
response alone does not prove browser interaction. SIGINT/SIGTERM closes both
servers; a two-hour deadline also closes them. Retained temporary data is available
for inspection and can be removed after the fixture has exited.
