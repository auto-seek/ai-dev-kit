---
name: ai-dev-kit
description: "Use this skill for software development in repositories that want skill-first quality discipline: GitFlow/worktree loop coordination, requirements ledgers, codegraph/docgraph lookup, test-file review, document synchronization, multi-agent review, and merge readiness gates."
---

# AI Dev Kit Skill

Use this skill to keep development work complete, reviewable, and synchronized with project docs.

## Core Rules

1. Read the repo instructions and project profile before changing code.
2. Search the codegraph/docgraph first; if unavailable, use targeted repository search.
3. Do not ship transitional implementations that depend on a promised future rewrite; every increment must be complete and part of the intended final architecture.
4. Do not hide required-path errors behind fallback, WARN-and-skip, stale/default data, or weaker semantics; surface and fix the cause.
5. Prefer a clean breaking change with callers, tests, docs, and migration updated together over obsolete compatibility shims or dual paths.
6. Do not create new utilities, components, services, scripts, commands, or abstractions until existing project assets and mature dependency/framework capabilities have been checked.
7. Implement the current contract directly; avoid speculative abstraction and heavy defensive code outside real trust boundaries or observed/contractual failure modes.
8. Keep incomplete, placeholder, mock, and speculative work out of `dev`.
9. Update docs when code changes behavior, APIs, workflows, tests, commands, architecture, or operational assumptions.
10. Treat tests as evidence only after a test-review pass confirms they are meaningful. Use the project's tracked `.ai-dev-kit/test-scope.json`; never infer coverage from a language or filename allowlist.
11. When you must ask the user, ask well — research first, ask only decision-changing questions, and carry a default to confirm. See `references/asking-the-user.md`.
12. Write comments for the next maintainer: plain, specific, verified context that the code alone does not convey. Avoid code narration, work reports, and invented rationale; preserve useful API docs and required directives.
13. Write for people in plain language. Reports and replies lead with the result and give the cause, what was done, and what is still open; use words the reader already knows, not coined terms or buzzwords. Product UI text reads like a professional commercial app: short verb buttons, plain labels, actionable errors, and no explanatory text where none is needed. See `references/plain-language.md`.

## Choose The Workflow

- Start every routine slice from `references/quick-checklist.md` — the compact operating card; open the deep references below only when a step is ambiguous or contested.
- Before production implementation or architecture review, read `references/implementation-discipline.md` for the no-transition, no-fallback, breaking-change, reuse-first, lean-implementation, and maintainer-oriented comment rules.
- For feature/fix loop work or multiple workers in one project, read `references/loop-workflow.md`.
- For coordinator/delegate splits (a stronger model reviewing, cheaper or parallel agents implementing), read `references/delegation.md`.
- For claims, scheduling, and cross-machine coordination (the Cascade engine, storage modes, roles, degradation), read `references/cascade-coordination.md`.
- For joining with a project ID and model level, use [cascade-center-agent](../cascade-center-agent/SKILL.md). It grants task-state Git access; product Git is checked separately after joining, without a legacy enrollment report. For a traditional center without project-ID admission, use `ai-dev-kit-cascade-init` and `references/worker-enrollment.md`.
- For viewing a task flow or starting a local read-only graph, use [cascade-flow](../cascade-flow/SKILL.md). For a new Git center with project-ID admission and a web UI, use `ai-dev-kit-cascade-init` and its `references/project-id-center.md`.
- For a new project's shared center, use `ai-dev-kit-cascade-init` and `references/project-center.md`; a shared server can host separate project centers. For migration or failed access, use `references/center-access.md`; restore verified access rather than waiving coordination or merging without a current preflight receipt.
- For new or changed tests, read `references/test-review.md`.
- For player-visible changes (requesting, performing or checking an independent player's-eye playtest), read `references/player-review.md`.
- For setting up a project's GUI evidence on workstation containers (pool, host preparation, capture, turning on player review), read `references/workstation-onboarding.md`.
- For code that takes screenshots or drives a program for evidence, read `references/no-focus-stealing.md`: no foreground, focus or system pointer changes on the host; check with `scripts/focus-steal-scan.cjs`.
- For document creation, brainstorming, plans, design docs, or doc drift, read `references/document-discipline.md`.
- For review, merge readiness, SOLID/DRY/KISS checks, or adversarial verification, read `references/review-agents.md`.
- For ready-to-send reviewer prompts, read `references/agent-prompts.md`.
- For periodic cleanup of dead, duplicate, placeholder, or low-quality code accumulated by loop work, read `references/subtraction.md`.
- For asking the user a clarifying question in any workflow, read `references/asking-the-user.md`.
- For reports, summaries, docs, commit/PR text, and any user-facing product copy (buttons, labels, errors, empty states, toasts, tooltips), read `references/plain-language.md`.

## Slash Commands

When installed from the ai-dev-kit local marketplace, harnesses may expose:

- `/ai-dev-kit-loop`
- `/ai-dev-kit-preflight`
- `/ai-dev-kit-test-review`
- `/ai-dev-kit-doc-review`
- `/ai-dev-kit-merge-guardian`
- `/ai-dev-kit-player-review`
- `/ai-dev-kit-clean`
- `/ai-dev-kit-cascade-init`
- `/cascade-center-agent`
- `/cascade-flow`

These commands are entry points into the same references above. If slash
commands are unavailable, invoke the matching workflow by reading this skill
and the listed reference file directly.

## Graph Lookup

Prefer an installed graph provider such as Serena, CodeGraph, code-review-graph, codebase-memory-mcp, Graphify, Understand-Anything, Repomix, or Aider-style repo maps.

If no provider is available, use `rg`, directory listings, public facades, tests, and docs. Record what was searched when the decision depends on reuse or impact analysis.

## Requirements Ledger

Use `.ai-dev-kit/workflow/LEDGER.md` for large, multi-agent, high-risk, or multi-session work.
For preflight, the tracked `.ai-dev-kit/gate-contract.json` explicitly selects
the requirements file and `task-sections`, `task-files` or `global` scope, the approved base
ref and real project verification argv. Read requirements from the reviewed
checkout; do not complete unrelated historical tasks to clear the current one.

Format:

```text
- [ ] 1. Requirement or constraint
- [x] 2. Done and verified
- [~] deferred: reason approved by user | owner: responsible-person
```

Do not close work with open ledger items unless they are explicitly deferred with a reason.

## Findings Gate

Accepted review findings belong in `.ai-dev-kit/workflow/findings.jsonl` or the project-configured equivalent. A finding closes only after a fix and verification evidence exist.

## Final Readiness

Before declaring work complete:

- changed code is implemented, not placeholder;
- test evidence has passed test-review when it matters;
- docs and development ledgers reflect the actual state;
- blocking findings are closed or explicitly deferred;
- the final commit has a passing content-bound project preflight receipt; later
  commits or input/config changes require revalidation before merge;
- merge to `dev` is only proposed for complete, reviewed functionality.
