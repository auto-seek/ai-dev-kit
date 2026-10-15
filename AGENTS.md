# AGENTS.md

This repository is AI Dev Kit v2: a skill-first workflow kit for agent harnesses.

## Commands

```bash
npm run build
bash bootstrap/init-skill.sh /path/to/project --harness codex --profile balanced
bash bootstrap/install-adapter.sh /path/to/project --harness generic
bash scripts/skill-first-gate.sh --phase preflight --project /path/to/project
```

## Architecture

```text
bootstrap/
├── init-skill.sh          # installs skill/profile/workflow and optional adapter
├── install-skill.sh       # fallback copier for local/offline skill package installs
└── install-adapter.sh     # installs or refreshes harness adapters

skills/
├── ai-dev-kit/            # reusable skill and references
└── ai-dev-kit-*/          # user-invoked workflow skills

scripts/
├── generate-skill-profile.cjs
├── skill-first-gate.sh
└── upgrade-v1-to-skill.cjs

templates/
├── adapters/              # codex, claude, generic hook contract
├── profiles/              # generated profile shape
└── workflow/              # ledger, findings, doc registry templates
```

## Design Rules

- V2 install path is `bootstrap/init-skill.sh`; do not reintroduce generated heavy `AGENTS.md` / `CLAUDE.md` templates.
- Harness support belongs in `templates/adapters/<harness>/` and `bootstrap/install-adapter.sh`.
- Cross-harness behavior belongs in the skill or generic hook contract, not in harness-specific files.
- Cross-harness implementation discipline is defined in
  `skills/ai-dev-kit/references/implementation-discipline.md`; keep the core
  skill, quick checklist, review workflows, and slash templates aligned with it.
- Keep hooks light. The stop gate should block explicit findings only; preflight/merge gates enforce ledgers, test-review evidence, and merge readiness.
- Test files are untrusted until a test-review pass validates contract, assertions, and mocking boundaries.
- Documentation is workflow state. Update feature ledgers, doc registry, and findings when development reality changes.

## Validation

Before committing:

```bash
npm run build
python3 -m venv --clear /tmp/ai-dev-kit-skill-validator
. /tmp/ai-dev-kit-skill-validator/bin/activate
python -m pip install --disable-pip-version-check --no-cache-dir 'PyYAML==6.0.2'
for d in skills/*; do python scripts/quick-validate-skill.py "$d"; done
```
