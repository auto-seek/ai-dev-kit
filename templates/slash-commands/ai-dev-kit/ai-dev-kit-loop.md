# AI Dev Kit Loop Work

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill before starting implementation.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Read `references/loop-workflow.md` and `.ai-dev-kit/profile.yml`. Read `docs/development/feature-ledger.md` only when the profile still selects deprecated `engine: ledger`; Cascade projects inspect the shared graph instead.

## Discovery Mode

If `Arguments` contains `--discovery`, treat that flag as an explicit request to discover one safe, high-value improvement in the current repository before reserving work. Follow "Autonomous Target Selection" in `references/loop-workflow.md` with the conservative `--discovery` profile: shared clean-worktree gate and health posture, bounded read-only evidence, at most one L1/L2 candidate, a `DISCOVERY_PLAN` (with rejected candidates and review focus) before any write, then the normal reservation, design-document binding, worktree, implementation, review, and preflight gates. Discovery must not create long-lived evolution state, run module rotation, or start L5 strategic planning. If no concrete safe candidate emerges, stop cleanly with the evidence checked and do not edit production files.

## Evolution Mode

If `Arguments` contains `--ev`, treat that flag as an explicit request for a more aggressive self-evolution pass. Follow "Autonomous Target Selection" in `references/loop-workflow.md` with the `--ev` profile: the same shared gate, inputs, and priority order, plus L1-L5 sizing, module rotation when state already exists, L5 cadence when explicitly due, and an `EV_PLAN` before any write. `--ev` may maintain lightweight ai-dev-kit workflow state, but it still must reserve the selected work, bind a design document, use a dev-based branch/worktree, run test-review/review/preflight gates, honor subtraction cadence, and never merge placeholders or stale docs.

Required flow:

1. For normal loop requests, clarify first: confirm intent, scope, non-goals, and acceptance criteria with the user before reserving. For `--discovery` or `--ev`, the flag authorizes target selection; first run the matching gate and print `DISCOVERY_PLAN` or `EV_PLAN`, then use that plan as the clarified input unless a decision-changing ambiguity remains.
2. Inspect active reservations for overlapping work: use `cascade list-nodes` under `engine: cascade`, or the feature ledger only under deprecated `engine: ledger`.
3. Reserve the requested feature. In the default self-serve Cascade role, use `scripts/cascade-lane.cjs add --slug <slug> [--required-tier lite|pro|max]`, then targeted `claim --slug <slug> [--agent-tier <actual-tier>]`; preserve the fencing token. In ledger mode, update `docs/development/feature-ledger.md`.
4. Create or bind a design document at `docs/working/<slug>.md` (or an accepted decision at `docs/decisions/<slug>.md`) capturing the clarified requirements, and add that path to the reservation's `Expected docs` section.
5. Create an isolated worktree from the up-to-date `merge_policy.target_branch` in the main-checkout profile, using `<prefix>/<slug>` with exactly one prefix segment, such as `feature/<slug>`, `fix/<slug>` or `<agent-id>/<slug>`. Use the configured trunk name; do not invent a missing `dev` branch.
6. Choose the loop driver your harness provides — AutoSeek's runner, Claude Code's `/loop` or ralph-loop or background tasks, Codex's loop, or manual sequential iteration if none (see `references/loop-workflow.md` "Choose Your Loop Driver"). Whatever drives it, honor the kit discipline.
7. Before and during implementation, apply `references/implementation-discipline.md`: research reuse first; do not introduce transitional paths, fallback degradation, obsolete compatibility, speculative abstraction, or heavy defensive machinery. Keep the reservation, bound design doc, tests, and findings current, and run the required subtraction cadence (`/ai-dev-kit-clean`).
8. Do not merge placeholders, mocks, unfinished paths, or stale docs back to `dev`.
9. Apply the same reference's comment guidance while editing: plain, verified
   reasons and constraints for maintainers, not code narration or work reports.
   Keep affected comments current and preserve useful API docs and directives.
