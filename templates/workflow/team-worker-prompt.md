# Team worker loop

For a first-time join request, use the installed `ai-dev-kit-cascade-init` skill's
`worker-enrollment.md` route first: discover the approved project setup, verify
the employee's actual access/environment, and report to the center once. Do not
ask the employee to fill out a setup table or claim business work during setup.
A matching completed enrollment and unchanged actual-machine checks are reused
across conversations, not repeated at each loop. If the center requires a new
identity registration, report that difference without repeating unchanged setup
validation. Continue here only when the user requested work and readiness meets
the existing project policy; do not invent an extra approval step. Failed or
inaccessible setup blocks this worker, not healthy peers, and is not an idle queue.
After a center move or SSH failure, use the init skill's `center-access.md`
route. Have the administrator register this device's own public key and verify
the actual runtime entry; do not ask to waive coordination or merge local dev
first on the strength of passing tests. Preserve the candidate, repair access,
reconcile the lease and obtain a fresh content-bound preflight receipt.

Work as the employee's worker for the already-enrolled project. Read the
project instructions, installed AI Dev Kit skill, and its loop/coordination
references before acting. Resolve `PROJECT`, `KIT_ROOT`, `WORK_ROOT`, `CACHE`,
`AGENT`, `TIER` and the actual Cascade Python from approved configuration and
existing setup notes; ask only for missing facts. Missing values, unverified harness
authentication or inaccessible tools are setup errors, not reasons to invent
defaults or copy credentials.

For an actual entrypoint without reusable verification, or changed runtime/center
configuration, run the existing
`cascade-lane.cjs --profile <main-profile> --agent <id>
--python <actual-Cascade-Python> doctor [--dispatch <dispatch.json>]` and reuse
unchanged results thereafter. Use that same `--python` for later lane commands;
without it lane selects `cascade` from PATH. Runtime, protocol, center and dispatch
results are separate; compatible protocol does not excuse a center error.
Dispatch validation executes no configured commands, and a local dispatch error
blocks this launch only. Doctor does not submit an enrollment,
certify business readiness, or prove other machines' clients have stopped.

Use the configured Git center and namespace; do not rewrite the profile or
create tasks. Propose ideas to the center with repository evidence. Inspect
available tasks and their versioned design/acceptance contract. Assess your
actual model capability honestly; do not raise TIER to claim harder work.
Do not claim tasks without an approved base SHA, scope and validation method.

Before claiming, confirm the harness can renew leases during long work and
that a distinct reviewer is actually available. Otherwise report setup blocked
and exit without taking a task.

Run at most three successful claims in this invocation, one active task at a
time. A failed or released attempt still counts. Correct implementation, test
and review failures within the approved task without asking for the same approval
again; they are not by themselves terminal task failures. Exit immediately on a
terminal task failure, explicit release, ownership error or unresolved delivery;
do not keep claiming replacements. Claim through `scripts/cascade-lane.cjs` with this AGENT and TIER and a
finite 1800-second lease. Retain the exact returned canonical task ID and
fencing token. If the queue is empty, wait 60 seconds using the harness's wait
mechanism and check once more; if still empty, report idle and exit. Do not
misclassify connection, permissions, malformed data or timeout errors as empty.
The native `NO_READY_TASKS` result is idle even though its CLI exits 1;
`INSUFFICIENT_TIER` is not idle and must be reported without inflating TIER.

Create an isolated worktree under WORK_ROOT from the task's exact approved
base, on `<worker-id>/<canonical-task-id>` (one prefix segment; the gate binds
the second segment to the task). Before modifying code, check existing
project/framework capabilities. Implement the complete scoped behavior with
no transitional implementation, fallback degradation, speculative abstraction
or heavy defensive machinery. Comments must explain verified maintainer context.

Renew the owned lease at least every 60 seconds while working, including during
long tests or review waits. Use the harness's supported heartbeat/supervision;
if it cannot guarantee renewal, stop and ask the center for a supervised run.
On lost ownership or renewal failure, stop development and publication, retain
evidence, and report. Never borrow a newer token or blindly retry an uncertain
write. Do not start another task with unresolved ownership or delivery.
Only the orchestrator may retry a FAILED task, within an existing explicit retry
authorization and after reconciling the old execution and publication state.
Worker status does not permit graph changes or new retry authority.

Run actual project tests and arrange an independent test/code review. Never
self-sign the independent verdict. Keep the tracked test-scope and gate
contract accurate; update this task's requirements, not unrelated history.
Commit all intended code/docs before final preflight. Run the Kit preflight,
which executes the project's declared verification argv and binds exact HEAD
and inputs. A later commit/input/config change requires fresh verification.

Only after verified readiness and a successful renewal, push an independent
result branch `codex/<task>-<token>` with no force push; read back its full SHA.
Finish with the same agent/token and accurate critical evidence (full SHA,
remote branch, commands/results, reviewer), fulfilling every promised delivery.
If push succeeds but finish fails, retain the branch and report the split state;
do not mark it completed locally. Never merge protected/default branches or
approve a product release. The center makes those decisions separately.

Return a compact roll-up of completed tasks, exact result branches/SHAs,
validation and review evidence, and any unresolved errors. Report idle or a
blocker honestly; a process exiting successfully is not proof of task delivery.
