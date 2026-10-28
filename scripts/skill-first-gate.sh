#!/bin/bash
# skill-first-gate.sh — light gate for ai-dev-kit v2 skill-first projects.

set -euo pipefail

PROJECT_PATH="."
PHASE="stop"
SUBTRACTION_THRESHOLD=""
BLOCKED_EXIT_FLAG=""
BLOCKED_EXIT_SET=false
STATUS_ALL=false
STATUS_JSON=false

usage() {
  cat <<'EOF'
Usage: bash scripts/skill-first-gate.sh [--phase stop|preflight|merge|integrate|status] [--project <path>] [--subtraction-threshold <n>] [--blocked-exit-code <n>] [--all] [--json]

Stop phase blocks only explicit blocking findings.
Preflight/merge require a tracked .ai-dev-kit/gate-contract.json with explicit requirements and project verification argv, reviewed tests, valid coordination, and subtraction evidence. Merge requires a content-bound preflight receipt after the final commit.

With receipt_binding: merge-base in the contract, branch receipts ignore target movement; the integrate phase (one serial integrator, exclusive lock) merges the branch onto the current target in a temporary worktree, runs the project command there and writes an integrate receipt, which merge then also requires for the current target commit and HEAD, recomputing the merged tree with git merge-tree --write-tree (git >= 2.38). The temporary worktree holds only committed files: no ignored venvs, node_modules, .env or uninitialised submodules.

A project command exiting with one of preflight.blocked_exit_codes reports BLOCKED (retryable) and writes no receipt. BLOCKED exits 2 by default, like FAIL, so hooks stay blocking; --blocked-exit-code <n> > AI_DEV_KIT_BLOCKED_EXIT selects another exit code (1-255; read only by preflight and integrate) for loop runners. Before the project command runs, an environment check (node on PATH, at least AI_DEV_KIT_MIN_FREE_MB, default 1024, free on the shared state volume) also reports BLOCKED.

Status phase is read-only: it reports receipt freshness and the differing snapshot keys, merge readiness, subtraction debt, test review and the environment check for the current branch (--all: every local branch with a receipt; --json: machine-readable). It never writes and exits 0 unless the gate itself crashes.

Subtraction threshold resolves as: --subtraction-threshold <n> > AI_DEV_KIT_SUBTRACTION_THRESHOLD > subtraction.every_commits in .ai-dev-kit/profile.yml > default 10. Disable with threshold 0, AI_DEV_KIT_DISABLE_SUBTRACTION_GATE=1, or subtraction.gate_enabled: false in the profile.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --phase)
      PHASE="${2:-stop}"
      shift 2
      ;;
    --project)
      PROJECT_PATH="${2:-.}"
      shift 2
      ;;
    --subtraction-threshold)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--subtraction-threshold requires a nonnegative integer" >&2
        exit 2
      fi
      SUBTRACTION_THRESHOLD="${2:-}"
      shift 2
      ;;
    --blocked-exit-code)
      if [ "$#" -lt 2 ]; then
        echo "--blocked-exit-code requires an exit code from 1 to 255" >&2
        exit 2
      fi
      BLOCKED_EXIT_FLAG="$2"
      BLOCKED_EXIT_SET=true
      shift 2
      ;;
    --all)
      STATUS_ALL=true
      shift
      ;;
    --json)
      STATUS_JSON=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      PROJECT_PATH="$1"
      shift
      ;;
  esac
done

case "$PHASE" in
  stop|preflight|merge|integrate|status) ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    usage >&2
    exit 1
    ;;
esac

# Only preflight and integrate can report BLOCKED. Other phases ignore the
# option and AI_DEV_KIT_BLOCKED_EXIT, so a loop runner's value can never break
# stop or merge. 0 is rejected: BLOCKED must never look like a pass.
BLOCKED_EXIT_CODE=2
case "$PHASE" in
  preflight|integrate)
    if [ "$BLOCKED_EXIT_SET" = true ]; then
      requested_blocked_exit="$BLOCKED_EXIT_FLAG"
    else
      requested_blocked_exit="${AI_DEV_KIT_BLOCKED_EXIT:-}"
    fi
    if [ "$BLOCKED_EXIT_SET" = true ] || [ -n "$requested_blocked_exit" ]; then
      if ! [[ "$requested_blocked_exit" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$requested_blocked_exit" -gt 255 ]; then
        echo "--blocked-exit-code / AI_DEV_KIT_BLOCKED_EXIT must be an integer exit code from 1 to 255" >&2
        exit 2
      fi
      BLOCKED_EXIT_CODE="$requested_blocked_exit"
    fi
    ;;
esac
# integrate runs immediately before merge in a merge queue, so coordination,
# ledger and test-review checks apply their merge-time rules to it.
RULE_PHASE="$PHASE"
[ "$PHASE" != "integrate" ] || RULE_PHASE="merge"

PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"

# Environment self-check (part 1): every phase below needs node. A missing
# runtime is retryable infrastructure trouble, so preflight reports BLOCKED and
# status reports it without failing; the other phases keep their existing error.
if ! command -v node >/dev/null 2>&1; then
  case "$PHASE" in
    status)
      echo "environment: BLOCKED — node is not on PATH; receipts cannot be inspected"
      exit 0
      ;;
    preflight|integrate)
      echo "BLOCKED (retryable): environment check failed: node is not on PATH"
      echo "AI Dev Kit skill-first gate BLOCKED (retryable): node is not on PATH"
      exit "$BLOCKED_EXIT_CODE"
      ;;
  esac
fi

# Linked git worktrees don't carry the (gitignored) .ai-dev-kit directory.
# Resolve workflow state from the MAIN worktree so gate runs inside a
# feature worktree see the same profile/receipts/logs as the main repo.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIDK_ROOT="$(node "$SCRIPT_DIR/project-state.cjs" "$PROJECT_PATH")" || {
  echo "FAIL: cannot resolve shared project state" >&2
  exit 2
}

if [ "$PHASE" = "status" ]; then
  # Read-only report: no findings gate, no receipt revocation, no gate-log
  # entry. Exit 0 unless the helper itself crashes.
  [ "$STATUS_JSON" = true ] || echo "AI Dev Kit skill-first gate: phase=status project=$PROJECT_PATH"
  STATUS_ARGS=(status --project "$PROJECT_PATH")
  [ "$STATUS_ALL" = false ] || STATUS_ARGS+=(--all)
  [ "$STATUS_JSON" = false ] || STATUS_ARGS+=(--json)
  [ -z "$SUBTRACTION_THRESHOLD" ] || STATUS_ARGS+=(--subtraction-threshold "$SUBTRACTION_THRESHOLD")
  exec node "$SCRIPT_DIR/project-gate-evidence.cjs" "${STATUS_ARGS[@]}"
fi
FINDINGS_FILE="$AIDK_ROOT/.ai-dev-kit/workflow/findings.jsonl"
LEDGER_FILE="$AIDK_ROOT/.ai-dev-kit/workflow/LEDGER.md"
FEATURE_LEDGER="$PROJECT_PATH/docs/development/feature-ledger.md"
FALLBACK_FEATURE_LEDGER="$AIDK_ROOT/.ai-dev-kit/workflow/feature-ledger.md"
SUBTRACTION_LOG="$AIDK_ROOT/.ai-dev-kit/workflow/subtraction-log.md"
PROFILE_FILE="$AIDK_ROOT/.ai-dev-kit/profile.yml"
# One main-checkout profile, overlay, store and evidence directory serve all
# linked worktrees, including those that materialize a tracked .ai-dev-kit.
PROFILE_LOCAL_FILE="$AIDK_ROOT/.ai-dev-kit/profile.local.yml"

FAILED=false
WARNED=false
BLOCKED=false
BLOCKED_REASON=""
ACTIVE_PID=""
COMMAND_TMP=""
RESULT_OUT=""
RESULT_ERR=""
RESULT_RC=0

cleanup_command_output() {
  if [ -n "$COMMAND_TMP" ]; then
    rm -rf -- "$COMMAND_TMP"
    COMMAND_TMP=""
  fi
}

cancel_gate() {
  local signal="$1" code="$2"
  trap '' INT TERM
  if [ -n "$ACTIVE_PID" ]; then
    kill -s "$signal" "$ACTIVE_PID" 2>/dev/null || true
    # The Node supervisor owns the detached command group. Wait for its
    # TERM/grace/KILL cleanup rather than abandoning it with the shell.
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
  cleanup_command_output
  echo "AI Dev Kit skill-first gate cancelled by SIG$signal." >&2
  exit "$code"
}

trap 'cancel_gate INT 130' INT
trap 'cancel_gate TERM 143' TERM
trap cleanup_command_output EXIT

run_supervised() {
  RESULT_OUT=""; RESULT_ERR=""; RESULT_RC=0
  if ! COMMAND_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ai-dev-kit-gate.XXXXXXXX")"; then
    RESULT_RC=1
    RESULT_ERR="cannot create private supervisor output directory"
    return 0
  fi
  # This runs in the gate shell, not a command-substitution subshell, so an
  # interrupted wait can promptly forward the signal to the actual supervisor.
  "$@" >"$COMMAND_TMP/stdout" 2>"$COMMAND_TMP/stderr" &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then RESULT_RC=0; else RESULT_RC=$?; fi
  ACTIVE_PID=""
  if ! RESULT_OUT="$(cat "$COMMAND_TMP/stdout")"; then
    RESULT_RC=1
    RESULT_ERR="cannot read supervisor stdout"
  elif ! RESULT_ERR="$(cat "$COMMAND_TMP/stderr")"; then
    RESULT_RC=1
    RESULT_ERR="cannot read supervisor stderr"
  fi
  cleanup_command_output
}

echo "AI Dev Kit skill-first gate: phase=$PHASE project=$PROJECT_PATH"

emit_fail() {
  FAILED=true
  echo "FAIL: $1"
}

emit_warn() {
  WARNED=true
  echo "WARN: $1"
}

# BLOCKED is retryable: a busy exclusive resource or an unusable environment,
# not a verdict on the change. It never writes a receipt; FAIL takes precedence.
emit_blocked() {
  BLOCKED=true
  BLOCKED_REASON="$1"
  echo "BLOCKED (retryable): $1"
}

has_blocking_findings() {
  [ -f "$FINDINGS_FILE" ] || return 1
  grep -E '"severity"[[:space:]]*:[[:space:]]*"(critical|high)"' "$FINDINGS_FILE" \
    | grep -E '"status"[[:space:]]*:[[:space:]]*"(open|blocked)"' >/dev/null 2>&1
}

show_blocking_findings() {
  grep -E '"severity"[[:space:]]*:[[:space:]]*"(critical|high)"' "$FINDINGS_FILE" \
    | grep -E '"status"[[:space:]]*:[[:space:]]*"(open|blocked)"' \
    | head -20 || true
}

if has_blocking_findings; then
  emit_fail "open critical/high findings in .ai-dev-kit/workflow/findings.jsonl"
  show_blocking_findings
fi

check_unfinished_ledger() {
  local file="$1"
  [ -f "$file" ] || return 0
  if grep -nE '^[[:space:]]*- \[ \]' "$file" >/dev/null 2>&1; then
    if [ "$PHASE" = "stop" ]; then
      emit_warn "unfinished requirements in ${file#$PROJECT_PATH/}"
    else
      emit_fail "unfinished requirements in ${file#$PROJECT_PATH/}"
      grep -nE '^[[:space:]]*- \[ \]' "$file" | head -20 || true
    fi
  fi
}

check_feature_ledger_status() {
  # Branch-scoped semantics (v0.6.0): in multi-worker repos the ledger
  # legitimately holds other owners' reserved/active entries at all times.
  # Failing merge/preflight on ANY non-ready entry makes the gate
  # permanently red, which trains people to ignore it (alarm fatigue).
  # So: hard-check only the reservation that belongs to the current
  # branch; other owners' non-ready entries are WARNs. When no entry
  # matches the current branch, fall back to the legacy strict behavior
  # (safe for single-worker repos and detached/trunk runs).
  local file="$1"
  [ -f "$file" ] || return 0
  local branch=""
  branch="$(git -C "$PROJECT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

  # No node: degrade to the legacy pure-grep strict check instead of dying —
  # python-only environments keep a working (if coarser) gate.
  if ! command -v node >/dev/null 2>&1; then
    if grep -nE '^[[:space:]]*-[[:space:]]*Status:[[:space:]]*(reserved|active|blocked)' "$file" >/dev/null 2>&1; then
      if [ "$PHASE" = "stop" ]; then
        emit_warn "feature ledger has non-ready entries in ${file#$PROJECT_PATH/} (node unavailable — branch-scoped check skipped)"
      else
        emit_fail "feature ledger has entries not ready for merge in ${file#$PROJECT_PATH/} (node unavailable — branch-scoped check skipped)"
      fi
    fi
    return 0
  fi

  local verdict
  verdict="$(node - "$file" "$branch" "$RULE_PHASE" <<'NODE'
const fs = require("node:fs");
const [file, branch, phase] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\r?\n/);
const entries = [];
let current = null;
for (const line of lines) {
  const heading = line.match(/^##\s+(.+?)\s*$/);
  if (heading) {
    current = { slug: heading[1].trim(), status: "", branch: "" };
    entries.push(current);
    continue;
  }
  if (!current) continue;
  const status = line.match(/^\s*-\s*Status:\s*(\S+)/);
  if (status) current.status = status[1].toLowerCase();
  const br = line.match(/^\s*-\s*Branch:\s*(\S+)/);
  if (br) current.branch = br[1];
}
const notReady = (e) => ["reserved", "active", "blocked"].includes(e.status);
const shortBranch = branch.replace(/^[^/]+\//, "");
// Trunk runs are not "merging a reservation" — never own-match there,
// fall through to the legacy strict check instead.
const trunk = ["dev", "main", "master", "HEAD", ""].includes(branch);
const own = !trunk && branch
  ? entries.find(
      (e) =>
        e.branch === branch ||
        e.slug === branch ||
        e.slug === shortBranch,
    )
  : undefined;
const others = entries.filter((e) => e !== own && notReady(e));
const out = [];
if (own) {
  if (phase === "merge" && own.status !== "ready-for-review" && own.status !== "merged") {
    out.push(`FAIL current reservation '${own.slug}' is '${own.status}', not ready-for-review`);
  } else if (phase === "preflight" && own.status === "blocked") {
    out.push(`WARN current reservation '${own.slug}' is blocked`);
  }
  for (const e of others) {
    out.push(`WARN other reservation '${e.slug}' is '${e.status}' (not blocking this branch)`);
  }
} else if (others.length > 0) {
  out.push("LEGACY");
}
console.log(out.join("\n"));
NODE
)" || verdict="LEGACY"

  if [ -z "$verdict" ]; then
    return 0
  fi

  if [ "$verdict" = "LEGACY" ]; then
    if grep -nE '^[[:space:]]*-[[:space:]]*Status:[[:space:]]*(reserved|active|blocked)' "$file" >/dev/null 2>&1; then
      if [ "$PHASE" = "stop" ]; then
        emit_warn "feature ledger has non-ready entries in ${file#$PROJECT_PATH/}"
      else
        emit_fail "feature ledger has entries not ready for merge in ${file#$PROJECT_PATH/}"
        grep -nE '^[[:space:]]*-[[:space:]]*Status:[[:space:]]*(reserved|active|blocked)' "$file" | head -20 || true
      fi
    fi
    return 0
  fi

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      FAIL\ *)
        if [ "$PHASE" = "stop" ]; then
          emit_warn "${line#FAIL } (${file#$PROJECT_PATH/})"
        else
          emit_fail "${line#FAIL } (${file#$PROJECT_PATH/})"
        fi
        ;;
      WARN\ *)
        emit_warn "${line#WARN } (${file#$PROJECT_PATH/})"
        ;;
    esac
  done <<< "$verdict"
}

check_feature_design_docs() {
  local file="$1"
  [ -f "$file" ] || return 0
  if ! command -v node >/dev/null 2>&1; then
    emit_warn "node unavailable — design-doc binding check skipped for ${file#$PROJECT_PATH/}"
    return 0
  fi

  local issues
  issues="$(node - "$file" "$PROJECT_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [file, projectPath] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\r?\n/);
const entries = [];
let current = null;
let inExpectedDocs = false;

function relative(item) {
  return path.relative(projectPath, item) || path.basename(item);
}

function startEntry(heading, lineNumber) {
  if (current) entries.push(current);
  current = {
    heading,
    start: lineNumber,
    status: null,
    docs: []
  };
  inExpectedDocs = false;
}

function ensureEntry(lineNumber) {
  if (!current) {
    startEntry(`entry starting line ${lineNumber}`, lineNumber);
  }
}

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const lineNumber = index + 1;
  const heading = line.match(/^##\s+(.+?)\s*$/);
  if (heading) {
    startEntry(heading[1], lineNumber);
    continue;
  }

  const status = line.match(/^\s*-\s*Status:\s*([^|#\s]+)/i);
  if (status) {
    ensureEntry(lineNumber);
    current.status = status[1].trim().toLowerCase();
    inExpectedDocs = false;
    continue;
  }

  const expectedDocs = line.match(/^\s*-\s*Expected docs:\s*(.*?)\s*$/i);
  if (expectedDocs) {
    ensureEntry(lineNumber);
    if (expectedDocs[1]) {
      current.docs.push({
        line: lineNumber,
        value: expectedDocs[1].trim()
      });
      inExpectedDocs = false;
    } else {
      inExpectedDocs = true;
    }
    continue;
  }

  if (!inExpectedDocs) continue;

  const docItem = line.match(/^\s+-\s+(.+?)\s*$/);
  if (docItem) {
    current.docs.push({
      line: lineNumber,
      value: docItem[1].trim()
    });
    continue;
  }

  if (/^\s*-\s+\S/.test(line)) {
    inExpectedDocs = false;
  }
}

if (current) entries.push(current);

const relevant = new Set(["reserved", "active", "blocked", "ready-for-review"]);

function issue(message) {
  process.stdout.write(`ISSUE\t${message}\n`);
}

function normalizeDocValue(raw) {
  return raw
    .replace(/\s+#.*$/, "")
    .replace(/^`(.+)`$/, "$1")
    .trim();
}

function hasFrontmatter(filePath) {
  const body = fs.readFileSync(filePath, "utf8");
  if (!body.startsWith("---\n")) return false;
  const end = body.indexOf("\n---", 4);
  if (end === -1) return false;
  const frontmatter = body.slice(4, end);
  const scalarRequired = [
    "type",
    "status",
    "owner",
    "created_at",
    "last_verified_at"
  ];
  const keyRequired = [
    "related_paths",
    "truth_sources"
  ];
  return scalarRequired.every((field) => new RegExp(`^${field}:\\s*\\S+`, "m").test(frontmatter))
    && keyRequired.every((field) => new RegExp(`^${field}:`, "m").test(frontmatter));
}

for (const entry of entries) {
  if (!entry.status || !relevant.has(entry.status)) continue;

  const waiver = entry.docs.some((doc) => /^none\s*[-:]\s*\S+/i.test(normalizeDocValue(doc.value)));
  const boundDocs = entry.docs
    .map((doc) => ({ ...doc, value: normalizeDocValue(doc.value) }))
    .filter((doc) => /^docs\/(working|decisions)\/[^<>]+\.md$/i.test(doc.value));

  if (!waiver && boundDocs.length === 0) {
    issue(`${relative(file)}:${entry.start} feature reservation "${entry.heading}" must bind Expected docs to docs/working/<slug>.md or docs/decisions/<slug>.md`);
    continue;
  }

  if (waiver) continue;

  for (const doc of boundDocs) {
    const docPath = path.join(projectPath, doc.value);
    if (!fs.existsSync(docPath)) {
      issue(`${relative(file)}:${doc.line} bound design document is missing: ${doc.value}`);
      continue;
    }
    if (!hasFrontmatter(docPath)) {
      issue(`${doc.value}:1 bound design document must start with frontmatter containing type, status, owner, created_at, last_verified_at, related_paths, and truth_sources`);
    }
  }
}
NODE
)"

  while IFS=$'\t' read -r level message; do
    [ -n "${level:-}" ] || continue
    case "$level" in
      ISSUE)
        if [ "$PHASE" = "stop" ]; then
          emit_warn "$message"
        else
          emit_fail "$message"
        fi
        ;;
    esac
  done <<< "$issues"
}

check_changed_tests_reviewed() {
  [ "$RULE_PHASE" = "preflight" ] || [ "$RULE_PHASE" = "merge" ] || return 0
  if ! git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local result
  if result="$(node "$SCRIPT_DIR/test-review-evidence.cjs" check --project "$PROJECT_PATH" 2>&1)"; then
    # A passing check can still print a notice (e.g. legacy single-file receipt deprecation).
    [ -z "$result" ] || emit_warn "$result"
  else
    emit_fail "$result"
  fi
}

# A change to the contract's player_review.paths needs a passing review from
# another session, bound to the current commit: preflight warns, merge blocks.
check_player_review() {
  [ "$RULE_PHASE" = "preflight" ] || [ "$RULE_PHASE" = "merge" ] || return 0
  if ! git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local result rc=0
  result="$(node "$SCRIPT_DIR/player-review.cjs" check --project "$PROJECT_PATH" --phase "$RULE_PHASE" 2>&1)" || rc=$?
  case "$rc" in
    0) [ -z "$result" ] || echo "$result" ;;
    3) emit_warn "$result" ;;
    *) emit_fail "$result" ;;
  esac
}

GATE_LOG="$AIDK_ROOT/.ai-dev-kit/workflow/gate-log.jsonl"

run_project_gate() {
  local command="$1"
  local args=("$command" --project "$PROJECT_PATH" --phase "$PHASE")
  [ -z "$SUBTRACTION_THRESHOLD" ] || args+=(--subtraction-threshold "$SUBTRACTION_THRESHOLD")
  run_supervised node "$SCRIPT_DIR/project-gate-evidence.cjs" "${args[@]}"
  if [ "$RESULT_RC" -eq 0 ]; then
    [ -z "$RESULT_OUT" ] || echo "$RESULT_OUT"
    [ -z "$RESULT_ERR" ] || emit_warn "$RESULT_ERR"
  elif [ "$RESULT_RC" -eq 75 ]; then
    # project-gate-evidence.cjs BLOCKED_EXIT: retryable, no receipt written.
    [ -z "$RESULT_OUT" ] || echo "$RESULT_OUT"
    emit_blocked "${RESULT_ERR#project-gate: BLOCKED (retryable): }"
  else
    emit_fail "${RESULT_OUT}${RESULT_ERR:+${RESULT_OUT:+
}$RESULT_ERR}"
  fi
}

write_gate_receipt() {
  local result="$1"
  mkdir -p "$(dirname "$GATE_LOG")" 2>/dev/null || return 0
  local branch head ts
  branch="$(git -C "$PROJECT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  head="$(git -C "$PROJECT_PATH" rev-parse HEAD 2>/dev/null || echo unknown)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","phase":"%s","result":"%s","branch":"%s","head":"%s"}\n' \
    "$ts" "$PHASE" "$result" "$branch" "$head" >> "$GATE_LOG" 2>/dev/null || return 0
  # keep the log bounded
  if [ "$(wc -l < "$GATE_LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -200 "$GATE_LOG" > "$GATE_LOG.tmp" && mv "$GATE_LOG.tmp" "$GATE_LOG"
  fi
}

# --- Coordination engine (v0.8.0): cascade | ledger(deprecated) -------------
# engine=cascade routes claim/reservation checks through the Cascade store
# instead of the markdown feature-ledger. Preflight and merge are fail-closed:
# if the configured coordination state cannot be proven, readiness cannot pass.
# Stop remains light and performs no coordination I/O.

coord_value_from() {
  # coord_value_from <file> <key|section.key> — read a value from the
  # coordination: block of the given file. Handles one level of nesting
  # (coordination.cascade.*).
  [ -f "$1" ] || return 0
  awk -v target="$2" '
    function strip(s){ sub(/[[:space:]]*#.*/,"",s); gsub(/^[[:space:]]+|[[:space:]]+$/,"",s); sub(/^"/,"",s); sub(/"$/,"",s); return s }
    BEGIN{ n=split(target,parts,".") }
    /^coordination:[[:space:]]*(#.*)?$/ { inc=1; next }
    inc==0 { next }
    /^[^[:space:]#]/ { inc=0; next }
    {
      match($0,/^[[:space:]]*/); indent=RLENGTH
      key=$0; sub(/:.*/,"",key); gsub(/^[[:space:]]+|[[:space:]]+$/,"",key)
      val=$0; sub(/^[^:]*:[[:space:]]*/,"",val)
      if (n==1) {
        if (indent==2 && key==parts[1]) { print strip(val); exit }
      } else {
        if (indent==2 && key==parts[1]) { insub=1; next }
        if (indent<=2) { insub=0 }
        if (insub && indent==4 && key==parts[2]) { print strip(val); exit }
      }
    }
  ' "$1"
}

coord_value() {
  # coord_value <key|section.key> — profile.local.yml (machine-local secrets
  # overlay, gitignored) wins per key over the tracked profile.yml. An overlay
  # cannot set a key to explicit empty — absent/empty there falls through.
  local v
  v="$(coord_value_from "$PROFILE_LOCAL_FILE" "$1")"
  if [ -n "$v" ]; then printf '%s\n' "$v"; return 0; fi
  coord_value_from "$PROFILE_FILE" "$1"
}

cascade_storage_args() {
  # Emit the cascade global storage flags (one token per line) for the
  # configured backend. file: --storage; git: --git-remote/cache/namespace;
  # redis: --redis-url/namespace.
  local storage
  storage="$(coord_value cascade.storage)"
  if [ "$storage" = "redis" ]; then
    local url ns
    # Precedence mirrors the subtraction-threshold idiom: env > profile
    # (where "profile" is already local-overlay > tracked, per coord_value).
    url="${AI_DEV_KIT_CASCADE_REDIS_URL:-$(coord_value cascade.redis_url)}"
    ns="$(coord_value cascade.namespace)"
    [ -n "$url" ] && printf -- '--redis-url\n%s\n' "$url"
    [ -n "$ns" ] && printf -- '--namespace\n%s\n' "$ns"
  elif [ "$storage" = "git" ]; then
    local configured remote cache ns
    configured="${AI_DEV_KIT_CASCADE_GIT_REMOTE:-$(coord_value cascade.git_remote)}"
    [ -n "$configured" ] || return 1
    remote="$(git -C "$AIDK_ROOT" remote get-url "$configured" 2>/dev/null || true)"
    if [ -z "$remote" ]; then
      case "$configured" in
        /*|*://*|*@*:*) remote="$configured" ;;
        *) remote="$AIDK_ROOT/$configured" ;;
      esac
    fi
    cache="$(coord_value cascade.git_cache)"
    ns="$(coord_value cascade.namespace)"
    printf -- '--git-remote\n%s\n' "$remote"
    if [ -n "$cache" ]; then
      case "$cache" in /*) : ;; *) cache="$AIDK_ROOT/$cache" ;; esac
      printf -- '--git-cache\n%s\n' "$cache"
    fi
    [ -n "$ns" ] && printf -- '--namespace\n%s\n' "$ns"
  else
    local sp
    sp="$(coord_value cascade.storage_path)"
    [ -n "$sp" ] || sp=".ai-dev-kit/cascade"
    case "$sp" in
      /*) : ;;
      *) sp="$AIDK_ROOT/$sp" ;;
    esac
    printf -- '--storage\n%s\n' "$sp"
  fi
}

cascade_command() {
  local budget
  budget="$(coord_value cascade.command_timeout_seconds)"
  local options=(--storage-kind "$(coord_value cascade.storage)")
  [ -z "$budget" ] || options+=(--timeout-seconds "$budget")
  run_supervised node "$SCRIPT_DIR/cascade-process.cjs" "${options[@]}" -- "$@"
}

run_cascade() {
  # Bash 3.2 needs this expansion when no storage arguments are present.
  cascade_command ${CAS_ARGS[@]+"${CAS_ARGS[@]}"} "$@"
}

cascade_payload_valid() {
  node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(raw);
        if (value?.success !== true || !Array.isArray(value?.data?.nodes)) process.exit(1);
        if (value.data.nodes.some(node => typeof node?.id !== "string" || typeof node?.state !== "string" || !Object.hasOwn(node, "reserved_for") || (node.reserved_for !== null && typeof node.reserved_for !== "string"))) process.exit(1);
      } catch { process.exit(1); }
    });
  '
}

cascade_node_state() {
  # Canonical ID lookup only. Legacy lane encoding is an explicit migration
  # error, including on trunk; never silently mix the two ownership contracts.
  node -e '
    const slug = process.argv[1];
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      const nodes = JSON.parse(raw).data.nodes;
      if (nodes.some(node => node.id.includes("@"))) process.exit(2);
      const exact = nodes.find(node => node.id === slug);
      if (exact) { console.log(`${exact.state} ${exact.id}`); return; }
    });
  ' "$1"
}

check_cascade_version() {
  local min raw inst rmaj rmin imaj imin version_output
  min="$(coord_value cascade.min_version)"
  if [ -z "$min" ]; then
    emit_fail "coordination.cascade.min_version is required for a fail-closed Cascade gate"
    return 0
  fi
  raw="$(printf '%s' "$min" | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -z "$raw" ]; then
    emit_fail "configured cascade.min_version '$min' could not be parsed"
    return 0
  fi
  cascade_command --version
  if [ "$RESULT_RC" -ne 0 ]; then
    emit_fail "installed cascade version could not be parsed or queried: ${RESULT_OUT}${RESULT_ERR:+ $RESULT_ERR}"
    return 0
  fi
  [ -z "$RESULT_ERR" ] || emit_warn "$RESULT_ERR"
  version_output="$RESULT_OUT"
  inst="$(printf '%s' "$version_output" | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -z "$inst" ]; then
    emit_fail "installed cascade version could not be parsed — install a release with 'cascade --version' support"
    return 0
  fi
  rmaj="${raw%%.*}"; rmin="${raw#*.}"
  imaj="${inst%%.*}"; imin="${inst#*.}"
  case "$rmaj$rmin$imaj$imin" in
    *[!0-9]*) emit_fail "cascade version comparison received invalid numeric components"; return 0 ;;
  esac
  if [ "$imaj" -eq 0 ] && [ "$imin" -lt 7 ]; then
    emit_fail "Cascade >=0.7.0 is required for native reserved_for ownership — migrate the CLI and legacy lane nodes"
  fi
  if [ "$imaj" -lt "$rmaj" ] || { [ "$imaj" -eq "$rmaj" ] && [ "$imin" -lt "$rmin" ]; }; then
    emit_fail "cascade $inst is below min_version $min — follow /ai-dev-kit-cascade-init and the Installation section in references/cascade-coordination.md"
  fi
}

cascade_node_config() {
  local configured="${AI_DEV_KIT_CASCADE_NODE_CONFIG:-$(coord_value cascade.node_config)}"
  case "$configured" in "~/"*) configured="$HOME/${configured#\~/}" ;; esac
  printf '%s' "$configured"
}

check_cascade_task_state() {  # check_cascade_task_state <state> <node id>
  # ACTIVE is the observed coordination state, not authentication of this
  # process or proof of a live lease. Owners must retain and renew their token.
  if [ "$RULE_PHASE" = "preflight" ] && [ "$1" != "ACTIVE" ]; then
    emit_fail "cascade node '$2' is $1, not ACTIVE — claim this exact task before preflight and retain its fencing token"
  fi

  # Merge rule: finish-task carries the verification evidence and merge follows
  # (design §3 mapping: 'merged + evidence' -> finish-task/COMPLETED). So at
  # merge the node must already be COMPLETED; anything else means the work was
  # not finished with evidence in the store.
  if [ "$RULE_PHASE" = "merge" ] && [ "$1" != "COMPLETED" ]; then
    emit_fail "cascade node '$2' is $1, not COMPLETED — finish it with evidence first: cascade get-task --agent <agent> --task '$2', then cascade finish-task --task '$2' --agent <agent> --token <fencing_token from get-task> --success --summary '<verification evidence>'. Use scripts/cascade-lane.cjs finish to resolve the shared project storage."
  fi
}

check_cascade_node_coordination() {  # check_cascade_node_coordination <instance client.json>
  # A center on the node-collaboration runtime refuses lock-ref pushes, so the
  # CLI's Git-lease reads fail there even for a read; the center's node API
  # answers instead. The branch's task is read with this agent's instance.
  local config="$1"
  local client="${AI_DEV_KIT_CASCADE_NODE_CLIENT:-$SCRIPT_DIR/../skills/cascade-center-agent/scripts/cascade-node-client.cjs}"
  if [ ! -f "$config" ]; then
    emit_fail "coordination.cascade.node_config '$config' does not exist — join the center (/ai-dev-kit-cascade-init) and point it at that instance's client.json"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    emit_fail "Node.js unavailable — required to read the center through the node client"
    return 0
  fi

  local branch slug
  branch="$(git -C "$PROJECT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  case "$branch" in dev|main|master|HEAD|"") return 0 ;; esac
  slug="${branch#*/}"
  case "$slug" in
    */*)
      emit_fail "branch '$branch' must be <owner-or-type>/<canonical-task-id> with exactly one prefix segment"
      return 0
      ;;
  esac

  run_supervised node --no-warnings "$client" --config "$config" thread --task "$slug"
  if [ "$RESULT_RC" -ne 0 ]; then
    case "$RESULT_ERR$RESULT_OUT" in
      *"HTTP 404"*) emit_fail "no cascade node matches canonical branch slug '$slug'" ;;
      *) emit_fail "cascade node client failed (exit $RESULT_RC) — center unreachable: ${RESULT_ERR:-$RESULT_OUT}" ;;
    esac
    return 0
  fi

  local state
  state="$(printf '%s' "$RESULT_OUT" | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const state = JSON.parse(raw)?.task?.state;
        if (typeof state === "string" && state.length > 0) process.stdout.write(state);
      } catch { /* reported below as a missing state */ }
    });
  ')"
  if [ -z "$state" ]; then
    emit_fail "cascade node client returned no task state for '$slug'"
    return 0
  fi
  check_cascade_task_state "$state" "$slug"
}

check_cascade_coordination() {
  # Replaces the markdown ledger checks when engine=cascade. Coordination is a
  # required preflight/merge input, so configuration, CLI, storage, and payload
  # failures are blocking. Stop intentionally does no coordination I/O.
  [ "$RULE_PHASE" = "preflight" ] || [ "$RULE_PHASE" = "merge" ] || return 0

  local node_config
  node_config="$(cascade_node_config)"
  if [ -n "$node_config" ]; then
    check_cascade_node_coordination "$node_config"
    return 0
  fi

  local storage configured
  storage="$(coord_value cascade.storage)"
  case "$storage" in
    file) : ;;
    redis)
      configured="${AI_DEV_KIT_CASCADE_REDIS_URL:-$(coord_value cascade.redis_url)}"
      if [ -z "$configured" ]; then
        emit_fail "coordination.cascade.redis_url is required when storage=redis"
        return 0
      fi
      ;;
    git)
      configured="${AI_DEV_KIT_CASCADE_GIT_REMOTE:-$(coord_value cascade.git_remote)}"
      if [ -z "$configured" ]; then
        emit_fail "coordination.cascade.git_remote is required when storage=git"
        return 0
      fi
      ;;
    *)
      emit_fail "coordination.cascade.storage must be one of file, git, redis (got '${storage:-<missing>}')"
      return 0
      ;;
  esac
  if ! command -v cascade >/dev/null 2>&1; then
    emit_fail "cascade CLI unavailable — follow /ai-dev-kit-cascade-init and the Installation section in references/cascade-coordination.md before preflight or merge"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    emit_fail "Node.js unavailable — required to validate Cascade JSON output"
    return 0
  fi
  check_cascade_version

  CAS_ARGS=()
  while IFS= read -r _arg; do
    [ -n "$_arg" ] && CAS_ARGS+=("$_arg")
  done < <(cascade_storage_args)

  local out rc
  # 'if' guards set -e so a failing Cascade command becomes a controlled gate
  # failure instead of aborting the shell before the receipt is written.
  run_cascade list-nodes
  out="$RESULT_OUT"; rc="$RESULT_RC"
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
      emit_fail "cascade list-nodes timed out — coordination storage unreachable"
    else
      emit_fail "cascade list-nodes failed (exit $rc) — coordination storage unreachable${out:+: $out}${RESULT_ERR:+ $RESULT_ERR}"
    fi
    return 0
  fi
  [ -z "$RESULT_ERR" ] || emit_warn "$RESULT_ERR"
  if ! printf '%s' "$out" | cascade_payload_valid; then
    emit_fail "cascade list-nodes returned an invalid JSON contract"
    return 0
  fi

  local branch slug state
  branch="$(git -C "$PROJECT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  # <owner-or-type>/<canonical-task-id>: the prefix is free, the second segment is the node id.
  slug="${branch#*/}"

  local match node_id
  if match="$(printf '%s' "$out" | cascade_node_state "$slug")"; then :; else
    emit_fail "legacy @lane nodes require explicit migration to canonical IDs with reserved_for; see docs/coordination-0.7-migration.md"
    return 0
  fi
  case "$branch" in dev|main|master|HEAD|"") return 0 ;; esac
  case "$slug" in
    */*)
      emit_fail "branch '$branch' must be <owner-or-type>/<canonical-task-id> with exactly one prefix segment"
      return 0
      ;;
  esac
  if [ -z "$match" ]; then
    emit_fail "no cascade node matches canonical branch slug '$slug'"
    return 0
  fi
  state="${match%% *}"
  node_id="${match#* }"
  check_cascade_task_state "$state" "$node_id"
}

if [ "$PHASE" = "stop" ]; then
  check_unfinished_ledger "$LEDGER_FILE"
else
  run_project_gate check
fi

COORD_ENGINE="$(coord_value engine)"
case "$COORD_ENGINE" in
  cascade)
    check_cascade_coordination
    ;;
  ledger|"")
    # engine=ledger (deprecated) or unset — legacy markdown coordination checks.
    if [ "$PHASE" != "stop" ]; then
      emit_warn "coordination engine 'ledger' is deprecated — migrate explicitly with /ai-dev-kit-cascade-init; existing configuration is preserved"
    fi
    check_feature_ledger_status "$FEATURE_LEDGER"
    check_feature_ledger_status "$FALLBACK_FEATURE_LEDGER"
    check_feature_design_docs "$FEATURE_LEDGER"
    check_feature_design_docs "$FALLBACK_FEATURE_LEDGER"
    ;;
  *)
    if [ "$PHASE" != "stop" ]; then emit_fail "unknown coordination.engine '$COORD_ENGINE' — configure cascade or the explicit deprecated ledger mode"; fi
    ;;
esac

check_changed_tests_reviewed
check_player_review

if [ "$FAILED" = false ] && [ "$PHASE" != "stop" ]; then
  run_project_gate "$PHASE"
fi

if [ "$FAILED" = true ]; then
  write_gate_receipt "fail"
  echo "AI Dev Kit skill-first gate failed."
  exit 2
fi

if [ "$BLOCKED" = true ]; then
  write_gate_receipt "blocked"
  echo "AI Dev Kit skill-first gate BLOCKED (retryable): $BLOCKED_REASON"
  exit "$BLOCKED_EXIT_CODE"
fi

if [ "$WARNED" = true ]; then
  write_gate_receipt "pass-with-warnings"
  echo "AI Dev Kit skill-first gate passed with warnings."
else
  write_gate_receipt "pass"
  echo "AI Dev Kit skill-first gate passed."
fi

exit 0
