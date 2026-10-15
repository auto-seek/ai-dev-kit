# AI Dev Kit v2 — Skill-First Harness Design

> Draft design for simplifying ai-dev-kit into a skill-first, harness-neutral workflow system.

## Goals

- Move long-lived development discipline into a reusable skill, not large generated `AGENTS.md` / `CLAUDE.md` files.
- Let each harness implement hooks in its own way while sharing the same workflow contract.
- Prefer agent review, code graphs, document graphs, and evidence gates over broad regex scripts.
- Keep `dev` clean: incomplete features, placeholder implementations, mock production code, and stale docs must not merge back.
- Require final-architecture increments: no promised-later transitional paths,
  hidden fallback degradation, obsolete compatibility residue, reinvented
  mature capability, speculative abstraction, or heavy defensive machinery.

## Core Shape

```text
ai-dev-kit
├── skills/ai-dev-kit/                  # reusable skill package
├── skills/ai-dev-kit-*/                # slash-invoked workflow skills
├── templates/profiles/                 # project shape and generated check templates
├── adapters/codex/                     # Codex hook adapter
├── adapters/claude/                    # Claude hook adapter
└── docs/skill-first-v2-design.md       # this design
```

The skill owns behavior. Adapters own integration. Scripts become evidence collectors, not the main source of judgment.

Skill-first install entries:

```text
# Claude Code
/plugin marketplace add https://github.com/auto-seek/ai-dev-kit.git
/plugin install ai-dev-kit@ai-dev-kit-marketplace
/reload-plugins

# Codex
Install these repo paths as skills:
skills/ai-dev-kit
skills/ai-dev-kit-loop
skills/ai-dev-kit-preflight
skills/ai-dev-kit-test-review
skills/ai-dev-kit-doc-review
skills/ai-dev-kit-merge-guardian
skills/ai-dev-kit-clean
```

Project bootstrap entry for profile files, ledgers, and hook adapters:

```bash
bash bootstrap/init-skill.sh /path/to/project --harness codex --profile balanced
```

Adapters can be installed later:

```bash
bash bootstrap/install-adapter.sh /path/to/project --harness codex --overwrite
bash bootstrap/install-adapter.sh /path/to/project --harness claude --overwrite
bash bootstrap/install-adapter.sh /path/to/project --harness generic
```

The generic adapter writes a harness-neutral contract to
`.ai-dev-kit/adapters/generic/` so new harnesses can translate the same stop,
preflight, and merge commands into their native hook format.

## Skill Marketplace

Canonical skill packages live in:

```text
skills/
```

Claude plugin marketplace metadata lives in:

```text
.claude-plugin/marketplace.json
.claude-plugin/plugin.json
```

The harness-neutral local market index lives in:

```text
marketplace/index.json
```

The first market entry is `ai-dev-kit`. It points at the reusable skill package,
slash-invoked workflow skills, supported install targets, adapter templates, and
legacy command templates for harnesses that still require command files.

Offline fallback installer:

```bash
bash bootstrap/install-skill.sh --list
bash bootstrap/install-skill.sh --target all --project /path/to/project
```

Install locations:

```text
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-*/
${CLAUDE_HOME:-~/.claude}/skills/ai-dev-kit/
${CLAUDE_HOME:-~/.claude}/skills/ai-dev-kit-*/
.ai-dev-kit/skills/ai-dev-kit/
.ai-dev-kit/skills/ai-dev-kit-*/
```

Legacy project command locations for adapters that still need command files:

```text
.codex/commands/
.claude/commands/
.ai-dev-kit/commands/        # generic harness fallback
```

Commands:

```text
/ai-dev-kit-loop
/ai-dev-kit-preflight
/ai-dev-kit-test-review
/ai-dev-kit-doc-review
/ai-dev-kit-merge-guardian
/ai-dev-kit-clean
```

Generated target layout:

```text
.ai-dev-kit/
├── profile.yml
├── skills/
│   ├── ai-dev-kit/
│   └── ai-dev-kit-*/
├── workflow/
│   ├── LEDGER.md
│   ├── feature-ledger.md
│   ├── findings.jsonl
│   └── test-review.md
└── docs/
    ├── registry.yml
    ├── claims.jsonl
    └── document-template.md

docs/development/feature-ledger.md
docs/working/
docs/decisions/
```

## Codegraph And Docgraph

The skill should detect an available graph provider before falling back to `rg`:

- Serena: LSP/MCP semantic code navigation and symbol-level edits.
- CodeGraph, code-review-graph, or codebase-memory-mcp: local persistent code graph, blast radius, references, callers, and dependencies.
- Graphify or Understand-Anything: broader knowledge graph across code, docs, SQL, and other project artifacts.
- Repomix or Aider-style repo maps: fallback context packing and project-map generation.

The required internal abstraction is small:

```yaml
graph:
  symbol_lookup: required
  reference_lookup: required
  changed_file_impact: preferred
  doc_code_links: preferred
  provider: auto
```

Agents must consult the graph before adding new utilities, components, services, commands, or abstractions. If no graph provider exists, the agent must run targeted repository search and record what was checked.

## Loop GitFlow

Baseline branch rules follow `autoseek/docs/development/GitFlow.md`:

- `dev` is the development trunk.
- feature work starts from `dev` as `feature/<name>`.
- fixes start from `dev` or release/main when appropriate as `fix/<name>`.
- commits use conventional messages such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, and `chore:`.

Loop mode adds two requirements before implementation:

1. Reserve the work in a dev-branch development document.
2. Bind the reservation to a design document under `docs/working/` or an accepted decision under `docs/decisions/`.
3. Create an isolated worktree from the updated `dev`.
4. Implement only inside that worktree.
5. Keep the reservation, bound design/decision document, tests, and findings current.
6. Merge back only when the feature is complete and reviewed.

Default reservation file:

```text
docs/development/feature-ledger.md
```

Fallback if the project has no docs tree:

```text
.ai-dev-kit/workflow/feature-ledger.md
```

Reservation entries must include owner, branch, worktree path, feature scope, affected areas, non-goals, expected tests, expected docs, status, and conflict notes. `Expected docs` must include at least one `docs/working/<slug>.md` or `docs/decisions/<slug>.md` path unless the user explicitly approves `Expected docs: none - <reason>`. Multiple workers must check this ledger before claiming overlapping work.

### Feature Design Binding

Active feature design uses:

```text
docs/working/<feature-or-fix-slug>.md
```

Accepted design decisions use:

```text
docs/decisions/<feature-or-fix-slug>.md
```

The bound document must exist before coding starts and must include frontmatter with at least `type`, `status`, owner/date fields, related paths, and truth sources. Preflight and merge gates block if a ready-for-review reservation lacks this binding, the bound document is missing, or the document no longer matches the implementation.

## Requirements Ledger

Large or risky work uses:

```text
.ai-dev-kit/workflow/LEDGER.md
```

Each item is a checkbox:

```text
- [ ] 1. Requirement or constraint
- [x] 2. Done and verified
- [~] 3. deferred: reason approved by user
```

Use a file ledger when the task has 5+ requirements, touches multiple agents, crosses sessions, edits core systems, changes public behavior, or creates merge risk. Small tasks can use an inline checklist.

## Test Review

Tests are not automatically trusted. A test file can be wrong, vacuous, over-mocked, or merely assert the implementation.

Every test change must be reviewed by a test-review agent when:

- a new test file is added;
- a test contract/docstring is changed;
- production behavior changes and tests are used as evidence;
- merge to `dev` is being prepared.

The test-review agent starts from skepticism:

- Does the test describe Perspective, Invariant, Goal, and Migration?
- Does it test behavior rather than internal calls?
- Would it fail for the bug or regression it claims to prevent?
- Does it use real storage or real in-process adapters?
- Are stubs limited to external services?
- Does it avoid mocking the project code under test?
- Is the assertion non-vacuous and tied to user-visible or domain behavior?
- Are fixtures documented when they shape behavior?

Test findings are blocking when a test is the claimed verification evidence for a merge.

## Document Discipline

Brainstorming, plans, decisions, and generated research documents must not become an unmanaged pile.

Recommended layout:

```text
docs/
├── working/                 # brainstorming, drafts, active plans
├── decisions/               # accepted architecture/product decisions
├── development/             # feature ledger and loop coordination
└── archive/YYYY/            # superseded or historical docs

.ai-dev-kit/
└── docs/
    ├── registry.yml         # doc index and status
    └── claims.jsonl         # optional claim/evidence records
```

Every generated or modified planning document should carry frontmatter:

```yaml
---
type: brainstorming | plan | design | decision | runbook | archive
status: draft | active | superseded | archived
owner: agent-or-human
created_at: YYYY-MM-DD
last_verified_at: YYYY-MM-DD
related_paths: []
related_commits: []
supersedes: []
truth_sources:
  - code
  - tests
  - issue
---
```

Agents must update docs when development changes APIs, commands, architecture, data models, workflows, tests, or operational behavior. A doc-curator or fact-review agent must verify doc/code consistency before merge.

## Review Agents

Use distinct review lenses instead of one generic self-review:

- test reviewer: distrust tests and validate test contracts.
- architecture reviewer: SOLID, DRY, KISS, YAGNI, public boundaries, and reuse.
- fact reviewer: compare claims against code, tests, graph output, and command evidence.
- doc curator: archive stale docs, update registry, and mark superseded plans.
- merge guardian: enforce GitFlow, feature completeness, closed findings, and no mock/placeholder leakage to `dev`.

For high-risk work, spawn a fresh reviewer that did not implement the change. It should try to refute the claims, not affirm them.

## Findings Gate

Accepted review findings must be stored outside conversation context:

```text
.ai-dev-kit/workflow/findings.jsonl
```

Each finding records severity, source agent, location, evidence, status, resolution, and verification. Merge is blocked while critical or accepted high findings remain open.

## Hook Contract

Hooks should stay light:

- `pre_command`: block destructive operations only.
- `post_edit`: format changed files and optionally refresh graph indexes.
- `pre_spawn`: nudge or block large delegation without a ledger.
- `stop`: block unfinished ledger or open blocking findings.
- `pre_merge` / `preflight`: run full graph/doc/test review gates.

The same contract can be implemented by Codex, Claude Code, or other harnesses.
