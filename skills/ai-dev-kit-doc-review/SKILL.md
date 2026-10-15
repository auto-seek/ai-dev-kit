---
name: ai-dev-kit-doc-review
description: "User-invoked ai-dev-kit document review workflow. Use when the user invokes /ai-dev-kit-doc-review, asks to synchronize docs with implementation, archive brainstorming output, or verify docs against code facts."
---

# AI Dev Kit Doc Review

Use the `ai-dev-kit` skill first, then read `../ai-dev-kit/references/document-discipline.md`.

Arguments:

```text
$ARGUMENTS
```

Compare changed docs, active planning docs, the active Cascade reservation (or `docs/development/feature-ledger.md` only in deprecated ledger mode), `.ai-dev-kit/docs/registry.yml`, code diffs, tests, and command evidence.

Check:

- docs contradicted by code;
- code behavior changes not reflected in docs;
- brainstorming or planning docs that need `draft`, `superseded`, or `archived` status;
- missing frontmatter or registry entries;
- reservation status that no longer matches reality (Cascade node state, or feature-ledger status in deprecated mode).

Do not invent facts. Cite file:line or command evidence, then make the smallest doc update needed to restore consistency.
