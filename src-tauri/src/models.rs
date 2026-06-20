use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub gid: i64,
    pub name: String,
    pub expanded: bool,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub sid: i64,
    pub url: String,
    pub icon_url: Option<String>,
    pub name: String,
    pub open_target: i64,
    pub last_fetched_ms: i64,
    pub service_ref: Option<String>,
    pub fetch_frequency: i64,
    pub text_dir: i64,
    pub hidden: bool,
    pub group_id: Option<i64>,
    pub position: i64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SourceRule {
    pub rid: i64,
    pub source_id: i64,
    pub position: i64,
    pub filter_type_mask: i64,
    pub filter_search: String,
    pub filter_match: bool,
    pub action_read: Option<i64>,
    pub action_star: Option<i64>,
    pub action_hide: Option<i64>,
    pub action_notify: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub iid: i64,
    pub source_id: i64,
    pub title: String,
    pub link: String,
    pub date_ms: i64,
    pub fetched_date_ms: i64,
    pub thumb: Option<String>,
    pub content: String,
    pub snippet: String,
    pub creator: Option<String>,
    pub has_read: bool,
    pub starred: bool,
    pub hidden: bool,
    pub notify: bool,
    pub service_ref: Option<String>,
    pub guid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSource {
    pub url: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub group_id: Option<i64>,
    pub open_target: Option<i64>,
    pub fetch_frequency: Option<i64>,
    pub text_dir: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub source_id: i64,
    pub title: String,
    pub link: String,
    pub date_ms: i64,
    pub thumb: Option<String>,
    pub content: Option<String>,
    pub snippet: Option<String>,
    pub creator: Option<String>,
    #[serde(default)]
    pub guid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRule {
    pub source_id: i64,
    pub position: i64,
    pub filter_type_mask: i64,
    pub filter_search: String,
    pub filter_match: bool,
    pub action_read: Option<i64>,
    pub action_star: Option<i64>,
    pub action_hide: Option<i64>,
    pub action_notify: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePatch {
    pub position: i64,
    pub filter_type_mask: i64,
    pub filter_search: String,
    pub filter_match: bool,
    pub action_read: Option<i64>,
    pub action_star: Option<i64>,
    pub action_hide: Option<i64>,
    pub action_notify: Option<i64>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCount {
    pub source_id: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IngestionOutcome {
    NotModified {
        #[serde(rename = "finalUrl")]
        final_url: String,
    },
    Updated {
        inserted: u64,
        skipped: u64,
        #[serde(rename = "finalUrl")]
        final_url: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IngestionError {
    Network { message: String },
    Parse { message: String },
    Db { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchError {
    Db { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFeed {
    pub url: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiscoveryError {
    Network { message: String },
    NotFound { message: String },
}
