use crate::commands::AppState;
use crate::models::*;
use crate::repo;
use tauri::State;

// TODO: support a scope param ("title" | "titleAndSnippet") so the user can
// narrow searches when snippet hits are noisy. Default stays title+snippet.
#[tauri::command]
pub async fn items_search(
    state: State<'_, AppState>,
    query: String,
    source_id: Option<i64>,
    has_read: Option<bool>,
    starred: Option<bool>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Item>, SearchError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    repo::items::search(
        &state.pool,
        trimmed,
        source_id,
        has_read,
        starred,
        limit,
        offset,
    )
    .await
    .map_err(|e| SearchError::Db { message: e.to_string() })
}
