# Subtraction (Clean)

Use this for periodic subtraction passes: removing the meaningless, wrong, low-quality, and duplicate work that automated loop development accumulates, and keeping the project readable, maintainable, well-structured, and elegant.

Subtraction is **evidence-gated deletion**, not reformatting. The cardinal failure is removing real work. **Unused is not the same as dead** — prove it before you cut.

## Ledger Archiving (part of every pass)

While cleaning, also move feature-ledger entries whose Status has been
`merged` or `abandoned` for more than 7 days into
`docs/development/feature-ledger-archive.md` (same format, newest first).
The live ledger is read in full on every claim check — keeping it short
is a token-efficiency concern, not cosmetics.

Cascade-mode projects (0.8.0+) additionally export the coordination
history as part of the pass — one-way backup, never read back:

```bash
cascade --storage .ai-dev-kit/cascade history > docs/development/cascade-history.md
```

## Every Pass Produces Two Outputs

1. **A work-result summary** — what the loop actually produced in scope, organized so a human can see it. This is not optional: a clean pass reports work, it does not only delete.
2. **Subtraction actions** — what was removed (or proposed for removal) with evidence.

Never return only a deletion list. If you cannot summarize what real work exists in the scope, you have not surveyed enough to delete safely.

## Inventory First: Classify Every Work Product

Before judging anything garbage, inventory the scope and classify each item. **Not all work is code, and non-code work must always be reported, never silently dropped or bulk-deleted.**

| Class | Examples | Subtraction stance |
|-------|----------|--------------------|
| Code | source, scripts, build/config | Evidence-gated deletion per below |
| Tests & evidence | unit/integration/e2e, fixtures, snapshots, golden files | Deleted *with* their subject (see cluster) |
| Narrative / story | plot, dialogue, lore, quest/script text | **Report, do not delete** without explicit approval — continuity, not references, governs these |
| Art & media assets | images, sprites, audio, video, models | **Report**; deletable only when no asset-key/manifest/design-doc references it |
| Gameplay / design content | rules, balance tables, level/encounter data, configs | **Report**; treat as data the design owns, not code clutter |
| Docs | working drafts, decisions, runbooks, registry | Subtract the rot side only (see Documentation Subtraction) |

The work-result summary lists, per class, what was found and its status (kept / proposed / removed / handed off). Non-code deliverables appear in the summary even when you take no action on them — the operator needs to see what the loop produced.

## Intensity Modes

Pick the mode from arguments (default `propose`). Higher intensity trades approval checkpoints for speed; never raise intensity to skip evidence or review.

| Mode | Behavior | Use when |
|------|----------|----------|
| `propose` | Survey → multi-angle review each candidate → write findings → human approves → delete cluster + verify. No deletion before approval. | Default. Shared trunk, unfamiliar code, high blast radius. |
| `assisted` | Auto-delete the **safe tier** (mechanically provable, review lenses agree); write the rest as findings for approval. | Routine cleanup on an isolated branch with green tests. |
| `sweep` | Full automated pass over everything classified as garbage, then verify and report. | Disposable `feature/clean-*` branch only, clean git tree, green baseline, change reviewed before merge. |

A `sweep` on its own `feature/clean-*` branch is a separate task whose record clears only that branch. The cadence pass that keeps a feature branch under the threshold runs on that feature branch (see [No-candidate pass](#no-candidate-pass) and the rule above it).

### Safe tier (the only thing `assisted` deletes without asking)

Mechanically provable garbage, each item independently verifiable and agreed by every review lens:

- commented-out code blocks and disabled/`xit`/`skip` dead test bodies;
- unreferenced **private** symbols (0 graph references, not exported);
- unreachable branches after a constant/early return;
- unused imports, variables, and parameters flagged by the linter;
- files with 0 inbound references that are not entrypoints, configs, fixtures, or non-code assets;
- exact duplicates (identical AST/normalized text) where one copy is clearly canonical.

Commented-out dead code is not the same as documentation examples, doctests,
test contracts, license notices, or tool directives. Preserve these and apply
`implementation-discipline.md` when reviewing prose. A comment's length or
vocabulary does not prove it is garbage; rewriting its explanation needs
judgment and belongs in propose tier.

Everything else — abstractions, "unused" public APIs, structural moves, any non-code asset, anything needing judgment — is **propose tier**, regardless of mode.

## Garbage Targets

1. **Dead & unreachable code** — unreferenced functions/files, commented-out blocks, unused imports/vars, orphaned modules left by prior loop iterations.
2. **Duplication & redundant abstraction** — copy-paste utilities, near-identical implementations, premature/over-engineered abstractions, wrapper layers with a single caller.
3. **Placeholder, mock & speculative work** — TODO stubs, fake/mock implementations merged as if real, "might need later" code, half-finished features behind no flag.
4. **Structural & readability rot** — misplaced files, inconsistent naming, dumping-ground modules, files grown past one coherent responsibility, churned formatting.
5. **Orphaned companions** — tests, fixtures, mocks, snapshots, type defs, or assets whose subject is already gone (see cluster rules).
6. **Unneeded and AI-flavored text** — UI explanation nobody needs (restated headings, intro paragraphs, helper text on obvious fields, tooltips repeating labels), marketing or explanatory wording in buttons and messages, and comments or docs written as work reports. Rewrite or delete per `plain-language.md`; strings in i18n resources still need explicit approval (below).

## Multi-Angle Review (No Single-Pass Deletion)

No candidate is deleted on one perspective. Review each from every lens below; in `assisted`/`sweep` these can run as parallel reviewer agents per `review-agents.md` (adversarial verification — each lens tries to *save* the candidate). A candidate is deletable only when **all lenses clear it (safe)** AND **the full cluster is identified (complete)**.

- **Reachability** — static references, entrypoints, exports, public/SDK surface.
- **Dynamic use** — reflection, string-keyed dispatch, glob/registry/DI loading, codegen input, i18n keys, env-driven paths.
- **History & intent** — `git log`/`blame`: is this work-in-progress from a current reservation, recently added, or an intentional seam? Newer-than-the-active-reservation code is not garbage.
- **Coupling & completeness** — what companion artifacts travel with it; will removal leave orphans or dangling references?
- **Domain / non-code** — does this back narrative, gameplay, or art referenced by id, manifest, or design doc even if no code imports it?

If any lens is uncertain, the candidate stays in propose tier with the open question stated. Never delete "to see if tests fail."

## Delete The Whole Cluster — No Orphans

When you remove a unit, remove everything that exists only to serve it, in the same change. Deleting the implementation but leaving its test, fixture, or mock is itself a defect this skill must prevent. The cluster for a unit:

- its tests (unit/integration/e2e) and their fixtures, snapshots, golden files;
- mocks, stubs, and factories that exist only for it;
- type definitions / interfaces / `.d.ts` declared only for it;
- imports and barrel/index re-exports of it;
- DI/registry/route/command/hook registrations of it;
- config keys, feature flags, and env vars referencing only it;
- doc, comment, and changelog references to it;
- non-code assets it solely owns (images, audio, data, narrative entries) — subject to approval per class above.

**Orphan sweep (mandatory after any deletion).** Grep the codebase for the deleted names, paths, and asset keys; assert zero remaining references. Assert no test now targets a non-existent subject and no fixture/asset has lost its only consumer. A surviving import or test of deleted code must surface as build/lint/typecheck/test failure — treat that as incomplete subtraction, not "fix forward."

## Never Subtract Without Explicit Approval

Public/exported APIs and SDK surface · entrypoints, routes, CLI commands, hooks · config, secrets, env wiring · DB migrations and seed data · i18n/translation resources · generated code and its source · golden/fixture test data · **narrative, gameplay, and art assets** · anything referenced only dynamically · code newer than the current loop reservation that may be work-in-progress.

## Documentation Subtraction

`clean` owns the **subtraction side** of docs; `/ai-dev-kit-doc-review` owns synchronization. Per `document-discipline.md`, subtract:

- orphan brainstorming/draft docs in `docs/working/` with no active feature-ledger binding → mark `superseded`/`archived` and move to `docs/archive/YYYY/`;
- duplicate or stale docs that a newer doc supersedes (set `supersedes`);
- `.ai-dev-kit/docs/registry.yml` entries pointing at deleted or moved files;
- feature-ledger entries left `active`/`reserved` for work that merged or was abandoned.

When a doc is contradicted by code (not merely stale-by-status), that is drift, not garbage — record a finding and hand off to `/ai-dev-kit-doc-review` rather than deleting the claim.

## Findings, Ledger, Verification

- Write each propose-tier candidate to `.ai-dev-kit/workflow/findings.jsonl` with evidence and the lenses that cleared it; a candidate closes only after the cluster is deleted and verified.
- When you surface candidates for approval, ask per `asking-the-user.md`: batch them, carry a recommended call per item, and never interrogate the user file-by-file.
- Run the cadence pass on the current task branch, against that branch's own diff (`git diff <base>...HEAD`, where `<base>` is the merge base with the target branch), and commit any deletions there as separate `refactor:`/`chore:` commits so they stay reviewable apart from the feature commits. The gate only counts a record whose `branch:` names the branch being checked and whose `commit:` is an ancestor of its HEAD; a clean pass reserved as a separate topic on another branch never clears this branch's debt.
- After any deletion batch: run the orphan sweep, then build, lint, typecheck, and tests; confirm green. A red suite after subtraction means restore the cluster and re-investigate, not "fix forward."
- Record the pass in `.ai-dev-kit/workflow/subtraction-log.md` (date + HEAD commit) so the preflight/merge gate can confirm the cadence was met.
- Deliver the **work-result summary** (per class, including non-code) alongside what was removed and what was deliberately **kept** with reasons. Silent scope limits read as "nothing left to clean" when they aren't.

### No-candidate pass

A pass that surveys the branch diff and finds nothing worth removing is valid and should be quick: a short work-result summary, no commit, and one record line that marks the outcome in `scope:`:

```text
- 2026-10-06 | commit: <HEAD sha> | branch: feature/<slug> | scope: <base>..HEAD (none) | mode: propose
```

Keep `mode:` exactly `propose`, `assisted`, or `sweep` — the gate rejects a current-branch record with anything after the mode (for example `mode: propose (none)`) as malformed. Stop when candidates are exhausted: do not invent deletions, restyle code, or churn files to make a pass look productive. A further pass is due only when new commits accumulate.

## Loop Cadence (Enforced)

Subtraction is periodic and **required**, but enforced at a safe checkpoint — not by auto-deletion. A feature branch may accumulate at most N commits (default 10, configurable) without a recorded clean pass; the preflight/merge gate FAILs on overdue subtraction debt, blocking `ready-for-review`/merge until a pass runs. After each pass, append one line to `.ai-dev-kit/workflow/subtraction-log.md`:

```text
- YYYY-MM-DD | commit: <sha> | branch: <branch> | scope: <scope> | mode: <mode>
```

The gate only checks this log — it never deletes. Keep destructive deletion an explicit, evidence-gated pass; never fold it into the loop's stop hook. The threshold lives in `.ai-dev-kit/profile.yml` (`subtraction.every_commits`) and resolves as `--subtraction-threshold <n>` > `AI_DEV_KIT_SUBTRACTION_THRESHOLD` > profile > default 10; disable via threshold 0, `AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1`, or `subtraction.gate_enabled: false`.

## Rationalizations — STOP

| Excuse | Reality |
|--------|---------|
| "It has 0 references, just delete it." | 0 *static* references ≠ dead. Clear every review lens — dynamic use, history, domain — first. |
| "I'll delete it and see if tests fail." | Tests are incomplete. Absence of a failing test is not proof of deadness. |
| "It's just loop-generated junk anyway." | Loop also produces real features, narrative, and assets. Classify and report each item; don't bulk-trust the source. |
| "sweep mode means I can skip the evidence/review." | Intensity changes *who approves*, never *whether you prove* or *how many lenses review*. |
| "One angle says it's unused, that's enough." | No single-pass deletion. All lenses must clear it. |
| "I deleted the code; the test/fixture can stay." | Orphaned companions are garbage you created. Delete the whole cluster and run the orphan sweep. |
| "It's just an image / story file, not code — ignore it." | Non-code work must be reported, and deleted only with approval. Never silently drop it. |
| "This abstraction is over-engineered, I'll inline it now." | Single-caller today ≠ safe to remove. Propose tier — record it, get approval. |
| "Removing the doc is faster than archiving it." | Subtraction preserves history: mark `superseded`/`archived`, update registry. Don't erase the trail. |
| "Tests went red but my deletion is correct." | Red after subtraction = restore the cluster and re-investigate, not force-merge. |

## Red Flags — back to propose tier

- Deleting an exported symbol, route, CLI command, or hook.
- Deleting a file you can't fully trace the callers of.
- Deleting code without locating its tests, fixtures, mocks, and docs.
- Touching narrative, gameplay, or art assets without approval.
- Approving a deletion on a single review angle.
- Raising the mode to `sweep` to avoid writing findings or running lenses.
- "It's probably unused." / "Nobody calls this anymore." / "It looks like a leftover."
- Bundling deletions into an unrelated feature commit.
- A test going red and the urge to edit the test instead of restoring the code.
