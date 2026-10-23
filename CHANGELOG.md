# Changelog

All notable changes to AI Dev Kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses semantic
versioning. Versions track the plugin manifests (`.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`) and `package.json`, which must stay in
lockstep — see the Release Convention in `CLAUDE.md`.

## [Unreleased]

### Fixed
- `ws-run` in a pool workstation recorded the default screen
  (`1920x1080x24`) in `ws-run.json` instead of the workstation's own: batch
  mode now reads the running screen's geometry, and pool containers get
  `WS_SCREEN`.

## [0.21.1] - 2026-10-22

### Fixed
- `resource-lock.cjs` pools: a slot-mutex marker left by a process that died
  could block every claim and release until their mutex wait ran out, if the
  system had reused its pid. Markers now record their process's start time
  (`LC_ALL=C ps -o lstart=`); a marker older than 5 s whose pid now has another
  start time is removed, and any marker not refreshed for 30 minutes is removed
  as a backstop. A holder refreshes its marker after every `docker rm` inside
  the mutex, so a live holder's marker never gets older than one Docker timeout
  (120 s), however many slots it frees. A claim whose `--wait` ends while the
  mutex is held exits 75 instead of waiting up to 60 s.

## [0.21.0] - 2026-10-22

### Fixed
- `resource-lock.cjs` pools: `release` could delete the slot file of the next
  holder when its own ticket was reclaimed while it removed its container (an
  owner pid that is gone makes a ticket reclaimable however recently it was
  refreshed). Every change to slot files (assigning, freeing a dead holder's
  slot, `release`, cleanup after a failed claim or a finished run) now holds a
  per-pool slot mutex, so a slot file checked under it cannot change before the
  same process acts on it. This replaces the ticket refresh added to the
  cleanup in 0.20.0.

### Added
- Pool settings `requires` (paths the checkout must already have) and
  `prepare` (how to prepare one): a claim for an unprepared checkout exits 1
  before anything starts. Assets and import caches belong on the host, where
  they can be cloned; copies made inside a workstation through the bind mount
  are real data on the host disk.

### Changed
- `references/loop-workflow.md` and the workstation README note that the 2.5g
  workstation default covers running, not building: a measured `dotnet build`,
  first import and run in one 2.5g container was OOM-killed, and a build plus a
  4K Godot run peaked at 2.55 GiB. Build and import on the host (three run-only
  workstations fit an 8 GB Docker VM), or raise `memory` (3g for build and run)
  and lower `slots` (two fit an 8 GB VM; three need 10 GB).

## [0.20.0] - 2026-10-22

### Added
- `scripts/resource-lock.cjs` workstation pools: projects declare Docker
  workstations in `.ai-dev-kit/workstations.json` (image or Dockerfile, count,
  CPUs, memory, screen, start command) and agents `claim`, `run`, `renew` and
  `release` them with `--pool`. At most the declared number are held and none
  twice; each claim gets a new container, release and reclaim remove it; only
  the claim's token releases it; a dead owner or an expired lease is reclaimed
  with a printed and logged reason. A pool that needs more memory than Docker
  can use is refused with the numbers. The defaults (3 × 3 CPUs / 2.5 GB) fit an
  8 GB Docker VM. Exclusive locks such as the real-screen `godot` lock are
  unchanged and independent of pools.
- `resource-lock.cjs status --pool <pool>` shows each workstation's holder, hold
  time, lease, waiters and their wait, a configurable long-hold reminder, recent
  reclaims, Docker's memory fit and actual disk use (Docker's and the host's
  free space, the image, each workstation's writable layer, evidence size);
  `status` without a name lists every lock and pool of the project.
- `claim` and `run --pool` check that Docker's disk and the host disk both have
  the pool's `min_free_disk` (default 5g) free and otherwise exit 75 before
  anything starts. `resource-lock.cjs prune --pool <pool>` removes workstation
  containers no slot holds, images the pool built that are no longer configured,
  and, with `--evidence-days`, old evidence of claims no longer held; it never
  touches held workstations or project files.

### Changed
- `skill-first-gate.sh --phase status` also lists the project's locks and
  workstation pools on this machine. It stays read-only and reports nothing to
  the center.

## [0.19.0] - 2026-10-22

### Added
- `templates/workstation/`: a Linux GUI workstation container, so an agent can
  run, drive and screenshot a windowed program on a private virtual screen
  instead of the host's display. `base/` is a pinned Debian image with Xvfb,
  XTEST input and screenshots: `ws-run` runs one command (batch) or keeps the
  screen up for `docker exec` steps (session), stops the command's whole
  process group on exit or `--timeout`, and records exit code, timeout, time,
  container memory peak, OOM kills and CPU seconds in `ws-run.json`;
  `ws-input` injects keys and clicks into the container's own X server;
  `ws-shot` saves the screen or one window as PNG. `examples/godot-dotnet/`
  layers Godot 4.7.1 .NET and the .NET 8 SDK on Mesa software rendering
  (lavapipe for Forward+, llvmpipe for OpenGL), with archives checked against
  official SHA512 sums. Pool semantics on top of `resource-lock.cjs` follow in
  a later release.
- `npm run test:workstation`: the workstation entry contract against real
  containers (needs Docker and `WORKSTATION_IMAGE`; not part of `npm run build`).

## [0.18.1] - 2026-10-20

### Changed
- `cascade-center-agent`: the `ssh_config` that join writes reuses one SSH
  connection for the center's Git host (`ControlMaster auto`,
  `ControlPersist 60`, control socket under the agent directory's `mux/`).
  A claim or renewal now authenticates once instead of once per Git command.
  Agents that joined with an earlier version get it by re-running join with
  their original inputs in the same directory; the old config keeps working
  without reuse.
- `cascade-center-agent`: join refuses an agent directory longer than 76 bytes
  on macOS or 80 bytes on Linux, before any key is created, because the control
  socket path has a length limit. The default directory name is shorter.
- The bundled Center clients now come from CascadeCenter-web `33b9ec0`
  (previously `7b7d4d1`). `cascade-node-client.cjs` and `cascade-process.cjs`
  are byte-identical; `cascade-node-join.cjs` keeps the kit's own rule that a
  bare project ID needs a configured center.

### Fixed
- `cascade-center-agent`: a timed-out command no longer waits minutes past its
  deadline when an SSH connection master keeps its stderr open; the command
  returns about 2 seconds after it is force-killed.

## [0.18.0] - 2026-10-19

### Added
- `cascade-center-agent`: join accepts the `PROJECT_ID@CENTER_ORIGIN` text that
  the Center web page copies. The address after `@` selects the center and wins
  over `CASCADE_CENTER_ORIGIN`; a different `--origin` is rejected before any key
  is created.
- `cascade-center-agent`: `--harness NAME` on join, and the client's
  `profile --harness NAME`, report which tool runs the agent. Center shows it as
  self-reported and never uses it for permissions.
- `cascade-center-agent`: join prints a one-time owner confirmation code for an
  agent that has no owner yet. It is valid for 10 minutes; a project member
  enters it in Center under 我的项目 → 执行 agent → 确认我的 agent to become the
  agent's owner. The client's `owner-code` command issues a new code.

### Changed
- The bundled Center clients now come from CascadeCenter-web `7b7d4d1`
  (previously `683080f`). A bare project ID still needs `--origin`,
  `CASCADE_CENTER_ORIGIN` or the saved enrollment; the kit has no built-in
  center address.

## [0.17.2] - 2026-10-15

### Changed
- The public repository is now https://github.com/auto-seek/ai-dev-kit. The
  previous internal repository is archived and receives no further updates.
  Claude Code users switch with `/plugin marketplace remove ai-dev-kit-marketplace`
  followed by `/plugin marketplace add https://github.com/auto-seek/ai-dev-kit.git`.
- Source records for the bundled Cascade Center clients name the internal
  repository without its address; the pinned commit is unchanged.
- Changelog compare links to the previous repository are removed; its tags are
  not carried over.

## [0.17.1] - 2026-10-15

### Added
- MIT `LICENSE`, with `license` fields in `package.json` and the plugin manifest.
  The README lists the bundled third-party licenses.

### Removed
- Company deployment templates (`deploy/cascade-portal/`) and internal working,
  verification and ledger records under `docs/`. They described one
  organization's servers and are not part of the kit. The portal scripts and the
  team center guide remain.

## [0.17.0] - 2026-10-15

### Added
- `cascade-center-agent`: agents can propose goals (`goal`) and, when a project
  owner has granted it, confirm goals that agents proposed (`confirm`) and retry
  their own failed batch (`retry`). `inbox` shows each goal's author and whether
  this agent holds a grant. A member's own goal is still confirmed only by that
  member. Grants are per agent and project, not by model level, and allow at
  most 10 confirmations per agent per project per day.

## [0.16.1] - 2026-10-13

### Changed
- Setup, joining and visualization use project configuration and generic
  placeholders instead of a specific project or default center domain.
- New agent registrations require a center address from `--origin`,
  `CASCADE_CENTER_ORIGIN` or interactive input. Retrying an existing registration
  can reuse its private enrollment directory; different origins cannot reuse
  that identity. Existing task clients keep their saved `client.json` origin.

## [0.16.0] - 2026-10-13

### Added
- `cascade-center-agent`: join an AutoSeek task center using only project ID and
  model level, with independent credentials, bundled clients and the fixed
  offline runtime. Agents check product Git separately after joining.
- `cascade-flow`: open the existing team page or start the bundled loopback
  read-only Git viewer, including its complete local assets and licenses.

### Changed
- Cascade Init routes project-ID joins and graph viewing to the new skills, and
  documents building a Git center with AutoSeek login, project admission and
  shared visualization using the approved standalone Center release.
- Plugin, offline and project installs include both new skills and slash
  entries. Existing centers, heartbeat behavior and product Git permissions stay
  under their existing configuration.

## [0.15.0] - 2026-10-11

Plain-language rules for everything people read: agent reports and product UI text.

### Added
- `references/plain-language.md`: reports lead with the result and give cause,
  what was done and what is still open; no coined terms, internal identifiers
  used as words, or buzzwords; natural sentences. Product copy reads like a
  professional commercial app: delete unneeded explanatory text first, short
  verb buttons, plain labels, actionable errors, one-line empty states, no
  marketing wording or emoji, consistent naming. Includes before/after examples.
- Core rule 13 in the `ai-dev-kit` skill and a Copy Reviewer lens in
  `review-agents.md`.

### Changed
- Quick checklist, preflight review and subtraction targets now cover
  user-facing text.

## [0.14.0] - 2026-10-06

Options for running many parallel agents against one repository. Everything is
opt-in except the environment self-check noted under Changed.

### Added
- `preflight.blocked_exit_codes`: a listed exit code from the project argv is
  reported as `BLOCKED (retryable)`, writes no receipt and is never a pass. The gate
  still exits 2 by default (hooks stay blocking); `--blocked-exit-code <n>` or
  `AI_DEV_KIT_BLOCKED_EXIT` (1-255, read only by preflight and integrate) lets loop
  runners tell BLOCKED apart from FAIL.
- `preflight.task_args`: per-task argv suffix from a tracked
  `<dir>/<task-id>.json` (`{"args": [...]}`), so topic-specific verification no
  longer rewrites the shared `gate-contract.json`. Bound into the receipt; an
  untracked or ignored task file fails.
- `requirements.mode: "task-files"` with `requirements.dir`: one requirements file
  per task instead of a shared ledger.
- `--phase status` (read-only, `--all`, `--json`): receipt freshness with the
  differing snapshot keys, merge readiness, subtraction debt, test-review result and
  environment check for the current or every receipted branch.
- Merge-queue mode: top-level `receipt_binding: "merge-base"` stops target movement
  alone from staling branch receipts; `--phase integrate` (single integrator,
  exclusive lease lock, `AI_DEV_KIT_INTEGRATE_LEASE_SECONDS`) merges the branch onto
  the current target in a fresh temporary worktree (committed files only), runs the
  project command with the receipt's task args there and writes an integrate receipt
  that `--phase merge` requires; merge recomputes the merged tree with
  `git merge-tree --write-tree` (git >= 2.38). Only the queue head re-verifies on
  the latest target.
- `scripts/resource-lock.cjs`: FIFO queued exclusive lock (`run`, `acquire`,
  `release`, `status`) for scarce resources such as a single GUI engine or display,
  stored in the main checkout's `.ai-dev-kit/locks/<name>/`; wait expiry exits 75.

### Changed
- Test-review evidence is stored per branch
  (`.ai-dev-kit/workflow/test-review/<sha256(branch)>.{md,json}`, receipt schema 3,
  now also bound to the narrative hash). Recording on one branch no longer
  invalidates another. A legacy single-file receipt is accepted for one release only
  for the exact current branch and snapshot, with a deprecation notice that the gate
  now surfaces as a warning. New `test-review-evidence.cjs paths` command. `record`
  requires `--report <file>` or the branch's narrative at the `paths` report location
  and never reads the shared `.ai-dev-kit/workflow/test-review.md`; bootstrap
  installs the template as `.ai-dev-kit/workflow/test-review-template.md` instead of
  creating that shared file.
- Preflight and integrate run an environment self-check first (node on PATH, at
  least `AI_DEV_KIT_MIN_FREE_MB`, default 1024, free on the shared state volume) and
  report BLOCKED when it fails. Set `AI_DEV_KIT_MIN_FREE_MB=0` to disable.
- Bootstrap adds `.ai-dev-kit/workflow/` to the project `.gitignore` (creating it if
  absent, never untracking files, hinting when workflow files are already tracked).
- Subtraction guidance: run the cadence clean pass on the current task branch
  against its own diff (a separately reserved clean topic never clears another
  branch's debt), record a quick no-candidate pass as
  `scope: <base>..HEAD (none) | mode: propose`, and stop when candidates run out.
- `loop-workflow.md` gains "Exclusive Resources And Retryable Blocks" and "Scaling To
  Many Agents" sections; `docs/team-gate-migration.md` gains "Options for many
  parallel agents" with an example contract.

## [0.13.2] - 2026-09-20

### Changed
- New installations pin Cascade 0.8.1, commit
  `689f1f296e1350515842c08522963afd3f387db3` (tag `v0.8.1`). It keeps the 0.8.0 event
  and storage protocol and adds the supervisor process-cleanup fixes that were
  previously available only as the local build `0.8.0+supervisor.1`. Environments
  installed and verified from the 0.8.0 commit stay approved; the minimum remains
  Cascade >=0.8.0.
- The portal publisher accepts the approved 0.8.0 and 0.8.1 releases and local builds
  of either. Any other release is still rejected as an unapproved runtime upgrade.

## [0.13.1] - 2026-09-20

### Changed
- Task branches bind by shape instead of a fixed prefix list:
  `<owner-or-type>/<canonical-task-id>` with exactly one prefix segment. `fix/`,
  `feature/` and `codex/` keep working, and any agent id
  (`claude-fable-worker01/<task>`) binds the same way in the `task-sections`
  requirements gate, the Cascade node lookup and the legacy ledger own-match. A
  branch with a second segment after the task id (`codex/<task>/<worker>`) now
  fails with an explicit message instead of "no cascade node matches".

## [0.13.0] - 2026-09-16

### Added
- Company-hosted, single-project team portal with individual proxy-authenticated
  accounts, durable request conversations and exact-commit candidate evidence.
- Center client freezes versioned proposals before native Cascade 0.8 batch
  publication and independently reads back complete task contracts. Employee
  input and human feedback do not grant merge, deployment or model-spend authority.
- Immutable artifact manifests, authenticated image/video/download access and
  manifest-bound acceptance/rework feedback; explicit storage-integrity failures.
- Isolated Node 24.21.0/systemd/Nginx deployment templates, operator recovery
  instructions and real Git/HTTP/SQLite and native Git publication tests.
- Preserved the existing Git task-flow viewer as a standalone loopback command
  and a linked view inside the authenticated portal. Browser game execution is
  outside this release.
- Employee session login and a focused workbench; a horizontal task DAG with
  dependency routes, canvas dragging and anchored 25%–200% zoom.
- Per-project company Git center setup and migration/access-recovery guidance.
- Scoped native runtime/center diagnostics, explicit interpreter selection and
  authorized exact-failure retry without repeating unchanged enrollment checks.

### Changed
- Require Node >=24.21.0 for the kit runtime/build, including built-in SQLite.
  The server portal uses its own pinned runtime, not a global Node replacement.
- Accept approved release-local Cascade builds in the doctor and the 0.8.0
  portal publisher without accepting prereleases, malformed labels or unapproved
  runtime upgrades.

## [0.12.1] - 2026-09-15

### Changed
- New installations use the fixed Cascade 0.8.0 release source; new profile
  defaults require >=0.8.0. Bootstrap still preserves complete existing profiles,
  including explicit older version requirements; migration is never automatic.
- Installation skills, slash guidance and the team runbook require upgrading and
  verifying actual CLI/worker entrypoints before the first 0.8-only event in a
  shared namespace. Updating Kit/profile text alone does not upgrade Cascade.
  Native ownership, leases, gates and failure handling are unchanged.

## [0.12.0] - 2026-09-07

### Changed
- Replace language/name-based test detection with tracked, project-owned
  `.ai-dev-kit/test-scope.json` literal file/directory roots. Missing, invalid or
  empty scope fails explicitly; projects without tests must declare a reason.
- Bind merge-base, HEAD, index and working-tree scope plus test identities to
  schema-2 review evidence. Narrowing scope does not hide historical test changes;
  scope-only changes also require approval. Existing schema-1 approvals require
  renewed review. See [test scope migration](docs/test-scope-migration.md).
- Bootstrap preserves project scope and prints the enrollment step when absent;
  it does not infer test ownership or manufacture a no-tests exception.
- Require tracked `gate-contract.json` with explicit base ref, scoped requirements
  and real project verification argv. Preflight now executes that command and
  binds exact HEAD, index/worktree/untracked inputs and effective configuration;
  merge cannot reuse an ancestor or another merge receipt. Existing projects
  require the [explicit gate migration](docs/team-gate-migration.md).
- Scope subtraction debt to the current branch and its recorded clean passes;
  malformed configuration no longer silently substitutes a default.

### Added
- Shared POSIX Cascade process supervision for gate/lane commands: Git gets a
  configurable 180-second budget (file/Redis 30), timeout/cancellation cleans up
  the owned process group, and original failures remain actionable and redacted.
- Team lane operations for open or assigned publication, finite task leases,
  renewal, release and promised deliveries, backed by real Cascade integration.
- Team worker startup prompt and refreshed cloud-center runbook distinguishing
  a bounded harness loop, coordination storage and protected product publication.
- Operator recovery guidance for lost workers, lease expiry, uncertain Git writes
  and separate product-push/task-finish outcomes. Supervised worker installation
  pins Cascade `aac3814`, with final-commit verification and serialized renewal
  shutdown before completion; cancellation and late results remain fail-closed.

## [0.11.1] - 2026-09-06

This is the first published release after 0.10.0 and includes all corrections
listed under the 0.11.0 candidate below, which was not tagged separately.
Upgrading from 0.10 requires Cascade >=0.7.0 and the
[coordination migration](docs/coordination-0.7-migration.md); it is not just a
comment-style update.

### Added
- Maintainer-oriented comment guidance in the cross-harness implementation
  discipline, with examples and synchronized implementation/review entrypoints.
  Comments explain verified reasons and constraints in plain language, preserve
  useful API/test docs and directives, and avoid narration or work reports.
  Review blocks materially misleading explanations, not vocabulary preferences;
  no comment-style lint or additional stop hook is introduced.
- Team Git-center onboarding: separate coordination storage, planning and
  execution; describe developer enrollment, tier-aware claims, delivery and
  review, without requiring an always-on server for the coordination store.

### Fixed
- Initialization smoke tests use valid Cascade 0.7 task IDs. Installation
  guidance points to a verified immutable Cascade 0.7 source revision instead
  of assuming the package registry or default branch supplies that version.

## [0.11.0] - 2026-09-06

### Changed
- Require Cascade >=0.7.0 and its native `reserved_for` protocol. Canonical task
  IDs provide atomic reservation uniqueness; worker selection and targeted owner
  checks run in the engine transaction. Legacy `slug@owner` graphs require the
  explicit migration documented in `docs/coordination-0.7-migration.md`.
- Fresh bootstrap defaults to Cascade; repeated bootstrap preserves the complete
  existing profile. Storage/role changes require an explicit migration.
- Gate, wrapper and review receipts share the main checkout's config and state
  across linked worktrees, including tracked `.ai-dev-kit` directories.
- Test review now checks the target-branch diff plus staged, unstaged and
  untracked tests. A named approved review is bound to Git/content identities;
  stale or missing receipts block preflight/merge. The unreviewed-test bypass is
  removed.
- Existing ledger mode remains deprecated but supported for explicit migration.
  This supersedes the earlier 0.11 removal announcement; new installs use Cascade.

### Added
- `npm run test:integration` executes real bootstrap, tracked-worktree, review
  evidence and concurrent Git reservation regressions. `CASCADE_BIN` must point
  to a real Cascade >=0.7.0 executable; missing dependencies fail, never skip.

## [0.10.0] - 2026-08-11

### Added
- Add a CODING-compatible `Jenkinsfile` that enforces manifest version
  lockstep, the full gate suite, build, skill schema validation, real Redis,
  and npm package inspection. The skill validator is release-pinned in the
  repository so a clean Jenkins agent does not depend on a personal Codex install.
- Cross-harness implementation discipline covering final-architecture
  increments, no fallback degradation, coordinated breaking changes,
  reuse/framework research before code, and lean abstraction/defense. The core
  skill, quick checklist, loop, preflight, merge guardian, reviewer prompts,
  and slash-command templates now enforce the same rules.
- Lane-aware tier enforcement: `cascade-lane.cjs` now forwards `required_tier`/`agent_tier`, rejects under-tier owners, and skips harder shared work without overlooking a later eligible node.
- Redis-free `storage: git` integration for profiles, gates, lanes, and the setup helper. Remote names such as `origin` resolve through the project repository; direct URLs and bare-repository paths are also accepted.
- Git remote-ref CAS design and acceptance criteria in `docs/git-coordination-backend.md`; the Cascade backend passed an independent-container lifecycle/race/fencing/tier E2E against a local bare remote.

### Changed
- Cascade preflight/merge now fail closed for missing/old CLI, invalid storage
  config, unreachable/timed-out storage, malformed JSON, and missing branch
  nodes. Stop remains light and performs no coordination I/O.
- Preflight now requires the branch node to be `ACTIVE`, proving a live fenced
  owner; unclaimed `READY` and already-finished `COMPLETED` nodes are rejected.
- Git storage is now the recommended zero-service cross-machine backend after
  local/container crash, skew, compaction, 1,000-attempt contention, GitHub
  SSH-over-443, and CODING HTTPS acceptance with Cascade 0.6.0.
- Synchronized the default profile, README, workflow skills, references, and slash-command templates with the 0.9.0 `self-serve` default and the ledger-removal move to 0.11.0.

### Fixed
- npm publication now uses an explicit runtime/documentation whitelist instead
  of `.gitignore` inference, excluding tests, CI files, and verification media.
- Cascade command failures are URI-userinfo redacted before reaching gate or CI
  output, while preserving the actionable error message.
- Redis orchestrator leases now fail closed when the client/server/operation is
  unavailable; an unenforced lease can no longer return success.
- `set-coordination.cjs` now replaces an existing inline-commented `coordination:` heading instead of appending a duplicate block; the former XFAIL is a hard passing assertion.
- Removed unsupported `argument-hint` frontmatter from the loop skill so every shipped skill passes the common validator.

## [0.9.0] - 2026-07-15

### Added
- **`self-serve` coordination role — the new default**: for the agent that plans its own work items into the shared graph and executes them itself (the improve→evaluate→improve loop), alongside `orchestrator` and `worker`. Cascade (≤0.4.x) has no native node ownership (`add-node --expectations` is not persisted; `list-nodes` exposes only id/state), so a self-serve reservation is encoded in the node id as a **lane**: `<slug>@<agent>`.
- **`scripts/cascade-lane.cjs`** — the enforced path for lane discipline: `add` reserves `<slug>@<agent>` after a graph-wide slug-collision check; `claim` is role-aware and can never steal another agent's lane (self-serve targets its own lane; a worker's pool claim only picks UNRESERVED ready nodes and refuses when everything READY is lane-reserved — never bare `get-task`, which claims an arbitrary node); `finish` resolves the lane id from the slug. Storage/role resolve with the same precedence as the gate (env > `profile.local.yml` > `profile.yml`).
- The merge/preflight gate now matches a branch slug against both `<slug>` and the lane form `<slug>@<agent>` (exact id wins over a lane form; prefix matching is exact — `lane` does not match `lane-extra@x`), and its FAIL hint prints the full lane id so the suggested commands are copy-pasteable.
- `set-coordination.cjs` validates `--role` against {self-serve, orchestrator, worker} and defaults to `self-serve`; `init-skill.sh --coordination cascade` and the cascade-init wizard follow. Upstream ask stays on record: native `add-node --reserved-for` + bare `get-task` exclusion would let the lane script thin to a shim.

### Fixed
- **Subtraction-debt fallback counted trunk history as branch debt**: with no recorded clean pass, the gate required the baseline ref to be an *ancestor* of HEAD, so a branch whose fork point sat behind the trunk tip fell through to an ancient `main` and reported absurd debt (a real branch hit 242). The fallback now uses the merge-base (fork point) directly.
- `tests/fake-cascade` emitted invalid JSON for an EMPTY store (`"count": ` with no value — uninitialized awk variable), diverging from the real CLI. Callers that strictly parse `list-nodes` (like `cascade-lane.cjs`) crashed on a fresh store in tests only.

### Changed
- Ledger-mode removal, previously announced for 0.9.0, is rescheduled to 0.11.0 (0.10.0 is the Git coordination/fail-closed release; the removal precondition — node-metadata design-doc binding validated by the autoseek pilot — is still open). Deprecation WARN text updated.

## [0.8.4] - 2026-07-15

### Fixed
- **The 0.8.3 overlay was dead config over a file-mode tracked baseline**: the gate selects the coordination backend from `cascade.storage` before it ever reads `cascade.redis_url`, so a `redis_url`-only `profile.local.yml` over a tracked `storage: file` profile left every gate silently checking the (empty) local file store — merge gates reported "no cascade node matches branch slug" for nodes that were COMPLETED in redis (found in the autoseek pilot, where the shipped tracked baseline is file mode). `set-coordination.cjs --local` now writes `storage: redis` into the overlay, plus `namespace` when passed explicitly (never by default, so it can't shadow the tracked namespace). Docs updated; test net gains the tracked-file + overlay regression scenario — every prior overlay scenario had rewritten the tracked profile to redis mode first, which is exactly how the hole shipped.

## [0.8.3] - 2026-07-14

### Added
- **Coordination secrets overlay**: the gate now reads `.ai-dev-kit/profile.local.yml` (gitignored, machine-local) per key over the tracked `profile.yml` coordination block, and `AI_DEV_KIT_CASCADE_REDIS_URL` over both — so a redis URL with an embedded password never needs to be committed or `skip-worktree`'d. In linked worktrees the overlay resolves from the MAIN worktree (the tracked `.ai-dev-kit/` a worktree materializes used to block the 0.8.1 main-worktree climb and silently degraded coordination to WARN+skip — found in the autoseek pilot). `set-coordination.cjs --local --redis-url <url>` writes the secrets-only overlay; `init-skill.sh` gitignores it.

### Fixed
- Merge-gate FAIL for a non-COMPLETED node now prints the exact targeted command sequence (`get-task --agent <agent> --task '<slug>'` then `finish-task ... --token <fencing_token>`); the bare hint led people to run `get-task` without `--task`, which claims an ARBITRARY ready node. The cascade-init wizard's CLI-contract notes now spell out that danger explicitly (its smoke tests already claim with `--task`).

## [0.8.2] - 2026-07-14

### Added
- Tier-aware Cascade delegation guidance using the portable `lite < pro < max` model, with feature detection so older Cascade installations continue in untiered mode.
- Fake-Cascade coverage for required-tier publication and agent-tier claim filtering.

### Fixed
- Cascade worker examples and workflows now preserve the claim token and agent identity through `finish-task`, matching the fenced 0.4.14+ CLI contract.
- Coordination guidance now makes task publication, self-assessment, claim refusal, and high-difficulty escalation explicit for harnesses without native model-tier configuration.

## [0.8.1] - 2026-07-06

### Fixed
- Gate runs inside a linked git worktree now resolve `.ai-dev-kit/` (profile, receipts, workflow logs, and the file-mode cascade store) from the MAIN worktree via `git rev-parse --git-common-dir` — previously a worktree run silently fell back to legacy-ledger mode because the gitignored `.ai-dev-kit/` directory doesn't exist in linked worktrees. Validated end-to-end in the autoseek pilot: a worktree merge-phase run correctly reaches the shared cascade store and blocks on a non-COMPLETED node.

## [0.8.0] - 2026-07-06

### Added
- **Cascade coordination engine** (`coordination.engine: cascade`, the supported engine going forward): claims, scheduling, and cross-machine coordination move from the markdown ledger to [Cascade](https://github.com/auto-seek/Cascade) (`cascade-auto` on PyPI, tested with 0.4.14) — atomic claims, contract-carrying DAG edges, event sourcing. Design: `docs/cascade-coordination-design.md`.
- `/ai-dev-kit-cascade-init` wizard: probes/installs the CLI, storage choice (file default — single machine, zero deps; redis for cross-machine), role choice, idempotent profile write, real smoke test. Non-interactive path: `bootstrap/init-skill.sh --coordination cascade`.
- Gate cascade branch: reservation checks query the store (`list-nodes`); merge requires the branch-slug node COMPLETED (finish-task carries the verification evidence); degradation is always WARN+skip — a missing CLI or unreachable redis never blocks a merge on its own.
- `references/cascade-coordination.md`: concept mapping, roles (orchestrator/worker), storage rules (file store must stay gitignored — worktrees would fork it), one-way backup export, and the batch-delegation pull pattern ("Spawning worker agents": orchestrator builds the graph, N generic workers drain it, verify nodes make review graph structure).
- `scripts/cascade-lease.sh`: TTL-lease backstop for one-orchestrator-per-namespace in redis mode.

### Deprecated
- **Ledger coordination mode.** Preflight/merge now emit a deprecation WARN under `engine: ledger` (or unset). The legacy checks still run in 0.8.x as a migration window; **0.9.0 removes them** along with the markdown-ledger code path. Migrate with `/ai-dev-kit-cascade-init`.

## [0.7.0] - 2026-07-05

### Added
- Gate evidence receipts: every `skill-first-gate.sh` run appends `{ts, phase, result, branch, head}` to `.ai-dev-kit/workflow/gate-log.jsonl` (bounded). The merge phase requires a passing preflight/merge receipt for the current branch at HEAD or a recent ancestor (≤3 commits) — `ready-for-review` stops being a bare claim. WARN by default; `gate.require_preflight_receipt: true` in `profile.yml` escalates to FAIL.
- `references/delegation.md`: the coordinator/implementer protocol — division of authority, delegation brief, delegate report format, coordinator verification checklist ("reports are claims, not evidence"), and the parallel-delegates rule that only the coordinator writes the ledger.
- `references/quick-checklist.md`: a compact operating card for the routine slice path; `SKILL.md` now points loop iterations there first, deep references on demand.
- Loop State & Idle Protocol in `references/loop-workflow.md`: iteration position lives in `.ai-dev-kit/workflow/loop-state.md`; two consecutive idle iterations back off instead of re-scanning an unchanged repo.
- L1 micro path ("Sizing The Ceremony"): ledger entry never waived, design doc waivable via the existing `none - <reason>` form, worktree skippable for clean docs-only changes.
- Ledger archiving cadence (loop-workflow + subtraction reference): entries merged/abandoned >7 days move to `docs/development/feature-ledger-archive.md` so claim checks stay cheap as history grows.

### Changed
- The gate degrades gracefully without node: the ledger check falls back to the legacy pure-grep strict path and the design-doc check warn-skips, keeping python-only environments on a working gate.

## [0.6.0] - 2026-07-05

### Changed
- `skill-first-gate.sh` preflight/merge ledger check is now branch-scoped: the reservation matching the current branch (its `Branch:` line or slug) is the only hard-checked entry — merge requires it `ready-for-review` — while other owners' reserved/active/blocked entries downgrade to WARN. Multi-worker repos no longer live with a permanently red gate. When no entry matches the current branch the legacy strict behavior applies, so single-worker repos are unchanged.
- Unified `--discovery` and `--ev` into one "Autonomous Target Selection" machinery in `references/loop-workflow.md`: shared clean-worktree gate, shared runner/health posture (fixing the inconsistency where discovery ranked a red health gate first but never instructed probing it), shared inputs and priority order, and a single plan schema — `rejected_candidates` and `review_focus` now apply to `DISCOVERY_PLAN` too. Mode differences (L2 cap, evolution-state rights, rotation/L5 eligibility, plan tag) are captured in a profile table. Both flags and their intents are unchanged.

### Removed
- Vestigial `typescript`/`tsx`/`@types/node` devDependencies, `package-lock.json`, and the stale `dist/` compiled artifact — the repo has no TypeScript source; `npm run build` remains a pure validation gate.

## [0.5.0] - 2026-07-01

### Added
- Added `--discovery` and `--ev` modes to `ai-dev-kit-loop`: discovery selects one bounded, repository-local self-improvement candidate, while evolution adds ev-style health-gate priority, requirements-pool priority, L1-L5 sizing, optional rotation/cadence signals, and an `EV_PLAN` before continuing through the normal reservation, design-document, worktree, review, and preflight gates.

### Changed
- Clarified the mode split: `--discovery` is conservative L1/L2 target discovery with no long-lived evolution state, while `--ev` may use L1-L5 sizing and lightweight evolution state but must prefer unfinished requirements after red health gates.

## [0.4.3] - 2026-06-28

### Changed
- Added explicit `asking-the-user.md` back-references at the points workflows
  actually ask: subtraction's deletion-approval step (batch candidates, carry a
  recommended call per item, never interrogate file-by-file) and merge guardian's
  waiver/deferral decisions (surface the specific blocker and a recommended call,
  not an open-ended prompt).

## [0.4.2] - 2026-06-28

### Changed
- Extracted the shared question-quality rules into `references/asking-the-user.md`
  and added core rule 7 to the main skill, so every workflow that asks the user
  (loop, clean, merge guardian, …) inherits them via "use the ai-dev-kit skill
  first". The loop reference now points at the shared rules and keeps only its
  loop-specific question template.

## [0.4.1] - 2026-06-28

### Added
- Question-quality rules and a five-dimension clarification template for the loop
  kickoff (outcome, boundary, reuse/integration, constraints, verification), so
  harnesses without a brainstorming skill still ask well. Outcome and
  verification are never guessed.

## [0.4.0] - 2026-06-28

### Added
- **Clarify Before Looping**: the loop now runs a lightweight requirements
  clarification (acceptance criteria, scope, non-goals, verification) before the
  first iteration, folding the result into the reservation and bound design doc.
- **Choose Your Loop Driver**: the kit defines loop discipline but ships no loop
  engine; the agent selects the mechanism its harness provides (AutoSeek runner,
  Claude Code `/loop` / ralph-loop / background tasks, Codex loop) or falls back
  to manual sequential iteration, running the discipline on top regardless.

## [0.3.0] - 2026-06-25

### Added
- **`ai-dev-kit-clean` subtraction skill** (`/ai-dev-kit-clean`): an
  evidence-gated pass that removes the dead, duplicate, placeholder, and
  low-quality work loop automation accumulates, with three intensity modes
  (`propose` / `assisted` / `sweep`).
  - Produces a work-result summary that classifies and reports all output,
    including non-code work (narrative, art, gameplay/design content) — never
    silently dropped or bulk-deleted.
  - Multi-angle review (reachability, dynamic use, history/intent, coupling,
    domain/non-code) — no single-pass deletion.
  - Cluster deletion with a mandatory orphan sweep, preventing "code deleted,
    test file kept" leftovers.
- **Subtraction-debt gate**: preflight/merge fail when commits since the last
  recorded `/ai-dev-kit-clean` exceed a threshold (recorded in
  `.ai-dev-kit/workflow/subtraction-log.md`). The gate only checks the log; it
  never deletes, and the stop phase stays light.
- **Configurable threshold** via `.ai-dev-kit/profile.yml`
  (`subtraction.every_commits`, scaled by enforcement profile: light 15 /
  balanced 10 / strict 5), resolving as `--subtraction-threshold` > env >
  profile > default 10; disable with threshold 0,
  `AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1`, or `subtraction.gate_enabled: false`.

