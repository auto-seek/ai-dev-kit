# Document Discipline

Use this for brainstorming, plans, architecture notes, generated research, feature ledgers, runbooks, and docs that must stay synchronized with code.

## Document Locations

Recommended structure:

```text
docs/
├── working/
├── decisions/
├── development/
└── archive/YYYY/

.ai-dev-kit/docs/
├── registry.yml
└── claims.jsonl
```

Brainstorming and draft plans start in `docs/working/`. Accepted decisions move to `docs/decisions/`. Stale or superseded docs move to `docs/archive/YYYY/` and are marked in the registry.

## Feature-Bound Documents

Loop work must bind its feature-ledger reservation to a document path:

- `docs/working/<slug>.md` for active brainstorming, plans, and design drafts;
- `docs/decisions/<slug>.md` for accepted design or architecture decisions.

The feature-ledger entry's `Expected docs` section must include that path. The document must exist before implementation starts unless the user explicitly approves `Expected docs: none - <reason>`.

When the implementation changes reality, update the bound document in the same work. If a draft is accepted, move or rewrite it under `docs/decisions/`, mark the old draft `superseded` or archive it, and update `.ai-dev-kit/docs/registry.yml`.

## Frontmatter

Planning and generated docs should start with:

```yaml
---
type: brainstorming | plan | design | decision | runbook | archive
status: draft | active | superseded | archived
owner: agent-or-human
created_at: YYYY-MM-DD
last_verified_at: YYYY-MM-DD
feature_ledger: docs/development/feature-ledger.md#feature-slug
related_paths: []
related_commits: []
supersedes: []
truth_sources:
  - code
  - tests
  - issue
---
```

## Agent Duties

Agents must update docs when changing:

- API, CLI, hook, or command behavior;
- architecture or module boundaries;
- data schema or storage paths;
- test strategy or verification expectations;
- feature status in a loop reservation;
- build, deployment, or operational behavior.

Do not leave brainstorming docs as if they are accepted facts. Mark them `draft`, `superseded`, or `archived`.

## Doc Curator Prompt

```text
You are the doc-curator agent.

Review changed docs, active working docs, and the development feature ledger.
Compare them against git diff, codegraph/docgraph results, tests, and command evidence.

Tasks:
1. Identify docs that are stale, contradicted by code, or missing frontmatter.
2. Move or mark brainstorming/planning docs that are no longer active.
3. Update registry entries for active, superseded, and archived docs.
4. Check whether code changes require docs that were not updated.
5. Report findings with file:line evidence.

Do not rewrite product or architecture facts without evidence from code, tests, issues, or explicit user instruction.
```

## Fact Sync

When a document claim matters for development, store or preserve:

- the claim;
- source path or command evidence;
- last verification date;
- owner;
- related code paths;
- whether it is active, disputed, superseded, or archived.
