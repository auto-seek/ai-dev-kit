# AI Dev Kit 0.11 / Cascade 0.7 migration

This release requires `cascade --version` to report at least 0.7.0. Every
storage mode uses the same native ownership contract: task ID is the canonical
branch slug and `reserved_for` names the agent, or is null for shared work.
The gate matches the canonical slug against the branch's second segment: a task
branch is `<owner-or-type>/<canonical-task-id>` with exactly one prefix segment, and
a further segment fails. Releases before 0.13.1 accepted only the `feature/`, `fix/`
and `codex/` prefixes.
Do not run older workers against a namespace enabled for this contract.

## Existing coordination configuration

Bootstrap preserves an existing profile byte for byte. Reinstalling the skill
does not change the engine, backend, Git remote, namespace, role, credentials or
custom project commands. Fresh profiles default to Cascade file storage.
Use `/ai-dev-kit-cascade-init` or the explicit `set-coordination.cjs` operation
to migrate, after verifying the selected backend. Update `min_version` to
`">=0.7.0"` and ensure the executable on the worker's PATH is the upgraded one.

Version 0.11 retains deprecated ledger mode for existing configurations. The
earlier announcement that this release would remove it is superseded. New
projects use Cascade; there is no silent engine/backend switch on error.

## Legacy `slug@owner` graphs

The old kit checked slug collisions before a separate add transaction, while
each owner created a different node ID. Two concurrent publishers could both
succeed. The new kit refuses any namespace containing `@` in task IDs, including
completed historical lane nodes. It does not infer ownership or mix two ID
schemes.

Migrate a legacy namespace during a planned coordination pause:

1. Stop all publishers and workers using that namespace. Finish or explicitly
   release active claims with their original identities and fencing tokens.
2. Export `history` and inventory all nodes, dependencies, outcomes and pending
   deliverables. Preserve the old namespace read-only as the history record.
3. Initialize a new namespace. Publish outstanding tasks under unique canonical
   slugs, using `add-node --id <slug> --reserved-for <owner>` for self-serve work
   and omitting `--reserved-for` for the shared pool. Rebuild dependency edges
   and carry verified upstream results into the corresponding contracts.
4. Resolve any duplicate slug explicitly before publishing. Do not copy both
   formerly successful reservations into different IDs.
5. Verify under-tier and wrong-owner refusals plus an owner claim/finish round
   trip in a smoke-test namespace. Update the main checkout's profile/overlay
   and only then resume upgraded workers on the new namespace.

There is no automatic rename of event-sourced DAGs, no background dual write and
no fallback to the archived namespace. A graph with only canonical unreserved
IDs can continue in place after all clients have upgraded; `reserved_for: null`
means public pool work.

## Main-checkout state

The gate, lane wrapper and review tool resolve the main checkout via Git's
common directory. Its `.ai-dev-kit/profile.yml`, `profile.local.yml`, workflow
evidence and relative file/cache paths are authoritative for all linked
worktrees. A tracked `.ai-dev-kit` copy in a feature worktree does not create a
second store. Bootstrap the main checkout first. Separate clones share only the
configured Git/Redis center; they have their own local profiles and credentials.

## Test-review receipts

When using Kit 0.12 or later, also follow [test scope migration](test-scope-migration.md):
declare the reviewed branch's test roots and replace schema-1 approvals after actual review.

Review covers changes from `merge_policy.target_branch` through HEAD, plus
staged, unstaged and untracked tests. The configured target must exist and share
history with HEAD. The gate does not substitute a different target on error.

Commit the intended test changes, review their behavior and assertions, and
record substantive findings in the branch's narrative (copy
`.ai-dev-kit/workflow/test-review-template.md` to the `report` path printed by
`test-review-evidence.cjs paths`; current kits store evidence per branch, see
`skills/ai-dev-kit/references/test-review.md`). On approval set
`- Status: approved` and `- Reviewer: <identity>`, then run from the feature checkout:

```bash
node <kit>/scripts/test-review-evidence.cjs snapshot --project .
node <kit>/scripts/test-review-evidence.cjs record --project .
bash <kit>/scripts/skill-first-gate.sh --phase preflight --project .
```

The receipt binds the review to branch/base plus each changed test's Git HEAD,
index and working content. Content edits, index-only changes, new untracked
tests, branch changes or base changes require renewed review. A prose verdict
without this receipt fails. `AI_DEV_KIT_ALLOW_UNREVIEWED_TESTS` no longer bypasses
the check. These receipts attest to review scope; they do not replace tests or
the reviewer's judgment.

## Release verification

```bash
npm run build
npm test
CASCADE_BIN=/absolute/path/to/cascade npm run test:integration
```

The integration suite uses temporary repositories, real bootstrap, linked
worktrees and a real bare Git remote with independent caches. It forces both
publishers to observe an empty graph before racing the native add operation;
exactly one may succeed. It also checks wrong-owner rejection, persisted
ownership, profile preservation and content-bound test-review failures.
