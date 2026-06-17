#!/usr/bin/env bash
# Claude Code PostToolUse hook for Edit / Write / MultiEdit.
# Reads JSON on stdin, extracts the file_path, hands off to scripts/check-file.sh.
set -u

input=$(cat)

# Best-effort JSON parse without depending on jq.
file=$(printf '%s' "$input" \
    | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1)

[ -z "$file" ] && exit 0

# Normalize escaped backslashes from JSON.
file="${file//\\\\/\\}"

exec bash scripts/check-file.sh "$file"
