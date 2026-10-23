# AI Dev Kit Preflight

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill and read `references/implementation-discipline.md`
before deciding readiness.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Project:

```text
{{PROJECT_PATH}}
```

Complete implementation, applicable validation and independent reviews, then
commit all intended changes. Read the tracked `.ai-dev-kit/gate-contract.json`
for the explicit base, requirements scope and real project verification argv.
Missing enrollment requires migration; never substitute a no-op command.
Run the gate after the final commit:

```bash
bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase preflight --project "{{PROJECT_PATH}}"
```

The gate executes the declared project command and records a content-bound
receipt only if checks pass without changing inputs. Include applicable build,
lint, typecheck, tests and E2E in that project entrypoint. Any later commit,
index/worktree change, base-ref or effective-config change invalidates preflight;
merge does not renew the receipt.

`BLOCKED (retryable)` means a declared busy-resource exit code or a failed
environment check (node, free disk) and wrote no receipt: retry rather than
treat it as a failure. Keep topic-specific test selection in the task's committed
`preflight.task_args` file and requirements in its `task-files` file, not in the
shared contract or ledger. `--phase status [--all] [--json]` shows read-only
which receipts are missing or stale and why. Under `receipt_binding: merge-base`
target movement does not stale preflight; one integrator runs `--phase integrate`
before merge.

`player review:` warnings mean player-visible files changed and the current
commit has no passing review from another session yet; preflight still passes,
merge will not. Request one per `references/player-review.md`.

Review touched comments using `references/implementation-discipline.md`: plain,
verified context for maintainers, with useful API docs and directives preserved.
Block materially misleading explanations with code/contract evidence;
wording-only preferences are non-blocking. The shell gate does not judge comment quality.

Use review agents according to the skill:

- changed tests: test-review agent;
- changed docs or behavior documented elsewhere: doc-curator or fact reviewer;
- public API, shared utility, module boundary, or new abstraction: architecture reviewer;
- merge preparation: merge guardian.

The test reviewer must cover committed, staged and untracked tests against the
configured target branch and record the approved verdict with
`node <kit>/scripts/test-review-evidence.cjs record --project . --report <narrative.md>`.
The gate rejects a missing or stale content-bound receipt for the current branch
(receipts are stored per branch). It also requires the
reviewed checkout's tracked `.ai-dev-kit/test-scope.json` and binds policy changes;
follow `references/test-review.md`, not language/name-based inference.

Return `READY` only when the active reservation (Cascade node by default, feature-ledger entry only in deprecated ledger mode), findings, tests, docs, and implementation are all consistent, with no transitional path, fallback degradation, unjustified compatibility residue, missed reuse, speculative abstraction, or heavy defensive machinery. Otherwise return blocking findings first.
