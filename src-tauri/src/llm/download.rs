// Fetch a curated model GGUF to `<app_data_dir>/models/`, streaming to a
// `.part` temp file, hashing as we go (single pass — no second read of a
// multi-GB file), verifying against the catalog's sha256 when present, then
// atomically renaming into place and recording it in the manifest.
//
// reqwest is built without the `stream` feature (see net.rs); `Response::chunk`
// works without it, so we don't pull in futures-util.
use crate::llm::catalog::CuratedModel;
use crate::llm::manifest::{self, InstalledModel};
use crate::models::ModelError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use tauri::ipc::Channel;

// Emit progress at most this often (bytes) to avoid flooding the IPC channel.
const PROGRESS_EMIT_STEP: u64 = 1_048_576; // 1 MiB

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    // None when the server didn't send a Content-Length.
    pub total_bytes: Option<u64>,
    // "downloading" | "verifying"
    pub phase: String,
}

/// True when `free` bytes leaves ~20% headroom over `size`. Pure — unit-tested.
pub fn disk_ok(free: u64, size: u64) -> bool {
    free >= size.saturating_mul(12) / 10
}

fn build_client() -> Result<reqwest::Client, ModelError> {
    reqwest::Client::builder()
        .user_agent(concat!("fluent-reader-tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ModelError::Download {
            message: e.to_string(),
        })
}

/// Download `cm` into `models_dir`. On any failure the partial `.part` file is
/// removed. On success the file is renamed into place and the manifest updated.
pub async fn download(
    models_dir: &Path,
    cm: &CuratedModel,
    on_progress: &Channel<DownloadProgress>,
) -> Result<(), ModelError> {
    std::fs::create_dir_all(models_dir).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;

    let free = fs2::available_space(models_dir).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    if !disk_ok(free, cm.size_bytes) {
        return Err(ModelError::Disk {
            message: format!(
                "not enough free space: need ~{} MB, have {} MB",
                cm.size_bytes / 1_048_576,
                free / 1_048_576
            ),
        });
    }

    let tmp = models_dir.join(format!("{}.part", cm.file));
    let final_path = models_dir.join(cm.file);

    match stream_to_file(&tmp, cm, on_progress).await {
        Ok(hash) => {
            std::fs::rename(&tmp, &final_path).map_err(|e| ModelError::Io {
                message: e.to_string(),
            })?;
            manifest::upsert(
                models_dir,
                InstalledModel {
                    id: cm.id.to_string(),
                    name: cm.name.to_string(),
                    file: cm.file.to_string(),
                    size_bytes: cm.size_bytes,
                    sha256: Some(hash),
                    source: "curated".to_string(),
                },
            )
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

async fn stream_to_file(
    tmp: &Path,
    cm: &CuratedModel,
    on_progress: &Channel<DownloadProgress>,
) -> Result<String, ModelError> {
    let client = build_client()?;
    let resp = client
        .get(cm.url)
        .send()
        .await
        .map_err(|e| ModelError::Download {
            message: e.to_string(),
        })?;
    if !resp.status().is_success() {
        return Err(ModelError::Download {
            message: format!("HTTP {} fetching model", resp.status().as_u16()),
        });
    }
    let total = resp.content_length();

    let mut file = std::fs::File::create(tmp).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;

    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| ModelError::Download {
        message: e.to_string(),
    })? {
        file.write_all(&chunk).map_err(|e| ModelError::Io {
            message: e.to_string(),
        })?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= PROGRESS_EMIT_STEP {
            last_emit = downloaded;
            let _ = on_progress.send(DownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: total,
                phase: "downloading".to_string(),
            });
        }
    }
    file.flush().map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;

    let _ = on_progress.send(DownloadProgress {
        downloaded_bytes: downloaded,
        total_bytes: total,
        phase: "verifying".to_string(),
    });

    let got = hex::encode(hasher.finalize());
    if let Some(expected) = cm.sha256 {
        if !got.eq_ignore_ascii_case(expected) {
            return Err(ModelError::Verify {
                message: format!("sha256 mismatch: expected {}, got {}", expected, got),
            });
        }
    }
    Ok(got)
}

/// Copy a user-supplied local .gguf into `models_dir`, hash it, and record it in
/// the manifest as a "custom" model. Synchronous (called via spawn_blocking).
pub fn import(models_dir: &Path, src: &Path) -> Result<InstalledModel, ModelError> {
    if !src.is_file() {
        return Err(ModelError::NotFound {
            message: format!("not a file: {}", src.display()),
        });
    }
    let is_gguf = src
        .extension()
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err(ModelError::Io {
            message: "only .gguf files can be imported".to_string(),
        });
    }
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ModelError::Io {
            message: "invalid file name".to_string(),
        })?
        .to_string();

    std::fs::create_dir_all(models_dir).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    let dest = models_dir.join(&file_name);
    std::fs::copy(src, &dest).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let hash = sha256_file(&dest)?;

    let entry = InstalledModel {
        id: format!("custom:{}", file_name),
        name: file_name.clone(),
        file: file_name,
        size_bytes: size,
        sha256: Some(hash),
        source: "custom".to_string(),
    };
    manifest::upsert(models_dir, entry.clone())?;
    Ok(entry)
}

fn sha256_file(p: &Path) -> Result<String, ModelError> {
    let mut f = std::fs::File::open(p).map_err(|e| ModelError::Io {
        message: e.to_string(),
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| ModelError::Io {
            message: e.to_string(),
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_ok_headroom() {
        assert!(disk_ok(1200, 1000)); // exactly 1.2x
        assert!(disk_ok(5000, 1000));
        assert!(!disk_ok(1199, 1000)); // just under headroom
        assert!(!disk_ok(0, 1000));
    }

    #[test]
    fn disk_ok_no_overflow_on_huge_size() {
        // size * 12 would overflow u64; saturating math must not panic, and a
        // tiny free space can't satisfy a huge model.
        assert!(!disk_ok(1000, u64::MAX));
    }

    #[test]
    fn import_rejects_non_gguf() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("notamodel.txt");
        std::fs::write(&src, b"hi").unwrap();
        let models = dir.path().join("models");
        let err = import(&models, &src).unwrap_err();
        assert!(matches!(err, ModelError::Io { .. }));
    }

    #[test]
    fn import_records_custom_model_with_hash() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("mymodel.gguf");
        std::fs::write(&src, b"weights").unwrap();
        let models = dir.path().join("models");
        let entry = import(&models, &src).unwrap();
        assert_eq!(entry.source, "custom");
        assert_eq!(entry.file, "mymodel.gguf");
        assert!(entry.sha256.is_some());
        // sha256("weights") is deterministic; the file was copied in.
        assert!(models.join("mymodel.gguf").is_file());
        assert_eq!(manifest::read(&models).unwrap().installed, vec![entry]);
    }
}
