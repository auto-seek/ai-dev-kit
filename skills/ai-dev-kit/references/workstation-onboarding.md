# Workstation Onboarding

How a project starts using workstations (Linux containers with a private
screen) for GUI evidence, and then player review, from nothing. Read it in
order; each step needs the one before it. It is written for a project's
maintainers and for agents doing the setup.

The kit ships a small project that does every step:
`templates/workstation/examples/starter/` (a two-window `xmessage` "game").
`tests/starter-example.test.cjs` runs its configuration and scripts on every
build, and `tests/starter-workstation.test.cjs` plays it on real Docker. Copy
its files and replace the game.

Related references: `templates/workstation/README.md` (image, `ws-*` tools,
measurements), "Workstation Pools" in `loop-workflow.md` (queueing, leases,
reclaim), `player-review.md` (the reviewer role), `no-focus-stealing.md` (what
evidence code may not do).

## 0. Prerequisites

- Docker. On macOS, Docker Desktop: its VM memory (Settings > Resources)
  limits how many workstations fit; `docker info --format '{{.MemTotal}} {{.NCPU}}'`
  shows what containers can use.
- Node 24 or newer and Git on the host, and the kit checkout (`<kit>` below).
- The program runs on Linux. A game engine needs a Linux build or editor
  binary in the image; software rendering (Mesa llvmpipe for OpenGL, lavapipe
  for Vulkan) needs no GPU.

## 1. Build The Image

Build the generic base, then a project layer `FROM` it with the engine, SDKs
and fonts the program needs:

```bash
docker build -t ai-dev-kit/workstation-base:local <kit>/templates/workstation/base
docker build --build-arg BASE=ai-dev-kit/workstation-base:local -t <project>/workstation:1 tools/workstation
```

Pin every download by version and checksum, as the Godot example in
`templates/workstation/examples/godot-dotnet/` does. Tag the image with a
version and change the tag whenever its Dockerfile changes. A pool can build
its image itself when it is missing (`build` below). The starter example runs
on the base image alone.

## 2. Declare The Pool

Commit `.ai-dev-kit/workstations.json`. It is read from the main checkout;
relative paths resolve against the project root.

```json
{
  "schema_version": 1,
  "warn_hold_seconds": 900,
  "pools": {
    "starter": {
      "image": "ai-dev-kit/workstation-base:local",
      "slots": 2, "cpus": 1, "memory": "512m", "screen": "1280x720x24",
      "env": { "WS_PLAY_SUMMARY": "tools/ws-summary.sh" },
      "start": ["game/start.sh"],
      "requires": ["game/assets", "game/.import/lock.sha256"],
      "prepare": "on the host: tools/prepare.sh [--from <another checkout with the same assets.lock>]",
      "timeout_seconds": 300, "max_hold_seconds": 1800
    }
  }
}
```

Top level:

| Key | Default | Meaning |
| --- | --- | --- |
| `schema_version` | required | `1` |
| `warn_hold_seconds` | 1800 | status reminds when a claim is held longer; pools may override |
| `pools` | required | pool name (`[A-Za-z0-9][A-Za-z0-9._-]*`) to settings |

Each pool:

| Key | Default | Meaning |
| --- | --- | --- |
| `image` | required | Docker image every workstation starts from |
| `build` | none | `{ "dockerfile": ..., "context": <dockerfile's directory>, "args": {} }`; builds `image` when it is missing |
| `slots` | 3 | workstations that can be held at once (1 to 64) |
| `cpus` | 3 | CPU limit per workstation; may not exceed Docker's CPUs; `LP_NUM_THREADS` follows it |
| `memory` | `"2.5g"` | memory limit per workstation, swap included (at least `64m`) |
| `screen` | `"1920x1080x24"` | Xvfb screen, `WxHxD` with depth 8, 16 or 24 |
| `env` | `{}` | environment for the workstation, for example `WS_PLAY_NODE` and `WS_PLAY_SUMMARY` |
| `mounts` | `[]` | extra bind mounts `{ "source", "target", "readonly" }`; `source` may start with `~/`, `target` is absolute |
| `start` | required | argv every run starts with; extra run arguments follow it |
| `user` | `"host"` | `"host"` runs as your uid and gid (files it writes stay yours); `"image"` uses the image's user |
| `min_free_disk` | `"5g"` | a claim needs this much free on Docker's disk and on the host disk, else exit 75 |
| `requires` | `[]` | paths the checkout must have before a claim; checked on the host |
| `prepare` | `""` | text printed when `requires` is not met: how to prepare a checkout |
| `timeout_seconds` | 1800 | `ws-run --timeout` for `run --pool` and the claim's `exec=` line (0 = none) |
| `max_hold_seconds` | 3600 | lease: a claim not renewed within it is reclaimed |
| `warn_hold_seconds` | top level | per-pool override |

### How many, and how big

A claim refuses (exit 2, with the numbers) when the sum of slots × memory
over all pools is more than Docker can use. Size from the program's peak:

| Work in a workstation | `memory` | 8 GB Docker VM (7.65 GiB usable) |
| --- | --- | --- |
| Run only: assets imported and code built on the host | 2.5g | 3 workstations |
| Build and run (for example `dotnet build`, then the game) | 3g | 2 workstations; 3 need a VM of at least 10 GB |

These are measured with Godot 4.7 .NET running a 4K Forward+ capture on
lavapipe: run-only peaked at 2.50 GiB, build and run at 2.55 GiB and was
OOM-killed once at 2.5g. Three run-only workstations together used 7.1 GiB.
Lower resolutions and lighter programs need less; the starter example uses
512m and one CPU. Measure your own peak: `ws-run.json` records
`container.memory_peak_bytes` and `oom_kills` for every run.

A Godot .NET project with 1.6 GB of assets runs this way: three slots of 3
CPUs and 2.5g at 3840x2160x24, `requires` naming its assets, its import cache
and its built game assembly, and one host script as `prepare`.

## 3. Prepare Checkouts On The Host

A workstation bind-mounts the agent's own checkout and only runs it. Fill the
checkout on the host first:

1. Pull the assets (or check them against the lock file).
2. Fill the engine's import cache. If another checkout on this machine has a
   cache built from the same asset lock (for example the same hash of the lock
   file), clone it: `cp -c -R` on APFS, `cp -R --reflink=always` on Btrfs or
   XFS. The engine then verifies the clone and imports only what changed.
   Otherwise import once.
3. Build code the program needs (C# assemblies built on macOS ran unchanged in
   the Linux image).

Do none of this inside a workstation. A copy made there goes through the bind
mount and is real data on the host disk: 192 MiB of assets copied in a
container used 192 MiB, while `cp -c` on the host used about 1 MiB. A first
import or build in a workstation also needs more memory than running (see the
table above).

`requires` and `prepare` enforce the order. A claim from a checkout that lacks
a listed path exits 1 before anything starts and prints `prepare`. Make the
prepare script safe to rerun, check the asset lock, and write a completion
marker last that `requires` names, so an interrupted import is never taken for
a finished one. The starter's `tools/prepare.sh` does all three.

## 4. Capture Evidence

Evidence code claims a workstation, starts the program on its screen, drives
it and takes screenshots there, then releases it. The starter's
`tools/capture.sh`:

```bash
claim=$(node "$kit/scripts/resource-lock.cjs" claim --pool starter --owner-pid $$ --label "menu capture") || exit $?
value() { printf '%s\n' "$claim" | sed -n "s/^$1=//p"; }
ws=$(value workstation); token=$(value token)
trap 'node "$kit/scripts/resource-lock.cjs" release --pool starter --token "$token" >/dev/null' EXIT
docker exec -d "$ws" ws-run --timeout 300 -- game/start.sh
docker exec "$ws" ws-input wait starter 30 >/dev/null
docker exec "$ws" ws-shot /ws/out/menu.png
echo "evidence=$(value out)"
```

- `claim` prints `token`, `slot`, `workstation`, `out`, and ready `exec`,
  `renew` and `release` commands (`--json` for one object). The checkout is
  mounted at its own path and is the working directory, so relative paths in
  `start` and `env` work.
- `out` is the evidence directory on the host, `/ws/out` inside. It holds
  `claim.json` (pool, slot, image and image id, screen, start command),
  `ws-run.json` (exit code, duration, memory peak, OOM kills) and whatever the
  run writes there.
- `ws-input` (`wait`, `focus`, `key`, `type`, `move`, `click`) and `ws-shot`
  act on the workstation's screen only. `ws-play` does the same and records
  each step with a screenshot for player reviews. Match windows by an ASCII
  `WM_CLASS` name; non-ASCII titles may not match. There is no window manager:
  fullscreen requests are ignored.
- One run without steps: `node "$kit/scripts/resource-lock.cjs" run --pool
  starter -- <args>` claims, runs `start` plus the arguments, and releases.
- Agents whose shell ends between tool calls claim without `--owner-pid` and
  run the printed `renew` command within `max_hold_seconds`.
- `status --pool starter` shows holders, waiters, leases, recent reclaims,
  Docker memory fit and actual disk use. `status` alone lists every lock and
  pool of the project on this machine; so does `skill-first-gate.sh --phase
  status`.
- `prune --pool starter [--dry-run] [--evidence-days <n>]` removes containers
  no slot holds, images the pool built that are no longer configured, and with
  `--evidence-days` evidence older than n days (filed player-review evidence is
  kept until its `keep_until`).

Exit codes: 0 done; 1 not prepared, not held, or a Docker failure; 2 usage or
configuration error; 75 every workstation is busy after `--wait`, or too
little free disk: nothing ran, retry later (see "Exit 75 means BLOCKED" in
`loop-workflow.md`).

Disk notes:

- `du` counts cloned files at their full size. Measure with `df` before and
  after, or read `status --pool`, which reports allocated blocks.
- After deleting files on the host that a workstation used, Docker Desktop
  may keep them open for a while (384 MiB stayed allocated for at least 15
  minutes and was freed on its own within 35). `lsof +L1` lists such files.
  Check freed space later, not right after `rm`.

Evidence code never takes the host screen: no bringing windows to the front,
no focus changes, no system pointer or keyboard. Commit
`.ai-dev-kit/focus-steal-scan.json` listing the capture code and run
`scripts/focus-steal-scan.cjs` in the project's checks
(`no-focus-stealing.md`); the starter's `tools/check.sh` does.

## 5. Player Review

A player review makes a player-visible change wait for a different session to
play the exact candidate on a workstation (`player-review.md`). Declare it in
`.ai-dev-kit/gate-contract.json`:

```json
"player_review": {
  "paths": ["game"],
  "pool": "starter",
  "lock": "assets.lock",
  "rubric": "docs/qa/player-rubric.md",
  "specs": ["docs/design/menu.md"],
  "keep_days": 30,
  "owners": ["lead-designer"]
}
```

- `paths` (and `exclude`): repository-relative roots of player-visible files.
- `pool`: the pool reviewers claim. `lock`: the asset lock whose hash the
  playtest records.
- `rubric` and `specs`: the only project documents a reviewer reads. Write
  them for a player: what each screen shows and how it should behave.
- `keep_days`: how long filed evidence is kept (default 30).
- `owners`: people who may waive a review. Owners are read from the target
  branch's contract.

### When to turn it on

Once `paths` is on the target branch, every branch that touches those paths
fails merge until a review passes or an owner waives it. Turn it on only when
reviews can actually run:

1. Steps 1 to 4 work: a claim from a prepared checkout starts the program and
   evidence capture works.
2. The reviewer's channel works: `ws-play` can reach every screen the paths
   cover (coordinates, keys, and the project's `WS_PLAY_NODE` and
   `WS_PLAY_SUMMARY` commands if it has them), and the rubric and specs exist.
3. On a branch, add `player_review`, make a player-visible change, and run one
   whole review: request, a reviewer session plays and files, and
   `skill-first-gate.sh --phase merge` passes. Merge that branch afterwards.

List `owners` at the same time, so a change that cannot wait for a review can
still merge with a recorded waiver.

### The flow

1. Author: commit the change, then
   `node <kit>/scripts/player-review.cjs request --goal "..." --focus "..."`.
   It records the author's session and prints the playtest file.
2. Start a new session for the reviewer with only the reviewer role from
   `player-review.md` and the playtest path.
3. Reviewer: claim from the playtest's pool, start the program, play with
   `ws-play`, write `review/report.md` and `review/report.json` from
   `<kit>/templates/player-review/`, release, then
   `player-review.cjs file --request <id> --evidence <out>`.
4. Merge. Any new commit needs a new review.

Waiver: an owner, from their own session (not the author's), runs
`player-review.cjs waive --owner <owner> --reason "..."` and commits the
printed file by itself. An agent runs `waive` only when the named owner asks
for it in that agent's own conversation.

Gate behavior: `--phase preflight` warns about a missing or invalid review;
`--phase merge` and `--phase integrate` fail; `--phase status` shows the state
and counts it against merge readiness. A waiver passes merge and is printed as
`player review: WAIVED by owner ...`.

## Common Failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| claim exits 2: the pools may use more memory than Docker can use | slots × memory over all pools exceeds Docker's memory | lower `slots` or `memory`, or give Docker more memory |
| claim exits 2 naming a setting | invalid `workstations.json` | fix the named key |
| claim exits 1: checkout lacks ..., prepare it on the host | `requires` not met | run the `prepare` steps on the host in that checkout |
| claim exits 1: image is not available locally | image not built or pulled | build it, or add `build` to the pool |
| claim or run exits 75 | all workstations busy after `--wait`, or less than `min_free_disk` free | wait and retry; `status --pool` shows holders and disk; `prune` frees unused containers, images and old evidence |
| `renew` or `release` says the claim was reclaimed | the lease expired, or the owner pid ended | claim again; renew within `max_hold_seconds`, or pass `--owner-pid` for a process that lives as long as the claim |
| `ws-run.json` shows exit 137 and `oom_kills` > 0 | the workstation hit `memory` | raise `memory` (and lower `slots`), or build and import on the host |
| exit 124 from `ws-run` | `--timeout` expired | raise `timeout_seconds`, or find the hang in the screenshots |
| `ws-input wait` finds no window | non-ASCII title, wrong name, or the program failed to start | match the ASCII `WM_CLASS`; read the program's output and `ws-run.json` |
| the window ignores fullscreen or a resize | no window manager in the workstation | set the window size directly (Godot: set `Window.Size`; `DisplayServer.WindowSetSize` alone does not update it) and size the screen to the design resolution |
| the engine imports everything again in each checkout | the import cache was not cloned from a checkout with the same lock | clone it on the host in `prepare`; check that the lock hashes match |
| host disk use grows by full asset size per checkout | assets or caches copied inside a workstation, or with plain `cp` | prepare on the host with `cp -c` or reflink; measure with `df` |
| freed space does not come back after `rm` | Docker Desktop keeps the files open | check `lsof +L1`; measure again later |
| merge fails: player review missing or stale | no passing review for HEAD | request a review of the current commit, or ask an owner to waive |
| `file` refuses the evidence | no `claim.json` (not played on a claimed workstation), the report names another build, or a screenshot is missing | play on a claimed workstation and file its `out` directory unchanged |
| merge fails: invalid waiver | owner not listed on the target branch, another commit or tree, empty reason, or signed by the author's session | the owner signs a new waiver for the current commit from their own session |
| the focus-steal scan fails | evidence code calls a host focus or input API | move the input into the app or a workstation; allow an entry only for code that runs inside a workstation, with a reason |
