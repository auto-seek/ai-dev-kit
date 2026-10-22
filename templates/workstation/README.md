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
└── examples/godot-dotnet/   # example project layer: Godot .NET + .NET SDK on Mesa
    ├── Dockerfile, SHA512SUMS, fetch.sh
```

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
ws-run [--screen WxHxD] [--out DIR] [--timeout SECONDS] [--shot NAME] [-- command...]
```

- **Batch** (`-- command...`): start a screen on `:99` unless one is already up,
  run the command, write `<out>/ws-run.json`, stop the screen it started, and
  exit with the command's code (124 after `--timeout`, 127/126 if it cannot
  start, 2 for usage errors). The command's whole process group is stopped when
  it exits or times out, so background children cannot keep using the screen.
- **Session** (no command): keep the screen up until the container stops. Drive
  it step by step with `docker exec <ctr> ws-run -- ...`, `ws-shot`, `ws-input`;
  batch runs inside a session reuse its screen and leave it up.

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
```

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
a new container.

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
