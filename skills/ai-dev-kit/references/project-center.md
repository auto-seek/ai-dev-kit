# Create a project's company Git center

For project-ID admission, AutoSeek login and a shared task website, start with
[Project ID center](../../ai-dev-kit-cascade-init/references/project-id-center.md).
This guide covers the underlying Git resource lifecycle, not a complete modern
Portal deployment.

Use this route when the user asks to create a center for another project. One
project has its own coordination repository, namespace and assigned planner;
several projects may share a company Git host. The host stores state and leases,
not model sessions. A center Agent runs in a working harness on the owner's
computer or an explicitly provisioned execution host. Workers run separately.

## 1. Establish which operation is authorized

Discover the main checkout, project instructions/profile/overlay, product remote,
team entry document and any company Git administration runbook or management
entry point. Inspect relevant environment overrides without printing secrets.
Use these facts, not another project's address, namespace or agent ID.

- An existing center means [join](worker-enrollment.md), unless the user asked
  for migration or planner handover. Do not create a second graph for it.
- A new project center requires an approved dedicated coordination repository
  and namespace, distinct from the product repository. Record the exact URL,
  product baseline/target branch, project owner, administrator and sole planner
  identity. Do not move the product remote as part of center setup.
- Moving existing state follows [Migration and access recovery](center-access.md):
  freeze/drain before taking the final source snapshot, preserve history and
  ownership, and verify each actual client. An empty destination is not permission
  to initialize a replacement graph or operate two writable authorities.

If the management entry point or authority is missing, give one concrete opening
request to the administrator: project/product URL, proposed dedicated repository
and namespace, owner/planner, required identities and public-key fingerprints,
required Git operations, and the verification/backup plan below. Ask only for
facts that cannot be discovered. Do not request a root password, copy private
keys, use a peer's credentials, or bypass the coordination gate while waiting.

## 2. Provision through the company's existing Git administration path

Prefer the company's existing Git hosting and access controls. If the approved
host only has Git and OpenSSH, reuse its reviewed provisioning procedure; do not
invent a registration API, scheduler or Git transport. Inspect running services,
storage and the approved resource boundary before changing a shared server.

The administrator creates an empty bare repository only at the approved new
path (for example, `git init --bare "$APPROVED_NEW_REPO"` after confirming the
path does not exist), and applies the host's ownership and Git-only access
policy. The [Git server guide](https://git-scm.com/book/en/v2/Git-on-the-Server-Setting-Up-the-Server)
documents bare repositories and SSH public-key access. `git-shell` limits shell
commands, but does not by itself isolate projects or disable SSH forwarding.

The opening must include:

- A separate revocable identity/key for each employee device or approved service.
  Verify the server host key through a trusted channel. Register only public
  keys and fingerprints; private keys stay on their originating machines.
- Repository ACLs or a reviewed forced-command/path restriction, plus no shell,
  PTY, forwarding or access to unrelated repositories for Git-only identities.
  A namespace, role, agent ID or declared model tier is not an authorization
  boundary. Sharing an unrestricted Git account across projects is not isolation.
- The selected Cascade runtime's actual state/lock/archive ref operations,
  including expected-OID updates, lock creation/deletion and compaction's
  non-fast-forward state replacement. Do not apply generic branch protection
  that blocks the protocol. Permit an approved isolated smoke namespace too.
  Normal Cascade reads also require transaction-lock writes; a viewer-only key
  that can fetch is not sufficient for a worker or preflight.
- Recorded disk/CPU/memory/process limits appropriate to this host, a backup
  owner/cadence/retention and an off-host copy. Keep server policy, SSH keys and
  permissions in the restoration runbook; they are not restored by a Git bundle.

Test denied shell/forwarding, an unregistered identity, and cross-project access
against administrator-approved test targets. Verify refusal without modifying
another project's business state. A successful `ssh -T` is not the acceptance
test: restricted Git accounts may deliberately refuse interactive login.

## 3. Verify the runtime and initialize only the authorized new graph

Follow [Installation](cascade-coordination.md#installation) as the single runtime
source contract: use the company-approved full source remote, immutable commit
and expected version when provided. Verify the executable actually used by the
lane, gate and supervisor, not just a package inventory. A company's source
mirror can supply the runtime without any GitHub account. Do not substitute a
mutable branch, registry package, older release or another backend on failure.

Before any native operation on the formal namespace, inspect its remote state
ref using Git transport only:

```bash
git ls-remote --exit-code "$REMOTE" "refs/heads/cascade-state/$NAMESPACE"
```

Exit 2 with no matching ref means missing; authentication/network failures do
not mean an empty center. Existing formal state stops this new-center route:
verify its owner and use join/handover/migration instead. For a genuinely new
center, record administrator confirmation that this exact missing state is
expected and authorized for initialization. A join still requires existing
state and must never seed it.

Run the init skill's [step 6 lifecycle](../../ai-dev-kit-cascade-init/SKILL.md#6-final-smoke-test-on-the-real-configured-storage)
first against `<namespace>-initsmoke-<uuid>`, the approved remote, a fresh local
cache and a unique reserved probe. That lifecycle includes renewing the returned
token between claim and finish.

Use the selected runtime's real commands and check every result. Preserve the
probe ID on failure; never claim arbitrary READY work or unconditionally remove
a node after a failed add. On this isolated target also verify one winner for
two competing claims on an additional unreserved probe (different agents and
caches; the loser must be an actual claim conflict, not authentication failure),
stale-token refusal after release/reclaim, compaction/archive publication and
`verify-chain`. Retain concrete commands, exit statuses and evidence locations.

Only after this passes, initialize the approved new formal namespace through the
same native reserved-probe lifecycle; its first successful mutation creates the
state. Do not manufacture graph JSON or push a synthetic state commit. Confirm
the formal state ref, `list-nodes` and `verify-chain`, and that the probe was
removed while its audit history remains. Do not publish business tasks yet.

Create a complete backup from the authoritative non-shallow repository, covering
the state and archive refs. Verify the bundle, restore it to an isolated bare
repository and compare restored refs/history; use a fresh native cache to check
the restored graph/event chain. Retain a verified off-host copy. The
[Git bundle documentation](https://git-scm.com/docs/git-bundle) describes complete
bundles and verification; an incremental bundle needs its prerequisites, and
`bundle verify` alone does not prove application-level recovery.

## 4. Bind the shared project and the local planner

Preserve the exact previous profile and ignored overlay before writing. The
tracked project baseline uses `engine: cascade`, `storage: git`, **role: worker**,
the approved remote/namespace and runtime minimum. Keep absolute cache paths,
credentials and machine-specific roles out of the shared baseline.

For a fresh coordination block, the existing helper supports:

```bash
node "$KIT_ROOT/scripts/set-coordination.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.yml" \
  --engine cascade --role worker --storage git \
  --git-remote "$REMOTE" --namespace "$NAMESPACE" \
  --min-version "$MIN_VERSION"
```

The center's ignored `.ai-dev-kit/profile.local.yml` overrides role to
`orchestrator` and selects a private, non-synced Git cache. Workers stay `worker`
with their own per-clone caches. For a fresh center overlay:

```bash
node "$KIT_ROOT/scripts/set-coordination.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.local.yml" \
  --engine cascade --role orchestrator --storage git \
  --git-remote "$REMOTE" --git-cache "$CACHE" \
  --namespace "$NAMESPACE" --min-version "$MIN_VERSION"
```

This ordinary helper call targets the overlay via `--profile`; **do not use
`--local`** for Git, since that mode is Redis-only. The helper replaces the
entire `coordination` block, so first preserve extra existing fields such as
lease and command timeouts, then restore those unchanged fields and review the
whole result. Do not erase unrelated project or overlay settings.

The lane and gates resolve the main checkout's configuration even from linked
worktrees. A center needing a different role from workers on the same machine
uses an independent clone, not merely another linked worktree. Check that the
overlay and cache are ignored. Resolve environment overrides, supervisor JSON,
explicit CLI arguments and any viewer configuration too; editing a profile does
not update those independent entry points.

Repeat the reserved round trip using the **effective configured** formal target
and verified executable. Confirm the remote/namespace, role and cache actually
used by the lane, gate and supervised worker. If this verification fails, restore
the exact former profile/overlay and report the failure. Preserve newly created
remote evidence for diagnosis; do not delete it, claim setup success or silently
switch storage. After a migration, restoration must not reopen the fenced source.

## 5. Hand over the center, then enable only requested loops

Write the project's approved entry document in its existing documentation system.
It is human/Agent-readable operational guidance, not a new machine-parsed schema.
Include the product remote and baseline, coordination URL/namespace, owner and
sole planner, administrator contact, host-key fingerprint and public-key
registration process, pinned Kit/Cascade sources, effective profile rules,
worker result-branch policy, admission checks, backup/restore evidence and setup
status. Never include credentials or claim another employee's access was tested
using only the center's identity.

Adapt `templates/workflow/team-center-prompt.md` in the Kit repository from these
facts. Creating a Git repository or assigning `orchestrator` does not start a
loop. Only if the user requested scheduling and the current harness has a real
supported scheduling mechanism, create/update that project's existing schedule
and verify its returned state. Otherwise report center storage ready and planner
scheduling not enabled, with the concrete missing capability or decision. Do not
invent a daemon, call an unavailable tool or claim the server runs the model.
Record the approved cadence, per-run time/task/cost budget, idle policy and
notification preference; do not turn an unspecified loop into unlimited work.

For planner handover, stop the previous planner before enabling its replacement,
retain one named owner and verify current state/claims. A runtime change also
requires compatibility evidence from every affected actual client before new
event types or retry operations are enabled. Paused clients are not upgraded
clients; a successful center test does not approve an employee's runtime.

Give the owner one concise result: exact entry point, created/reused resources,
planner/schedule status, real verification/restore evidence, and outstanding
employee access. Workers use [enrollment](worker-enrollment.md) and report once.
SSH refusal is an access blocker to repair with the worker's own key; tests
passing elsewhere do not authorize skipping a content-bound preflight receipt.
