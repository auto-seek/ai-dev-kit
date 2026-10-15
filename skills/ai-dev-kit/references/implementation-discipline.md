# Implementation Discipline

Read this before writing production code and during architecture, preflight,
and merge review. Apply the review criteria below; do not turn wording
preferences into merge blockers.

## Hard Rules

1. **Do not ship transitional implementations.** Do not merge a knowingly
   temporary path on the promise that it will be replaced or generalized
   later. Incremental delivery is valid only when every increment is complete,
   production-quality, and part of the intended final architecture.
2. **Do not degrade through fallback.** Do not catch a required-path error and
   silently continue, return success/WARN, switch to weaker semantics, skip a
   check, or substitute stale/default data. Preserve the error, add actionable
   context, and fix its cause. An alternate path is valid only when it is an
   explicit product contract with equivalent, independently tested semantics.
3. **Prefer a clean breaking change over compatibility residue.** When the
   correct design changes an API, schema, workflow, or module boundary, update
   callers, tests, docs, and migration steps in the same slice. Do not retain
   obsolete shims or dual paths unless compatibility is an explicit current
   requirement with an owner and removal condition.
4. **Research reuse before implementation.** Before adding code, inspect repo
   instructions, dependency manifests, codegraph/docgraph or targeted search,
   public facades, tests, and relevant framework/library capabilities. Extend
   a mature dependency or existing function when it meets the contract. For a
   non-trivial choice, record what was checked and why reuse did or did not fit.
5. **Implement the current contract directly.** Add an abstraction only for a
   demonstrated boundary or present duplication, not hypothetical scale.
   Validate at trust boundaries and handle specified or observed failures; do
   not add broad catches, speculative retries, impossible-state guards, wrapper
   layers, or configuration switches merely to feel safe.
6. **Write comments for the next maintainer.** Explain non-obvious reasons,
   constraints, or consequences in plain, specific language. Do not narrate
   the code, report your work, or dress up an obvious operation with jargon.
   Keep comments true as code changes; never invent a rationale to make code
   look intentional. See the comment guidance below.

## Comments That Help Maintain the Code

Write as a programmer leaving context for a teammate, not as an agent
summarizing its answer. Ask: what would a competent reader miss from the code
and names alone, and what could they break without this explanation?

- Prefer a concrete reason, invariant, unit, external constraint, or failure
  consequence. Say what must remain true and why, not just "ensure robustness"
  or "maintain consistency" without naming the risk.
- Omit obvious narration and decorative section banners. Use clearer names or
  simpler code when the explanation is only compensating for confusing code.
  Do not add a comment to every function, branch, or changed line.
- Keep progress reports, patch history, review replies, and future-development
  promises in commits, issues, or working docs. Source comments should describe
  the current behavior or a still-relevant constraint. A verified bug/spec
  reference is useful when accompanied by the local reason, not just a link.
- Use the repository's language and conventions. Be concise, but keep the
  detail needed to explain a tricky algorithm or protocol. Ordinary technical
  terms are fine; forced slang, metaphors, and promotional language are not
  what makes a comment human.
- Check explanations against code, tests, or an authoritative contract. If the
  reason is unknown, investigate or record the uncertainty outside the code;
  do not guess. Update or remove stale comments with the affected code.
- Preserve useful API docs and docstrings (including behavior, units, errors,
  and side effects), test intent/contracts, license notices, and tool directives.
  These may need to describe *what*, not just *why*. Keep their required syntax
  and explain any non-obvious suppression; do not remove them for brevity.

Examples (use the reason only when it is verified):

```python
# Before: Increment the retry counter.
retries += 1
# After: no comment needed; the code already says this.
```

```python
# Before: Enforce the atomicity boundary to guarantee coordination consistency.
# After: Keep the read and write under one lock; two workers could otherwise claim the same task.
```

```python
# 修改前：优化缓存生命周期管理，确保数据状态的正确性。
# 修改后：先删缓存再提交会让并发读把旧值写回缓存，所以要在提交后删除。
```

The examples are not templates to paste onto unrelated code. A short comment
is not automatically good, and a long one is not automatically bad.

## Before-Code Evidence

For non-trivial implementation, record these facts in the bound working or
decision document:

- repository symbols, modules, and tests searched;
- dependencies or mature frameworks evaluated;
- the existing path selected for extension, or the concrete gap requiring new
  code;
- errors and failure semantics that must remain visible;
- any breaking change and its caller/data/document migration.

If this evidence is missing, stop before writing code and perform the search.

## Review Questions

Block preflight or merge when any answer is yes:

- Is this path knowingly temporary or waiting for a future rewrite?
- Does an error become success, WARN, skipped verification, stale data, or
  weaker behavior?
- Is a compatibility shim preserving a contract that is no longer required?
- Was new code added without checking existing project/dependency capability?
- Is an abstraction, guard, retry, or configuration branch justified only by
  a hypothetical future scenario?
- Does a changed or directly affected comment misstate behavior, invent a
  guarantee or rationale, or omit a constraint needed to change/use the code
  safely? Cite the code or contract and the concrete risk when blocking.

During review, also remove redundant narration and rewrite vague commentary
in the touched scope. Wording-only preferences are non-blocking suggestions;
do not expand the slice into repository-wide comment cleanup. Judge meaning
and accuracy, not keyword blacklists, line limits, or comment-count quotas.

The smallest correct implementation is not the one with the fewest lines; it
is the one that fully satisfies the current contract without deferred design
debt, hidden failure, duplicate capability, or speculative machinery.
