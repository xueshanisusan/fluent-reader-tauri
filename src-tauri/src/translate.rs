// Article translation via an OpenAI-compatible chat endpoint (Ollama first).
// The frontend extracts visible text nodes and sends them here as a flat list;
// we batch them, prompt the model to translate each numbered line, parse the
// numbered output back into the same-length list, and return it. The caller
// reinserts by index, so the returned Vec MUST match the input length/order.
//
// reqwest is built without the `json` feature (see net.rs), so request bodies
// are serialized with serde_json::to_string and responses parsed from text.
use crate::models::TranslationError;
use reqwest::Client;
use std::time::Duration;

// Local models can be slow; give a generous per-request timeout.
const TIMEOUT: Duration = Duration::from_secs(120);
// Max characters of source text per chat request (sized well under a small
// model's context window, leaving room for the prompt + the translation).
const CHAR_BUDGET: usize = 1800;
// Hard cap on batches so a pathologically long article can't run for minutes.
// Segments beyond this keep their original text.
const MAX_BATCHES: usize = 40;

fn build_client() -> Result<Client, TranslationError> {
    Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("fluent-reader-tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| TranslationError::Network {
            message: e.to_string(),
        })
}

// {endpoint}/chat/completions, tolerating a trailing slash on the base URL.
fn chat_url(endpoint: &str) -> String {
    format!("{}/chat/completions", endpoint.trim().trim_end_matches('/'))
}

// Collapse a text node's internal whitespace to a single line, so the numbered
// line protocol below stays one-segment-per-line.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Group segment indices into batches whose combined length stays under
/// `budget`. A single over-budget segment gets its own batch.
pub fn chunk_segments(texts: &[String], budget: usize) -> Vec<Vec<usize>> {
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_len = 0usize;
    for (i, t) in texts.iter().enumerate() {
        let len = t.chars().count();
        if !cur.is_empty() && cur_len + len > budget {
            batches.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur.push(i);
        cur_len += len;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

// If a line starts with a "12." / "12)" marker, return (number, rest).
fn split_marker(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &trimmed[digits.len()..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    let num: usize = digits.parse().ok()?;
    Some((num, rest.trim_start()))
}

/// Parse a model's "1. ...\n2. ..." output back into exactly `n` segments.
/// Tolerates a preamble before the first marker, blank/continuation lines, and
/// reordered numbers. Returns None if it can't recover all of 1..=n — the caller
/// then falls back (per-segment retry, ultimately keeping the original).
///
/// Special case n==1: the whole output is the single segment (a leading marker
/// is stripped), which makes the per-segment fallback robust to unnumbered
/// replies.
pub fn parse_numbered(output: &str, n: usize) -> Option<Vec<String>> {
    let trimmed = output.trim();
    if n == 0 {
        return Some(Vec::new());
    }
    if n == 1 {
        let s = match split_marker(trimmed.lines().next().unwrap_or("")) {
            Some((1, rest)) => {
                // Rebuild: first line's rest + any continuation lines.
                let mut lines = trimmed.lines();
                lines.next();
                let mut acc = rest.to_string();
                for l in lines {
                    let l = l.trim();
                    if l.is_empty() {
                        continue;
                    }
                    if !acc.is_empty() {
                        acc.push(' ');
                    }
                    acc.push_str(l);
                }
                acc
            }
            _ => trimmed.to_string(),
        };
        let s = s.trim().to_string();
        return if s.is_empty() { None } else { Some(vec![s]) };
    }

    let mut map: std::collections::BTreeMap<usize, String> = std::collections::BTreeMap::new();
    let mut cur: Option<usize> = None;
    for line in trimmed.lines() {
        if let Some((num, rest)) = split_marker(line) {
            cur = Some(num);
            let entry = map.entry(num).or_default();
            if !entry.is_empty() && !rest.is_empty() {
                entry.push(' ');
            }
            entry.push_str(rest);
        } else if let Some(k) = cur {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let entry = map.entry(k).or_default();
            if !entry.is_empty() {
                entry.push(' ');
            }
            entry.push_str(line);
        }
    }

    let mut out = Vec::with_capacity(n);
    for i in 1..=n {
        match map.get(&i) {
            Some(s) if !s.trim().is_empty() => out.push(s.trim().to_string()),
            _ => return None,
        }
    }
    Some(out)
}

fn build_body(model: &str, target_lang: &str, segs: &[String]) -> String {
    let numbered = segs
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!(
        "You are a professional translation engine. Translate each numbered line into {}. \
         Output ONLY the translations as the same numbered lines, in the same order, one per \
         line. Do not add commentary, notes, or the original text. Keep numbers, names, and \
         inline markup as-is.",
        target_lang
    );
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": numbered }
        ],
        "temperature": 0,
        "stream": false
    });
    body.to_string()
}

// Translate one batch. A transport failure (unreachable / timeout / non-2xx)
// returns Network; a parse/content failure returns Parse.
async fn translate_batch(
    client: &Client,
    url: &str,
    model: &str,
    target_lang: &str,
    segs: &[String],
) -> Result<Vec<String>, TranslationError> {
    let payload = build_body(model, target_lang, segs);
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| TranslationError::Network {
            message: e.to_string(),
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| TranslationError::Network {
        message: e.to_string(),
    })?;
    if !status.is_success() {
        let mut snippet = text.chars().take(200).collect::<String>();
        if snippet.is_empty() {
            snippet = status.to_string();
        }
        return Err(TranslationError::Network {
            message: format!("HTTP {}: {}", status.as_u16(), snippet),
        });
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| TranslationError::Parse {
        message: e.to_string(),
    })?;
    let content = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| TranslationError::Parse {
            message: "missing choices[0].message.content".to_string(),
        })?;
    parse_numbered(content, segs.len()).ok_or_else(|| TranslationError::Parse {
        message: format!("could not recover {} segments from reply", segs.len()),
    })
}

#[tauri::command]
pub async fn translate_segments(
    endpoint: String,
    model: String,
    target_lang: String,
    texts: Vec<String>,
) -> Result<Vec<String>, TranslationError> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    if endpoint.trim().is_empty() {
        return Err(TranslationError::Config {
            message: "translation endpoint is not set".to_string(),
        });
    }
    if model.trim().is_empty() {
        return Err(TranslationError::Config {
            message: "translation model is not set".to_string(),
        });
    }
    if target_lang.trim().is_empty() {
        return Err(TranslationError::Config {
            message: "set a target language in Translation settings".to_string(),
        });
    }

    let folded: Vec<String> = texts.iter().map(|t| collapse_ws(t)).collect();
    let client = build_client()?;
    let url = chat_url(&endpoint);

    // Default to the original text; batches overwrite on success, and a content
    // failure leaves the original in place (partial translation is acceptable).
    let mut result = texts.clone();

    for batch in chunk_segments(&folded, CHAR_BUDGET).into_iter().take(MAX_BATCHES) {
        let batch_texts: Vec<String> = batch.iter().map(|&i| folded[i].clone()).collect();
        match translate_batch(&client, &url, &model, &target_lang, &batch_texts).await {
            Ok(translations) => {
                for (bi, &i) in batch.iter().enumerate() {
                    if let Some(s) = translations.get(bi) {
                        result[i] = s.clone();
                    }
                }
            }
            Err(e) => {
                // Transport failure → surface it; the whole translation fails.
                if matches!(e, TranslationError::Network { .. }) {
                    return Err(e);
                }
                // Content/parse failure → retry each segment on its own; keep the
                // original for any that still won't translate.
                for &i in &batch {
                    match translate_batch(&client, &url, &model, &target_lang, &[folded[i].clone()])
                        .await
                    {
                        Ok(one) => {
                            if let Some(s) = one.into_iter().next() {
                                result[i] = s;
                            }
                        }
                        Err(e2) => {
                            if matches!(e2, TranslationError::Network { .. }) {
                                return Err(e2);
                            }
                            // keep original result[i]
                        }
                    }
                }
            }
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn chunk_segments_groups_under_budget() {
        let texts = v(&["aaaa", "bbbb", "cc", "dddddddd"]); // 4,4,2,8
        let batches = chunk_segments(&texts, 8);
        // [0,1] = 8, [2] then +8 would exceed -> [2,?]; walk it: 0(4),1(+4=8),
        // 2 would be 10>8 -> new batch [2](2), 3 would be 10>8 -> [3](8)
        assert_eq!(batches, vec![vec![0, 1], vec![2], vec![3]]);
    }

    #[test]
    fn chunk_segments_oversized_gets_own_batch() {
        let texts = v(&["xxxxxxxxxx"]); // 10 > budget 4
        assert_eq!(chunk_segments(&texts, 4), vec![vec![0]]);
        assert!(chunk_segments(&[], 4).is_empty());
    }

    #[test]
    fn parse_numbered_exact() {
        let out = "1. hola\n2. mundo\n3. adios";
        assert_eq!(parse_numbered(out, 3), Some(v(&["hola", "mundo", "adios"])));
    }

    #[test]
    fn parse_numbered_tolerates_preamble_and_blank_lines() {
        let out = "Sure, here you go:\n\n1. uno\n\n2. dos\n";
        assert_eq!(parse_numbered(out, 2), Some(v(&["uno", "dos"])));
    }

    #[test]
    fn parse_numbered_reordered() {
        let out = "2. dos\n1. uno";
        assert_eq!(parse_numbered(out, 2), Some(v(&["uno", "dos"])));
    }

    #[test]
    fn parse_numbered_missing_line_returns_none() {
        let out = "1. uno\n3. tres"; // 2 missing
        assert_eq!(parse_numbered(out, 3), None);
    }

    #[test]
    fn parse_numbered_continuation_line_joins() {
        let out = "1. first part\ncontinued\n2. second";
        assert_eq!(
            parse_numbered(out, 2),
            Some(v(&["first part continued", "second"]))
        );
    }

    #[test]
    fn parse_numbered_n1_accepts_unnumbered() {
        assert_eq!(parse_numbered("just the translation", 1), Some(v(&["just the translation"])));
        assert_eq!(parse_numbered("1. numbered too", 1), Some(v(&["numbered too"])));
        assert_eq!(parse_numbered("   ", 1), None);
    }
}
