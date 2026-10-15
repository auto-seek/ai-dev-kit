# AI Dev Kit Generic Harness Contract

This project uses ai-dev-kit v2 skill-first workflow.

Local skill:

```text
.ai-dev-kit/skills/ai-dev-kit/SKILL.md
```

Project profile:

```text
.ai-dev-kit/profile.yml
```

## Required Harness Behavior

Implement these hook moments if the harness supports them:

| Moment | Required command | Blocking |
|---|---|---|
| pre-command | block destructive shell commands | yes |
| post-edit | format changed files if project formatter exists | no |
| stop / finish | `bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase stop --project "{{PROJECT_PATH}}"` | yes on exit 2 |
| preflight / pre-merge | `bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase preflight --project "{{PROJECT_PATH}}"` | yes |

The harness should not run broad language-specific regex scans by default.
Use the skill's reviewer prompts and graph/profile guidance for code, test, doc,
and merge review.

## Generic Install Notes

If the harness has no hook system, expose equivalent user commands:

```bash
bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase stop --project "{{PROJECT_PATH}}"
bash "{{AI_DEV_KIT_PATH}}/scripts/skill-first-gate.sh" --phase preflight --project "{{PROJECT_PATH}}"
```

For custom harnesses, copy or translate this file into the harness-native
configuration format.

