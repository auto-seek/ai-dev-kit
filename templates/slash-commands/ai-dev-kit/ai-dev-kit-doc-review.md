# AI Dev Kit Doc Review

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill and read `references/document-discipline.md`.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Compare changed docs, active planning docs, the active Cascade reservation (or `docs/development/feature-ledger.md` only in deprecated ledger mode), `.ai-dev-kit/docs/registry.yml`, code diffs, tests, and command evidence.

Check:

- docs contradicted by code;
- code behavior changes not reflected in docs;
- brainstorming or planning docs that need `draft`, `superseded`, or `archived` status;
- missing frontmatter or registry entries;
- reservation status that no longer matches reality (Cascade node state, or feature-ledger status in deprecated mode).

Do not invent facts. Cite file:line or command evidence, then make the smallest doc update needed to restore consistency.
