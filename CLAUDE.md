# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repository is AI Dev Kit v2: a skill-first workflow kit for agent harnesses. The product shipped to users is the set of skill packages under `skills/` and their workflow tooling. Changes here are to skills, Node/Bash tooling, installers, templates, and manifests; real repository/process/protocol tests live under `tests/`.

## Commands

```bash
npm run build                                                              # validate (no compile step — see below)
bash bootstrap/init-skill.sh /path/to/project --harness claude --profile balanced
bash bootstrap/install-adapter.sh /path/to/project --harness generic
bash scripts/skill-first-gate.sh --phase preflight --project /path/to/project
```

`npm run build` is a validation gate, not a compiler: it checks Bash/Node syntax, skill entrypoints and manifest JSON, then runs test-scope, team-gate/process and fast shell tests. `npm test` includes the full shell suite; `npm run test:integration` additionally requires an explicit real `CASCADE_BIN`. See `tests/README.md`. Tests are repo-internal and not shipped to plugin users.

## Distribution Model

The packages declared in `marketplace/index.json` reach users two ways — keep both paths working when you touch skills:

1. **Plugin / marketplace (daily use):** `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` (Claude Code plugin install) and `marketplace/index.json` (the local skill-market manifest, including `skillPackages` and `slashCommands`). Adding, renaming, or removing a skill means updating these manifests — `npm run build` only checks they parse, not that they list the right skills.
2. **Project bootstrap:** `bootstrap/init-skill.sh` copies skills + profile + workflow ledgers into a target repo's `.ai-dev-kit/` and optionally installs a harness adapter. `bootstrap/install-skill.sh` is the offline/local fallback copier; `bootstrap/install-adapter.sh` installs/refreshes only the harness adapter.

## Release Convention

Plugin clients (`/plugin update`) detect a new release **by version number**, not by commit. Shipping new skills or behavior without bumping the version means users `update` and see nothing — exactly the "pushed but no update" failure. So any user-facing change (new/renamed/removed skill, slash command, gate behavior, profile shape) MUST bump the version in **all three** files, kept in lockstep:

- `.claude-plugin/plugin.json` → `version`
- `.claude-plugin/marketplace.json` → both `metadata.version` and `plugins[0].version`
- `package.json` → `version`

Use semver: new skill/feature → minor (`0.2.1 → 0.3.0`); fix/docs-only → patch. Bump as part of the same change (or a trailing `chore: bump ... version` commit), then push. Add a matching `CHANGELOG.md` entry for the new version. `marketplace/index.json`'s top-level `"version": 1` is the manifest *schema* version — leave it alone. `npm run build` only checks these files parse, not that the version moved, so this is a manual discipline. Changes to repo-internal docs only (this file, `CHANGELOG.md`, `README.md`, `docs/`) are not delivered to plugin clients and do not require a version bump.

## Architecture

```text
skills/
├── ai-dev-kit/            # the reusable skill: core rules + references/ (loop, test-review, document-discipline, review-agents, agent-prompts, subtraction, asking-the-user, plain-language)
└── ai-dev-kit-*/          # 6 user-invoked workflow skills (loop, preflight, test-review, doc-review, merge-guardian, clean) — thin entry points into the references above

bootstrap/                 # installers (init-skill / install-skill / install-adapter)
scripts/
├── generate-skill-profile.cjs   # derives profile.yml for a target project
├── skill-first-gate.sh          # the runtime hook gate (stop/preflight/merge phases)
└── upgrade-v1-to-skill.cjs      # migrates v1 installs to v2 skill layout
templates/
├── adapters/              # codex/, claude/, generic/ hook wiring; generic/ holds the cross-harness hook contract
├── profiles/              # profile.yml shape
├── workflow/              # LEDGER, findings, doc registry templates copied into projects
└── workstation/           # Linux GUI workstation container: generic base image + example project layer
```

The workflow skills do not duplicate logic; they point at `skills/ai-dev-kit/references/*.md`. Behavior changes belong in the references, not the workflow-skill wrappers.

### Gate phases

`skill-first-gate.sh` is the enforcement mechanism, wired as a harness hook via the adapters. `--phase stop` blocks only on open critical/high findings in `.ai-dev-kit/workflow/findings.jsonl`. Preflight/merge require the tracked project `gate-contract.json`, its selected requirements, reviewed test/test-scope changes, branch-local subtraction evidence and coordination state. In Cascade mode, preflight requires an ACTIVE task and runs the real project argv; merge requires COMPLETED and an unchanged exact-HEAD preflight receipt. Design bindings remain a workflow requirement: legacy ledger mode checks them mechanically, while Cascade reviewers verify the task's referenced design. Commit all candidate files before final preflight. See `docs/team-gate-migration.md`; the shared operations ledger is not automatically a global product acceptance contract. `--phase status` is a read-only receipt/readiness report that also lists this machine's resource locks and workstation pools; opt-in contract keys add retryable BLOCKED exits, per-task args and requirement files, and a `receipt_binding: merge-base` merge queue whose single integrator runs `--phase integrate` before merge.

## Design Rules

- V2 install path is `bootstrap/init-skill.sh`; do not reintroduce generated heavy `AGENTS.md` / `CLAUDE.md` templates.
- Harness support belongs in `templates/adapters/<harness>/` and `bootstrap/install-adapter.sh`. Cross-harness behavior belongs in the skill or the generic hook contract, never in harness-specific files.
- Keep hooks light. The stop gate blocks explicit findings only; preflight/merge gates enforce ledgers, test-review evidence, and merge readiness.
- Test files are untrusted until a test-review pass validates contract, assertions, and mocking boundaries.
- Documentation is workflow state: update feature ledgers, doc registry, and findings when development reality changes.

## Validation

Before committing:

```bash
npm run build
python3 -m venv --clear /tmp/ai-dev-kit-skill-validator
. /tmp/ai-dev-kit-skill-validator/bin/activate
python -m pip install --disable-pip-version-check --no-cache-dir 'PyYAML==6.0.2'
for d in skills/*; do python scripts/quick-validate-skill.py "$d"; done
```
