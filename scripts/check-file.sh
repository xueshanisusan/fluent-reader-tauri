#!/usr/bin/env bash
# Static guardrail checks for a single file. Called from both the Claude Code
# post-edit hook and the git pre-commit hook. Exit 0 = pass, 2 = block.
#
# Existing violations in tracked files are grandfathered: only newly-added
# lines (vs. HEAD) are scanned for code-style violations. This is so the
# 22 legacy `Result<T, String>` commands in commands.rs don't fail every edit
# while still preventing new ones from landing.
set -u

file="${1:-}"
[ -z "$file" ] && exit 0

# Normalize Windows backslashes so case patterns match.
file="${file//\\//}"

# Repo-relative path makes case patterns simpler. Try multiple normalizations.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null | sed 's|\\|/|g' || true)
if [ -n "$repo_root" ]; then
    # Strip absolute-Windows prefix (D:/Programs/repo) and bash-style (/d/Programs/repo).
    case "$file" in
        "$repo_root"/*) rel="${file#$repo_root/}" ;;
        *) rel="$file" ;;
    esac
else
    rel="$file"
fi

# If the file does not exist on disk, this was a deletion — nothing to check.
[ -f "$file" ] || [ -f "$rel" ] || exit 0

fail() {
    echo "[guardrail] $1" >&2
    echo "[guardrail] file: $rel" >&2
    exit 2
}

# Lines that this edit added (vs. HEAD). Empty when file is unchanged.
added_lines() {
    git diff HEAD -- "$rel" 2>/dev/null \
        | awk '/^@@/ { in_hunk=1; next } in_hunk && /^\+[^+]/ { sub(/^\+/, ""); print }'
}

# Whole-file content for new (untracked) files; otherwise just added lines.
new_or_added_content() {
    if git ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
        added_lines
    else
        # Untracked: treat the whole file as "added".
        cat "$rel" 2>/dev/null || cat "$file" 2>/dev/null
    fi
}

case "$rel" in
    src-tauri/src/*.rs | src-tauri/src/**/*.rs)
        added=$(new_or_added_content)

        # 1. Newly-added Result<*, String> on a tauri command.
        #    Heuristic: any added line that contains Result<_, String> AND the
        #    file (current state) shows that line is within 6 lines of a
        #    #[tauri::command] attribute.
        if [ -n "$added" ]; then
            if echo "$added" | grep -qE 'Result<[^>]*,[[:space:]]*String[[:space:]]*>'; then
                # Confirm at least one #[tauri::command] block in the file currently
                # has a Result<_, String> signature within 6 lines after it.
                if grep -nE '#\[tauri::command\]' "$file" >/dev/null 2>&1 \
                    && grep -A 6 -E '#\[tauri::command\]' "$file" 2>/dev/null \
                        | grep -qE 'Result<[^>]*,[[:space:]]*String[[:space:]]*>'; then
                    fail "new #[tauri::command] returns Result<_, String>; use a typed thiserror enum with #[serde(tag=\"kind\")] — see feeds.rs::IngestionError"
                fi
            fi

            # 2. Newly-added block_on outside lib.rs.
            if [ "$(basename "$rel")" != "lib.rs" ]; then
                if echo "$added" | grep -qE 'tauri::async_runtime::block_on'; then
                    fail "tauri::async_runtime::block_on outside lib.rs::setup — deadlocks the tokio runtime when reached from a #[tauri::command]"
                fi
            fi
        fi

        # 3. New #[tauri::command] must be registered in lib.rs.
        #    Extract fn names that follow a #[tauri::command] attribute.
        cmd_names=$(awk '
            /#\[tauri::command\]/ { want=1; next }
            want && /pub[[:space:]]+(async[[:space:]]+)?fn[[:space:]]+/ {
                match($0, /fn[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*/)
                if (RSTART > 0) {
                    name = substr($0, RSTART + 3, RLENGTH - 3)
                    gsub(/^[[:space:]]+/, "", name)
                    print name
                }
                want=0
            }
            want && !/^[[:space:]]*\/\// && !/^[[:space:]]*$/ && !/^#\[/ { want=0 }
        ' "$file" 2>/dev/null | sort -u)

        if [ -n "$cmd_names" ] && [ "$(basename "$rel")" != "lib.rs" ]; then
            lib_rs="${rel%/*}"
            # Find the crate's lib.rs (climb until we hit one).
            search="$lib_rs/lib.rs"
            while [ ! -f "$search" ] && [ "$lib_rs" != "" ] && [ "$lib_rs" != "." ]; do
                lib_rs="${lib_rs%/*}"
                search="$lib_rs/lib.rs"
            done
            [ -f "$search" ] || search="src-tauri/src/lib.rs"

            missing=""
            while IFS= read -r name; do
                [ -z "$name" ] && continue
                # Look for module::name or ::name in generate_handler!
                if ! grep -qE "::${name}\b|\b${name}\b" "$search" 2>/dev/null; then
                    missing="$missing $name"
                fi
            done <<< "$cmd_names"

            if [ -n "$missing" ]; then
                fail "tauri command(s) not registered in $search::generate_handler![]:$missing"
            fi
        fi
        ;;

    src-tauri/migrations/*.sql)
        # 4. New migration must bump schema_meta.
        if ! git ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
            if ! grep -qE 'UPDATE[[:space:]]+schema_meta[[:space:]]+SET[[:space:]]+value[[:space:]]*=' "$file" 2>/dev/null; then
                fail "new migration missing 'UPDATE schema_meta SET value = ...' — see 0003_items_guid.sql"
            fi
        fi

        # 5. Editing a migration already in HEAD is forbidden.
        if git cat-file -e "HEAD:$rel" 2>/dev/null; then
            if ! git diff --quiet HEAD -- "$rel" 2>/dev/null; then
                fail "editing a committed migration ($rel) — migrations are append-only. Create a new 00NN_*.sql instead."
            fi
        fi
        ;;

    src/components/*.tsx | src/components/**/*.tsx)
        # 6. No newly-added inline style={{
        added=$(new_or_added_content)
        if [ -n "$added" ] && echo "$added" | grep -qE 'style=\{\{'; then
            fail "inline style={{ — use CSS Modules (.module.css). Webpack rule is wired."
        fi
        ;;
esac

exit 0
