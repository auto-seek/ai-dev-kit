# AI Dev Kit Test Review

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill and read `references/test-review.md`.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Treat changed tests as untrusted until proven useful. Inspect changed test files, related production code, fixtures, and test output.

Validate the reviewed checkout's tracked `.ai-dev-kit/test-scope.json` against
the actual test layout. Review scope changes too; language/name inference is not
accepted. Follow `references/test-review.md` for per-branch schema-3 evidence and migration.

For each changed test file, validate:

- Perspective: who cares about the behavior;
- Invariant: what must remain true;
- Goal: what regression this prevents;
- Migration: where the test belongs over time.

Report findings first with severity, file:line, evidence, and required fix. Review committed, staged and untracked test changes against the target branch. Write the narrative in a per-branch copy of `.ai-dev-kit/workflow/test-review-template.md`: the `report` path printed by `node <kit>/scripts/test-review-evidence.cjs paths --project .`, or a private file passed with `--report` (never the shared legacy `test-review.md`). Only after approval, set `Status: approved`, name the reviewer, and run `node <kit>/scripts/test-review-evidence.cjs record --project . [--report <narrative.md>]` to bind the verdict to the reviewed content. Evidence is stored per branch in the main checkout's `.ai-dev-kit/workflow/test-review/<branch-key>.{md,json}` (`paths` prints them), so recording never invalidates other branches. A later change requires renewed review.
