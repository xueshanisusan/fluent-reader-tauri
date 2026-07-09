// Pinned llama.cpp CPU-only `server` builds, one per (OS, arch) we support.
// Like catalog.rs for GGUFs: a hand-verified URL + sha256, bumped deliberately
// by a reviewed PR rather than resolved from "latest" at runtime — llama.cpp's
// release asset names have shifted across versions, and unauthenticated GitHub
// API calls are rate-limited per IP. Pinning avoids both. GPU backends (CUDA /
// Vulkan / ROCm) are a possible follow-up; CPU-only covers every platform with
// one build each and needs no hardware detection.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBinaryTarget {
    pub id: &'static str,
    pub url: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    #[serde(skip)]
    pub archive: ArchiveKind,
    // The top-level directory archive entries live under, stripped on extract.
    // `None` for the Windows zip, whose entries sit at the archive root.
    #[serde(skip)]
    pub strip_prefix: Option<&'static str>,
}

// The llama.cpp release tag every URL below points at. Bump this (and the
// URLs/hashes together) in one deliberate PR when upgrading.
pub const LLAMA_CPP_VERSION: &str = "b9925";

pub const TARGETS: &[RuntimeBinaryTarget] = &[
    RuntimeBinaryTarget {
        id: "linux-x86_64",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b9925/llama-b9925-bin-ubuntu-x64.tar.gz",
        size_bytes: 15_898_134,
        sha256: "4b36b976ba85a86371cc1a72ae3375441da03210085a7288fd16769c4c2923f4",
        archive: ArchiveKind::TarGz,
        strip_prefix: Some("llama-b9925"),
    },
    RuntimeBinaryTarget {
        id: "macos-aarch64",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b9925/llama-b9925-bin-macos-arm64.tar.gz",
        size_bytes: 11_146_856,
        sha256: "ecdf67730dfa219aeef1a6f93a283d8972fdb47b87c3229547fb267c4fa75a70",
        archive: ArchiveKind::TarGz,
        strip_prefix: Some("llama-b9925"),
    },
    RuntimeBinaryTarget {
        id: "macos-x86_64",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b9925/llama-b9925-bin-macos-x64.tar.gz",
        size_bytes: 11_461_255,
        sha256: "2b426e2171912b6847647c42ca3a4dbe1ff0e31ce8a89238efc0efa3fd98bfac",
        archive: ArchiveKind::TarGz,
        strip_prefix: Some("llama-b9925"),
    },
    RuntimeBinaryTarget {
        id: "windows-x86_64",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b9925/llama-b9925-bin-win-cpu-x64.zip",
        size_bytes: 17_507_535,
        sha256: "b842abce2c9b9fc0d7708823281fb179804aba687a34d9329156216618609af3",
        archive: ArchiveKind::Zip,
        strip_prefix: None,
    },
];

/// The pinned target for the machine currently running this process, if we
/// ship one. `None` on platforms without a pin yet (e.g. Linux/Windows arm64)
/// — surfaced to the UI as "not supported on your platform" rather than a
/// broken download attempt.
pub fn current_target() -> Option<&'static RuntimeBinaryTarget> {
    let id = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => return None,
    };
    TARGETS.iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_target_has_a_sha256_and_positive_size() {
        for t in TARGETS {
            assert_eq!(t.sha256.len(), 64, "{} sha256 should be 64 hex chars", t.id);
            assert!(t.size_bytes > 0, "{} size should be positive", t.id);
            assert!(t.url.contains(LLAMA_CPP_VERSION), "{} url should reference the pinned version", t.id);
        }
    }

    #[test]
    fn target_ids_are_unique() {
        let mut ids: Vec<&str> = TARGETS.iter().map(|t| t.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), TARGETS.len());
    }
}
