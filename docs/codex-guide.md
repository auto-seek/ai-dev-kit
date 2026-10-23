# AI Dev Kit v2 — Codex Adapter Guide

Install the Codex skills with Codex's skill installer or the host-provided skill
marketplace. The canonical repo paths are:

```text
skills/ai-dev-kit
skills/ai-dev-kit-loop
skills/ai-dev-kit-preflight
skills/ai-dev-kit-test-review
skills/ai-dev-kit-doc-review
skills/ai-dev-kit-merge-guardian
skills/ai-dev-kit-player-review
skills/ai-dev-kit-clean
skills/ai-dev-kit-cascade-init
skills/cascade-center-agent
skills/cascade-flow
```

Expected install layout:

```text
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-loop/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-preflight/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-test-review/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-doc-review/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-merge-guardian/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-player-review/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-clean/
${CODEX_HOME:-~/.codex}/skills/ai-dev-kit-cascade-init/
${CODEX_HOME:-~/.codex}/skills/cascade-center-agent/
${CODEX_HOME:-~/.codex}/skills/cascade-flow/
```

If the built-in installer only accepts GitHub repositories, mirror this repo to
GitHub and install the paths above. For local or offline installs, use the
fallback copier:

```bash
bash bootstrap/install-skill.sh --target codex
```

Project bootstrap for Codex hooks:

```bash
bash bootstrap/init-skill.sh /path/to/project --harness codex --profile balanced
```

This creates:

```text
AGENTS.md
.codex/hooks.json
.ai-dev-kit/profile.yml
.ai-dev-kit/skills/ai-dev-kit*/
.ai-dev-kit/skills/cascade-center-agent/
.ai-dev-kit/skills/cascade-flow/
.ai-dev-kit/workflow/
docs/development/feature-ledger.md
```

If the project already has `.codex/hooks.json`, the bootstrap preserves it and
writes `.codex/hooks.skill-first.json` unless `--overwrite-hooks` is provided.

Refresh only the Codex adapter later:

```bash
bash bootstrap/install-adapter.sh /path/to/project --harness codex --overwrite
```

Codex should read the project `AGENTS.md`, then use:

```text
.ai-dev-kit/skills/ai-dev-kit/SKILL.md
.ai-dev-kit/profile.yml
```

Preflight:

```bash
bash /path/to/ai-dev-kit/scripts/skill-first-gate.sh --phase preflight --project /path/to/project
```

Invoke installed skills directly:

```text
/ai-dev-kit-loop
/ai-dev-kit-preflight
/ai-dev-kit-test-review
/ai-dev-kit-doc-review
/ai-dev-kit-merge-guardian
/ai-dev-kit-player-review
/ai-dev-kit-clean
/ai-dev-kit-cascade-init
/cascade-center-agent
/cascade-flow
```

For Git task centers, use `ai-dev-kit-cascade-init` to set up storage and optional
web admission, `cascade-center-agent` to join by ID and level, and `cascade-flow`
to view tasks. The last two include their required clients/assets; copy the whole
skill directories, not just their `SKILL.md` files. Product Git permissions are
checked separately after joining.
