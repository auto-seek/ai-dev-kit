#!/bin/bash
# install-skill.sh — install ai-dev-kit skills from the local marketplace.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKILL_NAME="ai-dev-kit"
TARGET="both"
HARNESS="both"
PROJECT_PATH=""
MARKET_PATH="$KIT_ROOT/marketplace/index.json"
FORCE=false
COMMANDS_ONLY=false
SKILL_ONLY=false
GLOBAL_COMMANDS=false
LIST_ONLY=false

usage() {
  cat <<'EOF'
Usage: bash bootstrap/install-skill.sh [options]

Options:
  --list                        List skills in the local marketplace
  --skill <name>                Marketplace skill name (default: ai-dev-kit)
  --target <codex|claude|both|project|all>
                                codex/claude/both install user-level skills
                                project installs .ai-dev-kit/skills/<packages>
                                all installs both user-level skills and project skills
  --project <path>              Project path for project skills and legacy slash commands
  --harness <codex|claude|both|generic|none>
                                Project slash command target when --target project
  --market <path>               Marketplace index JSON (default: marketplace/index.json)
  --global-commands             Also install legacy user-level command files when a project is given
  --commands-only               Install legacy command files without copying skills
  --skill-only                  Install skill packages without legacy command files
  --force                       Replace existing files instead of keeping backups
  --help                        Show this help

Examples:
  bash bootstrap/install-skill.sh --list
  bash bootstrap/install-skill.sh --target both
  bash bootstrap/install-skill.sh --target all --project /path/to/project
  bash bootstrap/install-skill.sh --target project --project /path/to/project --harness codex
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list)
      LIST_ONLY=true
      shift
      ;;
    --skill)
      SKILL_NAME="${2:-ai-dev-kit}"
      shift 2
      ;;
    --target)
      TARGET="${2:-both}"
      shift 2
      ;;
    --project)
      PROJECT_PATH="${2:-}"
      shift 2
      ;;
    --harness)
      HARNESS="${2:-both}"
      shift 2
      ;;
    --market)
      MARKET_PATH="${2:-$MARKET_PATH}"
      shift 2
      ;;
    --global-commands)
      GLOBAL_COMMANDS=true
      shift
      ;;
    --commands-only)
      COMMANDS_ONLY=true
      shift
      ;;
    --skill-only)
      SKILL_ONLY=true
      shift
      ;;
    --force)
      FORCE=true
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

case "$TARGET" in
  codex|claude|both|project|all) ;;
  *)
    echo "Error: --target must be codex, claude, both, project, or all." >&2
    exit 1
    ;;
esac

case "$HARNESS" in
  codex|claude|both|generic|none) ;;
  *)
    echo "Error: --harness must be codex, claude, both, generic, or none." >&2
    exit 1
    ;;
esac

if [ "$COMMANDS_ONLY" = true ] && [ "$SKILL_ONLY" = true ]; then
  echo "Error: --commands-only and --skill-only cannot be used together." >&2
  exit 1
fi

resolve_market_path() {
  node - "$KIT_ROOT" "$MARKET_PATH" <<'NODE'
const path = require("node:path");
const [kitRoot, marketPath] = process.argv.slice(2);
console.log(path.isAbsolute(marketPath) ? marketPath : path.resolve(kitRoot, marketPath));
NODE
}

MARKET_PATH="$(resolve_market_path)"

if [ ! -f "$MARKET_PATH" ]; then
  echo "Error: marketplace index not found: $MARKET_PATH" >&2
  exit 1
fi

if [ "$LIST_ONLY" = true ]; then
  node - "$MARKET_PATH" <<'NODE'
const fs = require("node:fs");
const marketPath = process.argv[2];
const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
console.log(`Skills from ${marketPath}:`);
for (const skill of market.skills ?? []) {
  console.log(`- ${skill.name}: ${skill.description ?? ""}`);
}
NODE
  exit 0
fi

MARKET_DATA="$(node - "$KIT_ROOT" "$MARKET_PATH" "$SKILL_NAME" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [kitRoot, marketPath, skillName] = process.argv.slice(2);
const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
const skill = (market.skills ?? []).find((entry) => entry.name === skillName);
if (!skill) {
  console.error(`Skill not found in marketplace: ${skillName}`);
  process.exit(1);
}
const source = path.resolve(kitRoot, skill.source);
const commands = skill.slashCommands?.source
  ? path.resolve(kitRoot, skill.slashCommands.source)
  : "";
console.log(source);
console.log(commands);
console.log(skill.description ?? "");
NODE
)"

SKILL_SOURCE="$(printf '%s\n' "$MARKET_DATA" | sed -n '1p')"
COMMAND_SOURCE="$(printf '%s\n' "$MARKET_DATA" | sed -n '2p')"
SKILL_DESCRIPTION="$(printf '%s\n' "$MARKET_DATA" | sed -n '3p')"

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
  echo "Error: skill source does not contain SKILL.md: $SKILL_SOURCE" >&2
  exit 1
fi

if [ -n "$COMMAND_SOURCE" ] && [ ! -d "$COMMAND_SOURCE" ]; then
  echo "Error: slash command source not found: $COMMAND_SOURCE" >&2
  exit 1
fi

list_skill_packages() {
  node - "$KIT_ROOT" "$MARKET_PATH" "$SKILL_NAME" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [kitRoot, marketPath, skillName] = process.argv.slice(2);
const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
const skill = (market.skills ?? []).find((entry) => entry.name === skillName);
const packages = skill?.skillPackages?.length ? skill.skillPackages : [skill?.source].filter(Boolean);
for (const packagePath of packages) {
  console.log(path.resolve(kitRoot, packagePath));
}
NODE
}

if [ "$TARGET" = "project" ] && [ -z "$PROJECT_PATH" ]; then
  echo "Error: --target project requires --project <path>." >&2
  exit 1
fi

if [ -n "$PROJECT_PATH" ]; then
  PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"
  if [ ! -d "$PROJECT_PATH" ]; then
    echo "Error: project directory does not exist: $PROJECT_PATH" >&2
    exit 1
  fi
fi

resolve_path() {
  node - "$1" <<'NODE'
const path = require("node:path");
console.log(path.resolve(process.argv[2]));
NODE
}

portable_path() {
  local item="$1"
  if [[ "$item" == "$HOME/"* ]]; then
    printf '$HOME/%s' "${item#$HOME/}"
  else
    printf '%s' "$item"
  fi
}

replace_placeholders() {
  local file="$1"
  local project_path="$2"
  local project_skill_path="$3"
  local user_skill_path="$4"
  local kit_path
  kit_path="$(portable_path "$KIT_ROOT")"
  node - "$file" "$kit_path" "$project_path" "$project_skill_path" "$user_skill_path" "$SKILL_NAME" <<'NODE'
const fs = require("node:fs");
const [file, kitPath, projectPath, projectSkillPath, userSkillPath, skillName] = process.argv.slice(2);
let text = fs.readFileSync(file, "utf8");
text = text.replaceAll("{{AI_DEV_KIT_PATH}}", kitPath);
text = text.replaceAll("{{PROJECT_PATH}}", projectPath);
text = text.replaceAll("{{PROJECT_SKILL_PATH}}", projectSkillPath);
text = text.replaceAll("{{USER_SKILL_PATH}}", userSkillPath);
text = text.replaceAll("{{SKILL_NAME}}", skillName);
fs.writeFileSync(file, text);
NODE
}

backup_or_replace() {
  local path_to_replace="$1"
  if [ ! -e "$path_to_replace" ]; then
    return
  fi

  if [ "$FORCE" = true ]; then
    rm -rf "$path_to_replace"
    return
  fi

  local backup="${path_to_replace}.bak.$(date +%Y%m%d%H%M%S)"
  mv "$path_to_replace" "$backup"
  echo "  backed up $path_to_replace to $backup"
}

install_skill_dir() {
  local label="$1"
  local src="$2"
  local dest="$3"

  if [ "$COMMANDS_ONLY" = true ]; then
    return
  fi

  if [ ! -f "$src/SKILL.md" ]; then
    echo "Error: skill package does not contain SKILL.md: $src" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dest")"
  backup_or_replace "$dest"
  cp -R "$src" "$dest"
  if [ ! -f "$dest/SKILL.md" ]; then
    echo "Error: installed skill is missing SKILL.md: $dest" >&2
    exit 1
  fi
  echo "  installed $label skill: $dest"
}

install_skill_packages() {
  local label="$1"
  local dest_root="$2"

  while IFS= read -r package_source; do
    [ -n "$package_source" ] || continue
    local package_name
    package_name="$(basename "$package_source")"
    install_skill_dir "$label" "$package_source" "$dest_root/$package_name"
  done < <(list_skill_packages)
}

install_commands_dir() {
  local label="$1"
  local dest="$2"
  local project_path="$3"
  local project_skill_path="$4"
  local user_skill_path="$5"

  if [ "$SKILL_ONLY" = true ] || [ -z "$COMMAND_SOURCE" ]; then
    return
  fi

  mkdir -p "$dest"
  for template in "$COMMAND_SOURCE"/*.md; do
    [ -f "$template" ] || continue
    local output="$dest/$(basename "$template")"
    backup_or_replace "$output"
    cp "$template" "$output"
    replace_placeholders "$output" "$project_path" "$project_skill_path" "$user_skill_path"
    echo "  installed $label slash command: $output"
  done
}

CODEX_HOME_DIR="$(resolve_path "${CODEX_HOME:-$HOME/.codex}")"
CLAUDE_HOME_DIR="$(resolve_path "${CLAUDE_HOME:-$HOME/.claude}")"
CODEX_SKILL_ROOT="$CODEX_HOME_DIR/skills"
CLAUDE_SKILL_ROOT="$CLAUDE_HOME_DIR/skills"
CODEX_SKILL_DIR="$CODEX_SKILL_ROOT/$SKILL_NAME"
CLAUDE_SKILL_DIR="$CLAUDE_SKILL_ROOT/$SKILL_NAME"
PROJECT_SKILL_DIR=""
if [ -n "$PROJECT_PATH" ]; then
  PROJECT_SKILL_DIR="$PROJECT_PATH/.ai-dev-kit/skills"
fi

echo "AI Dev Kit skill installer"
echo "  skill: $SKILL_NAME"
echo "  target: $TARGET"
echo "  description: $SKILL_DESCRIPTION"
if [ -n "$PROJECT_PATH" ]; then
  echo "  project: $PROJECT_PATH"
fi
echo ""

INSTALLED_USER_SKILL=false

case "$TARGET" in
  codex)
    install_skill_packages "Codex" "$CODEX_SKILL_ROOT"
    INSTALLED_USER_SKILL=true
    ;;
  claude)
    install_skill_packages "Claude" "$CLAUDE_SKILL_ROOT"
    INSTALLED_USER_SKILL=true
    ;;
  both)
    install_skill_packages "Codex" "$CODEX_SKILL_ROOT"
    install_skill_packages "Claude" "$CLAUDE_SKILL_ROOT"
    INSTALLED_USER_SKILL=true
    ;;
  project)
    install_skill_packages "project" "$PROJECT_SKILL_DIR"
    ;;
  all)
    install_skill_packages "Codex" "$CODEX_SKILL_ROOT"
    install_skill_packages "Claude" "$CLAUDE_SKILL_ROOT"
    INSTALLED_USER_SKILL=true
    if [ -n "$PROJECT_PATH" ]; then
      install_skill_packages "project" "$PROJECT_SKILL_DIR"
    else
      echo "  skipped project skill: no --project supplied"
    fi
    ;;
esac

PROJECT_COMMAND_PATH="${PROJECT_PATH:-.}"
PROJECT_COMMAND_SKILL_PATH=".ai-dev-kit/skills/$SKILL_NAME/SKILL.md"
if [ -n "$PROJECT_PATH" ]; then
  PROJECT_COMMAND_SKILL_PATH="$PROJECT_PATH/.ai-dev-kit/skills/$SKILL_NAME/SKILL.md"
fi

install_project_commands_for_harness() {
  local harness="$1"
  case "$harness" in
    codex)
      install_commands_dir "Codex project" "$PROJECT_PATH/.codex/commands" "$PROJECT_COMMAND_PATH" "$PROJECT_COMMAND_SKILL_PATH" "$CODEX_SKILL_DIR/SKILL.md"
      ;;
    claude)
      install_commands_dir "Claude project" "$PROJECT_PATH/.claude/commands" "$PROJECT_COMMAND_PATH" "$PROJECT_COMMAND_SKILL_PATH" "$CLAUDE_SKILL_DIR/SKILL.md"
      ;;
    both)
      install_project_commands_for_harness codex
      install_project_commands_for_harness claude
      ;;
    generic)
      install_commands_dir "generic project" "$PROJECT_PATH/.ai-dev-kit/commands" "$PROJECT_COMMAND_PATH" "$PROJECT_COMMAND_SKILL_PATH" "$PROJECT_COMMAND_SKILL_PATH"
      ;;
    none)
      ;;
  esac
}

if [ -n "$PROJECT_PATH" ]; then
  case "$TARGET" in
    codex)
      install_project_commands_for_harness codex
      ;;
    claude)
      install_project_commands_for_harness claude
      ;;
    both|all)
      install_project_commands_for_harness both
      ;;
    project)
      install_project_commands_for_harness "$HARNESS"
      ;;
  esac
fi

INSTALL_USER_COMMANDS=false
if [ -z "$PROJECT_PATH" ] || [ "$GLOBAL_COMMANDS" = true ]; then
  INSTALL_USER_COMMANDS=true
fi

if [ "$INSTALL_USER_COMMANDS" = true ]; then
  case "$TARGET" in
    codex)
      install_commands_dir "Codex user" "$CODEX_HOME_DIR/commands" "." ".ai-dev-kit/skills/$SKILL_NAME/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"
      ;;
    claude)
      install_commands_dir "Claude user" "$CLAUDE_HOME_DIR/commands" "." ".ai-dev-kit/skills/$SKILL_NAME/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
      ;;
    both|all)
      install_commands_dir "Codex user" "$CODEX_HOME_DIR/commands" "." ".ai-dev-kit/skills/$SKILL_NAME/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"
      install_commands_dir "Claude user" "$CLAUDE_HOME_DIR/commands" "." ".ai-dev-kit/skills/$SKILL_NAME/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
      ;;
    project)
      ;;
  esac
fi

echo ""
echo "Skill install complete."
echo "Slash commands installed from: $COMMAND_SOURCE"
if [ "$INSTALLED_USER_SKILL" = true ] && [ "$COMMANDS_ONLY" != true ]; then
  echo "Restart Codex or Claude Code if the running harness does not hot-reload skills."
fi
