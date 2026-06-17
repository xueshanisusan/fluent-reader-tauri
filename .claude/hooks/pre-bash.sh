#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash. Blocks a small set of foot-guns.
set -u

input=$(cat)
cmd=$(printf '%s' "$input" \
    | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1)

[ -z "$cmd" ] && exit 0

block() {
    echo "[guardrail] $1" >&2
    exit 2
}

# 1. git add -A / git add . / git add --all
if echo "$cmd" | grep -qE '(^|[[:space:];&|])git[[:space:]]+add[[:space:]]+(-A([[:space:]]|$)|--all([[:space:]]|$)|\.([[:space:]]|$))'; then
    block "'git add -A' / 'git add .' / 'git add --all' is forbidden. Stage files explicitly by name — see CLAUDE.md."
fi

# 2. git commit -a / -am
if echo "$cmd" | grep -qE '(^|[[:space:];&|])git[[:space:]]+commit\b[^|;&]*[[:space:]]-[a-zA-Z]*a'; then
    block "'git commit -a' is forbidden. Stage files with 'git add <path>' first."
fi

# 3. cargo run/build on the src-tauri crate
if echo "$cmd" | grep -qE '(^|[[:space:];&|])cargo[[:space:]]+(run|build)\b'; then
    if echo "$cmd" | grep -qE '(src-tauri|--manifest-path[[:space:]]+[^[:space:]]*src-tauri)'; then
        block "'cargo run/build' on src-tauri/ is forbidden. Use 'pnpm tauri:dev' / 'pnpm tauri:build' — see CLAUDE.md."
    fi
fi

exit 0
