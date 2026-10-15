#!/bin/bash
# cascade-lease.sh — orchestrator uniqueness backstop for redis-mode Cascade.
#
# One orchestrator per namespace is a DISCIPLINE (see
# references/cascade-coordination.md); this helper mechanizes it with a TTL
# lease key. File-mode and Git-mode setups don't need it. A missing client or
# unreachable configured Redis is a hard failure because starting without the
# required lease would permit multiple orchestrators.
#
# Usage: cascade-lease.sh acquire|renew|release|status --redis-url <url> --namespace <ns> [--holder <id>] [--ttl <seconds>]
set -euo pipefail

ACTION="${1:-status}"; shift || true
REDIS_URL=""; NS="default"; HOLDER="${USER:-agent}-$$"; TTL=900
while [ "$#" -gt 0 ]; do
  case "$1" in
    --redis-url) REDIS_URL="${2:-}"; shift 2 ;;
    --namespace) NS="${2:-default}"; shift 2 ;;
    --holder) HOLDER="${2:-}"; shift 2 ;;
    --ttl) TTL="${2:-900}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ "$ACTION" = "acquire" ] || [ "$ACTION" = "renew" ] || [ "$ACTION" = "release" ] || [ "$ACTION" = "status" ] || {
  echo "FAIL: action must be acquire, renew, release, or status" >&2
  exit 2
}
[ -n "$REDIS_URL" ] || { echo "FAIL: --redis-url required"; exit 1; }
KEY="cascade:${NS}:orchestrator-lease"

py_redis() {
  # Prefer the python environment that has the redis package (cascade's venv
  # ships with it when installed with redis support).
  for PY in "$(command -v python3)" "$(dirname "$(command -v cascade 2>/dev/null || echo /nonexistent)")/python3"; do
    [ -x "$PY" ] || continue
    if "$PY" -c "import redis" 2>/dev/null; then echo "$PY"; return 0; fi
  done
  return 1
}

PY="$(py_redis || true)"
if [ -z "$PY" ]; then
  echo "FAIL: no Python redis client available — refusing to run without an enforced orchestrator lease" >&2
  exit 2
fi

"$PY" - "$ACTION" "$REDIS_URL" "$KEY" "$HOLDER" "$TTL" <<'PYEOF'
import sys
import redis

action, url, key, holder, ttl = sys.argv[1:6]
try:
    r = redis.Redis.from_url(url, socket_timeout=5)
    r.ping()
except (redis.RedisError, ValueError) as exc:
    print(f"FAIL: redis lease backend unavailable ({type(exc).__name__}): {exc}", file=sys.stderr)
    sys.exit(2)

# CAS_DEL / CAS_PEXPIRE act only if THIS holder still owns the key, atomically —
# closing the GET-then-DEL race where the lease could expire and be re-acquired
# by another orchestrator between the two calls.
CAS_DEL = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return -1 end"
CAS_PEXPIRE = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end"

try:
    if action == "acquire":
        if r.set(key, holder, nx=True, ex=int(ttl)):
            print(f"OK: lease acquired by {holder} (ttl {ttl}s)")
        else:
            cur = (r.get(key) or b"?").decode()
            print(f"FAIL: lease held by {cur} — a second orchestrator must not start; use another namespace or wait")
            sys.exit(2)
    elif action == "renew":
        # heartbeat: extend the TTL only while we still hold it, so a long-running
        # orchestrator keeps the lease instead of it lapsing mid-session.
        if r.eval(CAS_PEXPIRE, 1, key, holder, int(ttl) * 1000) == 1:
            print(f"OK: lease renewed by {holder} (ttl {ttl}s)")
        else:
            print(f"FAIL: lease not held by {holder} — re-acquire or stop orchestrating")
            sys.exit(2)
    elif action == "release":
        if r.eval(CAS_DEL, 1, key, holder) == 1:
            print("OK: lease released")
        elif not (r.get(key) or b"").decode():
            print("OK: no lease held")
        else:
            print(f"FAIL: lease held by another orchestrator, not {holder} — refusing to release it")
            sys.exit(2)
    else:
        cur = (r.get(key) or b"").decode()
        t = r.ttl(key)
        print(f"holder={cur or 'none'} ttl={t}")
except redis.RedisError as exc:
    print(f"FAIL: redis lease operation failed ({type(exc).__name__}): {exc}", file=sys.stderr)
    sys.exit(2)
PYEOF
