#!/usr/bin/env bash
# lease-redis-test.sh — verifies scripts/cascade-lease.sh's atomic orchestrator
# election against a REAL redis. Kept out of the default `npm test` because it
# needs redis-server + the redis python client; run on demand: `npm run test:lease`.
# Missing dependencies fail explicitly; callers must provide the declared test
# environment instead of treating an unexecuted lease suite as success.
# Perspective: an orchestrator that requires exclusive Redis-backed ownership.
# Invariant: only the holder mutates the lease and backend failure is non-zero.
# Goal: prevent a second orchestrator from starting after a hidden lease failure.
# Migration: remains optional-backend integration evidence against real Redis.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEASE="$ROOT/scripts/cascade-lease.sh"

command -v redis-server >/dev/null 2>&1 || { echo "FAIL: redis-server not installed"; exit 1; }
python3 -c "import redis" 2>/dev/null || { echo "FAIL: python redis client not installed"; exit 1; }

PORT=63799; URL="redis://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
redis-server --port "$PORT" --save "" --appendonly no --daemonize yes --dir "$TMP" --logfile "$TMP/redis.log" >/dev/null 2>&1
for _ in 1 2 3 4 5; do redis-cli -p "$PORT" ping >/dev/null 2>&1 && break; sleep 0.2; done
redis-cli -p "$PORT" ping >/dev/null 2>&1 || { echo "FAIL: could not start redis"; rm -rf "$TMP"; exit 1; }
cleanup() { redis-cli -p "$PORT" shutdown nosave >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0; FAIL=0
L() { bash "$LEASE" "$@" --redis-url "$URL" --namespace demo --ttl 60 >/dev/null 2>&1; }
check() { # check <desc> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL  %s (expected rc %s, got %s)\n' "$1" "$2" "$3"; fi
}

echo "cascade-lease atomic election (real redis)"
echo "=========================================="
L acquire --holder A; check "A acquires" 0 $?
L acquire --holder B; check "B blocked while A holds (mutual exclusion)" 2 $?
L renew   --holder B; check "B cannot renew A's lease" 2 $?
L renew   --holder A; check "A renews its own lease" 0 $?
L release --holder B; check "B cannot release A's lease (atomic CAS)" 2 $?
L release --holder A; check "A releases" 0 $?
L acquire --holder B; check "B acquires after release (clean handoff)" 0 $?
bash "$LEASE" acquire --holder X --redis-url "redis://127.0.0.1:1" --namespace demo >/dev/null 2>&1
check "unreachable redis fails closed" 2 $?
bash "$LEASE" typo --redis-url "$URL" --namespace demo >/dev/null 2>&1
check "unknown action is rejected" 2 $?

echo "=========================================="
printf 'PASS %d  FAIL %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "LEASE SUITE GREEN"
