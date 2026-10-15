# Delegated Implementation (Coordinator / Implementer)

Use this protocol when one agent (the coordinator — typically the stronger
or costlier model) designs, reviews, and merges, while delegate agents
(cheaper or parallel workers) implement reserved slices in isolated
worktrees. This keeps review quality at coordinator level while paying
implementation cost at delegate level. It is the sanctioned pattern for
"save the expensive model's budget" and for parallel slice execution.

## Division of Authority

The coordinator owns everything that changes shared state:

- Cascade graph mutations/reservations (or feature-ledger entries in
  deprecated ledger mode): reserve, status transitions, completion evidence;
- branch/worktree creation and removal;
- merges, pushes, and releases;
- the final decision that a delegate's work is accepted.

The delegate owns exactly one claimed slice inside one worktree. The
delegate must NOT mutate the graph/feature ledger, must not merge or push, and
must not expand scope beyond the reservation. If the audit reveals the
reserved scope is wrong (already exists, impossible, mis-sized), the
delegate stops and reports instead of improvising a different feature.

## The Delegation Brief

The coordinator's task brief must contain:

- worktree path and branch name (already created from the trunk);
- the reservation's Goal/Scope/Non-goals, restated concretely;
- audit-first instruction: read the current implementation before writing;
- project conventions that bite: layering rules, module-responsibility
  boundaries, venv/tooling paths, which suites and gates must pass;
- test discipline: pin literals in contract assertions (never derive
  expected values from the implementation's own constants), and
  commit BEFORE running mutation spot-checks — `git checkout` during a
  mutation loop destroys uncommitted work;
- the explicit "do not" list: no shared graph/ledger edits, no merge, no push;
- the report format below.

## The Delegate's Report

The final message back to the coordinator is a report, not prose for a
user. It must contain: audit findings (what existed vs what was a gap),
seam/design choices with reasoning, files touched, test counts and suite
results, gate result, mutation spot-check results (including any that
initially survived and how the test was hardened), exact commit shas,
and open risks the coordinator should weigh.

## Coordinator Verification (before merging)

Delegate reports are claims, not evidence. Before merging, the
coordinator re-establishes the facts:

1. `git log dev..HEAD` and `git diff dev --stat` — commits and scope
   match the report and the reservation; shared coordination state was not
   mutated outside the declared claim/finish operations;
2. re-run the project health gate and any suite the report leans on —
   do not trust pasted output;
3. read the core seam of the implementation (the function or contract
   the slice exists for) — not the whole diff, the load-bearing part;
4. check the design doc exists, has required frontmatter, and does not
   contradict the code;
5. rebase onto the current trunk if it moved, re-running the gate after;
6. only then flip ready-for-review, run the merge gate, and merge.

Record in the Cascade completion evidence (or merged ledger entry in legacy
mode) that implementation was delegated and what the coordinator verified —
future readers should know which review depth this slice received.

## Parallel Delegates

Parallel delegates must hold disjoint reservations (different files,
modules, and docs). Cascade atomically serializes claims; in deprecated ledger
mode the coordinator still serializes ledger writes. When two slices must touch the
same file, run them sequentially and rebase the second, or make one
delegate the explicit integrator.

## With the Cascade engine

Under `coordination.engine: cascade` the brief/report plumbing above is
mechanized: the brief lives on the node (contracts + metadata, optionally a
portable `required_tier`), workers self-select eligible tasks with `get-task
--agent-tier <lite|pro|max>`, and the report
is `finish-task --agent <claiming-agent> --token <fencing-token>
--summary/--critical`, and batch delegation uses generic
pull-loop workers — see "Spawning worker agents" in
`cascade-coordination.md`. The division of authority and the coordinator
verification checklist apply unchanged.
