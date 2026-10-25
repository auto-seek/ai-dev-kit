#!/bin/bash
# Captures the menu as evidence on a workstation of pool "starter": claim,
# start the game, wait for its window, screenshot, release. Prints the
# evidence directory. Input and screenshots stay on the workstation's screen.
#   AI_DEV_KIT=<ai-dev-kit checkout> tools/capture.sh
set -euo pipefail
kit=${AI_DEV_KIT:?set AI_DEV_KIT to the ai-dev-kit checkout}
cd "$(dirname "$0")/.."
claim=$(node "$kit/scripts/resource-lock.cjs" claim --pool starter --owner-pid $$ --label "menu capture") || exit $?
value() { printf '%s\n' "$claim" | sed -n "s/^$1=//p"; }
ws=$(value workstation)
token=$(value token)
trap 'node "$kit/scripts/resource-lock.cjs" release --pool starter --token "$token" >/dev/null' EXIT
docker exec -d "$ws" ws-run --timeout 300 -- game/start.sh
docker exec "$ws" ws-input wait starter 30 >/dev/null
docker exec "$ws" ws-shot /ws/out/menu.png
echo "evidence=$(value out)"
