# Linux workstation container

A workstation is one Docker container that gives one agent a private virtual
screen (Xvfb), keyboard/pointer injection and screenshots. GUI checks run there
instead of on the host: nothing in the container can reach the host's display,
focus or pointer, so several agents can verify visual work at the same time.

```text
templates/workstation/
├── base/                    # generic image: Xvfb, xdotool, screenshots, ws-* entry
│   ├── Dockerfile
│   └── bin/ws-run, ws-shot, ws-input
└── examples/
    ├── godot-dotnet/        # example project layer: Godot .NET + .NET SDK on Mesa
    │   └── Dockerfile, SHA512SUMS, fetch.sh
    └── starter/             # example project: pool, host prepare, capture, player review
```

To set up a project from scratch, follow
`skills/ai-dev-kit/references/workstation-onboarding.md`; `examples/starter/`
is the project it walks through. Code that captures evidence follows
`skills/ai-dev-kit/references/no-focus-stealing.md`.

Project runtimes (engines, SDKs, fonts, assets) belong in a layer `FROM` the
base image, like the Godot example. The base stays project-neutral.

## Build

```bash
docker build -t ai-dev-kit/workstation-base:local templates/workstation/base
# slow link: --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
# (apt still verifies Debian's signed Release files)

templates/workstation/examples/godot-dotnet/fetch.sh        # official archives, SHA512-checked
docker build --build-arg BASE=ai-dev-kit/workstation-base:local \
  -t ai-dev-kit/workstation-godot-dotnet:local templates/workstation/examples/godot-dotnet
```

Versions are pinned: the Debian base by digest, apt packages by version, Godot
and the .NET SDK by file name and SHA512 from the publishers' own checksum lists.

## Entry contract

The image entrypoint is `tini -- ws-run`.

```text
ws-run [--screen WxHxD] [--out DIR] [--timeout SECONDS] [--shot NAME] [--watch] [--watch-port PORT] [--watch-vnc-port PORT] [-- command...]
```

- **Batch** (`-- command...`): start a screen on `:99` unless one is already up,
  run the command, write `<out>/ws-run.json`, stop the screen it started, and
  exit with the command's code (124 after `--timeout`, 127/126 if it cannot
  start, 2 for usage errors). The command's whole process group is stopped when
  it exits or times out, so background children cannot keep using the screen.
- **Session** (no command): keep the screen up until the container stops. Drive
  it step by step with `docker exec <ctr> ws-run -- ...`, `ws-shot`, `ws-input`;
  batch runs inside a session reuse its screen and leave it up.
- **Read-only live view** (`--watch` or `WS_WATCH=1`): starts `x11vnc -viewonly`
  (localhost only, port `5900` / `--watch-vnc-port`) and `websockify` serving
  noVNC on `0.0.0.0:6080` (`--watch-port` / `WS_WATCH_PORT`). Pointer and key
  events from the browser are discarded by `x11vnc -viewonly` and cannot reach
  the display or game (`x11vnc` polls with `-wait 10 -defer 10`). When `--watch`
  is off (the default), neither process starts and zero ports are exposed.

`ws-run.json`:

```json
{"exit": 0, "timed_out": false, "duration_s": 61.4, "started_at": "...",
 "screen": "3840x2160x24", "display": ":99", "command": ["godot", "..."],
 "container": {"memory_peak_bytes": 2683944960, "oom_kills": 0, "cpu_seconds": 78.2}}
```

`container` holds cgroup v2 totals for the whole container. Exit 137 with
`oom_kills > 0` is the kernel OOM killer, not a timeout.

Environment: `DISPLAY=:99`, `WS_OUT` (default `/ws/out`), `WS_SCREEN` (default
`1920x1080x24`). Under an unknown `--user` uid, `HOME` falls back to a writable
`/tmp/ws-home-<uid>`.

### Screenshots and input

```text
ws-shot FILE.png [WINDOW-ID]         # the virtual screen (or one window) as PNG
ws-input wait PATTERN [SECONDS]      # wait for a visible window, print its id
ws-input focus PATTERN               # give it input focus (there is no window manager)
ws-input key KEY...                  # e.g. Escape ctrl+s Page_Down
ws-input type TEXT
ws-input move X Y | click X Y [BUTTON]
ws-input hold SECONDS KEY...         # keys held down together, e.g. hold 1.5 w d
ws-input keydown KEY... | keyup KEY... # held across calls
ws-input press X Y SECONDS [BUTTON]  # a mouse button held down
ws-input mousedown X Y [BUTTON] | mouseup [BUTTON]
ws-input drag X1 Y1 X2 Y2 [SECONDS]  # left button, gliding through ten points
ws-input scroll X Y up|down [CLICKS]
```

Real-time controls need the held forms: a character walks only while its key
is down, a charged attack or a block lasts while the button is, a slider moves
with a drag. A tap (`key`, `click`) is too short for them.

For a player review, `ws-play` is the recorded player's channel: each call
(`focus`, `click X Y`, `node NODE`, `key`, the held forms above, `move`,
`type`, `wait`, `shot [NAME]`, `summary`) acts on the screen, saves a screenshot under
`$WS_OUT/review/shots/` and appends the step, with the screenshot's SHA-256, to
`$WS_OUT/review/steps.jsonl`. A project offers UI-node clicks and a UI summary
by setting `WS_PLAY_NODE` (a command that clicks the node named by its last
argument) and `WS_PLAY_SUMMARY` (a command that prints the summary) in the
pool's `env`; without them `node` exits 2 and `summary` lists the windows.
`type` goes through xdotool, which sends ASCII reliably but not other
characters: for those it remaps a spare keycode per character, and a program
that keeps its own copy of the keymap (Godot does) reads the wrong ones. A
project whose reviewers type other text sets `WS_PLAY_TYPE`, a command that
types the text given as its last argument through the program's own input
path. A real-time game sets `WS_PLAY_FREEZE` and `WS_PLAY_THAW`, commands that
stop and restart the game's own clock: every acting step thaws it, acts,
waits its settle time and freezes it before the screenshot, so the game runs
only while the reviewer acts. A reviewer decides in seconds, not in frames;
without them a fight is lost while the reviewer reads the screenshot. See
`skills/ai-dev-kit/references/player-review.md`.

`PATTERN` is matched against the title, then `WM_CLASS`. Prefer an ASCII class
(Godot sets it to the project name): Godot stores non-ASCII titles in `WM_NAME`
as Latin-1, which xdotool cannot match.

There is no window manager. Fullscreen requests are ignored (the window keeps
its requested size at 0,0), and a program that resizes its own window through a
low-level call may not see the resize; Godot's `DisplayServer.WindowSetSize`
does not update the `Window` node unless the window also moves, while setting
`Window.Size` works.

## Claiming a workstation

Projects declare a pool of workstations in `.ai-dev-kit/workstations.json` and
claim them through `scripts/resource-lock.cjs` (`claim`, `run`, `renew`,
`release` and `status` with `--pool`); see "Workstation Pools" in
`skills/ai-dev-kit/references/loop-workflow.md`. Each claim starts one session
container, the equivalent of:

```bash
docker run -d --name aidk-ws-<project>-<pool>-<slot>-<id> --label ai-dev-kit.workstation=<project>/<pool> \
  --user "$(id -u):$(id -g)" --cpus 3 --memory 2.5g --memory-swap 2.5g -e LP_NUM_THREADS=3 \
  -v "$WORKTREE:$WORKTREE" -w "$WORKTREE" -v "$EVIDENCE:/ws/out" \
  <image> --screen 3840x2160x24
docker exec <container> ws-run --timeout 1800 -- <start command> <args>
```

and release or reclaim runs `docker rm -f <container>`, so the next holder gets
a new container. The claimer also writes `claim.json` into the evidence
directory: pool, slot, workstation, image and image id, screen, optional `watch`
URL/port metadata, and start command, which a player review cites.

To open a read-only browser view on a claimed workstation, set `"watch": true`
(or `{"enabled": true, "bind": "127.0.0.1", "port": 0}`) in the pool's
`workstations.json` entry or pass `--watch` (`--watch-bind <ip>`, `--watch-port <port>`,
`--no-watch`) to `resource-lock.cjs claim` / `run`. Port `0` picks a free host
port per slot, bound to `127.0.0.1` by default (pass `--watch-bind 0.0.0.0` for
LAN access); the claimer prints `view=http://<host>:<port>/vnc.html` and records
`watch` in `claim.json`.

- The worktree is mounted at its host path so build outputs that record
  absolute paths stay valid on both sides. Nothing that exposes a host display
  is mounted.
- `LP_NUM_THREADS` follows `--cpus`; Mesa's software rasterizers otherwise
  start one thread per VM CPU in every container.
- `--memory-swap` equals `--memory`, so a runaway run is killed and reported
  instead of swapping the shared VM.

## Disk

Measured on an Apple M4 with Docker Desktop (8 GB VM), Godot 4.7.1 .NET and a
project with 1.6 GB of assets and a 720 MB import cache, running three 4K
`--panels` captures at once from three checkouts:

| What | Real disk |
| --- | --- |
| Example image (base + Godot + .NET + Mesa) | 1.81 GB once, shared by every workstation |
| Three running workstations | +12 MiB on Docker's disk (about 4 MB writable layer each), back to zero after release |
| Assets and import cache inside Docker | nothing: the checkout is bind-mounted |
| A checkout's own import cache, imported from scratch | 0.5 to 0.7 GB (489 MB and 720 MB at two asset versions) |
| Second checkout's assets and import cache, cloned with `cp -c -R` (APFS) | +1.5 MiB (apparent size 2.3 GB) |
| The same assets copied inside a workstation (`cp` or .NET `File.Copy`) | their full size: 192 MiB for 192 MiB |
| A checkout's C# `bin`/`obj` and `.godot/mono` | about 54 MiB |
| Evidence of one 4K `--panels` run (20 PNGs) | 174 MiB on the host |

`du` counts cloned files at full size, so measure with `df` deltas or the
pool's status, which reports actual use. Godot's import output was
byte-identical on macOS (Metal editor) and in the container (417 of 417
assets), a cloned import cache was accepted without re-importing (4 s instead
of 56 s), and a host import and a container import of the same checkout at the
same time finished with a cache identical to a single import. A running game
wrote nothing into the checkout's `.godot`. Workstations therefore use the
checkout's own `.godot`; there is no separate cache volume to manage.

Pull assets and fill the import cache on the host, where copies can be clones;
a workstation only mounts them. Pools can enforce this with `requires` and
`prepare` (see `skills/ai-dev-kit/references/loop-workflow.md`). Docker
Desktop's file sharing can keep files that a workstation touched open after the
host deletes them (384 MiB stayed allocated for at least 15 minutes in one
test and was released on its own within 35; `lsof +L1` lists them), so measure
freed space once the VM lets go.

## Memory

4K Forward+ `--panels` run, 3 CPUs per workstation; the peak is the
container's cgroup peak, which includes reclaimable page cache:

| Workstation | Limit | Result | Peak |
| --- | --- | --- | --- |
| Run only; C# built on the host (macOS) | 2.5 GB | passes | 2.50 GiB, at the limit |
| `dotnet build` and run in one workstation | 2.5 GB | passed here; one OOM kill in another run | 2.50 GiB, at the limit |
| `dotnet build` and run in one workstation | 3 GB | passes | 2.54 GiB |
| `dotnet build` and run in one workstation | 3.5 GB | passes | 2.55 GiB |

An 8 GB Docker Desktop VM gives containers 7.65 GiB. Three run-only
workstations at 2.5 GB fit (7.5 GiB declared; 7.1 GiB measured together).
Workstations that also build need 3 GB: two fit, and three need a Docker VM of
at least 10 GB. The pool refuses a configuration whose slots × memory exceeds
what Docker has.

Measured `--watch` (read-only VNC + noVNC) overhead on the base image at
`1920x1080x24`:

- **Watch off (default)**: 0 extra processes, 0 published ports, 0 MiB overhead
  (idle base container `memory.current` 15.03 MiB, `memory.peak` 16.42 MiB).
- **Watch on (`--watch`)**: `x11vnc` (~18.32 MiB RSS) + `websockify`
  (~33.80 MiB RSS), adding ~38.97 MiB cgroup `memory.current` idle over base
  and ~45.46 MiB `memory.peak` while streaming full-screen X11 updates at ~30 fps.

## Godot example

```bash
docker run --rm -v "$WT:$WT" -w "$WT" -v "$OUT:/ws/out" ai-dev-kit/workstation-godot-dotnet:local \
  --screen 3840x2160x24 --timeout 1800 -- \
  godot --path Game --audio-driver Dummy --rendering-method forward_plus --rendering-driver vulkan -- <game args>
```

Forward+ runs on lavapipe (Vulkan) and matches the Metal/Vulkan desktop
renderer; `--rendering-method gl_compatibility --rendering-driver opengl3` runs
on llvmpipe as a fallback. Build C# assemblies with the image's `dotnet build`
(mount the host NuGet cache read-only and set `NUGET_FALLBACK_PACKAGES` to avoid
network restores) and run `godot --headless --path Game --import` once per
checkout.

## Tests

```bash
WORKSTATION_IMAGE=ai-dev-kit/workstation-base:local npm run test:workstation
```

Real containers, Xvfb and XTEST input; requires Docker and fails without the image.
