# Feature Ledger

Reserve loop work here before creating a feature worktree. This file coordinates multiple workers sharing the same development branch.

## Example

- Status: archived
- Owner: example
- Branch: feature/example
- Worktree: ../repo-example
- Created: YYYY-MM-DD
- Goal: describe the complete behavior that would be mergeable
- Scope:
  - path/or/module
- Non-goals:
  - out-of-scope behavior
- Expected tests:
  - test path or flow
- Expected docs:
  - docs/working/example.md
  - docs path for user-facing or operational updates
- Coordination notes:
  - overlap or dependency notes

## Required Docs Binding

Every active reservation must include at least one `Expected docs` path under:

```text
docs/working/
docs/decisions/
```

Create the bound `docs/working/<slug>.md` before implementation starts. Move accepted decisions to `docs/decisions/<slug>.md` and update `.ai-dev-kit/docs/registry.yml`.
