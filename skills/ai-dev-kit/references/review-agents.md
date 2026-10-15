# Review Agents

Use multiple review lenses for high-risk work instead of one broad self-review.

## Roles

### Architecture Reviewer

Focus:

- SOLID, DRY, KISS, YAGNI;
- public API boundaries;
- dependency direction;
- unnecessary abstractions;
- duplicated logic that codegraph/search could reveal;
- whether a simpler change would satisfy the requirement.
- transitional implementations justified by a future rewrite;
- fallback paths that hide errors or weaken required semantics;
- obsolete compatibility shims that should be removed through a coordinated
  breaking change;
- speculative guards, retries, wrappers, and configuration branches.
- comments that obscure the actual constraint with narration or vague jargon;
  apply `implementation-discipline.md`, not a preferred vocabulary.

### Fact Reviewer

Focus:

- claims made by the implementing agent;
- docs versus code;
- command output versus final summary;
- graph evidence for references, callers, and blast radius.
- changed or affected comments/docstrings versus code and contracts; do not
  accept an invented rationale or a guarantee the code cannot provide.

### Copy Reviewer

Use when a change adds or changes user-facing text, and for final reports.
Apply `plain-language.md`.

Focus:

- UI text that can be deleted without hurting the user (restated headings,
  intro lines, helper text on obvious fields, tooltips repeating labels);
- buttons that are not short verbs, labels that are not plain nouns, errors
  that don't say what to do, empty states longer than one line plus an action;
- marketing words, exclamation marks, emoji, explanatory parentheses, and
  internal concepts exposed to users;
- the same thing named differently across screens or against existing i18n;
- reports and summaries that skip the cause, overstate verification, or rely
  on coined terms and buzzwords.

### Test Reviewer

Use `test-review.md`.

### Doc Curator

Use `document-discipline.md`.

### Merge Guardian

Focus:

- feature reservation status;
- bound design/decision document under `docs/working/` or `docs/decisions/`;
- worktree/branch hygiene;
- complete scope only;
- closed findings;
- no placeholder/mock/unfinished production paths;
- docs and tests aligned with the implemented feature.

## Adversarial Verification Prompt

```text
You are an adversarial reviewer. Your job is to refute the implementation claims, not approve them.

Assume each claim has a meaningful chance of being wrong.
For each claim:
1. Use codegraph/search, file reads, tests, and command evidence to look for counterexamples.
2. Mark it refuted, weak, or temporarily supported.
3. If supported, cite the evidence.
4. If refuted or weak, give the smallest required fix or the missing verification.

Do not rely on the implementer's summary. Do not accept "looks fine" without evidence.
```

## Findings Format

```json
{
  "id": "F001",
  "severity": "critical|high|medium|low",
  "source": "architecture|fact|test|doc|merge",
  "status": "open|blocked|resolved|deferred",
  "location": "path:line",
  "title": "short finding",
  "evidence": "what was observed",
  "required_fix": "what must change",
  "resolution": "",
  "verification": ""
}
```

## Blocking Policy

Block merge when:

- critical findings remain open;
- accepted high findings remain open and affect shipped behavior;
- tests used as evidence fail test review;
- docs contradict the implementation for user-facing or operational behavior;
- the feature ledger says the work is blocked, active, or incomplete;
- a ready-for-review reservation lacks a bound design/decision document, unless explicitly waived by the user;
- production code contains placeholder, fake, mock, or unfinished behavior.
- production code contains a transitional path, hidden fallback degradation,
  unjustified compatibility residue, duplicated mature capability, speculative
  abstraction, or heavy defensive machinery prohibited by
  `implementation-discipline.md`.
- changed or affected comments materially mislead maintainers or API users;
  identify the contradicted code/contract and concrete risk. Wording-only
  suggestions are non-blocking; preserve useful docs and required directives.

Medium and low findings can be deferred only with a clear reason and owner.
