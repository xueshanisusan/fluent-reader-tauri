# Project rules for AI assistants

Only rules that hooks can't enforce mechanically. Everything else is checked by `.claude/hooks/post-edit.sh` and `.githooks/pre-commit`.

## Setup

Run once per clone so `git commit` enforces the same checks the editor hooks do:

```
git config core.hooksPath .githooks
```

## Must NOT

- **No `tauri::async_runtime::block_on` outside `src-tauri/src/lib.rs`'s `.setup(...)`.** Inside any `#[tauri::command]` it deadlocks the tokio runtime.
- **No `cargo run` / `cargo build` on `src-tauri/`.** Use `pnpm tauri:dev` and `pnpm tauri:build`. Direct cargo invocations skip the frontend bundle and waste recompiles.
- **No SQLite `ALTER COLUMN` or `ALTER TABLE ... DROP COLUMN`.** SQLite's support is partial and silently breaks foreign keys. Use new-column + backfill if absolutely needed, and ask the user first.
- **No editing migration files once committed.** Migrations are append-only — add `00NN_short_name.sql`, bump `schema_meta`.
- **No `sqlx::query_as!` / `sqlx::query!` compile-time macros.** The runtime-string variants are an intentional choice: no `DATABASE_URL` requirement, in-memory tests work out of the box. If you want to change this, raise it explicitly first.
- **No `git add -A` / `git add .` / `git commit -a`.** Stray scratch files (`gemini-out.txt`, temp paths) have polluted commits twice. Always name files.

## Must DO

### New `#[tauri::command]` checklist

1. Return `Result<T, MyError>` where `MyError` is a `thiserror` enum with `#[serde(tag = "kind", rename_all = "camelCase")]`. Canonical example: `src-tauri/src/feeds.rs::IngestionError`. Never `Result<T, String>` on a new command.
2. Register the function in `src-tauri/src/lib.rs` inside `tauri::generate_handler![…]`. Unregistered commands fail at runtime with no compile-time signal.
3. Add a typed wrapper in `src/scripts/*-bridge.ts`. Backend uses `#[serde(rename_all = "camelCase")]`, so the bridge call passes camelCase keys.
4. If the command uses a new Tauri plugin or capability, update `src-tauri/tauri.conf.json` and `src-tauri/capabilities/*.json` in the same change.

### Frontend ↔ backend struct sync

Any field added, removed, or renamed in a serializable struct under `src-tauri/src/models.rs` must be mirrored in the matching TS interface in `src/scripts/db-bridge.ts` (or the relevant bridge file). The hook can't verify this — it's on you.

### Multi-step DB ops use `_in_tx` helpers + `pool.begin()`

See `src-tauri/src/feeds.rs::ingest` for the pattern (cache-header update + dedup insert + last-fetched bump in one transaction).

### Run commands

| Task | Command |
|---|---|
| Dev | `pnpm tauri:dev` |
| Production build | `pnpm tauri:build` |
| Frontend tests | `pnpm test` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Type / build check | `pnpm build` |

After any code change, the post-edit hook runs the static checks automatically. If it blocks you, fix the issue — do not work around the hook.
