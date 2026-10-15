#!/bin/bash
# install-adapter.sh — install or refresh ai-dev-kit v2 harness adapters.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_PATH=""
HARNESS="generic"
OVERWRITE=false

usage() {
  cat <<'EOF'
Usage: bash bootstrap/install-adapter.sh <project-path> --harness <codex|claude|generic> [--overwrite]

Installs only the harness adapter. Run bootstrap/init-skill.sh first if the
project does not already contain .ai-dev-kit/profile.yml and the local skill.

For unknown harnesses, use --harness generic. It writes the hook contract under
.ai-dev-kit/adapters/generic/ for the harness to consume.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --harness)
      HARNESS="${2:-generic}"
      shift 2
      ;;
    --overwrite)
      OVERWRITE=true
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
  codex|claude|generic) ;;
  *)
    echo "Error: unsupported harness '$HARNESS'. Use generic for custom harnesses." >&2
    exit 1
    ;;
esac

PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"
if [ ! -d "$PROJECT_PATH" ]; then
  echo "Error: directory does not exist: $PROJECT_PATH" >&2
  exit 1
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

install_file() {
  local template="$1"
  local active_file="$2"
  local inactive_file="$3"

  mkdir -p "$(dirname "$active_file")"
  if [ -f "$active_file" ] && [ "$OVERWRITE" != true ]; then
    cp "$template" "$inactive_file"
    replace_placeholders "$inactive_file"
    echo "existing ${active_file#$PROJECT_PATH/} preserved"
    echo "wrote inactive adapter ${inactive_file#$PROJECT_PATH/}"
    return
  fi

  if [ -f "$active_file" ]; then
    local backup="${active_file}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$active_file" "$backup"
    echo "backed up ${active_file#$PROJECT_PATH/} to ${backup#$PROJECT_PATH/}"
  fi

  cp "$template" "$active_file"
  replace_placeholders "$active_file"
  echo "installed ${active_file#$PROJECT_PATH/}"
}

case "$HARNESS" in
  codex)
    install_file "$KIT_ROOT/templates/adapters/codex/hooks.skill-first.json" \
      "$PROJECT_PATH/.codex/hooks.json" \
      "$PROJECT_PATH/.codex/hooks.skill-first.json"
    ;;
  claude)
    install_file "$KIT_ROOT/templates/adapters/claude/settings.skill-first.json" \
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
    echo "installed generic adapter contract under .ai-dev-kit/adapters/generic/"
    ;;
esac

