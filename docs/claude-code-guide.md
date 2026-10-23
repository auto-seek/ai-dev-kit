# AI Dev Kit v2 — Claude Code Adapter Guide

Install from the Claude Code plugin marketplace:

```text
/plugin marketplace add https://github.com/auto-seek/ai-dev-kit.git
/plugin install ai-dev-kit@ai-dev-kit-marketplace
/reload-plugins
```

If the installed Claude Code version only accepts GitHub marketplace slugs,
mirror this repo to GitHub and use `owner/repo`; the repository already contains
Claude plugin marketplace metadata.

The plugin exposes:

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

Local or offline fallback:

```bash
bash bootstrap/install-skill.sh --target claude
```

Project bootstrap for Claude Code hooks:

```bash
bash bootstrap/init-skill.sh /path/to/project --harness claude --profile balanced
```

This creates:

```text
CLAUDE.md
.claude/settings.json
.ai-dev-kit/profile.yml
.ai-dev-kit/skills/ai-dev-kit*/
.ai-dev-kit/skills/cascade-center-agent/
.ai-dev-kit/skills/cascade-flow/
.ai-dev-kit/workflow/
docs/development/feature-ledger.md
```

If the project already has `.claude/settings.json`, the bootstrap preserves it
and writes `.claude/settings.skill-first.json` unless `--overwrite-hooks` is
provided.

Refresh only the Claude adapter later:

```bash
bash bootstrap/install-adapter.sh /path/to/project --harness claude --overwrite
```

Claude Code should read the project `CLAUDE.md`, then use:

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
