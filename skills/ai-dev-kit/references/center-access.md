# Move a center or repair access

Use this for an existing project's center migration, SSH/ref permission failure
or post-migration access repair. New projects use [Project center](project-center.md);
new workers use [Worker enrollment](worker-enrollment.md). A server's successful
probe proves that probe identity only, not that every employee can connect.

## Authentication is a setup failure, not a merge exemption

Keep the feature branch, uncommitted work, test results and exact candidate SHA.
Do not merge local dev/main first, disable Cascade, switch to file/ledger, reuse
an old receipt or mark the gate deferred to work around authentication. Passing
tests cover product behavior; they do not prove ownership, the approved baseline,
complete requirements or a content-bound project preflight receipt.

The agent investigates what it can read, then asks only for missing facts.
Report the failed command, sanitized error, project/center/namespace, agent ID,
device and offered public-key fingerprint. Never request a private key,
password, authentication dump or another person's identity.

1. Resolve the project's current approved entry. Check user/host/port/repository,
   main-checkout profile and ignored overlay, environment overrides (especially
   `AI_DEV_KIT_CASCADE_GIT_REMOTE`), explicit CLI arguments, supervisor config and
   scheduled-process environment. A changed URL alone does not migrate keys.
2. Inspect effective SSH configuration with `ssh -G` for the actual host/user;
   inspect the chosen public key with `ssh-keygen -lf <key.pub>`. Confirm its
   private counterpart remains on this device. Do not dump the private file.
3. Use a bounded `git ls-remote --exit-code <approved-remote>
   refs/heads/cascade-state/<namespace>` under the actual execution identity.
   Distinguish failure modes:
   - `Permission denied (publickey)`: authentication failed before Git; compare
     offered key/user to the administrator's registered fingerprint.
   - Host-key mismatch: verify the approved server fingerprint through the
     administrator; do not disable checking or blindly remove known_hosts.
   - DNS/timeout/refused connection: investigate transport, not key enrollment.
   - Repository/ref-policy denial after authentication: inspect repository ACL
     and allowed refs. A read-only key cannot run normal Cascade transactions.
   - Exit 2 for a missing expected ref: this is not a new-project invitation;
     confirm the entry instead of creating an empty graph.
   A Git-only SSH account can reject `ssh -T` or shell commands after successful
   authentication. Use the Git operation, not shell denial, as the access test.
4. An authorized administrator verifies device/owner, public-key fingerprint and
   exact project access, backs up the current authorization, and enrolls only
   that device's key through the existing management mechanism. A direct
   OpenSSH deployment retains its forced command, restrictions and protected
   file ownership; do not replace the whole authorization file or broaden all
   keys to all project repositories. No admin authority: request one concrete
   enrollment, not a workflow bypass. Re-read the registration and fingerprint.
5. The employee—not the center using its own key—re-runs Git read, the approved
   isolated native roundtrip, formal state/history integrity, and actual
   CLI/supervisor/scheduler bindings. Use the project's pinned runtime/source;
   a local shell's success does not certify a differently sanitized worker
   subprocess. Report one verified outcome and remaining blockers.
6. Before resuming a task, reconcile its actual state, current owner/token,
   lease and any published result branch. Authentication repair does not renew
   an expired lease, retry a FAILED task, or grant another agent's reservation.
   Re-run the applicable full preflight on the final candidate under the
   repaired effective configuration, then native delivery and merge gates in
   project order. Changed HEAD/base/inputs/config require fresh receipts.
   Merge and device/game acceptance remain subject to their existing authority.

Non-mutating diagnosis or isolated tests may continue within the original
request while access is blocked; that is not permission to publish, merge,
claim new business work or resume an expired/uncertain execution.

## Cutover: enroll participants before resuming them

Maintain a small migration record in the project's controlled operations docs:
old/new entry, planner owner, participant/device/actual process entry, public-key
fingerprint, runtime provenance, access verification, stopped/resumed state,
source/target refs, backup and recovery location. Use observed evidence, not
`all upgraded` inferred from a version in one terminal. No credentials.

1. Inventory every access path: planner, worker loops, self-serve sessions,
   supervisor and renewal processes, CI/readers/viewers. Ask owners to safely
   stop or finish in-flight work. Never infer that every session stopped from
   one employee's reply, an expired lease or an old list of names.
2. Provision the destination without opening it as a second business writer.
   Register each participant's own project-scoped key and validate actual
   destination access in an isolated namespace before formal cutover where
   possible. Prepare fresh private caches and the exact required runtime.
3. Freeze the old **project's** write entry and drain in-flight transactions,
   without freezing unrelated projects. Use the host's supported ref/ACL
   controls; state the actual enforcement boundary. A protocol-only fence is
   not an ACL. Never say `old source read-only` merely because users were asked
   not to write. Preserve the frozen refs and all state/archive history in a
   verified full backup; do not carry a live transaction lock into the new store.
4. Import the final frozen state/history, verify exact refs, object/history
   completeness, graph/events and archive refs, then run the authorized native
   destination probe. Preserve all business nodes, reservations, contracts and
   historical tokens; probe events are audit history, not product work.
5. Update the versioned project entry, active task transport contracts, local
   overlays, explicit dispatch/CLI bindings, viewers and existing center
   scheduler. Do not alter scope, baseline, tier, branch conventions, reviewer
   or validation policy as a side effect of the move.
6. Verify a restore from the final backup and the destination's effective
   permissions, then enable it as the sole current center. Resume the one
   planner and only individually verified participants under their existing
   authorization. Users may explicitly accept a center-only cutover while
   workers remain paused; label it **center enabled / participants pending**,
   not team ready. List each remaining enrollment blocker.

Keep protocol upgrades separate from storage moves. A runtime with new event
types must not write them until every actual reader/writer satisfies that
project's compatibility contract. Preserve existing failure-bound retry
approval and checks; never delete/recreate tasks or generic-edit FAILED to READY.

If a check fails before any source freeze, leave/restore the exact previous
local profile and overlay, and retain failure evidence. Once the old source is
fenced or the new source has accepted writes, stop and reconcile latest state:
do not silently point clients back to the old source. A reverse migration needs
another coordinated stop, latest complete backup/import and verification.

## Handoff

Report separately: center transport ready, each participant ready/pending,
planner schedule configured/actually observed, business task states, and
product verification/merge status. Do not conflate any two.

References: [OpenSSH authorized keys](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT),
[Git full bundle and restore](https://git-scm.com/docs/git-bundle).
