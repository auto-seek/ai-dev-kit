#!/bin/bash
# post-edit-format.sh — PostToolUse hook: auto-format the edited file only
# Called by Claude Code or Codex after every Edit/Write/MultiEdit operation
#
# Part of ai-dev-kit — commercial-grade AI development quality framework

set -euo pipefail

# Get the edited file path from tool input. Agent hooks provide TOOL_INPUT.
HOOK_INPUT="${TOOL_INPUT:-}"
FILE_PATH=$(printf '%s\n' "$HOOK_INPUT" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"file_path"\s*:\s*"//; s/"$//')

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Only format known file types (skip .cjs, .json, .md, .sh, etc.)
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.css|*.scss|*.html|*.vue|*.svelte)
    ;;
  *)
    exit 0
    ;;
esac

PROJECT_ROOT=$(pwd)

# Debug: log what's happening
echo "[post-edit-format] FILE_PATH=$FILE_PATH PWD=$PROJECT_ROOT" >> /tmp/ai-dev-kit-hook-debug.log

# Try Prettier on the single file, then fall back to biome
if [ -f "$PROJECT_ROOT/node_modules/.bin/prettier" ]; then
  "$PROJECT_ROOT/node_modules/.bin/prettier" --write --log-level silent "$FILE_PATH" 2>/dev/null || true
elif command -v prettier &>/dev/null; then
  prettier --write --log-level silent "$FILE_PATH" 2>/dev/null || true
elif [ -f "$PROJECT_ROOT/node_modules/.bin/biome" ]; then
  "$PROJECT_ROOT/node_modules/.bin/biome" format --write "$FILE_PATH" 2>/dev/null || true
fi

exit 0  # Always succeed — formatting is best-effort
