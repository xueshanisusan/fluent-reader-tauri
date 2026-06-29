use crate::models::*;
use crate::repo;
use sqlx::SqlitePool;
use tauri::State;

pub struct AppState {
    pub pool: SqlitePool,
}

fn err(e: sqlx::Error) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn groups_list(state: State<'_, AppState>) -> Result<Vec<Group>, String> {
    repo::groups::list(&state.pool).await.map_err(err)
}

#[tauri::command]
pub async fn groups_create(
    state: State<'_, AppState>,
    name: String,
) -> Result<Group, String> {
    repo::groups::create(&state.pool, &name).await.map_err(err)
}

#[tauri::command]
pub async fn groups_rename(
    state: State<'_, AppState>,
    gid: i64,
    name: String,
) -> Result<(), String> {
    repo::groups::rename(&state.pool, gid, &name).await.map_err(err)
}

#[tauri::command]
pub async fn groups_set_expanded(
    state: State<'_, AppState>,
    gid: i64,
    expanded: bool,
) -> Result<(), String> {
    repo::groups::set_expanded(&state.pool, gid, expanded).await.map_err(err)
}

#[tauri::command]
pub async fn groups_set_position(
    state: State<'_, AppState>,
    gid: i64,
    position: i64,
) -> Result<(), String> {
    repo::groups::set_position(&state.pool, gid, position).await.map_err(err)
}

#[tauri::command]
pub async fn groups_delete(state: State<'_, AppState>, gid: i64) -> Result<(), String> {
    repo::groups::delete(&state.pool, gid).await.map_err(err)
}

#[tauri::command]
pub async fn sources_list(state: State<'_, AppState>) -> Result<Vec<Source>, String> {
    repo::sources::list(&state.pool).await.map_err(err)
}

#[tauri::command]
pub async fn sources_create(
    state: State<'_, AppState>,
    input: NewSource,
) -> Result<Source, String> {
    repo::sources::create(&state.pool, input).await.map_err(err)
}

#[tauri::command]
pub async fn sources_rename(
    state: State<'_, AppState>,
    sid: i64,
    name: String,
) -> Result<(), String> {
    repo::sources::rename(&state.pool, sid, &name).await.map_err(err)
}

#[tauri::command]
pub async fn sources_set_group(
    state: State<'_, AppState>,
    sid: i64,
    group_id: Option<i64>,
) -> Result<(), String> {
    repo::sources::set_group(&state.pool, sid, group_id).await.map_err(err)
}

#[tauri::command]
pub async fn sources_set_icon_url(
    state: State<'_, AppState>,
    sid: i64,
    icon_url: Option<String>,
) -> Result<(), String> {
    repo::sources::set_icon_url(&state.pool, sid, icon_url).await.map_err(err)
}

#[tauri::command]
pub async fn sources_set_fetch_frequency(
    state: State<'_, AppState>,
    sid: i64,
    fetch_frequency: i64,
) -> Result<(), String> {
    repo::sources::set_fetch_frequency(&state.pool, sid, fetch_frequency).await.map_err(err)
}

#[tauri::command]
pub async fn sources_set_hidden(
    state: State<'_, AppState>,
    sid: i64,
    hidden: bool,
) -> Result<(), String> {
    repo::sources::set_hidden(&state.pool, sid, hidden).await.map_err(err)
}

#[tauri::command]
pub async fn sources_set_last_fetched(
    state: State<'_, AppState>,
    sid: i64,
    last_fetched_ms: i64,
) -> Result<(), String> {
    repo::sources::set_last_fetched(&state.pool, sid, last_fetched_ms).await.map_err(err)
}

#[tauri::command]
pub async fn sources_delete(state: State<'_, AppState>, sid: i64) -> Result<(), String> {
    repo::sources::delete(&state.pool, sid).await.map_err(err)
}

#[tauri::command]
pub async fn rules_list(
    state: State<'_, AppState>,
    source_id: i64,
) -> Result<Vec<SourceRule>, String> {
    repo::rules::list_for_source(&state.pool, source_id).await.map_err(err)
}

#[tauri::command]
pub async fn rules_create(
    state: State<'_, AppState>,
    input: NewRule,
) -> Result<SourceRule, String> {
    repo::rules::create(&state.pool, input).await.map_err(err)
}

#[tauri::command]
pub async fn rules_update(
    state: State<'_, AppState>,
    rid: i64,
    patch: RulePatch,
) -> Result<(), String> {
    repo::rules::update(&state.pool, rid, patch).await.map_err(err)
}

#[tauri::command]
pub async fn rules_delete(state: State<'_, AppState>, rid: i64) -> Result<(), String> {
    repo::rules::delete(&state.pool, rid).await.map_err(err)
}

#[tauri::command]
pub async fn items_list(
    state: State<'_, AppState>,
    source_id: Option<i64>,
    has_read: Option<bool>,
    starred: Option<bool>,
    hidden: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<Item>, String> {
    repo::items::list(&state.pool, source_id, has_read, starred, hidden, limit, offset)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn items_insert(
    state: State<'_, AppState>,
    items: Vec<NewItem>,
) -> Result<u64, String> {
    repo::items::insert_many(&state.pool, items).await.map_err(err)
}

#[tauri::command]
pub async fn items_mark_read(
    state: State<'_, AppState>,
    iid: i64,
    has_read: bool,
) -> Result<(), String> {
    repo::items::mark_read(&state.pool, iid, has_read).await.map_err(err)
}

#[tauri::command]
pub async fn items_set_starred(
    state: State<'_, AppState>,
    iid: i64,
    starred: bool,
) -> Result<(), String> {
    repo::items::set_starred(&state.pool, iid, starred).await.map_err(err)
}

#[tauri::command]
pub async fn items_set_hidden(
    state: State<'_, AppState>,
    iid: i64,
    hidden: bool,
) -> Result<(), HideError> {
    repo::items::set_hidden(&state.pool, iid, hidden)
        .await
        .map_err(|e| HideError::Db { message: e.to_string() })
}

#[tauri::command]
pub async fn items_unread_counts(
    state: State<'_, AppState>,
) -> Result<Vec<UnreadCount>, String> {
    repo::items::unread_counts(&state.pool).await.map_err(err)
}
