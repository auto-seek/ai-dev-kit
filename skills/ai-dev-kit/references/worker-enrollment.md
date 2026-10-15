# Join a shared project and reuse verified setup

This is the traditional entry-configuration route. If the project uses a
`project_…` join ID, follow [cascade-center-agent](../../cascade-center-agent/SKILL.md)
instead. Do not require this report, product Git approval or profile wizard for
project-ID admission.

Use this route when the user asks to join a team or first report to its center.
The agent handles discovery and checks; the employee need only identify the
project or its approved entry point. This is an enrollment workflow, not a new
registration service, daemon, business task, or permission to administer a server.

Creating a center for another project is a different route:
[Project center](project-center.md). If a known center moved or SSH now fails,
use [Migration and access recovery](center-access.md) before continuing.
Do not reinterpret authentication failure as an empty project or request a
temporary coordination/preflight exemption to merge already-tested code.

## Discover and verify

1. Read project instructions, the main checkout's official profile and local
   overlay, relevant environment overrides, and tracked `gate-contract.json` /
   `test-scope.json`. Resolve the approved product remote, center remote/namespace,
   base ref and full commit from those sources or the team's entry point. Missing
   or conflicting values are a setup error: ask for the single concrete missing
   entry or permission, not a long form. Never guess a namespace, reuse an E2E
   graph, create the team's graph, or replace its configuration with defaults.
2. Inspect the installed kit/Cascade executable, version and source provenance,
   actual harness authentication, OS/architecture, project SDK pins, dependency
   layout and locks. Reuse verified facts for the same actual executable /
   interpreter, installation and effective center configuration; a new conversation
   is not a new machine. Follow [Installation](cascade-coordination.md#installation)
   and the project's existing setup commands for authorized installs; do not
   silently replace an existing installation, relax locks or copy credentials.
   Prefer the project's approved company mirror and immutable source contract;
   GitHub accounts are not a requirement. The coordinator's working key does
   not authorize this machine: discover its own key and enrollment status.
   Read actual harness/model configuration; unknown model or tier stays `unknown`.
   Use the team's assigned agent ID, or generate a unique session ID if its entry
   policy permits that. Keep it stable for this session; never reuse a peer's ID.
3. Check access with the employee's own identity on first join or when access
   changes; reuse matching verified access otherwise. `git ls-remote` proves read access,
   not result-branch or coordination-ref write permission. Reuse the init skill's
   isolated round trip in a fresh `<namespace>-initsmoke-<uuid>` and private cache;
   target only its reserved probe. Verify product result-branch access using the
   team's approved permission check, never by pushing a protected branch. Run
   declared project prerequisite/development checks without claiming a business
   task; a task-bound Kit gate is not an enrollment probe. Retain concise evidence
   for failures and unverified checks; neither counts as ready.
4. Verify the existing formal state ref, `list-nodes` and `verify-chain` against
   the approved entry point. Apply any authorized local setup through existing
   bootstrap / init helpers only after the isolated smoke succeeds, preserving
   the previous profile/overlay on failure. The resulting role is `worker`, with
   a per-clone cache; do not publish local cache paths or change team policy.

## Check the actual runtime once, reuse while unchanged

After the approved local setup is resolved, use the existing lane adapter:

```bash
node <kit>/scripts/cascade-lane.cjs --profile <main-profile> --agent <agent-id> \
  --python <actual-Cascade-Python> doctor [--dispatch <dispatch.json>]
```

See [Actual-runtime self-check](cascade-coordination.md#actual-runtime-self-check)
for the JSON protocol/dispatch checks and their limits. A local dispatch error
exits non-zero without discarding successful protocol checks or blocking peers.

Use the same `--python` for subsequent lane operations. Omitting it preserves
the PATH-selected `cascade` behavior; do not validate one interpreter and launch
another. Retain the concise result with existing private setup notes, not a new
certificate or registry. Recheck affected facts when the actual entrypoint,
installation, effective center configuration or access changes. A new session
or declared agent ID alone does not require repeating unchanged environment checks.

Doctor does not submit the join report or certify business readiness. Actual
access, harness authentication, review and admission requirements still apply.

## Deliver the first join report once

An invitation to join permits only the isolated probe and this join's own
reserved enrollment node, not additions or edits to business tasks. Keep the
enrollment ID and report task ID in existing private harness/setup notes. Before
retrying or resuming, inspect that same node and its history: a completed matching
report must not be sent again, including in a new conversation. A genuinely new
join to a center still gets one native report. If project policy requires a new
identity to be registered, report that identity change while reusing unchanged
environment checks; do not repeat installation or smoke tests merely for a new
session ID. After fixing a blocker, report changed readiness under the existing
join request. Do not auto-create replacements for uncertain writes.

Prepare `REPORT_JSON` from observed facts: `kind: "worker-enrollment"`,
`enrollment_id`, `agent_id`, `harness`, `model`, `tier`, `platform` (OS/architecture),
`project` (sanitized remote and full baseline SHA), `checks` (name, status and
short evidence locator/result), and boolean `ready`. Add concrete blockers when
not ready. Omit tokens, passwords, auth files, credential-bearing URLs, environment
dumps and full logs. Unknown capability is not permission to claim tiered work.
`ready` requires the actual setup checks and existing project admission policy;
it does not certify a product release, authenticate a model, or approve a merge.

Use the already-resolved `c` command from the team Git guide (the existing
`cascade-process.cjs` supervisor with the verified executable from the same
installation as the selected Python, remote, namespace and private cache).
For a new report choose one `onboard-<uuid>` node ID, retain it
before writing, and execute each step only after the previous one succeeds:

```bash
c add-node --id "$JOIN_ID" --reserved-for "$AGENT"
CLAIM="$(c get-task --task "$JOIN_ID" --agent "$AGENT" --timeout 300)"
TOKEN="$(printf '%s\n' "$CLAIM" | sed -n \
  's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
test -n "$TOKEN"
c finish-task --task "$JOIN_ID" --agent "$AGENT" --token "$TOKEN" \
  --success --summary "Worker enrollment report" --critical "$REPORT_JSON"
c inspect --task "$JOIN_ID"
c history --node "$JOIN_ID"
```

Use inspect's human-readable state and `reserved_for` to check the node and
reservation. Use structured history's `task_claimed` agent/token and
`task_completed.context.critical` to match the exact report; reservation identity
is not authentication. Keep the node for the center; do not remove it like the
isolated smoke probe. This node
has no business dependencies/promises. `--success` means the report was delivered;
a delivered report with `ready: false` still forbids business work. The center
can inspect the node or `history --node "$JOIN_ID"`; no automatic notification
or listener is implied. Tell the current user the report ID and readiness.

On any failed/unknown write, retain the ID/token and stop dependent steps; inspect
actual state before recovery. Continue only within the existing join authorization
and a confirmed valid owned claim; never borrow a token or blindly retry.
If the center is inaccessible, report the concrete blocker in the current session,
not a fictional remote check-in. Do not report ready or claim business work after
a failed check. Do not hold the 300-second report lease while running long setup
checks; gather evidence first, then submit the short report lifecycle.

## Continue only within the request

After successful ready readback, enter the existing `team-worker-prompt.md` bounded
loop only if the user asked to start work and project admission requirements are
satisfied. Do not invent an additional human approval gate where policy has none.
Otherwise stop after reporting. The worker still needs a real eligible task,
approved base/scope/validation, honest tier, renewal support and an independent
reviewer; no ready business tasks are assumed. During work, do not rewrite the
profile or business graph, merge, publish a release, or repeat enrollment each loop.
