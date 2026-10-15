# Cascade Coordination (engine for claims, scheduling, and cross-machine work)

Since 0.8.0 the kit coordinates work through [Cascade](https://github.com/auto-seek/Cascade):
a dynamic-DAG task store with atomic claims,
contract-carrying edges, and event sourcing. It replaces the markdown
feature-ledger as the coordination layer. **Ledger mode is deprecated** —
existing projects get a deprecation WARN from the gate and should migrate
via `/ai-dev-kit-cascade-init`. Version 0.11 retains existing ledger configurations
as an explicit migration path; no removal date is promised. Fresh bootstrap
uses Cascade and repeated bootstrap preserves the existing profile byte for byte.
Design and rationale: `docs/cascade-coordination-design.md` in the kit repo.

## Installation

For a center that admits agents by project ID, use
[cascade-center-agent](../../cascade-center-agent/SKILL.md) and its bundled fixed
runtime. The traditional CLI installation and readiness-report route below do
not apply to that join. To provision such a center, use
[Project ID center](../../ai-dev-kit-cascade-init/references/project-id-center.md).

New installations retain the Cascade >=0.8.0 requirement and native
`--reserved-for` contract. The fixed default release source is Cascade 0.8.1, commit
`689f1f296e1350515842c08522963afd3f387db3` (tag `v0.8.1`), whose `pyproject.toml` declares
version `0.8.1` and **Python >=3.11**. It carries the 0.8.0 event and storage protocol
unchanged plus the supervisor process-cleanup fixes. Have Git and Python 3.11 or newer available
before installation. Cascade is a private/access-controlled repository, not an
anonymous download. Resolve the **approved source remote, full commit and exact
expected version** from the project's center entry. The source remote is not the
coordination state remote or product remote. For GitHub the source URL is
`ssh://git@ssh.github.com:443/auto-seek/Cascade.git`; a company may instead approve
its source mirror containing the same full release commit. Choose that source
before installing; an access failure is not permission to switch sources.
Company Git, self-hosted Git and a reviewed wheel are supported delivery sources;
GitHub membership is not a protocol requirement. The selected identity must have
repository read access and a verified host key. Do not copy personal credentials
or disable SSH host verification.

For the default release, use full commit
`689f1f296e1350515842c08522963afd3f387db3` and expected version `0.8.1`.
The previous default, 0.8.0 at `4400dee8a0e1129e6408578eab4b495168a340ea`, stays an approved source
for environments already installed from it.
If the project already requires a different reviewed pinned runtime, preserve its
source/version and any higher minimum across CLI, worker, renewal and reader
entry points. Do not replace an approved environment merely to match the default
or downgrade it to the historical 0.7 source. New event types still require the
participant compatibility checks below.

### Source installation

Use the approved mirror containing the approved immutable commit. These are
inputs from the center entry, not automatically discovered environment settings
or additional profile keys. Do not substitute a public registry package,
mutable branch, guessed tag, different remote, or older version on failure.

```bash
set -euo pipefail
: "${CASCADE_SOURCE_REMOTE:?approved Git source URL, without git+ or credentials}"
: "${CASCADE_SOURCE_COMMIT:?approved full 40-character commit}"
: "${CASCADE_EXPECTED_VERSION:?approved exact runtime version}"
: "${CASCADE_PYTHON:?explicit Python 3.11+ executable}"
[[ "$CASCADE_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
```

After installation/upgrade is authorized, choose one already available manager:

```bash
pipx install --python "$CASCADE_PYTHON" \
  "cascade-auto @ git+${CASCADE_SOURCE_REMOTE}@${CASCADE_SOURCE_COMMIT}"
```

```bash
uv tool install --python "$CASCADE_PYTHON" \
  "cascade-auto @ git+${CASCADE_SOURCE_REMOTE}@${CASCADE_SOURCE_COMMIT}"
```

Use the selected manager's explicit upgrade/replacement operation for a
conflicting existing installation; do not silently overwrite it. With an
ordinary isolated venv, use that environment's `python -m pip install` with the
same pinned package argument. No source branch name proves the installed
revision: read that environment's PEP 610 `direct_url.json` and verify
`vcs_info.commit_id`, requested revision and approved source URL.

Registry availability is not the release source contract. If source access,
installation or verification fails, report the error and leave configuration
unchanged; do not retry with an older or different source.

For Redis only, select `cascade-auto[redis]` at the same remote/commit.
File and Git storage do not need Redis or that extra. A source repository
may require per-user access; verify its SSH host key and register the
employee's own public key when needed. Never share private keys, disable host
checks, or assume product/coordination access also grants source access.

### Reviewed wheel installation

If the center distributes a wheel, require its exact filename, SHA256,
runtime version and audited source commit in the entry. Verify the received
file hash before installing into the approved isolated environment; then check
the actual import path, version and PEP 610 archive hash. A wheel is an
explicit source choice, not a fallback after source authentication fails.
Dependencies may still require the organization's package index: no GitHub
dependency does not mean fully offline installation.

### Verify actual execution

```bash
command -v cascade
cascade --version
cascade --help
cascade add-node --help
```

The default pinned install must report `cascade 0.8.1`. Compare the actual version
to `CASCADE_EXPECTED_VERSION`, the project's minimum (at least 0.8.0 for new
installations) and required capabilities; `add-node --help` must expose
`--reserved-for`. Resolve PATH shadowing before changing a profile.
Verify the selected interpreter's import location and `python -m pip check`.
For supervised execution also verify `python -m cascade.worker --help` from
that **same** installed environment. Check PATH and the actual scheduled
process/worker bindings, not just an interactive shell. Any failed install,
provenance, capability or authentication check leaves configuration unchanged.

Before the first 0.8-only event is written to a shared namespace, verify the
actual entrypoints that access it: PATH-selected CLI, absolute-path CLI,
supervisor/worker interpreter and scheduled process environment. Reuse verified
compatibility for an unchanged entrypoint and configuration across sessions;
do not collect a new environment report for each conversation. Upgrade or stop
incompatible clients before they access that namespace; changing `min_version` or
updating Kit skills alone does not replace their installed Cascade code. Keep
bootstrap's byte-for-byte preservation of existing profiles, and change their
requirements only through an approved migration after verification. An already
approved, source-verified 0.8 environment need not be reinstalled just to match
the new-install recommendation. A local setup error blocks that worker, not
unrelated compatible workers. An uncontained incompatible client still blocks
the affected protocol migration; no local self-check proves peers have stopped.
Do not downgrade to recover from a new event.

For supervised workers with Kit 0.12, version output alone remains insufficient:
the earlier 0.7 source `4d5c8ae` commits after preflight and invalidates exact-HEAD
receipts. The 0.8 release retains the `aac3814` correction: validate the final
commit before publishing. It also retains the replacement of the intermediate
`c65e2fd` worker's five-second
renewal-stop race with serialized confirmation and draining of in-flight I/O;
expiry, cancellation and errors still block completion. Verify installation
provenance, not just the mutable branch name.

## Profile

```yaml
coordination:
  engine: cascade            # 'ledger' remains deprecated for existing configurations
  role: self-serve           # or: orchestrator | worker — every machine/session declares one
  cascade:
    storage: file            # single-machine default; 'git' cross-machine; 'redis' low latency
    storage_path: .ai-dev-kit/cascade   # file mode; MUST stay gitignored (see below)
    git_remote: ""           # git mode: remote name, URL, or bare-repo path
    git_cache: ""            # git mode: optional machine-local cache
    redis_url: ""            # redis mode; rediss:// supported
    namespace: <project>     # git/redis mode; one graph per project/epic
    min_version: ">=0.8.0"   # fresh default; existing requirements are not auto-rewritten
```

Run `/ai-dev-kit-cascade-init` to set this up interactively (probes the
CLI, offers install, smoke-tests the chosen storage, writes the profile).
The wizard is idempotent — re-run it to change storage or role.
For a new project's shared center, follow [Project center](project-center.md);
each project gets its own approved entry and planner, even on a shared server.
For a move or failed access, follow [Migration and access recovery](center-access.md).
Joining an existing team instead follows [Worker enrollment](worker-enrollment.md):
discover its approved configuration, check real access/environment, and retain one
native report node for the first join. Reuse unchanged machine checks and the
matching report across sessions. This route does not default to a new store.

### Actual-runtime self-check

```bash
node <kit>/scripts/cascade-lane.cjs --profile <main-profile> --agent <id> \
  --python <actual-Cascade-Python> doctor [--dispatch <dispatch.json>]
```

The JSON result separates `runtime`, `protocol`, `center` and `dispatch`: the
selected runtime's 0.8/retry support, existing center graph/event parsing/hash
chain, and optional native `WorkerConfig.from_dict` validation of dispatch,
center/agent and finite renewal settings. It executes no dispatch commands.
Protocol compatibility does not prove center readability; a center error still
blocks dependent operations. Invalid local dispatch exits non-zero without
erasing successful protocol checks. Keep the same `--python` on later lane
commands; without it they retain the PATH-selected `cascade` behavior.

This is a bounded setup check, not a report node, credential, full worker acceptance
or product gate. It does not mutate business tasks or profiles, certify all other
entrypoints, or replace source/access checks; source provenance is recorded, not
certified. Native storage queries can update locks, cache or clock metadata, but
not business nodes. Reuse unchanged setup facts in existing notes, not a new
per-session proof file. Reuse never overrides errors from current coordination calls.

### Machine-local overlay (`profile.local.yml`)

`profile.yml` is often committed (so worktrees and teammates share the
config), which means a redis URL with an embedded password must NOT live
there. Put the machine-local coordination config in
`.ai-dev-kit/profile.local.yml` — same block shape — and keep it
**gitignored** (init-skill appends the ignore entry; check it if the
project predates this):

```yaml
coordination:
  # Machine-local coordination overrides — NEVER commit this file.
  cascade:
    storage: redis
    redis_url: "redis://:<password>@127.0.0.1:6379"
    namespace: <project>        # only if the tracked profile doesn't set it
```

The overlay MUST carry `storage: redis`, not just the URL: the gate selects
the backend from `cascade.storage` before it reads `cascade.redis_url`, so
against a tracked `storage: file` baseline a URL-only overlay is dead config
and the gate silently checks the (empty) local file store. This shipped
broken in 0.8.3; 0.8.4's `--local` writes the storage key too.

Write it with the shared helper:
`node <kit>/scripts/set-coordination.cjs --profile .ai-dev-kit/profile.local.yml --local --redis-url "<url>" --namespace <project>`.

The gate and lane wrapper read the MAIN checkout's profile and overlay **per
key**, including when a linked worktree contains a tracked `.ai-dev-kit`.
File storage and relative cache paths resolve from that same main checkout.
One configuration and workflow evidence directory serve every linked worktree.
The tracked baseline keeps `redis_url: ""`.
Precedence for `cascade.redis_url`: `AI_DEV_KIT_CASCADE_REDIS_URL` env var >
`profile.local.yml` > `profile.yml`. (An overlay cannot set a key to
explicit empty — an absent/empty overlay key falls through to the tracked
value.)

## The self-serve loop (default)

One agent both reserves and completes its own work; there is **no separate
orchestrator handing out tasks**. Always use the lane wrapper so the same flow
remains safe if the storage later becomes shared. It resolves the main-checkout
profile and calls Cascade >=0.7.0 with canonical `id=<slug>` and
`reserved_for=<agent>`. The engine checks unique IDs and owner eligibility
inside its storage transaction. Two concurrent publishers of the same slug
cannot both reserve it. Legacy `<slug>@<agent>` graphs require explicit migration
before any wrapper operation; see `docs/coordination-0.7-migration.md` in the kit.

```bash
# 1. RESERVE — where the ledger flow would add a reservation:
AGENT="<machine-or-session-id>"
lane() { node <kit>/scripts/cascade-lane.cjs --profile .ai-dev-kit/profile.yml --agent "$AGENT" "$@"; }
lane add --slug <slug> [--required-tier lite|pro|max]

# 2. CLAIM — mark it in progress (moves the node to ACTIVE) and retain its token:
CLAIM="$(lane claim --slug <slug> [--agent-tier lite|pro|max])"
TOKEN="$(printf '%s\n' "$CLAIM" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
test -n "$TOKEN"  # stop if the briefing did not contain a token
#   get-task prints a human-readable briefing ending in "fencing_token: N".
#   Workers omit --slug to let the engine select eligible shared/own READY work.

# During work, renew before the finite task lease expires (default 1800 seconds):
lane renew --slug <slug> --token "$TOKEN" --timeout 1800

# 3. FINISH — commit all intended changes, then run preflight, then finish.
#    Preflight executes the tracked gate-contract.json project argv and binds
#    exact HEAD and working inputs; no post-preflight ledger-flip commit.
#    At ready-for-review, AFTER preflight is green, record completion
#    WITH the evidence the merge gate requires:
lane finish --slug <slug> --token "$TOKEN" \
  --summary '<one-line outcome>' --critical '<json, e.g. {"git_ref":"<sha>"}>'
#   moves the node to COMPLETED. The merge gate FAILs until it is.
```

The token is scoped to that node claim. A later claim of the same node gets a
new token, so an earlier holder cannot finish or renew it; claims on other nodes
do not invalidate it. Pass the same `--agent` and `--token` to `renew-task` when
extending a lease. To send work back to READY use `finish-task --task <slug>
--agent "$AGENT" --token "$TOKEN" --release` (or `--fail --reason <why>` with
the same identity and token). A full corrective-node `rework` is an advanced
multi-node operation (see `cascade rework --help`), not part of the routine
self-serve loop. Under `engine: cascade`, `--discovery`/`--ev` target selection
collapses to "claim the next READY node"; the scanning selectors apply only
when the graph is empty.

For a shared team pool, an orchestrator publishes with `lane add --open`; the
default add remains a private reservation for the publishing agent. An explicit
`--reserved-for` assigns ownership. Claims and renewal use a positive finite
`--timeout` (profile `coordination.cascade.lease_seconds`, default 1800 seconds).
This is not an automatic heartbeat: the harness must renew while working and
stop work/publication on loss of ownership. `lane release --slug <slug> --token
<token> --reason <reason>` returns owned work to the queue. `finish --deliveries
'{"downstream-id":"verified artifact location"}'` fulfills actual promised
edges; it does not substitute a summary for required deliveries.

All lane and gate Cascade calls use the same POSIX process supervisor: Git
command budget defaults to 180 seconds, file/Redis to 30 seconds. Configure
`coordination.cascade.command_timeout_seconds` or
`AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS` explicitly (positive, at most 3600).
Timeout/cancellation terminates the owned process group; it does not undo a
remote transaction. Inspect remote state before retrying a write. Windows
workers require WSL. Cloud errors never trigger a file-store fallback.

Normal implementation, test and review corrections inside an authorized task
continue without another approval. A terminal FAILED task is different: only an
orchestrator with an existing bounded retry authorization may use `lane retry
--slug <id> --failure-event <exact-event-id> --op-id <stable-operation-id>
--reason <reason>` with Cascade >=0.8.0. First confirm protocol compatibility,
that the old execution stopped, and its publication result. This native retry
does not claim or grant authority; preserve the operation ID and read back an
unknown write before deciding the next step. See `docs/team-loop-recovery.md`.

The orchestrator/worker split and batch delegation below are **only** for
multi-machine or fan-out pipelines — a single-machine loop never needs them.

## Capability tiers (portable across harnesses)

Use `lite < pro < max` as a minimum capability requirement, never a concrete
model name. A publisher may create `add-node --id <slug> --required-tier max`;
a worker declares its actual configured capability with `get-task --agent <id>
--agent-tier pro`. Generic pulls skip work above the declared tier, while an
explicit under-tier claim is rejected. Untiered nodes remain claimable by all
agents for backward compatibility.

For self-assessment, a worker either declares its actual tier before a generic
pull, or reads `list-nodes` (which exposes `required_tier`) before explicitly
claiming a named node. The atomic claim remains the final step, so this does not
reintroduce a read-then-write ownership race.

Native ownership and tier enforcement require Cascade >=0.7.0 in all storage
modes; new installations select >=0.8.0 as described above. The wrapper forwards
both tier flags; the engine filters owner and tier eligibility during the atomic
claim. Upgrade an older CLI before using the workflow; never silently drop a
requested tier or ownership constraint.

Estimate requirements from the work, not from who is currently idle:

- `lite`: bounded mechanical edits, searches, formatting, or narrow tests;
- `pro`: normal implementation, debugging, and scoped review;
- `max`: ambiguous architecture, security-sensitive changes, cross-system
  reasoning, or high-cost failure modes.

AutoSeek resolves these names through its existing global tier aliases. Other
harnesses pass the closest tier manually or omit tiering for unclassified work.
An agent must assess its configured model before pulling and must not claim a
higher tier merely to empty the queue. This is a scheduling guard, not an
authentication boundary: a worker can still overstate its capability.

## Concept mapping

| kit concept | Cascade | notes |
|---|---|---|
| reservation | `cascade add-node --id <slug> --reserved-for <agent>` | canonical slug is the atomic uniqueness key; omit reserved_for for shared work |
| difficulty / model routing | `required_tier` (`lite < pro < max`) | harness maps the abstract tier to a concrete model |
| reserved/active status | READY / ACTIVE (after claim) | claim is atomic — no read-then-write race |
| Goal / expected deliverable | edge contracts (`expectation` / `promise`) | downstream sees them on claim |
| merged + verification evidence | `finish-task` with summary + critical | `produced_at`/`git_ref` auto-attached, flows downstream |
| coordination notes (dependencies) | DAG edges | machine-enforced, not prose |
| review finding → rework | `rework` | event-sourced, carries reason |
| "someone else's active entry" | ACTIVE protection | engine refuses remove/split |
| design-doc / expected-tests binding | *(not a first-class node field in the CLI)* | carry the paths in the design doc and `--expectations` contracts; Cascade mode machine-enforces node state, not these metadata fields, so preflight must verify the referenced files directly |

## Roles

- **self-serve** (the default, 0.9.0): the agent plans its own work items into
  the graph and executes them itself — the single-machine loop above,
  generalized to a SHARED store. On a single machine it behaves exactly like
  that loop. In a shared namespace its additions must not collide with peers
  or get claimed by them. Cascade's native `reserved_for` field carries
  ownership, while the canonical slug is the unique task ID. Always go through
  `scripts/cascade-lane.cjs` to use the shared project configuration:

  ```bash
  node <kit>/scripts/cascade-lane.cjs --profile .ai-dev-kit/profile.yml --agent <id> \
    add --slug <slug> [--deps a,b] [--required-tier lite|pro|max]
  node <kit>/scripts/cascade-lane.cjs --profile .ai-dev-kit/profile.yml --agent <id> \
    claim --slug <slug> [--agent-tier lite|pro|max]
  node <kit>/scripts/cascade-lane.cjs --profile .ai-dev-kit/profile.yml --agent <id> \
    finish --slug <slug> --token <t> --summary '<evidence>'
  ```

  Any number of self-serve agents can share a namespace; they coexist with a
  graph-building orchestrator and pool workers. The merge gate matches the
  branch slug to the canonical node ID and requires COMPLETED. Never reserve
  work for yourself if someone else should be able to pick it up —
  shared pool work is plain `add-node --id <slug>` (orchestrator's call).
- **worker** (for extra machines/sessions): inspect, claim, renew and finish/release
  owned tasks; propose rework or new ideas to the center. Claims are atomic.
  A worker loop's target selection is "claim the next eligible READY task";
  an empty pool is idle, not authorization to create business work.
  **Workers cannot claim another agent's reservation.** Use
  `cascade-lane.cjs claim` without `--slug`; the engine chooses eligible READY
  work atomically, excluding other owners and requirements above the declared
  tier. Targeted claims apply the same owner and tier checks.
- **orchestrator** (exactly one per namespace): builds and mutates the
  graph (`add-node`, `split-node`, `refine-node`, `remove-node`,
  `edit-node`). Git mode uses one explicitly assigned planner; it has no
  automatic planner election or cross-center lease. A Git state lock is only a
  transaction lock, not ownership of the longer-running planning role.
  In Redis mode an authorized candidate acquires the TTL lease key
  (`cascade:{ns}:orchestrator-lease`) wins and a second gets a refusal
  (exit 2). Acquire before mutating the graph, `renew` on a heartbeat while
  orchestrating, `release` when done:
  `scripts/cascade-lease.sh acquire|renew|release --redis-url <url> --namespace <ns> --holder <id>`.
  All three are atomic — a holder can never release or renew another's lease.
  Missing Redis support, an unreachable server, or an operation failure exits
  non-zero; the helper never reports an unenforced lease as success.
  Multiple orchestrators = multiple namespaces, one graph per epic.

During execution, workers never rewrite the profile, mutate the business graph,
or merge. [Enrollment](worker-enrollment.md) is the narrow setup exception:
authorized local initialization, an isolated permission probe, and creation /
completion of the first join's own reserved report node, reused across sessions.
An identity-only update reuses unchanged environment checks. It grants no task-planning
authority. Role, agent ID and tier remain collaboration rules, not Git ACLs.
The coordinator/delegate division of `delegation.md` still applies to delegated
implementation; Cascade mechanizes the authorized claim/report operations.

**Why one orchestrator — and why this is not the old ledger race:** claiming
and finishing are *atomic* store operations, so any number of agents claiming
and reporting in parallel is safe — that is precisely what fixes the markdown
ledger's read-then-write races, not something to avoid. Only *graph mutation*
(deciding what the tasks are and how they depend) is single-writer, and for
plan *coherence*, not data safety — you don't want two agents restructuring the
plan at once. So "any agent can write" is fine for claims and reports; the plan
just has one author at a time.

## Spawning worker agents (batch delegation)

For structured implementation pipelines, prefer PULL over PUSH: the publisher
builds the graph (nodes carry contracts, `required_tier`, and metadata such as
design_doc, expected_tests, branch), then any number of generic workers claim
their own eligible work and each loop:

```
while tasks_done < cap (default 3):
    briefing = get-task --agent <worker-id> [--agent-tier <lite|pro|max>]
        # claims next eligible READY task, critical-path first
    token = parse briefing's fencing_token
    execute per the claim view (upstream summary/critical arrives with it)
    run the project health gate + preflight (receipt)
    finish-task --task <slug> --agent <worker-id> --token <token> --success --summary <report> --critical <facts>
exit with a short roll-up when the queue is dry or the cap is hit
```

Why pull beats per-agent static briefs: slice durations vary wildly, so
static assignment strands capacity; DAG edges make dependency waves
disappear (a node isn't READY until its upstream completed); upstream
findings flow into downstream claims automatically instead of the
coordinator hand-copying them between briefs; and the coordinator only
wakes for decisions (rework, graph changes, review), not per-completion.
The per-worker task cap bounds context growth — respawning a fresh worker
is cheaper than one bloated one.

Verification stays first-class: model review as a downstream verify node
(claimed by the orchestrator or a dedicated reviewer worker) that either
completes or `rework`s the implementation node — "reports are claims, not
evidence" (delegation.md) becomes graph structure.

Static one-shot briefs remain right for exploratory fan-out (research
sweeps, discovery) where the work isn't yet node-shaped.

## Storage

- **file** (single machine, default): the store lives at
  `coordination.cascade.storage_path` and **must stay gitignored**. Two
  reasons this is a hard rule: `git worktree add` would fork the store
  into per-worktree copies (file locks cannot protect divergent copies —
  the single source of truth fragments), and claims are real-time mutual
  exclusion that git's after-the-fact conflict resolution cannot repair
  (both sides already did the duplicate work by the time you see the
  conflict). Run all `cascade` commands with
  `--storage <main-repo>/.ai-dev-kit/cascade` from worktrees.
- **redis** (cross-machine — the "remote collaboration center"): all machines
  point at one Redis (`--redis-url ... --namespace <project>`, one graph per
  namespace); `rediss://` for TLS. Coordination metadata is tiny — latency is a
  non-issue. This is the form for a team/company: one shared atomic store every
  agent reads and writes, with the orchestrator elected via the lease above and
  run on any one machine the company chooses.

  **The remote store must be a real atomic store — never a synced file.** Do
  not back cross-machine coordination with a shared/synced network drive or a
  cloud-drive *file* (the file-mode store on Dropbox/Drive/NFS-sync): those sync
  and merge *after the fact*, so two machines each mutate their own copy and
  only discover the collision once both have already done the duplicate work —
  exactly the markdown-ledger race this engine exists to remove, and the same
  reason the file store must never be forked into worktrees. Cross-machine
  coordination needs live atomic operations. Redis is the current low-latency
  implementation, not an architectural requirement.

- **git (recommended Redis-free cross-machine backend)**: Cascade stores graph
  snapshots/events on dedicated remote refs and uses atomic ref
  compare-and-swap for reservation/claim/finish. This reuses Git credentials
  and history with no service to operate, at the cost of fetch/push latency and
  polling. Configure `git_remote` as a project remote name (for example
  `origin`), URL, or bare-repository path; the gate and lane wrapper resolve a
  remote name through the project repository. Prefer a dedicated coordination
  repository so `cascade-state/*` and `cascade-lock/*` refs do not trigger CI.
  The configured identity needs write access to both state and transaction/lease
  refs even for normal reads: a read can enter a storage transaction. Read-only
  repository access is not sufficient for the initialization round trip.
  Local/container E2E, process-kill injection, a 1,000-attempt contention soak,
  GitHub SSH-over-443, and CODING HTTPS have passed. Transactions renew a
  120-second lease, honor a 5-second recorded clock-skew tolerance, shallow
  fetch the active snapshot, and support `cascade compact` for archived history.
  See `docs/git-coordination-backend.md`.

Durability: the graph is working state, not the durable record (that's
design docs + commits + the event log). File mode loses the graph if the
machine dies — acceptable; use git/redis mode or the backup export if not.

## Backup export (one-way)

On each `/ai-dev-kit-clean` pass (or on an orchestrator cadence), export
human-readable history and commit it:

```bash
cascade --storage .ai-dev-kit/cascade history > docs/development/cascade-history.md
```

The engine NEVER reads this back — it is backup and history, not a sync
bridge. Do not build tooling that reconciles it with the store.

## Gate behavior

| condition | enforced behavior |
|---|---|
| engine=cascade, CLI/storage/JSON valid | query `list-nodes`; receipts unchanged |
| merge node not `COMPLETED` | **FAIL** |
| preflight node not `ACTIVE` | **FAIL**; readiness requires a live fenced owner |
| no node matches branch slug | **FAIL** for branch-scoped work |
| branch has a further segment after `<owner-or-type>/<canonical-task-id>` | **FAIL** naming the expected shape |
| CLI missing, invalid config, storage error/timeout, malformed JSON | **FAIL** with actionable context |
| installed version below or unparseable against `min_version` | **FAIL** |
| stop phase | no coordination I/O; stop remains the light explicit-findings gate |
| legacy @lane IDs | **FAIL** with the explicit migration path; no mixed ownership scheme |
| engine=ledger *or unset* | deprecated existing-project migration path; bootstrap preserves it |
