#!/bin/bash
# The example's game, started on a workstation's screen by the pool's start
# command: a menu window, and after Start Game a second window.
set -euo pipefail
cd "$(dirname "$0")"
title=$(sed -n 2p .import/title.txt.imported)
buttons=$(awk '{ printf "%s%s:%d", (NR > 1 ? "," : ""), $0, NR - 1 }' menu.txt)
choice=0
xmessage -name starter -title "$title" -geometry 480x160+0+0 \
  -buttons "$buttons" -default "$(head -n 1 menu.txt)" "Welcome to $title" || choice=$?
[ "$choice" -eq 0 ] || exit 0
exec xmessage -name starter -title "$title: playing" -geometry 480x160+0+0 \
  -buttons Quit:0 -default Quit "You started a game."
