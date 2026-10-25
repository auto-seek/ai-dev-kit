#!/bin/bash
# The UI summary ws-play prints (WS_PLAY_SUMMARY in the pool's env). It runs
# inside the workstation, so xdotool here sees only the private screen.
set -euo pipefail
for id in $(xdotool search --onlyvisible --classname starter 2>/dev/null || true); do
  eval "$(xdotool getwindowgeometry --shell "$id")"
  echo "window \"$(xdotool getwindowname "$id")\" at $X,$Y, ${WIDTH}x$HEIGHT"
done
