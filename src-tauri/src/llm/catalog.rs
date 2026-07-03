// Curated, vetted models the app knows how to download and run. 2a ships one
// (the default); 2b adds a picker over the rest. Kept tiny and static so the
// "recommended model" button has a known-good target with a verified license.
//
// sha256 is Option: when Some, the download is integrity-checked against it;
// when None, verification is skipped (the computed hash is still recorded in the
// manifest). Fill it in once a download has been confirmed.
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedModel {
    pub id: &'static str,
    pub name: &'static str,
    // Direct-download URL to the raw .gguf (Hugging Face "resolve" link).
    pub url: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
    pub quant: &'static str,
    pub license: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<&'static str>,
}

// The model the "download recommended model" button pulls in 2a. Qwen2.5-1.5B
// is small but a reliable translator; MiniCPM5-1B was tried first and dropped —
// it echoed the source untranslated on roughly half of real-world sentences.
pub const DEFAULT_MODEL_ID: &str = "qwen2.5-1.5b-instruct-q4km";

pub const CATALOG: &[CuratedModel] = &[CuratedModel {
    id: "qwen2.5-1.5b-instruct-q4km",
    name: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    size_bytes: 1_117_320_736,
    quant: "Q4_K_M",
    license: "Apache-2.0",
    sha256: None,
}];

pub fn lookup(id: &str) -> Option<&'static CuratedModel> {
    CATALOG.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_is_in_catalog() {
        assert!(lookup(DEFAULT_MODEL_ID).is_some());
    }

    #[test]
    fn lookup_unknown_is_none() {
        assert!(lookup("does-not-exist").is_none());
    }
}
