// Downloads the pinned llama-server archive for the current platform (see
// runtime_catalog.rs), verifies it against the pinned sha256, and extracts the
// server binary plus its shared libraries into `<app_data_dir>/bin/` — the
// exact path runtime.rs's `llama_server_path` resolves. Mirrors download.rs's
// streaming+hash pattern; the payload here is a multi-file archive rather than
// a single model file, so it needs an extraction pass on top.
use crate::llm::runtime::{self, ManagedState};
use crate::llm::runtime_catalog::{self, ArchiveKind, RuntimeBinaryTarget};
use crate::models::RuntimeError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::AppHandle;

const PROGRESS_EMIT_STEP: u64 = 1_048_576; // 1 MiB

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    // "downloading" | "verifying" | "extracting"
    pub phase: String,
}

fn io_err(e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Spawn {
        message: e.to_string(),
    }
}

/// True when `free` bytes leaves headroom for the archive plus its extracted
/// contents (~2.5x the compressed size) both landing in the same directory
/// simultaneously — the archive is only removed after extraction succeeds.
fn disk_ok(free: u64, archive_size: u64) -> bool {
    free >= archive_size.saturating_mul(4)
}

/// Download + install the llama-server binary for this machine. Single-flight
/// via `state.downloading_binary` (checked by the caller). On any failure the
/// partial archive is removed; already-extracted files from a failed run are
/// left in place (a retry overwrites them, same as a fresh install).
pub async fn install(
    app: &AppHandle,
    state: &ManagedState,
    on_progress: &Channel<BinaryDownloadProgress>,
) -> Result<(), RuntimeError> {
    let target = runtime_catalog::current_target().ok_or_else(|| RuntimeError::Unsupported {
        message: format!(
            "no prebuilt llama-server for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    })?;

    let dir = runtime::bin_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(io_err)?;

    let free = fs2::available_space(&dir).map_err(io_err)?;
    if !disk_ok(free, target.size_bytes) {
        return Err(RuntimeError::Disk {
            message: format!(
                "not enough free space: need ~{} MB, have {} MB",
                target.size_bytes.saturating_mul(4) / 1_048_576,
                free / 1_048_576
            ),
        });
    }

    let archive_ext = match target.archive {
        ArchiveKind::Zip => "zip",
        ArchiveKind::TarGz => "tar.gz",
    };
    let archive_path = dir.join(format!("llama-server-download.{archive_ext}"));

    // Stop the sidecar first if one's running — we're about to overwrite the
    // binary it's executing, which fails or misbehaves on most platforms.
    runtime::stop(state).await;

    let download_result = stream_download(&archive_path, target, on_progress).await;
    let hash = match download_result {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_file(&archive_path);
            return Err(e);
        }
    };
    if !hash.eq_ignore_ascii_case(target.sha256) {
        let _ = std::fs::remove_file(&archive_path);
        return Err(RuntimeError::Verify {
            message: format!(
                "sha256 mismatch for llama-server archive: expected {}, got {}",
                target.sha256, hash
            ),
        });
    }

    let _ = on_progress.send(BinaryDownloadProgress {
        downloaded_bytes: target.size_bytes,
        total_bytes: Some(target.size_bytes),
        phase: "extracting".to_string(),
    });

    let extract_result = {
        let archive_path = archive_path.clone();
        let dir = dir.clone();
        let target = *target;
        tokio::task::spawn_blocking(move || extract(&archive_path, &dir, &target))
            .await
            .map_err(io_err)?
    };
    let _ = std::fs::remove_file(&archive_path);
    extract_result?;

    let bin_path = dir.join(runtime::server_binary_name());
    if !bin_path.is_file() {
        return Err(RuntimeError::Verify {
            message: "extracted archive did not contain a llama-server binary".to_string(),
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&bin_path).map_err(io_err)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin_path, perms).map_err(io_err)?;
    }

    Ok(())
}

async fn stream_download(
    archive_path: &Path,
    target: &RuntimeBinaryTarget,
    on_progress: &Channel<BinaryDownloadProgress>,
) -> Result<String, RuntimeError> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("fluent-reader-tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| RuntimeError::Download {
            message: e.to_string(),
        })?;
    let mut resp = client
        .get(target.url)
        .send()
        .await
        .map_err(|e| RuntimeError::Download {
            message: e.to_string(),
        })?;
    if !resp.status().is_success() {
        return Err(RuntimeError::Download {
            message: format!("HTTP {} fetching llama-server", resp.status().as_u16()),
        });
    }
    let total = resp.content_length().or(Some(target.size_bytes));

    let mut file = std::fs::File::create(archive_path).map_err(io_err)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;

    while let Some(chunk) = resp.chunk().await.map_err(|e| RuntimeError::Download {
        message: e.to_string(),
    })? {
        file.write_all(&chunk).map_err(io_err)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= PROGRESS_EMIT_STEP {
            last_emit = downloaded;
            let _ = on_progress.send(BinaryDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: total,
                phase: "downloading".to_string(),
            });
        }
    }
    file.flush().map_err(io_err)?;

    let _ = on_progress.send(BinaryDownloadProgress {
        downloaded_bytes: downloaded,
        total_bytes: total,
        phase: "verifying".to_string(),
    });

    Ok(hex::encode(hasher.finalize()))
}

// Keep the server executable and every shared library the archive ships
// (versioned .so/.dylib/.dll, including llama.cpp's per-CPU-microarchitecture
// backend variants that ggml dlopens at runtime — we can't know in advance
// which one the target machine needs). Drop every other bundled CLI tool
// (llama-cli, llama-bench, llama-quantize, …) — we only run the server. This
// is deliberately permissive rather than an exact per-file allowlist: an
// allowlist would silently break if a future pinned-version bump renames an
// internal dependency DLL.
fn is_wanted_entry(file_name: &str) -> bool {
    file_name == runtime::server_binary_name()
        || file_name.contains(".so")
        || file_name.ends_with(".dylib")
        || file_name.ends_with(".dll")
}

fn extract(archive_path: &Path, dest: &Path, target: &RuntimeBinaryTarget) -> Result<(), RuntimeError> {
    match target.archive {
        ArchiveKind::TarGz => extract_tar_gz(archive_path, dest, target.strip_prefix),
        ArchiveKind::Zip => extract_zip(archive_path, dest),
    }
}

fn extract_tar_gz(
    archive_path: &Path,
    dest: &Path,
    strip_prefix: Option<&str>,
) -> Result<(), RuntimeError> {
    let file = std::fs::File::open(archive_path).map_err(io_err)?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(io_err)? {
        let mut entry = entry.map_err(io_err)?;
        let path: PathBuf = entry.path().map_err(io_err)?.into_owned();
        let rel: PathBuf = match strip_prefix {
            Some(p) => match path.strip_prefix(p) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            },
            None => path,
        };
        let Some(file_name) = rel.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_wanted_entry(file_name) {
            continue;
        }
        let out_path = dest.join(file_name);
        entry.unpack(&out_path).map_err(io_err)?;
    }
    Ok(())
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), RuntimeError> {
    let file = std::fs::File::open(archive_path).map_err(io_err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| RuntimeError::Verify {
        message: format!("bad llama-server archive: {e}"),
    })?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| RuntimeError::Verify {
            message: e.to_string(),
        })?;
        let Some(file_name) = Path::new(entry.name())
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !is_wanted_entry(&file_name) {
            continue;
        }
        let out_path = dest.join(&file_name);
        let mut out = std::fs::File::create(&out_path).map_err(io_err)?;
        std::io::copy(&mut entry, &mut out).map_err(io_err)?;
    }
    Ok(())
}

/// Single-flight guard around `install`, mirroring commands::model_download.
pub async fn download(
    app: &AppHandle,
    state: &ManagedState,
    on_progress: Channel<BinaryDownloadProgress>,
) -> Result<(), RuntimeError> {
    if state.downloading_binary.swap(true, Ordering::SeqCst) {
        return Err(RuntimeError::Download {
            message: "a llama-server download is already in progress".to_string(),
        });
    }
    let result = install(app, state, &on_progress).await;
    state.downloading_binary.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_ok_needs_four_x_headroom() {
        assert!(disk_ok(4000, 1000));
        assert!(!disk_ok(3999, 1000));
    }

    #[test]
    fn wanted_entries_keep_server_and_libs_drop_other_tools() {
        assert!(is_wanted_entry(runtime::server_binary_name()));
        assert!(is_wanted_entry("libggml-base.so.0"));
        assert!(is_wanted_entry("libggml-cpu-skylakex.so"));
        assert!(is_wanted_entry("libllama-server-impl.so"));
        assert!(is_wanted_entry("ggml-cpu-alderlake.dll"));
        assert!(is_wanted_entry("libmtmd.0.dylib"));
        assert!(!is_wanted_entry("llama-cli"));
        assert!(!is_wanted_entry("llama-bench.exe"));
        assert!(!is_wanted_entry("LICENSE"));
    }
}
