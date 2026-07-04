// The on-disk record of which models are actually installed, at
// `<app_data_dir>/models/models.json`. Separate from the static CATALOG: the
// catalog is what we *can* fetch, the manifest is what's *here*. Absent file =
// nothing installed. 2a writes one entry; 2b manages many.
use crate::models::ModelError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub name: String,
    pub file: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    // "curated" (from CATALOG) or "custom" (user-imported .gguf).
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub installed: Vec<InstalledModel>,
    // The model the runtime starts by default. Optional + serde default so old
    // (2a) manifests without the field still load. None → fall back to the first
    // installed entry.
    #[serde(default)]
    pub active_id: Option<String>,
}

pub fn manifest_path(models_dir: &Path) -> PathBuf {
    models_dir.join("models.json")
}

pub fn read(models_dir: &Path) -> Result<Manifest, ModelError> {
    let p = manifest_path(models_dir);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| ModelError::Io {
            message: format!("models.json is corrupt: {}", e),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(ModelError::Io {
            message: e.to_string(),
        }),
    }
}

pub fn write(models_dir: &Path, m: &Manifest) -> Result<(), ModelError> {
    std::fs::create_dir_all(models_dir).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    let s = serde_json::to_string_pretty(m).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    std::fs::write(manifest_path(models_dir), s).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })
}

/// Insert `entry`, replacing any existing entry with the same id.
pub fn upsert(models_dir: &Path, entry: InstalledModel) -> Result<(), ModelError> {
    let mut m = read(models_dir)?;
    m.installed.retain(|e| e.id != entry.id);
    m.installed.push(entry);
    write(models_dir, &m)
}

/// Set the active model to `id`. The caller is responsible for confirming the
/// model's file is actually present; here we only require a matching manifest
/// entry (a since-deleted file is handled by the runtime's fallback).
pub fn set_active(models_dir: &Path, id: &str) -> Result<(), ModelError> {
    let mut m = read(models_dir)?;
    if !m.installed.iter().any(|e| e.id == id) {
        return Err(ModelError::NotFound {
            message: format!("model not installed: {}", id),
        });
    }
    m.active_id = Some(id.to_string());
    write(models_dir, &m)
}

/// Drop the entry with `id` (no-op if absent). Clears `active_id` if it pointed
/// at the removed model. Does NOT touch the model's file on disk — the caller
/// deletes that first (so a failed delete leaves the manifest consistent).
pub fn remove(models_dir: &Path, id: &str) -> Result<(), ModelError> {
    let mut m = read(models_dir)?;
    m.installed.retain(|e| e.id != id);
    if m.active_id.as_deref() == Some(id) {
        m.active_id = None;
    }
    write(models_dir, &m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> InstalledModel {
        InstalledModel {
            id: id.to_string(),
            name: "Sample".to_string(),
            file: format!("{}.gguf", id),
            size_bytes: 123,
            sha256: Some("abc".to_string()),
            source: "curated".to_string(),
        }
    }

    #[test]
    fn read_missing_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()).unwrap(), Manifest::default());
    }

    #[test]
    fn write_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manifest {
            installed: vec![sample("a"), sample("b")],
            active_id: Some("a".to_string()),
        };
        write(dir.path(), &m).unwrap();
        assert_eq!(read(dir.path()).unwrap(), m);
    }

    #[test]
    fn upsert_replaces_by_id() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), sample("a")).unwrap();
        let mut updated = sample("a");
        updated.size_bytes = 999;
        upsert(dir.path(), updated.clone()).unwrap();
        let m = read(dir.path()).unwrap();
        assert_eq!(m.installed.len(), 1);
        assert_eq!(m.installed[0].size_bytes, 999);
    }

    #[test]
    fn set_active_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), sample("a")).unwrap();
        set_active(dir.path(), "a").unwrap();
        assert_eq!(read(dir.path()).unwrap().active_id, Some("a".to_string()));
    }

    #[test]
    fn set_active_on_uninstalled_errs() {
        let dir = tempfile::tempdir().unwrap();
        let err = set_active(dir.path(), "ghost").unwrap_err();
        assert!(matches!(err, ModelError::NotFound { .. }));
    }

    #[test]
    fn remove_drops_entry_and_clears_active() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), sample("a")).unwrap();
        upsert(dir.path(), sample("b")).unwrap();
        set_active(dir.path(), "a").unwrap();
        remove(dir.path(), "a").unwrap();
        let m = read(dir.path()).unwrap();
        assert_eq!(m.installed.len(), 1);
        assert_eq!(m.installed[0].id, "b");
        assert_eq!(m.active_id, None); // removing the active model clears it
    }

    #[test]
    fn remove_keeps_active_when_other_removed() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), sample("a")).unwrap();
        upsert(dir.path(), sample("b")).unwrap();
        set_active(dir.path(), "a").unwrap();
        remove(dir.path(), "b").unwrap();
        assert_eq!(read(dir.path()).unwrap().active_id, Some("a".to_string()));
    }

    #[test]
    fn old_manifest_without_active_id_loads() {
        // 2a wrote { "installed": [...] } with no activeId — must still parse.
        let dir = tempfile::tempdir().unwrap();
        let json = r#"{"installed":[{"id":"a","name":"Sample","file":"a.gguf","sizeBytes":123,"sha256":"abc","source":"curated"}]}"#;
        std::fs::write(manifest_path(dir.path()), json).unwrap();
        let m = read(dir.path()).unwrap();
        assert_eq!(m.installed.len(), 1);
        assert_eq!(m.active_id, None);
    }
}
