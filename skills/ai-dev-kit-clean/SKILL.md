---
name: ai-dev-kit-clean
description: "User-invoked ai-dev-kit subtraction workflow. Use when the user invokes /ai-dev-kit-clean, asks to clean up garbage from automated/loop development, remove dead or duplicate or placeholder code, do a subtraction pass, or restore code and documentation to a readable, maintainable, elegant state."
---

# AI Dev Kit Clean

Use the `ai-dev-kit` skill first, then read `../ai-dev-kit/references/subtraction.md`.

Arguments:

```text
$ARGUMENTS
```

Parse the intensity mode from arguments (`propose` default, `assisted`, or `sweep`) and an optional scope (paths/modules). Subtraction is evidence-gated deletion: the cardinal failure is removing real work, so **unused is not the same as dead** — prove it before cutting. Every pass produces two outputs: a work-result summary AND subtraction actions; never return only a deletion list.

Run the pass per `subtraction.md`:

1. **Inventory & classify** the scope into code, tests/evidence, narrative/story, art/media, gameplay/design content, and docs. Non-code work is always reported in the summary, never silently dropped or bulk-deleted.
2. Identify garbage candidates across the target classes (dead code, duplication/redundant abstraction, placeholder/mock/speculative work, structural rot, orphaned companions).
3. **Multi-angle review** each candidate — reachability, dynamic use, history/intent, coupling/completeness, domain/non-code (parallel reviewer agents per `review-agents.md` in `assisted`/`sweep`). Delete only when every lens clears it (safe) and the full cluster is identified (complete). No single-pass deletion.
4. Apply the mode: `assisted` auto-deletes only the mechanically-provable safe tier; everything needing judgment goes to `.ai-dev-kit/workflow/findings.jsonl` for approval. `sweep` runs fully automated on a disposable branch with a green baseline.
5. **Delete the whole cluster** — implementation plus its tests, fixtures, snapshots, mocks, type defs, imports, registrations, docs, and solely-owned assets — so nothing is left orphaned (no "code deleted, test file kept"). Then run the **orphan sweep**: grep the deleted names/paths/asset-keys and assert zero remaining references.
6. Subtract stale documentation (orphan drafts, superseded/duplicate docs, dead registry entries, and stale feature-ledger entries in deprecated ledger mode) per `document-discipline.md`. Code-vs-doc drift is a finding for `/ai-dev-kit-doc-review`, not a deletion.
7. Commit deletions on the current task branch as separate `refactor:`/`chore:` commits (not a separate topic branch: the gate only counts a record for the branch it checks), run build/lint/typecheck/test, and confirm green. A red suite after subtraction means restore the cluster and re-investigate.
8. Record the pass in `.ai-dev-kit/workflow/subtraction-log.md` (`- YYYY-MM-DD | commit: <HEAD sha> | branch: <current branch> | scope: <scope> | mode: <propose|assisted|sweep>`) so the preflight/merge subtraction-debt gate registers that the cadence was met.

The default scope for a cadence pass is the current branch's diff against its merge base with the target branch. If the survey finds no candidates, that is a valid, quick pass: give a short summary, make no commit, and record `scope: <base>..HEAD (none)` with an unchanged `mode:` value (the gate rejects text after the mode, such as `mode: propose (none)`). Stop when candidates are exhausted; never invent deletions or churn to make a pass look productive.

Deliver the work-result summary (per class, including non-code) plus what was removed and what was deliberately kept, with reasons. Never delete exported APIs, entrypoints, config, migrations, i18n, generated/fixture data, narrative/gameplay/art assets, or dynamically-referenced code without explicit approval, regardless of mode.
