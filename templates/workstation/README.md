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

A pool starts one container per claim:

```bash
docker run -d --name <pool>-<slot> --label ai-dev-kit.workstation=<pool> \
  --user "$(id -u):$(id -g)" --cpus 3 --memory 2.5g --memory-swap 2.5g -e LP_NUM_THREADS=3 \
  -v "$WORKTREE:$WORKTREE" -w "$WORKTREE" -v "$EVIDENCE:/ws/out" \
  <image> --screen 3840x2160x24                    # session
docker exec <pool>-<slot> ws-run --timeout 1800 -- <project start command>
docker rm -f <pool>-<slot>                         # release
```

- Mount the worktree at its host path so build outputs that record absolute
  paths stay valid on both sides. Mount nothing that exposes a host display.
- Match `LP_NUM_THREADS` to `--cpus`; Mesa's software rasterizers otherwise
  start one thread per VM CPU in every container.
- Set `--memory-swap` equal to `--memory` so a runaway run is killed and
  reported instead of swapping the shared VM.

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
