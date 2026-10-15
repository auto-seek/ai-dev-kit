#!/bin/bash
# init-skill.sh — Bootstrap ai-dev-kit v2 skill-first workflow into a project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_PATH=""
PROJECT_NAME=""
PROJECT_TYPE="auto"
ENFORCEMENT_PROFILE="balanced"
HARNESS="codex"
OVERWRITE_HOOKS=false
COORDINATION="skip"

usage() {
  cat <<'EOF'
Usage: bash bootstrap/init-skill.sh <project-path> [options]

Options:
  --name <name>                 Project name (default: directory name)
  --type <type>                 Project type override (default: auto)
  --profile <light|balanced|strict>
  --harness <codex|claude|both|generic|none>
  --coordination <cascade|ledger|skip>
                                Write the coordination engine block into
                                profile.yml. cascade = file storage +
                                self-serve role (single-machine default);
                                ledger = deprecated legacy mode; skip
                                (default) = preserve existing configuration;
                                fresh projects default to Cascade file storage.
                                Non-interactive; run /ai-dev-kit-cascade-init
                                for the guided setup with smoke tests.
  --overwrite-hooks             Replace active harness hook file after backing it up
  --help                        Show this help

This installs the skill-first v2 layout:
  .ai-dev-kit/profile.yml
  .ai-dev-kit/skills/ai-dev-kit/
  .ai-dev-kit/workflow/
  .ai-dev-kit/docs/
  docs/development/feature-ledger.md
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      PROJECT_NAME="${2:-}"
      shift 2
      ;;
    --type)
      PROJECT_TYPE="${2:-auto}"
      shift 2
      ;;
    --profile)
      ENFORCEMENT_PROFILE="${2:-balanced}"
      shift 2
      ;;
    --harness)
      HARNESS="${2:-codex}"
      shift 2
      ;;
    --coordination)
      COORDINATION="${2:-skip}"
      shift 2
      ;;
    --overwrite-hooks)
      OVERWRITE_HOOKS=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$PROJECT_PATH" ]; then
        PROJECT_PATH="$1"
      else
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$PROJECT_PATH" ]; then
  echo "Error: project path is required." >&2
  usage >&2
  exit 1
fi

case "$HARNESS" in
  codex|claude|both|generic|none) ;;
  *)
    echo "Error: --harness must be codex, claude, both, generic, or none." >&2
    exit 1
    ;;
esac

case "$ENFORCEMENT_PROFILE" in
  light|balanced|strict) ;;
  *)
    echo "Error: --profile must be light, balanced, or strict." >&2
    exit 1
    ;;
esac

case "$COORDINATION" in
  cascade|ledger|skip) ;;
  *)
    echo "Error: --coordination must be cascade, ledger, or skip." >&2
    exit 1
    ;;
esac

PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"
if [ ! -d "$PROJECT_PATH" ]; then
  echo "Error: directory does not exist: $PROJECT_PATH" >&2
  exit 1
fi

if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="$(basename "$PROJECT_PATH")"
fi

if [[ "$KIT_ROOT" == "$HOME/"* ]]; then
  PORTABLE_KIT_PATH='$HOME/'"${KIT_ROOT#$HOME/}"
else
  PORTABLE_KIT_PATH="$KIT_ROOT"
fi

replace_placeholders() {
  local file="$1"
  node - "$file" "$PORTABLE_KIT_PATH" "$PROJECT_PATH" <<'NODE'
const fs = require("fs");
const [file, kitPath, projectPath] = process.argv.slice(2);
let text = fs.readFileSync(file, "utf8");
text = text.replaceAll("{{AI_DEV_KIT_PATH}}", kitPath);
text = text.replaceAll("{{PROJECT_PATH}}", projectPath);
fs.writeFileSync(file, text);
NODE
}

copy_if_absent() {
  local src="$1"
  local dest="$2"
  if [ -f "$dest" ]; then
    echo "  kept existing ${dest#$PROJECT_PATH/}"
  else
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "  created ${dest#$PROJECT_PATH/}"
  fi
}

append_skill_pointer() {
  local file="$1"
  local agent_label="$2"
  local marker="AI_DEV_KIT_SKILL_FIRST"

  if [ ! -f "$file" ]; then
    cat > "$file" <<EOF
# Project Instructions

<!-- $marker -->
Use the ai-dev-kit skill-first workflow installed at:

\`.ai-dev-kit/skills/ai-dev-kit/SKILL.md\`

Project profile:

\`.ai-dev-kit/profile.yml\`

For loop work, use the configured coordination engine to reserve the canonical task slug before creating a worktree from the configured target branch.
EOF
    echo "  created $(basename "$file") for $agent_label"
    return
  fi

  if grep -q "$marker" "$file"; then
    echo "  $(basename "$file") already references skill-first workflow"
    return
  fi

  cat >> "$file" <<EOF

---

## AI Dev Kit Skill-First Workflow

<!-- $marker -->
Use the ai-dev-kit skill-first workflow installed at:

\`.ai-dev-kit/skills/ai-dev-kit/SKILL.md\`

Project profile:

\`.ai-dev-kit/profile.yml\`

For loop work, use the configured coordination engine to reserve the canonical task slug before creating a worktree from the configured target branch.
EOF
  echo "  appended skill-first pointer to $(basename "$file")"
}

install_hook_file() {
  local template="$1"
  local active_file="$2"
  local inactive_file="$3"

  mkdir -p "$(dirname "$active_file")"

  if [ -f "$active_file" ] && [ "$OVERWRITE_HOOKS" != true ]; then
    cp "$template" "$inactive_file"
    replace_placeholders "$inactive_file"
    echo "  existing ${active_file#$PROJECT_PATH/} preserved"
    echo "  wrote inactive adapter ${inactive_file#$PROJECT_PATH/}"
    return
  fi

  if [ -f "$active_file" ]; then
    local backup="${active_file}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$active_file" "$backup"
    echo "  backed up ${active_file#$PROJECT_PATH/} to ${backup#$PROJECT_PATH/}"
  fi

  cp "$template" "$active_file"
  replace_placeholders "$active_file"
  echo "  installed active adapter ${active_file#$PROJECT_PATH/}"
}

echo "AI Dev Kit skill-first bootstrap"
echo "  project: $PROJECT_NAME"
echo "  path: $PROJECT_PATH"
echo "  harness: $HARNESS"
echo "  profile: $ENFORCEMENT_PROFILE"
echo ""

mkdir -p "$PROJECT_PATH/.ai-dev-kit/workflow"
mkdir -p "$PROJECT_PATH/.ai-dev-kit/docs"
mkdir -p "$PROJECT_PATH/.ai-dev-kit/skills"

if [ -f "$PROJECT_PATH/.ai-dev-kit/profile.yml" ]; then
  echo "Preserving existing profile (including coordination and project commands)."
else
  echo "Generating profile..."
  node "$KIT_ROOT/scripts/generate-skill-profile.cjs" "$PROJECT_PATH" \
    --name "$PROJECT_NAME" \
    --type "$PROJECT_TYPE" \
    --profile "$ENFORCEMENT_PROFILE" \
    --out "$PROJECT_PATH/.ai-dev-kit/profile.yml"
  echo "  wrote .ai-dev-kit/profile.yml"
  if [ "$COORDINATION" = "skip" ]; then COORDINATION=cascade; fi
fi

if [ "$COORDINATION" != "skip" ] && grep -qE '^coordination:[[:space:]]*(#.*)?$' "$PROJECT_PATH/.ai-dev-kit/profile.yml"; then
  EXISTING_ENGINE="$(awk '/^coordination:/{inc=1;next} inc && /^  engine:/{print $2;exit} inc && /^[^ #]/{exit}' "$PROJECT_PATH/.ai-dev-kit/profile.yml")"
  if [ "$EXISTING_ENGINE" != "$COORDINATION" ]; then
    echo "Error: coordination is already configured as '$EXISTING_ENGINE'; use /ai-dev-kit-cascade-init for an explicit engine/storage/role migration." >&2
    exit 1
  fi
  echo "Preserving existing $EXISTING_ENGINE storage, role and namespace."
  COORDINATION=skip
fi
if [ "$COORDINATION" != "skip" ]; then
  echo "Setting coordination engine ($COORDINATION)..."
  if [ "$COORDINATION" = "cascade" ]; then
    node "$KIT_ROOT/scripts/set-coordination.cjs" \
      --profile "$PROJECT_PATH/.ai-dev-kit/profile.yml" \
      --engine cascade --role self-serve \
      --storage file --storage-path ".ai-dev-kit/cascade" --namespace "$PROJECT_NAME"
    # file-mode store must stay gitignored (worktree forking + real-time locks)
    GITIGNORE_COORD="$PROJECT_PATH/.gitignore"
    if [ ! -f "$GITIGNORE_COORD" ] || ! grep -q "\.ai-dev-kit/cascade" "$GITIGNORE_COORD"; then
      {
        echo ""
        echo "# AI Dev Kit Cascade coordination store (file mode)"
        echo ".ai-dev-kit/cascade/"
      } >> "$GITIGNORE_COORD"
      echo "  gitignored .ai-dev-kit/cascade/"
    fi
    # secrets overlay must stay gitignored even if profile.yml itself is tracked
    if ! grep -q "\.ai-dev-kit/profile\.local\.yml" "$GITIGNORE_COORD" 2>/dev/null; then
      {
        echo ""
        echo "# AI Dev Kit machine-local coordination secrets (redis_url etc.)"
        echo ".ai-dev-kit/profile.local.yml"
      } >> "$GITIGNORE_COORD"
      echo "  gitignored .ai-dev-kit/profile.local.yml"
    fi
  else
    node "$KIT_ROOT/scripts/set-coordination.cjs" \
      --profile "$PROJECT_PATH/.ai-dev-kit/profile.yml" \
      --engine ledger --role orchestrator
  fi
fi

echo "Installing skill..."
bash "$KIT_ROOT/bootstrap/install-skill.sh" \
  --target project \
  --project "$PROJECT_PATH" \
  --harness none \
  --skill-only

echo "Creating workflow files..."
copy_if_absent "$KIT_ROOT/templates/workflow/LEDGER.md" "$PROJECT_PATH/.ai-dev-kit/workflow/LEDGER.md"
copy_if_absent "$KIT_ROOT/templates/workflow/feature-ledger.md" "$PROJECT_PATH/.ai-dev-kit/workflow/feature-ledger.md"
copy_if_absent "$KIT_ROOT/templates/workflow/doc-registry.yml" "$PROJECT_PATH/.ai-dev-kit/docs/registry.yml"
# Reviewers copy this to the per-branch narrative path from `test-review-evidence.cjs paths`.
copy_if_absent "$KIT_ROOT/templates/workflow/test-review.md" "$PROJECT_PATH/.ai-dev-kit/workflow/test-review-template.md"
copy_if_absent "$KIT_ROOT/templates/workflow/subtraction-log.md" "$PROJECT_PATH/.ai-dev-kit/workflow/subtraction-log.md"
copy_if_absent "$KIT_ROOT/templates/workflow/document-template.md" "$PROJECT_PATH/.ai-dev-kit/docs/document-template.md"
if [ ! -f "$PROJECT_PATH/.ai-dev-kit/workflow/findings.jsonl" ]; then
  : > "$PROJECT_PATH/.ai-dev-kit/workflow/findings.jsonl"
  echo "  created .ai-dev-kit/workflow/findings.jsonl"
else
  echo "  kept existing .ai-dev-kit/workflow/findings.jsonl"
fi
if [ ! -f "$PROJECT_PATH/.ai-dev-kit/docs/claims.jsonl" ]; then
  : > "$PROJECT_PATH/.ai-dev-kit/docs/claims.jsonl"
  echo "  created .ai-dev-kit/docs/claims.jsonl"
else
  echo "  kept existing .ai-dev-kit/docs/claims.jsonl"
fi

echo "Creating development ledger..."
copy_if_absent "$KIT_ROOT/templates/workflow/feature-ledger.md" "$PROJECT_PATH/docs/development/feature-ledger.md"

echo "Updating agent instruction pointers..."
case "$HARNESS" in
  codex)
    append_skill_pointer "$PROJECT_PATH/AGENTS.md" "Codex"
    ;;
  claude)
    append_skill_pointer "$PROJECT_PATH/CLAUDE.md" "Claude Code"
    ;;
  both)
    append_skill_pointer "$PROJECT_PATH/AGENTS.md" "Codex"
    append_skill_pointer "$PROJECT_PATH/CLAUDE.md" "Claude Code"
    ;;
  generic)
    echo "  generic harness: project instruction file is harness-owned"
    ;;
  none)
    echo "  skipped harness instruction files"
    ;;
esac

echo "Installing hook adapters..."
case "$HARNESS" in
  codex)
    install_hook_file "$KIT_ROOT/templates/adapters/codex/hooks.skill-first.json" \
      "$PROJECT_PATH/.codex/hooks.json" \
      "$PROJECT_PATH/.codex/hooks.skill-first.json"
    ;;
  claude)
    install_hook_file "$KIT_ROOT/templates/adapters/claude/settings.skill-first.json" \
      "$PROJECT_PATH/.claude/settings.json" \
      "$PROJECT_PATH/.claude/settings.skill-first.json"
    ;;
  both)
    install_hook_file "$KIT_ROOT/templates/adapters/codex/hooks.skill-first.json" \
      "$PROJECT_PATH/.codex/hooks.json" \
      "$PROJECT_PATH/.codex/hooks.skill-first.json"
    install_hook_file "$KIT_ROOT/templates/adapters/claude/settings.skill-first.json" \
      "$PROJECT_PATH/.claude/settings.json" \
      "$PROJECT_PATH/.claude/settings.skill-first.json"
    ;;
  generic)
    mkdir -p "$PROJECT_PATH/.ai-dev-kit/adapters/generic"
    cp "$KIT_ROOT/templates/adapters/generic/hook-contract.md" \
      "$PROJECT_PATH/.ai-dev-kit/adapters/generic/hook-contract.md"
    cp "$KIT_ROOT/templates/adapters/generic/hook-commands.env" \
      "$PROJECT_PATH/.ai-dev-kit/adapters/generic/hook-commands.env"
    replace_placeholders "$PROJECT_PATH/.ai-dev-kit/adapters/generic/hook-contract.md"
    replace_placeholders "$PROJECT_PATH/.ai-dev-kit/adapters/generic/hook-commands.env"
    echo "  installed generic adapter contract under .ai-dev-kit/adapters/generic/"
    ;;
  none)
    echo "  skipped hook adapters"
    ;;
esac

echo "Installing slash commands..."
bash "$KIT_ROOT/bootstrap/install-skill.sh" \
  --target project \
  --project "$PROJECT_PATH" \
  --harness "$HARNESS" \
  --commands-only

GITIGNORE="$PROJECT_PATH/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q ".ai-dev-kit/graph" "$GITIGNORE"; then
    {
      echo ""
      echo "# AI Dev Kit local runtime data"
      echo ".ai-dev-kit/graph/"
    } >> "$GITIGNORE"
    echo "Updated .gitignore with local ai-dev-kit runtime data"
  fi
fi
# Workflow state (receipts, findings, loop position) is effort-local and is
# shared through the main checkout, never through commits.
if [ ! -f "$GITIGNORE" ] || ! grep -qE '^/?\.ai-dev-kit/workflow/?(\*\*?)?[[:space:]]*$' "$GITIGNORE"; then
  {
    echo ""
    echo "# AI Dev Kit workflow state (receipts, findings, loop state)"
    echo ".ai-dev-kit/workflow/"
  } >> "$GITIGNORE"
  echo "Updated .gitignore with .ai-dev-kit/workflow/"
fi
if git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
   [ -n "$(git -C "$PROJECT_PATH" ls-files -- .ai-dev-kit/workflow 2>/dev/null)" ]; then
  echo "Note: files under .ai-dev-kit/workflow/ are already tracked; .gitignore does not untrack them."
  echo "  Review them, then stop tracking with: git -C \"$PROJECT_PATH\" rm -r --cached .ai-dev-kit/workflow/"
fi

echo ""
echo "AI Dev Kit skill-first bootstrap complete."
if [ -e "$PROJECT_PATH/.ai-dev-kit/gate-contract.json" ] || [ -L "$PROJECT_PATH/.ai-dev-kit/gate-contract.json" ]; then
  echo "Preserved project-owned .ai-dev-kit/gate-contract.json; preflight validates and executes it."
else
  echo "Action required before preflight: declare and git add .ai-dev-kit/gate-contract.json."
  echo "Select the approved base ref, requirements scope, and real project verification argv explicitly."
  echo "Existing profile.preflight.entrypoint commands need an explicit migration; no default success command is installed."
  echo "Read docs/team-gate-migration.md in the kit before enrolling or migrating the project."
fi
if [ -e "$PROJECT_PATH/.ai-dev-kit/test-scope.json" ] || [ -L "$PROJECT_PATH/.ai-dev-kit/test-scope.json" ]; then
  echo "Preserved project-owned .ai-dev-kit/test-scope.json; review validates its contents."
else
  echo "Action required before preflight: declare and git add .ai-dev-kit/test-scope.json."
  echo "List the project's literal test files/directories; bootstrap does not guess from languages or names."
  echo "For the schema and explicit no-tests declaration, read docs/test-scope-migration.md in the kit."
fi
echo "Run a preflight gate with:"
echo "  bash \"$PORTABLE_KIT_PATH/scripts/skill-first-gate.sh\" --phase preflight --project \"$PROJECT_PATH\""
