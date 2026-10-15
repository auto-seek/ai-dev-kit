# Git-backed Cascade coordination (Redis-free cross-machine design)

status: production candidate; local/container/hosted acceptance passed
owner: autoseek + ai-dev-kit
created: 2026-07-16
targets: Cascade storage backend, then AI Dev Kit `coordination.cascade.storage: git`

## Production hardening evidence

Repository and dependency review before the production pass found:

- `GitStorage`, `GitRefLease`, `FileStorage`, `StorageProtocol`, the CLI storage
  factory, and their unit/integration/container tests are the existing public
  path to extend.
- `filelock` already provides the local cache mutex; Git
  `--force-with-lease` is the remote CAS primitive. GitPython or another
  storage framework would duplicate these capabilities without improving the
  remote atomicity contract.
- Python's standard `threading` primitives are sufficient for lease renewal;
  no scheduler or background-service dependency is required.
- Shell string matching is not a trustworthy JSON boundary. The gate already
  ships in a Node-based package, so strict `JSON.parse` validation is the
  mature parser selected for Cascade CLI output.
- Required-path failures that must remain visible are: missing/old Cascade
  CLI, invalid coordination configuration, storage timeout/error, malformed
  CLI output, lost Git lease renewal, state CAS rejection, and archive/state
  publication failure.
- The production contract intentionally breaks the 0.9 fail-open gate: a
  preflight or merge cannot pass when coordination cannot be proven. Tests,
  workflow docs, profiles, and changelog must move together.

## Decision

Redis is optional, not fundamental. Cross-machine coordination needs a shared
linearizable update primitive; a Git remote ref provides compare-and-swap
(CAS) through an expected old object id. Cascade should own this backend so the
kit keeps one task model and does not grow a second scheduler.

Do not implement this by committing `.ai-dev-kit/cascade/` on ordinary feature
branches. That creates merge conflicts after the fact and permits two agents
to believe they claimed the same task. Coordination state lives on dedicated
remote refs and never enters the product branch/worktree.

## Ref model

For namespace `<ns>`:

```text
refs/heads/cascade-state/<ns>   immutable state commits
refs/heads/cascade-lock/<ns>    short-lived distributed transaction lease
```

Regular branch refs are used for hosted-Git portability. A dedicated
coordination repository is recommended; using the product remote is allowed
when CI ignores these branch prefixes.

Each state commit contains the complete Cascade storage transaction:

```text
graph.json
events.jsonl
tokens/
operations.json
artifacts/
```

The commit parent is the previously observed state commit. This makes the
state/event history auditable and compactable without mixing it with source
history.

## Transaction protocol

The first implementation should preserve Cascade's existing pessimistic
`StorageProtocol.lock()` contract:

1. Fetch the lock ref and state ref.
2. Create a unique lock commit containing holder id and expiry.
3. Acquire with `push --force-with-lease=<lock-ref>:<expected-old-oid>`.
   Creation expects a missing ref; expired-lock takeover expects the exact old
   lock oid. Only one contender can succeed.
4. Materialize the state commit into a dedicated local cache, then run the
   existing FileStorage-backed transaction locally.
5. Commit graph, events, tokens, operation log, and artifacts together.
6. Publish the new state with
   `push --force-with-lease=<state-ref>:<base-oid> <new-oid>:<state-ref>`.
7. Delete the lock ref only with a lease expecting the holder's own lock oid.

A crash before step 6 publishes nothing; a crash after step 6 leaves valid
state and at worst a stale lock, which expires. Fencing tokens remain the final
protection against stale workers finishing a reclaimed task.

Once proven, Cascade may replace the lock ref with pure optimistic retries, but
that requires central retry support for every mutating client method. Today
only claim has explicit lock-contention retries, so the leased-lock adapter is
the safe first cut.

## Semantics and trade-offs

Git provides:

- atomic ref CAS on standard servers;
- existing credentials, ACLs, audit history, and replication;
- no Redis process, password, TLS setup, or backup job;
- immutable state history suitable for repair and replay.

Git does not provide:

- low-latency queue operations or push notifications;
- server-clock TTLs (lease expiry uses client time/HLC and needs a skew bound);
- efficient very-high-frequency heartbeats;
- guaranteed acceptance of every hosting policy, hence the hosted-Git test
  matrix and regular branch-prefix choice.

Agents poll/fetch with backoff. Git mode targets development workflow latency
(seconds), not a high-throughput runtime scheduler. Redis remains an optional
backend for teams that need sub-second claims or frequent heartbeats.

## Safety acceptance criteria

Production acceptance evidence:

1. **Passed:** two independent containers racing one claim had exactly one
   winner; the 1,000-attempt/8-worker contention soak produced one token and
   zero internal errors; finite lock-contention backpressure is reported
   separately instead of being hidden or misclassified.
2. **Passed:** CAS rejection preserves the winner and the other cache
   reloads the published state.
3. **Passed:** a stale fencing token cannot finish after reclaim.
4. **Passed:** real process-group kill injection immediately before and after
   the state push proves publish-nothing versus recover-complete semantics.
5. **Passed:** transactions renew the lease every one-third TTL; takeover uses
   the maximum clock-skew tolerance recorded by both holders, with skew
   injection coverage. Defaults are 120-second TTL and 5-second skew bound.
6. **Passed:** local bare repository, GitHub SSH-over-443, and CODING HTTPS
   accepted state/lock/archive refs and CAS cleanup.
7. **Passed:** active-state fetches are depth-one; `cascade compact` archives
   the old tip and replaces active history with one equivalent root snapshot.

## Delivery slices

1. **Done:** Cascade Git ref lease/CAS primitive with local-bare concurrency tests.
2. **Done:** Cascade `GitStorage` implementation and CLI flags.
3. **Done:** AI Dev Kit profile/gate/lane `storage: git` support and contract tests.
4. **Done:** GitHub/CODING hosted acceptance and failure injection.
5. **Done:** Git is the recommended zero-service cross-machine backend; Redis
   remains an optional low-latency backend and is not a default dependency.
