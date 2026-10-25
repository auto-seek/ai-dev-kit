#!/bin/bash
# Prepares this checkout on the host, before a workstation mounts it:
#   1. assets: a real project pulls them from its asset store here and checks
#      them against assets.lock; the example keeps game/assets in Git;
#   2. the import cache game/.import: cloned from another checkout whose cache
#      was built from the same assets.lock, else imported here. A cloned cache
#      is verified the way an engine verifies one: stale entries are imported
#      again.
# Never run this inside a workstation: a copy made there through the bind
# mount is real data on the host, while the host can clone (APFS clonefile,
# reflink) at almost no cost.
#   tools/prepare.sh [--from <checkout>]
set -euo pipefail
usage() { echo "usage: tools/prepare.sh [--from <checkout>]" >&2; exit 2; }
from=""
case $# in
  0) ;;
  2) [ "$1" = --from ] || usage; from=$(cd "$2" && pwd) ;;
  *) usage ;;
esac
cd "$(dirname "$0")/.."
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

while read -r name hash; do
  [ "$(sha256 "game/assets/$name")" = "$hash" ] || { echo "prepare: game/assets/$name does not match assets.lock; pull the assets again" >&2; exit 1; }
done < assets.lock
lock=$(sha256 assets.lock)

if [ "$(cat game/.import/lock.sha256 2>/dev/null)" = "$lock" ]; then
  echo "prepare: game/.import is current"
  exit 0
fi
clone() {
  if [ "$(uname)" = Darwin ]; then cp -c -R "$1" "$2" 2>/dev/null && return; else cp -R --reflink=always "$1" "$2" 2>/dev/null && return; fi
  echo "prepare: this filesystem cannot clone; copying $1 in full" >&2
  rm -rf "$2"
  cp -R "$1" "$2"
}
how=imported
if [ -n "$from" ]; then
  if [ "$(cat "$from/game/.import/lock.sha256" 2>/dev/null)" = "$lock" ]; then
    rm -rf game/.import
    clone "$from/game/.import" game/.import
    how="cloned from $from"
  else
    echo "prepare: $from has no import cache for this assets.lock; importing" >&2
  fi
fi
mkdir -p game/.import
imported=0
while read -r name hash; do
  if [ "$(head -n 1 "game/.import/$name.imported" 2>/dev/null)" != "imported $hash" ]; then
    { echo "imported $hash"; cat "game/assets/$name"; } > "game/.import/$name.imported"
    imported=$((imported + 1))
  fi
done < assets.lock
# Written last, so an interrupted import is never taken for a finished one.
echo "$lock" > game/.import/lock.sha256
echo "prepare: game/.import ready ($how; $imported imported)"
