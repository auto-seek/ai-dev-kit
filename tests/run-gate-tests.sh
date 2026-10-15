#!/usr/bin/env bash
# run-gate-tests.sh — the ai-dev-kit cascade test net.
#
# Exercises scripts/skill-first-gate.sh's cascade coordination branch against
# tests/fake-cascade (a pinned stand-in for the cascade-auto CLI), covering the
# fail-closed matrix, the merge/preflight node-state rules, and — the reason
# this net exists — a REGRESSION test for the `set -e` crash that shipped in
# 0.8.0 (a cascade CLI with no `--version` aborting the whole gate).
#
# Also spot-checks scripts/set-coordination.cjs idempotency.
#
# Run:  npm test   (or: bash tests/run-gate-tests.sh)
# Env:  FAST=1  skip the explicit one-second timeout fail-closed test.
# Perspective: agents and maintainers relying on preflight/merge readiness.
# Invariant: required coordination evidence fails closed without shell crashes.
# Goal: prevent unavailable, stale, or malformed coordination from reporting ready.
# Migration: remains the shipped-artifact contract for the shell gate and wrappers.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="${GATE:-$REPO_ROOT/scripts/skill-first-gate.sh}"   # override to test another gate build
FAKE="$REPO_ROOT/tests/fake-cascade"
SETCOORD="$REPO_ROOT/scripts/set-coordination.cjs"

PASS=0; FAIL=0
CUR=""; CUR_ERRS=""

# --- fake cascade on PATH as `cascade`
FAKEBIN="$(mktemp -d)"
ln -s "$FAKE" "$FAKEBIN/cascade"
PATH_WITH_FAKE="$FAKEBIN:$PATH"
# Removing one Cascade installation can expose another later on the host PATH.
# Keep the gate's real tools available without inheriting any host directories.
PATH_NO_CASCADE="$(mktemp -d)"

cleanup() { rm -rf "$FAKEBIN" "$PATH_NO_CASCADE" "${PROJ:-}" 2>/dev/null || true; }
trap cleanup EXIT
for tool in awk bash cat date dirname env git grep head mkdir mktemp mv node rm tail wc; do
  tool_path="$(type -P "$tool")" || {
    printf 'Missing gate test dependency: %s\n' "$tool" >&2
    exit 1
  }
  ln -s "$tool_path" "$PATH_NO_CASCADE/$tool" || exit 1
done

# ---- harness ---------------------------------------------------------------
start() { CUR="$1"; CUR_ERRS=""; }
_err()  { CUR_ERRS="${CUR_ERRS}\n      - $1"; }
finish() {
  if [ -z "$CUR_ERRS" ]; then PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$CUR"
  else FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s' "$CUR"; printf '%b\n' "$CUR_ERRS"; fi
}
assert_rc()   { [ "$RC" = "$1" ] || _err "expected exit $1, got $RC"; }
assert_rc_in(){ case " $* " in *" $RC "*) : ;; *) _err "expected exit in [$*], got $RC" ;; esac; }
has()         { case "$OUT" in *"$1"*) : ;; *) _err "output missing: '$1'" ;; esac; }
hasnt()       { case "$OUT" in *"$1"*) _err "output should NOT contain: '$1'" ;; *) : ;; esac; }
reached_end() { case "$OUT" in *"skill-first gate passed"*|*"skill-first gate failed"*) : ;; *) _err "gate did not reach its end (crashed mid-run?)" ;; esac; }

# ---- fixtures --------------------------------------------------------------
PROJ=""
new_project() {  # new_project <min_version> [branch]
  rm -rf "${PROJ:-/nonexistent}" 2>/dev/null || true
  PROJ="$(mktemp -d)"
  git -C "$PROJ" init -q -b main
  mkdir -p "$PROJ/.ai-dev-kit/workflow"
  printf '%s\n' '.ai-dev-kit/workflow/' '.ai-dev-kit/cascade/' '.ai-dev-kit/git-cache/' > "$PROJ/.gitignore"
  printf '%s\n' '- [x] Execute the coordination scenario against its declared external CLI fixture.' > "$PROJ/.ai-dev-kit/requirements.md"
  printf '%s\n' '{"schema_version":1,"base_ref":"main","requirements":{"mode":"global","ledger":".ai-dev-kit/requirements.md"},"preflight":{"argv":["node","-e","process.exit(0)"],"timeout_seconds":10}}' > "$PROJ/.ai-dev-kit/gate-contract.json"
  printf '%s\n' '{"schema_version":1,"no_tests_reason":"Coordination-only fixture; executable checks live in the kit gate suite."}' > "$PROJ/.ai-dev-kit/test-scope.json"
  git -C "$PROJ" add .gitignore .ai-dev-kit/test-scope.json .ai-dev-kit/gate-contract.json .ai-dev-kit/requirements.md
  git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit --allow-empty -qm init >/dev/null 2>&1
  [ -n "${2:-}" ] && git -C "$PROJ" checkout -q -b "$2"
  cat > "$PROJ/.ai-dev-kit/profile.yml" <<EOF
coordination:
  engine: cascade
  role: orchestrator
  cascade:
    storage: file
    storage_path: .ai-dev-kit/cascade
    min_version: "${1}"
EOF
}
seed_node() {  # seed_node <id> <state>  (state: READY|ACTIVE|COMPLETED) — real CLI flags
  local st="$PROJ/.ai-dev-kit/cascade"
  "$FAKE" --storage "$st" add-node --id "$1" >/dev/null
  case "$2" in
    ACTIVE)    "$FAKE" --storage "$st" get-task --agent seed --task "$1" >/dev/null ;;
    COMPLETED) local claim token
               claim="$("$FAKE" --storage "$st" get-task --agent seed --task "$1")"
               token="$(printf '%s\n' "$claim" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
               "$FAKE" --storage "$st" finish-task --task "$1" --agent seed --token "$token" --success --summary done >/dev/null ;;
  esac
}
run_gate() {  # run_gate <phase> [PATHOVERRIDE] [EXTRA_ENV...]
  local phase="$1"; local usepath="${2:-$PATH_WITH_FAKE}"
  # `env "${@:3}"`: extra VAR=val come from array expansion, so they are NOT
  # honored as a bare command prefix (the shell would treat them as a command
  # name → exit 127). `env` applies them correctly.
  OUT="$(PATH="$usepath" AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1 env "${@:3}" bash "$GATE" --phase "$phase" --project "$PROJ" 2>&1)"
  RC=$?
}

echo "ai-dev-kit cascade test net"
echo "==========================="

# === THE REGRESSION: a cascade CLI with no --version must fail cleanly, not crash ===
start "regression: unparseable cascade version → explicit gate FAIL (not shell crash)"
new_project ">=0.4"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_VERSION=none
reached_end
[ "$RC" = "1" ] && _err "gate crashed with exit 1 instead of reporting a controlled FAIL"
has "could not be parsed"; assert_rc 2
finish

# === required-path fail-closed matrix ===
start "fail closed: cascade CLI unavailable → gate FAIL"
new_project ">=0.4"
run_gate preflight "$PATH_NO_CASCADE"
has "cascade CLI unavailable"; reached_end; assert_rc 2
finish

start "fail closed: list-nodes failure → gate FAIL"
new_project ">=0.4"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_MODE=fail FAKE_CASCADE_VERSION=0.5
has "coordination storage unreachable"; reached_end; assert_rc 2
finish

start "fail closed: missing success field → gate FAIL"
new_project ">=0.4"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_MODE=nosuccess FAKE_CASCADE_VERSION=0.5
has "invalid JSON contract"; reached_end; assert_rc 2
finish

start "fail closed: malformed JSON → gate FAIL"
new_project ">=0.4"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_MODE=badjson FAKE_CASCADE_VERSION=0.5
has "invalid JSON contract"; reached_end; assert_rc 2
finish

if [ "${FAST:-}" = "1" ]; then
  echo "  (skipping explicit timeout test — FAST=1)"
else
  start "fail closed: list-nodes timeout → gate FAIL"
  new_project ">=0.4"
  run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_MODE=hang FAKE_CASCADE_VERSION=0.5 AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS=1
  has "timed out"; reached_end; assert_rc 2
  finish
fi

# === min_version check ===
start "version: installed below min_version → FAIL"
new_project ">=0.9"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_VERSION=0.4
has "below min_version"; assert_rc 2
finish

start "version: installed satisfies min_version and native ownership floor"
new_project ">=0.7.0"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_VERSION=0.7.0
hasnt "below min_version"; reached_end
finish

# === pinned claim/finish CLI contract ===
start "contract: get-task emits a briefing with a numeric fencing token"
new_project ">=0.4"
st="$PROJ/.ai-dev-kit/cascade"
"$FAKE" --storage "$st" add-node --id contract >/dev/null
OUT="$("$FAKE" --storage "$st" get-task --agent owner --task contract 2>&1)"; RC=$?
TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
has "Task: contract"; has "fencing_token:"
[ -n "$TOKEN" ] || _err "numeric fencing token was not parseable"
assert_rc 0
finish

start "contract: finish-task rejects a missing fencing token"
OUT="$("$FAKE" --storage "$st" finish-task --task contract --agent owner --success 2>&1)"; RC=$?
has "Fencing token is required"; assert_rc 1
finish

start "contract: finish-task rejects a different agent"
OUT="$("$FAKE" --storage "$st" finish-task --task contract --agent intruder --token "$TOKEN" --success 2>&1)"; RC=$?
has "claimed by 'owner'"; assert_rc 1
finish

start "contract: finish-task accepts the claiming agent and token"
OUT="$("$FAKE" --storage "$st" finish-task --task contract --agent owner --token "$TOKEN" --success 2>&1)"; RC=$?
has '"outcome": "COMPLETED"'; assert_rc 0
finish

start "tier routing: pro pull skips max-only work"
new_project ">=0.4"
st="$PROJ/.ai-dev-kit/cascade"
"$FAKE" --storage "$st" add-node --id hard --required-tier max >/dev/null
"$FAKE" --storage "$st" add-node --id easy >/dev/null
OUT="$("$FAKE" --storage "$st" get-task --agent pro-worker --agent-tier pro 2>&1)"; RC=$?
has "Task: easy"; has "agent_tier: pro"; assert_rc 0
finish

start "tier routing: explicit under-tier claim is rejected"
OUT="$("$FAKE" --storage "$st" get-task --agent low-worker --agent-tier pro --task hard 2>&1)"; RC=$?
has "requires tier 'max'"; assert_rc 1
finish

start "tier routing: eligible max agent claims max-only work"
OUT="$("$FAKE" --storage "$st" get-task --agent max-worker --agent-tier max --task hard 2>&1)"; RC=$?
has "Task: hard"; has "required_tier: max"; has "agent_tier: max"; assert_rc 0
finish

# === merge-phase node-state rule ===
start "merge: branch node ACTIVE (not COMPLETED) → FAIL, run finish-task"
new_project ">=0.4" feature/myfeat
seed_node myfeat ACTIVE
run_gate merge
has "not COMPLETED"; has "finish-task"; assert_rc 2
finish

start "merge: branch node COMPLETED → no cascade FAIL"
new_project ">=0.4" feature/myfeat
st="$PROJ/.ai-dev-kit/cascade"
"$FAKE" --storage "$st" add-node --id myfeat >/dev/null
claim="$("$FAKE" --storage "$st" get-task --agent seed --task myfeat)"
token="$(printf '%s\n' "$claim" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
run_gate preflight
assert_rc 0
"$FAKE" --storage "$st" finish-task --task myfeat --agent seed --token "$token" --success --summary "project preflight passed" >/dev/null
run_gate merge
hasnt "not COMPLETED"; reached_end; assert_rc_in 0
finish

start "merge: no node matches branch slug → FAIL"
new_project ">=0.4" feature/orphan
run_gate merge "$PATH_WITH_FAKE" FAKE_CASCADE_VERSION=0.5
has "no cascade node matches"; assert_rc 2
finish

start "preflight: ACTIVE branch node passes"
new_project ">=0.4" feature/myfeat
seed_node myfeat ACTIVE
run_gate preflight
hasnt "not COMPLETED"; reached_end; assert_rc 0
finish

start "preflight: READY node without a fenced owner FAILs"
new_project ">=0.4" feature/unclaimed
seed_node unclaimed READY
run_gate preflight
has "not ACTIVE"; assert_rc 2
finish

start "preflight: codex branch prefix resolves the canonical task slug"
new_project ">=0.7.0" codex/codexfeat
seed_node codexfeat ACTIVE
run_gate preflight
hasnt "no cascade node matches"; assert_rc 0
finish

start "preflight: any single prefix segment resolves the canonical task slug (agent id)"
new_project ">=0.7.0" claude-fable-worker01/agentfeat
seed_node agentfeat ACTIVE
run_gate preflight
hasnt "no cascade node matches"; reached_end; assert_rc 0
finish

start "preflight: a second segment after the task slug fails explicitly"
new_project ">=0.7.0" codex/suffixed/worker-1
seed_node suffixed ACTIVE
run_gate preflight
has "branch 'codex/suffixed/worker-1' must be"; reached_end; assert_rc 2
run_gate merge
has "branch 'codex/suffixed/worker-1' must be"; reached_end; assert_rc 2
finish

start "preflight: COMPLETED node belongs to merge handoff, not active work"
new_project ">=0.4" feature/alreadydone
seed_node alreadydone COMPLETED
run_gate preflight
has "not ACTIVE"; assert_rc 2
finish

start "trunk branch (dev/main) never own-matches a node"
new_project ">=0.4"      # stays on default branch
seed_node dev ACTIVE
run_gate preflight
assert_rc 0
run_gate merge
hasnt "not COMPLETED"; reached_end
finish

# === self-serve write-loop: the documented single-agent command sequence ===
# reserve (add-node) -> claim (get-task) -> finish (finish-task) must drive the
# branch node to COMPLETED so the merge gate passes — with the REAL CLI flags,
# including the claim's per-node fencing token and agent. This proves the write-loop
# in cascade-coordination.md is mechanically valid, not just prose.
start "self-serve loop: add→get→finish drives COMPLETED, merge gate passes"
new_project ">=0.4" feature/selfserve
st="$PROJ/.ai-dev-kit/cascade"
"$FAKE" --storage "$st" add-node --id selfserve >/dev/null
claim="$("$FAKE" --storage "$st" get-task --agent local --task selfserve)"
token="$(printf '%s\n' "$claim" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
run_gate preflight
assert_rc 0
"$FAKE" --storage "$st" finish-task --task selfserve --agent local --token "$token" --success --summary "impl done" --critical '{"git_ref":"abc123"}' >/dev/null
run_gate merge
hasnt "not COMPLETED"; reached_end; assert_rc_in 0
finish

start "self-serve loop: skipping finish-task leaves node ACTIVE, merge gate FAILs"
new_project ">=0.4" feature/unfinished
st="$PROJ/.ai-dev-kit/cascade"
"$FAKE" --storage "$st" add-node --id unfinished >/dev/null
"$FAKE" --storage "$st" get-task --agent local --task unfinished >/dev/null
run_gate merge
has "not COMPLETED"; assert_rc 2
finish

# === set-coordination.cjs idempotency ===
# === secrets overlay (0.8.3) ===
redis_profile() {  # rewrite $PROJ's profile to redis mode with an empty tracked url
  cat > "$PROJ/.ai-dev-kit/profile.yml" <<EOF
coordination:
  engine: cascade
  role: orchestrator
  cascade:
    storage: redis
    redis_url: ""
    namespace: t
    min_version: ">=0.4"
EOF
}
write_overlay() { printf 'coordination:\n  cascade:\n    redis_url: "%s"\n' "$1" > "$2/.ai-dev-kit/profile.local.yml"; }
git_profile() {  # rewrite $PROJ's profile to experimental git mode
  cat > "$PROJ/.ai-dev-kit/profile.yml" <<EOF
coordination:
  engine: cascade
  role: self-serve
  cascade:
    storage: git
    git_remote: origin
    git_cache: .ai-dev-kit/git-cache
    namespace: t
    min_version: ">=0.5"
EOF
}

start "overlay: profile.local.yml redis_url reaches the CLI"
new_project ">=0.4"
redis_profile
write_overlay "redis://overlay:1" "$PROJ"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_EXPECT_REDIS_URL=redis://overlay:1
hasnt "storage unreachable"; reached_end; assert_rc_in 0 2
finish

start "gate redacts Redis credentials from actionable Cascade errors"
new_project ">=0.4"
redis_profile
write_overlay "redis://:SECRET_FOR_TEST@127.0.0.1:6379" "$PROJ"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_EXPECT_REDIS_URL=redis://different:1
hasnt "SECRET_FOR_TEST"; has "redis://<redacted>@127.0.0.1:6379"; assert_rc 2
finish

start "git storage: gate resolves a project remote name and relative cache"
new_project ">=0.5"
git_profile
git -C "$PROJ" remote add origin /tmp/cascade-coordination.git
run_gate preflight "$PATH_WITH_FAKE" \
  FAKE_CASCADE_EXPECT_GIT_REMOTE=/tmp/cascade-coordination.git \
  FAKE_CASCADE_EXPECT_GIT_CACHE="$PROJ/.ai-dev-kit/git-cache"
hasnt "storage unreachable"; reached_end; assert_rc_in 0 2
finish

start "git storage: missing remote fails closed before invoking Cascade"
new_project ">=0.6"
git_profile
sed -i.bak 's/git_remote: origin/git_remote: ""/' "$PROJ/.ai-dev-kit/profile.yml" && rm -f "$PROJ/.ai-dev-kit/profile.yml.bak"
run_gate preflight "$PATH_WITH_FAKE"
has "git_remote is required"; assert_rc 2
finish

start "version: missing min_version fails closed"
new_project ">=0.6"
sed -i.bak '/min_version:/d' "$PROJ/.ai-dev-kit/profile.yml" && rm -f "$PROJ/.ai-dev-kit/profile.yml.bak"
run_gate preflight "$PATH_WITH_FAKE"
has "min_version is required"; assert_rc 2
finish

start "overlay: absent overlay + empty tracked url fails closed"
new_project ">=0.4"
redis_profile
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_EXPECT_REDIS_URL=redis://overlay:1 FAKE_CASCADE_VERSION=0.5
has "redis_url is required"; reached_end; assert_rc 2
finish

start "overlay: AI_DEV_KIT_CASCADE_REDIS_URL beats profile.local.yml"
new_project ">=0.4"
redis_profile
write_overlay "redis://overlay:1" "$PROJ"
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_EXPECT_REDIS_URL=redis://env:2 AI_DEV_KIT_CASCADE_REDIS_URL=redis://env:2
hasnt "storage unreachable"; reached_end; assert_rc_in 0 2
finish

start "overlay: linked worktree (tracked .ai-dev-kit) climbs to the main worktree's overlay"
new_project ">=0.4"
redis_profile
git -C "$PROJ" add .ai-dev-kit/profile.yml >/dev/null 2>&1
git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit -qm profile >/dev/null 2>&1
write_overlay "redis://overlay:1" "$PROJ"
WT="$PROJ-wt"
git -C "$PROJ" worktree add -q "$WT" -b feature/wtbranch >/dev/null 2>&1
OUT="$(PATH="$PATH_WITH_FAKE" AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1 env FAKE_CASCADE_EXPECT_REDIS_URL=redis://overlay:1 bash "$GATE" --phase preflight --project "$WT" 2>&1)"
RC=$?
hasnt "storage unreachable"; reached_end; assert_rc_in 0 2
git -C "$PROJ" worktree remove --force "$WT" >/dev/null 2>&1
finish

# THE 0.8.3 REGRESSION: the shipped tracked baseline says `storage: file`, so a
# redis_url-only overlay was dead config — the gate picked the file backend
# before ever reading the URL and silently checked an empty local store. The
# overlay written by set-coordination --local must flip storage to redis.
start "overlay: tracked file-mode baseline + --local overlay reaches redis (0.8.3 regression)"
new_project ">=0.4" feature/selfserve
node "$SETCOORD" --profile "$PROJ/.ai-dev-kit/profile.local.yml" --local --redis-url "redis://overlay:1" --namespace t >/dev/null 2>&1
run_gate preflight "$PATH_WITH_FAKE" FAKE_CASCADE_EXPECT_REDIS_URL=redis://overlay:1
hasnt "storage unreachable"; hasnt "wrong redis url"; reached_end; assert_rc_in 0 2
finish

start "merge FAIL message includes the targeted claim sequence"
new_project ">=0.4" feature/myfeat
seed_node myfeat ACTIVE
run_gate merge
has "get-task --agent"; has "--task 'myfeat'"; assert_rc 2
finish

# === native reservations: canonical IDs and engine-owned reserved_for ===
LANE="$REPO_ROOT/scripts/cascade-lane.cjs"
run_lane() {  # run_lane <agent> <args...>
  local agent="$1"; shift
  OUT="$(PATH="$PATH_WITH_FAKE" node "$LANE" --profile "$PROJ/.ai-dev-kit/profile.yml" --agent "$agent" "$@" 2>&1)"
  RC=$?
}

start "git storage: lane resolves the same remote and cache contract"
new_project ">=0.5"
git_profile
git -C "$PROJ" remote add origin /tmp/cascade-lane.git
OUT="$(PATH="$PATH_WITH_FAKE" \
  FAKE_CASCADE_EXPECT_GIT_REMOTE=/tmp/cascade-lane.git \
  FAKE_CASCADE_EXPECT_GIT_CACHE="$PROJ/.ai-dev-kit/git-cache" \
  node "$LANE" --profile "$PROJ/.ai-dev-kit/profile.yml" --agent git-agent add --slug git-lane 2>&1)"
RC=$?
has '"node_id": "git-lane"'; assert_rc 0
finish

start "lane: add reserves canonical slug for an agent, visible in list-nodes"
new_project ">=0.4"
run_lane alice add --slug lanework
has '"node_id": "lanework"'; assert_rc 0
OUT="$("$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" list-nodes)"; RC=$?
has '"id": "lanework"'; has '"reserved_for": "alice"'
finish

start "lane: add refuses a slug already reserved by another agent"
run_lane bob add --slug lanework
has "already exists"; has "lanework"; assert_rc 1
finish

start "lane: add refuses a slug that collides with a shared (unreserved) node"
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id shared >/dev/null
run_lane alice add --slug shared
has "already exists"; assert_rc 1
finish

start "lane: owner's targeted claim lands on the lane node"
run_lane alice --role self-serve claim --slug lanework
has "Task: lanework"; has "fencing_token:"; assert_rc 0
LANE_TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
[ -n "$LANE_TOKEN" ] || _err "no parseable fencing token from lane claim"
finish

start "lane: another agent's claim of a reserved slug is refused"
run_lane bob --role self-serve claim --slug lanework
has "reserved by 'alice'"; assert_rc 1
finish

start "lane+tier: required tier is persisted and under-tier owner is refused"
new_project ">=0.5"
run_lane alice add --slug hardlane --required-tier max
OUT="$("$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" list-nodes)"; RC=$?
has '"required_tier": "max"'; assert_rc 0
run_lane alice --role self-serve claim --slug hardlane --agent-tier pro
has "requires tier 'max'"; assert_rc 1
run_lane alice --role self-serve claim --slug hardlane --agent-tier max
has "Task: hardlane"; has "agent_tier: max"; assert_rc 0
finish

start "lane+tier: worker pool skips harder shared work and claims eligible work"
new_project ">=0.5"
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id hard --required-tier max >/dev/null
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id medium --required-tier pro >/dev/null
run_lane carol --role worker claim --agent-tier pro
has "Task: medium"; has "agent_tier: pro"; assert_rc 0
finish

start "lane: worker pool claim skips lane-reserved nodes"
new_project ">=0.4"
run_lane alice add --slug lanework >/dev/null 2>&1   # READY lane node, listed first
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id pooltask >/dev/null
run_lane carol --role worker claim
has "Task: pooltask"; assert_rc 0
finish

start "lane: worker pool claim with only lane nodes READY refuses instead of stealing"
new_project ">=0.4"
run_lane alice add --slug onlylane >/dev/null 2>&1
run_lane carol --role worker claim
hasnt "Task: onlylane"; assert_rc 1
finish

start "lane: finish completes the owner's lane node"
new_project ">=0.4"
run_lane alice add --slug done-slug >/dev/null 2>&1
run_lane alice --role self-serve claim --slug done-slug
tok="$(printf '%s\n' "$OUT" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
run_lane alice finish --slug done-slug --token "$tok" --summary "evidence"
has '"outcome": "COMPLETED"'; assert_rc 0
finish

start "gate merge: COMPLETED lane node satisfies the branch slug"
new_project ">=0.4" feature/lanefeat
run_lane owner add --slug lanefeat >/dev/null 2>&1
run_lane owner --role self-serve claim --slug lanefeat
tok="$(printf '%s\n' "$OUT" | sed -n 's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
run_gate preflight
assert_rc 0
run_lane owner finish --slug lanefeat --token "$tok" --summary "done" >/dev/null 2>&1
run_gate merge
hasnt "not COMPLETED"; hasnt "no cascade node matches"; reached_end; assert_rc_in 0
finish

start "gate merge: ACTIVE lane node FAILs with the full lane id in the hint"
new_project ">=0.4" feature/lanefeat
run_lane owner add --slug lanefeat >/dev/null 2>&1
run_lane owner --role self-serve claim --slug lanefeat >/dev/null 2>&1
run_gate merge
has "not COMPLETED"; has "lanefeat"; assert_rc 2
finish

start "gate merge: legacy lane encoding requires explicit migration"
new_project ">=0.4" feature/dualfeat
seed_node dualfeat COMPLETED
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id dualfeat@stray >/dev/null
run_gate merge
has "legacy @lane nodes require explicit migration"; reached_end; assert_rc 2
finish

start "gate merge: non-matching lane prefix fails closed"
new_project ">=0.4" feature/lane
"$FAKE" --storage "$PROJ/.ai-dev-kit/cascade" add-node --id lane-extra@x >/dev/null
run_gate merge "$PATH_WITH_FAKE" FAKE_CASCADE_VERSION=0.5
has "legacy @lane nodes require explicit migration"; assert_rc 2
finish

# === subtraction fallback: fork point behind the trunk tip (0.8.x bug) ===
# Old logic required the candidate ref to be an ANCESTOR of HEAD, so a branch
# forked behind the dev tip fell through to an ancient main and counted
# hundreds of trunk commits as this branch's debt. The fix uses the merge-base
# (fork point) directly.
start "subtraction: fork point behind dev tip counts branch commits only"
new_project ">=0.4"
git -C "$PROJ" checkout -q -b dev
for i in $(seq 1 20); do git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit --allow-empty -qm "dev $i"; done
git -C "$PROJ" checkout -q -b feature/forked "HEAD~8"
git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit --allow-empty -qm "feature work"
node - "$PROJ/.ai-dev-kit/gate-contract.json" <<'NODE'
const fs=require('node:fs');const file=process.argv[2];const contract=JSON.parse(fs.readFileSync(file,'utf8'));contract.base_ref='dev';fs.writeFileSync(file,JSON.stringify(contract)+'\n');
NODE
seed_node forked ACTIVE
OUT="$(PATH="$PATH_WITH_FAKE" bash "$GATE" --phase preflight --project "$PROJ" 2>&1)"; RC=$?
hasnt "subtraction overdue"; reached_end; assert_rc_in 0
finish

start "subtraction: real branch debt past the threshold still FAILs"
new_project ">=0.4"
git -C "$PROJ" checkout -q -b dev
git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit --allow-empty -qm base
git -C "$PROJ" checkout -q -b feature/heavy
for i in $(seq 1 12); do git -C "$PROJ" -c user.email=t@t.dev -c user.name=t commit --allow-empty -qm "w $i"; done
OUT="$(PATH="$PATH_WITH_FAKE" bash "$GATE" --phase preflight --project "$PROJ" 2>&1)"; RC=$?
has "subtraction overdue"; assert_rc 2
finish

start "set-coordination: --local writes a machine-local overlay (storage: redis), idempotent"
SCP="$(mktemp -d)"
node "$SETCOORD" --profile "$SCP/profile.local.yml" --local --redis-url "redis://x:1" >/dev/null 2>&1
node "$SETCOORD" --profile "$SCP/profile.local.yml" --local --redis-url "redis://x:1" >/dev/null 2>&1
OUT="$(cat "$SCP/profile.local.yml")"; RC=0
has 'redis_url: "redis://x:1"'; has "storage: redis"; hasnt "engine:"
# without an explicit --namespace the overlay must NOT shadow the tracked one
hasnt "namespace:"
n="$(grep -c 'redis_url' "$SCP/profile.local.yml")"
[ "$n" = "1" ] || _err "expected 1 redis_url line after 2 runs, got $n"
rm -rf "$SCP"
finish

start "set-coordination: --local --namespace lands in the overlay"
SCP="$(mktemp -d)"
node "$SETCOORD" --profile "$SCP/profile.local.yml" --local --redis-url "redis://x:1" --namespace myns >/dev/null 2>&1
OUT="$(cat "$SCP/profile.local.yml")"; RC=0
has "namespace: myns"; has "storage: redis"
rm -rf "$SCP"
finish

start "set-coordination: fresh default is self-serve with Cascade >=0.8.0"
SCP="$(mktemp)"
node "$SETCOORD" --profile "$SCP" --engine cascade >/dev/null 2>&1; RC=$?
OUT="$(cat "$SCP")"; assert_rc 0
has "role: self-serve"
has 'min_version: ">=0.8.0"'
rm -f "$SCP"
finish

start "set-coordination: explicit older min-version is preserved"
SCP="$(mktemp)"
node "$SETCOORD" --profile "$SCP" --engine cascade --min-version '>=0.7.0' >/dev/null 2>&1; RC=$?
OUT="$(cat "$SCP")"; assert_rc 0
has 'min_version: ">=0.7.0"'; hasnt 'min_version: ">=0.8.0"'
rm -f "$SCP"
finish

start "bootstrap: fresh project gets Cascade >=0.8.0 without explicit coordination"
SCP="$(mktemp -d)"
OUT="$(bash "$REPO_ROOT/bootstrap/init-skill.sh" "$SCP" --harness none 2>&1)"; RC=$?
assert_rc 0
OUT="$(cat "$SCP/.ai-dev-kit/profile.yml")"
has 'engine: cascade'; has 'role: self-serve'; has 'storage: file'
has 'min_version: ">=0.8.0"'
n="$(grep -c 'min_version:' "$SCP/.ai-dev-kit/profile.yml")"
[ "$n" = "1" ] || _err "expected one fresh version requirement, got $n"
rm -rf "$SCP"
finish

start "bootstrap: default and same-engine reinstall preserve the entire old profile"
SCP="$(mktemp -d)"
mkdir -p "$SCP/.ai-dev-kit"
printf '# operator-owned formatting\ncommands:\n  test: "custom test"\n' > "$SCP/.ai-dev-kit/profile.yml"
node "$SETCOORD" --profile "$SCP/.ai-dev-kit/profile.yml" --engine cascade \
  --storage git --git-remote ssh://example.invalid/team.git --namespace old-team \
  --role worker --min-version '>=0.7.0' >/dev/null 2>&1; RC=$?
assert_rc 0
OUT="$(cat "$SCP/.ai-dev-kit/profile.yml")"; has 'min_version: ">=0.7.0"'
cp "$SCP/.ai-dev-kit/profile.yml" "$SCP/expected-profile.yml"
for mode in default same-engine; do
  if [ "$mode" = default ]; then
    OUT="$(bash "$REPO_ROOT/bootstrap/init-skill.sh" "$SCP" --harness none 2>&1)"; RC=$?
  else
    OUT="$(bash "$REPO_ROOT/bootstrap/init-skill.sh" "$SCP" --harness none --coordination cascade 2>&1)"; RC=$?
  fi
  assert_rc 0
  cmp -s "$SCP/expected-profile.yml" "$SCP/.ai-dev-kit/profile.yml" || _err "$mode reinstall changed the old profile"
done
rm -rf "$SCP"
finish

start "bootstrap: workflow state is gitignored once and tracked files stay tracked"
SCP="$(mktemp -d)"
git -C "$SCP" init -q
mkdir -p "$SCP/.ai-dev-kit/workflow"
printf '# demo\n.ai-dev-kit/graph/\n' > "$SCP/.gitignore"
printf 'tracked before bootstrap\n' > "$SCP/.ai-dev-kit/workflow/LEDGER.md"
git -C "$SCP" add .gitignore .ai-dev-kit/workflow/LEDGER.md
for run in 1 2; do
  OUT="$(bash "$REPO_ROOT/bootstrap/init-skill.sh" "$SCP" --harness none 2>&1)"; RC=$?
  assert_rc 0
  has "already tracked; .gitignore does not untrack them"
done
n="$(grep -cx '\.ai-dev-kit/workflow/' "$SCP/.gitignore")"
[ "$n" = "1" ] || _err "expected one .ai-dev-kit/workflow/ entry, got $n"
n="$(grep -cx '\.ai-dev-kit/graph/' "$SCP/.gitignore")"
[ "$n" = "1" ] || _err "expected one .ai-dev-kit/graph/ entry, got $n"
git -C "$SCP" ls-files --error-unmatch .ai-dev-kit/workflow/LEDGER.md >/dev/null 2>&1 || _err "bootstrap untracked an existing workflow file"
git -C "$SCP" check-ignore -q .ai-dev-kit/workflow/findings.jsonl || _err "new workflow state is not ignored"
FRESH="$(mktemp -d)"
OUT="$(bash "$REPO_ROOT/bootstrap/init-skill.sh" "$FRESH" --harness none 2>&1)"; RC=$?
assert_rc 0; hasnt "already tracked"
grep -qx '\.ai-dev-kit/workflow/' "$FRESH/.gitignore" || _err "fresh bootstrap did not ignore workflow state"
[ -f "$FRESH/.ai-dev-kit/workflow/test-review-template.md" ] || _err "fresh bootstrap did not install the test-review template"
[ ! -e "$FRESH/.ai-dev-kit/workflow/test-review.md" ] || _err "fresh bootstrap created the shared legacy test-review.md narrative"
rm -rf "$SCP" "$FRESH"
finish

start "set-coordination: git mode writes remote and optional cache"
SCP="$(mktemp)"
node "$SETCOORD" --profile "$SCP" --storage git \
  --git-remote origin --git-cache .ai-dev-kit/git-cache --namespace shared >/dev/null 2>&1
OUT="$(cat "$SCP")"; RC=0
has "storage: git"; has 'git_remote: "origin"'; has 'git_cache: ".ai-dev-kit/git-cache"'; has "namespace: shared"
rm -f "$SCP"
finish

start "set-coordination: unknown storage is rejected"
SCP="$(mktemp)"
OUT="$(node "$SETCOORD" --profile "$SCP" --storage sqlite 2>&1)"; RC=$?
has "--storage must be one of"; assert_rc 1
rm -f "$SCP"
finish

start "set-coordination: unknown role is rejected"
SCP="$(mktemp)"
OUT="$(node "$SETCOORD" --profile "$SCP" --engine cascade --role manager 2>&1)"; RC=$?
has "--role must be one of"; assert_rc 1
rm -f "$SCP"
finish

start "set-coordination: bare heading is idempotent (2 runs → 1 block)"
SCP="$(mktemp)"; printf 'name: demo\nother: keep\n' > "$SCP"
node "$SETCOORD" --profile "$SCP" --engine cascade >/dev/null 2>&1
node "$SETCOORD" --profile "$SCP" --engine cascade >/dev/null 2>&1
n="$(grep -c '^coordination:' "$SCP")"
[ "$n" = "1" ] || _err "expected 1 coordination block, got $n"
rm -f "$SCP"
finish

start "set-coordination: inline-comment heading does not duplicate"
SCP="$(mktemp)"; printf 'name: demo\ncoordination:  # note\n  engine: ledger\nother: keep\n' > "$SCP"
node "$SETCOORD" --profile "$SCP" --engine cascade >/dev/null 2>&1
n="$(grep -c '^coordination:' "$SCP")"
[ "$n" = "1" ] || _err "expected 1 coordination block, got $n"
rm -f "$SCP"
finish

start "inline-comment coordination heading is readable by lane and gate"
new_project ">=0.5"
sed -i.bak 's/^coordination:$/coordination:  # shared config/' "$PROJ/.ai-dev-kit/profile.yml"
rm -f "$PROJ/.ai-dev-kit/profile.yml.bak"
run_lane alice add --slug inline-heading
has '"node_id": "inline-heading"'; assert_rc 0
OUT="$(PATH="$PATH_WITH_FAKE" bash "$GATE" --phase preflight --project "$PROJ" 2>&1)"; RC=$?
hasnt "coordination engine 'ledger'"; reached_end; assert_rc_in 0
finish

# === implementation-discipline distribution contract =======================
# Perspective: an agent consuming either the source skill or a generated slash
# command must receive the same non-negotiable engineering rules.
# Invariant: installed skills retain the full canonical reference and each
# implementation/readiness entrypoint tells its reader to load it.
# Goal: catch policy lost during installation or missing from a harness entrypoint.
# These checks prove distribution, not whether an agent writes good comments.
# Migration: move to a general package-contract suite if this test net is split
# by concern; until then it runs in the existing shipped-artifact test runner.
start "workflow discipline: real installs retain the policy for each harness"
for harness in codex claude generic; do
  new_project ">=0.7.0"
  OUT="$(bash "$REPO_ROOT/bootstrap/install-skill.sh" --target project --project "$PROJ" --harness "$harness" --force 2>&1)"; RC=$?
  assert_rc 0
  installed="$PROJ/.ai-dev-kit/skills/ai-dev-kit"
  for rel in SKILL.md references/implementation-discipline.md references/quick-checklist.md references/review-agents.md references/agent-prompts.md references/test-review.md; do
    cmp -s "$REPO_ROOT/skills/ai-dev-kit/$rel" "$installed/$rel" || _err "$harness: installed $rel differs or is missing"
  done
  case "$harness" in
    generic) commands="$PROJ/.ai-dev-kit/commands" ;;
    *) commands="$PROJ/.$harness/commands" ;;
  esac
  for workflow in loop preflight merge-guardian; do
    rel="ai-dev-kit-$workflow/SKILL.md"
    cmp -s "$REPO_ROOT/skills/$rel" "$PROJ/.ai-dev-kit/skills/$rel" || _err "$harness: installed $rel differs or is missing"
    grep -q 'implementation-discipline.md' "$commands/ai-dev-kit-$workflow.md" || _err "$harness: installed $workflow command does not load the policy"
  done
done
finish

start "workflow discipline: implementation entrypoints load the canonical reference"
for rel in \
  skills/ai-dev-kit/SKILL.md \
  skills/ai-dev-kit/references/quick-checklist.md \
  skills/ai-dev-kit-loop/SKILL.md \
  skills/ai-dev-kit-preflight/SKILL.md \
  skills/ai-dev-kit-merge-guardian/SKILL.md \
  templates/slash-commands/ai-dev-kit/ai-dev-kit-loop.md \
  templates/slash-commands/ai-dev-kit/ai-dev-kit-preflight.md \
  templates/slash-commands/ai-dev-kit/ai-dev-kit-merge-guardian.md
do
  grep -q "implementation-discipline.md" "$REPO_ROOT/$rel" || _err "$rel does not load implementation-discipline.md"
done
finish

start "workflow discipline: merge review blocks concrete violations"
OUT="$(cat "$REPO_ROOT/skills/ai-dev-kit-merge-guardian/SKILL.md" "$REPO_ROOT/templates/slash-commands/ai-dev-kit/ai-dev-kit-merge-guardian.md")"; RC=0
has "transitional implementation"
has "fallback degradation"
has "obsolete compatibility"
has "duplicated mature capability"
has "speculative abstraction"
has "heavy defensive machinery"
finish

# ---- summary ---------------------------------------------------------------
echo "==========================="
printf 'PASS %d  FAIL %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "SUITE FAILED"; exit 1; }
echo "SUITE GREEN"
