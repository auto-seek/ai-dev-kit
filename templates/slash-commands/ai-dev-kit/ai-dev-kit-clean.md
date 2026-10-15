# AI Dev Kit Clean

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill, then read `references/subtraction.md` before deleting anything.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Project:

```text
{{PROJECT_PATH}}
```

Run a subtraction pass to remove garbage accumulated by automated/loop development and restore readability, maintainability, structure, and elegance. Every pass produces two outputs: a work-result summary AND subtraction actions — never only a deletion list.

Parse the intensity mode from arguments (`propose` default, `assisted`, `sweep`) and optional scope. Subtraction is evidence-gated deletion — **unused is not the same as dead**; prove each candidate before cutting.

1. Inventory and classify the scope into code, tests/evidence, narrative/story, art/media, gameplay/design content, and docs. Non-code work is always reported, never silently dropped or bulk-deleted.
2. Identify garbage candidates: dead/unreachable code, duplication/redundant abstraction, placeholder/mock/speculative work, structural rot, orphaned companions.
3. Multi-angle review each candidate — reachability, dynamic use, history/intent, coupling/completeness, domain/non-code (parallel reviewer agents in `assisted`/`sweep`). Delete only when every lens clears it and the full cluster is identified. No single-pass deletion.
4. `assisted` auto-deletes only the mechanically-provable safe tier; everything else goes to `.ai-dev-kit/workflow/findings.jsonl` for approval. `sweep` runs fully automated on a disposable branch with a green baseline.
5. Delete the whole cluster — implementation plus its tests, fixtures, snapshots, mocks, type defs, imports, registrations, docs, and solely-owned assets — so nothing is left orphaned (no "code deleted, test file kept"). Then run the orphan sweep: grep the deleted names/paths/asset-keys and assert zero remaining references.
6. Subtract stale docs (orphan drafts, superseded/duplicate docs, dead registry entries, and stale feature-ledger entries in deprecated ledger mode) per document discipline; code-vs-doc drift is a finding for the doc-review workflow, not a deletion.
7. Commit deletions on the current task branch as separate `refactor:`/`chore:` commits (the gate only counts a record for the branch it checks), then run the orphan sweep and the available build, lint, typecheck, and test commands and confirm green. A red suite after subtraction means restore the cluster and re-investigate.
8. Record the pass in `.ai-dev-kit/workflow/subtraction-log.md` (`- YYYY-MM-DD | commit: <HEAD sha> | branch: <current branch> | scope: <scope> | mode: <propose|assisted|sweep>`) so the preflight/merge subtraction-debt gate registers that the cadence was met.

The default scope for a cadence pass is the current branch's diff against its merge base with the target branch. A survey with no candidates is a valid, quick pass: short summary, no commit, and `scope: <base>..HEAD (none)` with an unchanged `mode:` value (text after the mode, such as `mode: propose (none)`, is rejected). Stop when candidates are exhausted; never invent deletions or churn.

Never delete exported APIs, entrypoints, config, migrations, i18n, generated/fixture data, narrative/gameplay/art assets, or dynamically-referenced code without explicit approval, regardless of mode. Deliver the work-result summary (per class, including non-code) plus what was removed and what was deliberately kept, with reasons.
