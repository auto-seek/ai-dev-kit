#!/bin/bash
# The example's preflight command (gate-contract.json preflight.argv).
set -euo pipefail
kit=${AI_DEV_KIT:?set AI_DEV_KIT to the ai-dev-kit checkout}
for script in game/start.sh tools/*.sh; do bash -n "$script"; done
node "$kit/scripts/focus-steal-scan.cjs" --project .
