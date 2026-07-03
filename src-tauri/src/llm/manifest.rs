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
}
