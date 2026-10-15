---
name: ai-dev-kit-cascade-init
description: "Set up a project Git task center, including an AutoSeek web center with project-ID admission, or repair/migrate coordination access. Route project-ID joins to cascade-center-agent and graph viewing to cascade-flow; retain the local storage/role wizard for traditional centers."
---

# AI Dev Kit Cascade Init

First resolve the intended project and its configured center; there is no built-in project or server address. Then select the route below. Joining by project ID and viewing a graph do not
require the setup wizard, profile changes or a readiness-report task. For the
traditional local/storage wizard, read [Cascade coordination](../ai-dev-kit/references/cascade-coordination.md)
first — it defines the profile shape, concept mapping, roles, storage modes, and gate
degradation contract you are wiring up. The design rationale is in
`docs/cascade-coordination-design.md` in the kit repo.

## Route by the user's intent

- **Join with a project ID and model level:** use
  [cascade-center-agent](../cascade-center-agent/SKILL.md). The center issues
  task-state Git access; the agent then checks its own product Git access.
  This route does not use the legacy enrollment report or local setup wizard.
- **View tasks or start a local graph:** use
  [cascade-flow](../cascade-flow/SKILL.md). Reading a graph does not require
  creating a center, registering an agent or claiming a task.
- **Build a shared center with project IDs, AutoSeek login and a web UI:** use
  [Project ID center](references/project-id-center.md). This uses the complete
  approved CascadeCenter-web release, not the kit's historical portal. Prefer
  adding a project to an existing authorized deployment when one is available.

- **Create a Git-only center with the traditional entry configuration:** read
  [Project center](../ai-dev-kit/references/project-center.md). Discover the
  company's approved hosting and project entry, provision only within actual
  authority, then initialize a new Git graph and its project-specific planner.
  Do not join another project's graph or choose file/self-serve for a requested
  cross-machine center.
- **Migrate a center or fix access after migration:** read
  [Migration and access recovery](../ai-dev-kit/references/center-access.md).
  Preserve history and task ownership; verify each actual participant's new
  access before resuming it. A center's successful smoke does not prove worker
  authorization. Authentication failures are not permission to waive gates.
- **Join a traditional center without project-ID admission:** follow
  [Worker enrollment](../ai-dev-kit/references/worker-enrollment.md).
  Discover the approved configuration, verify the employee's actual access and
  environment, and deliver the first join's native report once. Reuse matching
  reports and unchanged machine checks across sessions; an identity update does
  not repeat environment validation. Use its `lane doctor --python
  <actual-Cascade-Python>` check, which is not itself a report or admission
  approval. Do not ask for a setup questionnaire, create a new store, default
  the shared project to file/self-serve, claim business work or run the local
  wizard a second time.
- **Local setup or an explicit storage/role change:** use the wizard below.
  Defaults apply only when the user has not already specified a shared center.

The traditional setup routes reuse the probe, install, isolated smoke and profile
helpers below. The project-ID and viewing routes stop at their linked skills;
do not continue into this wizard. Keep company addresses, project IDs, approved
runtime sources and key enrollment in that company's/project's entry document,
not hard-coded into this reusable skill.

**Storage-wizard invariant:** the wizard is idempotent and
never leaves a half-configuration. Do not change the profile or overlay until
installation and the selected storage's isolated smoke test have succeeded.
Preserve their exact prior contents before writing. If any probe, install,
smoke test, or write fails, stop and leave or restore both files exactly as they
were. A failed run must leave a project that still gates correctly under its old
engine. For an existing-center cutover, rollback of local files must not resume a
fenced old source: follow the migration route's stop-and-reconcile procedure.

For unspecified local setup, prefer **storage =
file**, **role = self-serve** (the agent plans its own work items into the
graph and executes them itself — right for a single agent per checkout, and
safe in shared namespaces via canonical IDs and native reserved_for; see the Roles section of the
reference). Only prompt the user where a choice genuinely matters (install vs
skip, redis credentials, optional ledger import). If you cannot get an answer,
take the conservative default and record any deferred decision rather than
stalling.

The non-interactive equivalent (file storage, self-serve) is
`bash bootstrap/init-skill.sh <project> --coordination cascade`, which calls
`scripts/set-coordination.cjs`. Use that same helper to write the block so the
profile stays consistent.

## 1. Probe for the cascade CLI

Probe the executable already selected by PATH; do not implicitly download a
registry package as a probe:

```bash
command -v cascade
cascade --help
cascade --version
cascade add-node --help
```

- Found → require a parseable `cascade --version` of at least 0.8.0 and verify
  `add-node --help` exposes `--reserved-for`. An older or unparseable executable
  cannot satisfy the new installation contract: upgrade before changing config.
- Not found → offer to install (step 2).

## 2. Offer install (or skip)

If the CLI is missing or incompatible, ask whether to install or explicitly
upgrade it. Follow **Installation** in the core skill's
[`references/cascade-coordination.md`](../ai-dev-kit/references/cascade-coordination.md#installation):
it is the single source for the fixed commit, Python requirement, copyable
pipx/uv source-install commands, Redis extra,
and executable/version/provenance verification. Before the first 0.8-only event,
verify compatibility of actual CLI/worker entrypoints accessing the namespace
and stop incompatible clients. Reuse unchanged entrypoint/configuration checks,
not per-session reports; local setup faults block only the affected worker.
A local doctor result cannot prove that other processes stopped. Updating Kit
or profile text alone is insufficient. Bootstrap preserves old
profiles; this wizard changes them only as an explicitly approved migration.
Do not substitute an unpinned registry
package, `main`, or a guessed release tag.

- Install succeeds → perform every executable/version/capability check in that
  reference before continuing.
- User declines, or install fails → do **not** switch the engine. Leave the
  project on its current engine (ledger stays ledger). Report an installation
  error as an error, not a successful skip. If the existing engine is ledger,
  its deprecation WARN remains; an existing Cascade engine retains its normal
  fail-closed checks. The profile is untouched.

## 3. Choose storage (default: file)

Present the choices with **file highlighted as the recommended default**:

- **file** (recommended, zero-config): single machine, multiple worktrees/agents.
  `storage_path` = `.ai-dev-kit/cascade`. FileStorage's lock is complete on one
  machine.
- **git** (recommended for cross-machine work): Redis-free collaboration through a
  dedicated Git remote-ref state/lease protocol. Prompt for `git_remote`
  (project remote name such as `origin`, URL, or bare-repository path) and
  `namespace`; `git_cache` is an optional machine-local path. Prefer a
  dedicated coordination repository and require Cascade 0.8+ with
  `--git-remote` and `compact` support before offering this choice.
- **redis**: cross-machine collaboration. Prompt for `redis_url` (supports
  `rediss://` for TLS) and `namespace` (default: the project directory name).
- **none**: do not use Cascade; keep ledger mode. Write `engine: ledger` and
  note that ledger is deprecated and retained only for explicit existing-project
  migration. Version 0.11 does not remove it. Stop after step 5.

Before writing any storage configuration, run the exact round trip in step 6
with an isolated target: a new temporary directory for **file**, or a fresh
`<namespace>-initsmoke-<uuid>` namespace for **git/redis**. Git also uses a new
temporary cache and the resolved remote URL/path. Redis uses the requested URL
and requires the pinned install's Redis extra. The round trip creates a unique
legal node ID reserved to a unique smoke agent, so a generic worker cannot take
the probe. Never claim, remove, or reuse an existing node after an add failure.

Git requires write permission to state and transaction/lease refs, including
for normal reads; read-only repository access is insufficient. Failed CAS,
authentication, ref-policy, connectivity, or lifecycle checks leave the previous
profile untouched. Report the error and let the user correct the selected
configuration or explicitly choose storage again; never switch backends
silently. Every selected remote must pass the smoke test before it is configured.

## 4. Choose role (default: self-serve)

- **self-serve** (the default): the agent adds its own work items to the graph
  and executes them itself, via `scripts/cascade-lane.cjs` (canonical IDs plus
  atomic `reserved_for` checks prevent duplicate reservations). Right for one
  agent per checkout — single-machine file mode AND a machine joining a shared
  git/redis namespace to run its own improvement loop.
- **orchestrator**: builds and mutates the shared graph for a worker pool;
  exactly one per namespace. Redis can lease-elect it; Git mode uses an
  explicitly assigned single planner (transactions remain CAS-safe, but the
  longer-lived planning role is not leader-elected).
- **worker**: claim and finish only, from the unreserved pool.

## 5. Write the coordination block (idempotent)

Only now, after the chosen storage passed its smoke test, write the block with
the shared helper — it replaces any existing `coordination:` block in place and
never duplicates it:

```bash
# file mode
node <kit>/scripts/set-coordination.cjs \
  --profile .ai-dev-kit/profile.yml \
  --engine cascade --role <role> \
  --storage file --storage-path .ai-dev-kit/cascade --namespace <project>

# redis mode — TWO writes: the tracked profile stays secretless (redis_url ""),
# the real URL goes to the gitignored profile.local.yml overlay. The gate reads
# the overlay per key over the tracked profile (and resolves it from the main
# worktree, so one overlay serves every linked worktree). The overlay carries
# `storage: redis` too, so it also works over a tracked `storage: file`
# baseline (e.g. a repo whose shipped default is file mode).
node <kit>/scripts/set-coordination.cjs \
  --profile .ai-dev-kit/profile.yml \
  --engine cascade --role <role> \
  --storage redis --redis-url "" --namespace <namespace>
node <kit>/scripts/set-coordination.cjs \
  --profile .ai-dev-kit/profile.local.yml \
  --local --redis-url "<redis_url>" --namespace <namespace>

# git mode — remote may be a project remote name, URL, or bare-repo path
node <kit>/scripts/set-coordination.cjs \
  --profile .ai-dev-kit/profile.yml \
  --engine cascade --role <role> --storage git \
  --git-remote <origin-or-url-or-path> --namespace <namespace>

# none: keep ledger (deprecated)
node <kit>/scripts/set-coordination.cjs \
  --profile .ai-dev-kit/profile.yml --engine ledger --role <role>
```

(For ad-hoc runs and CI, `AI_DEV_KIT_CASCADE_REDIS_URL` overrides the
resolved `cascade.redis_url` — precedence env > overlay > tracked profile.)

Then ensure the file-mode store stays **gitignored** (hard rule — worktree
`git add` would fork the store and file locks cannot protect divergent copies),
and the secrets overlay likewise (even if profile.yml itself is committed).
Append only if missing:

```bash
grep -q '.ai-dev-kit/cascade' .gitignore || printf '\n# Cascade coordination store (file mode)\n.ai-dev-kit/cascade/\n' >> .gitignore
grep -q '.ai-dev-kit/profile.local.yml' .gitignore || printf '\n# AI Dev Kit machine-local coordination secrets\n.ai-dev-kit/profile.local.yml\n' >> .gitignore
```

## 6. Final smoke test on the REAL configured storage

Run a full round trip against the storage you just wrote to the profile. In Bash,
set `CASCADE_ARGS` to exactly that storage (step 3 instead uses its isolated
target), then execute the following lifecycle unchanged:

```bash
# Choose one, resolving paths from the main checkout:
CASCADE_ARGS=(--storage .ai-dev-kit/cascade)
# CASCADE_ARGS=(--git-remote "<remote>" --namespace "<ns>" --git-cache "<cache-dir>")
# CASCADE_ARGS=(--redis-url "<url>" --namespace "<ns>")
```

```bash
(
set -eu
SUFFIX="$(node -p 'require("node:crypto").randomUUID()')"
SMOKE_ID="init-smoke-$SUFFIX"
SMOKE_AGENT="init-agent-$SUFFIX"
printf 'Smoke task: %s; agent: %s\n' "$SMOKE_ID" "$SMOKE_AGENT"
cascade "${CASCADE_ARGS[@]}" add-node --id "$SMOKE_ID" --reserved-for "$SMOKE_AGENT"
# Target only our successfully added node, never another READY task.
OUT="$(cascade "${CASCADE_ARGS[@]}" get-task --agent "$SMOKE_AGENT" --task "$SMOKE_ID" --timeout 300)"
TOK="$(printf '%s\n' "$OUT" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
test -n "$TOK"  # stop: never finish without the token returned by get-task
cascade "${CASCADE_ARGS[@]}" renew-task --task "$SMOKE_ID" --agent "$SMOKE_AGENT" --token "$TOK" --timeout 300
cascade "${CASCADE_ARGS[@]}" finish-task --task "$SMOKE_ID" --agent "$SMOKE_AGENT" --token "$TOK" --success --summary "init smoke"
NODES="$(cascade "${CASCADE_ARGS[@]}" list-nodes)"
printf '%s\n' "$NODES" | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => { const result=JSON.parse(text); const task=result.data.nodes.find(n => n.id === process.argv[1]); if (result.success !== true || task?.state !== "COMPLETED" || task.reserved_for !== process.argv[2]) process.exit(1); });' "$SMOKE_ID" "$SMOKE_AGENT"
cascade "${CASCADE_ARGS[@]}" remove-node --node "$SMOKE_ID"
NODES="$(cascade "${CASCADE_ARGS[@]}" list-nodes)"
printf '%s\n' "$NODES" | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => { const result=JSON.parse(text); if (result.success !== true || result.data.nodes.some(n => n.id === process.argv[1])) process.exit(1); });' "$SMOKE_ID"
)
```

The UUID suffix and alphanumeric prefix satisfy Cascade 0.7's ID rules without
sharing a fixed probe ID. Stop at the first failure; retain the printed task ID
for diagnosis, and never run unconditional cleanup that might remove a node this
attempt did not successfully create. This requires Node.js, already required by
the kit, and Bash arrays; do not execute it as a POSIX `sh` script.

Notes on the CLI contract (verified against cascade-auto): `add-node` takes
`--id` (plus optional `--deps`/`--expectations`). `get-task --agent <id>` claims
the next READY node (or `--task <id>` for a specific one), prints a human-readable
briefing ending in `fencing_token: N`, and moves the node to ACTIVE. Preserve
that numeric token. **Never run a bare `get-task` against a live store** — it
claims an ARBITRARY ready node; always pass `--task` when you mean a specific
one. `finish-task --task <id> --agent <same-id> --token <N>
--success` (optionally `--summary`/`--critical`) marks it COMPLETED. Missing or
stale tokens are rejected; passing a different agent is rejected.
`remove-node --node <id>` (no `--reason`). `list-nodes` emits JSON with
`data.nodes[].id`/`.state` and a top-level `success` bool (exit 0 on success).
States are `READY` / `ACTIVE` / `COMPLETED`.

If the final smoke test fails, restore the exact prior profile and overlay and
report the error — do not merely reset the engine while retaining failed storage
fields, and do not switch to ledger or another backend. Never leave
`engine: cascade` pointing at a storage that did not round-trip.

## 7. Optional: import existing ledger entries

If the project has a markdown feature-ledger with `reserved`/`active` entries,
offer a **one-shot** import of those as nodes:

```bash
cascade <ARGS> add-node --id <slug>   # one per reserved/active reservation
```

`merged` entries are **not** imported — they stay in the markdown history as the
durable record. This is a one-way seed, not a sync bridge; the engine never
reads the ledger back. If the user declines, skip it — the graph can be built
later with `/ai-dev-kit-loop`.

## Done

Report: the CLI version, the chosen storage/role, the smoke-test result, and
that the gate now routes coordination checks through the store. Remind the user
that re-running `/ai-dev-kit-cascade-init` is the supported way to change
storage or role (it rewrites the same block).
