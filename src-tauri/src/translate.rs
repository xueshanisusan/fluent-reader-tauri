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
use serde::Serialize;
use std::time::Duration;
use tauri::ipc::Channel;

// One finished segment (its position in the input list + its translation),
// streamed so the frontend can drop each block into place as it's done.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSegment {
    pub index: usize,
    pub text: String,
}

// Streamed to the frontend after each batch: a done/total count (for the bar)
// plus the batch's finished segments (for incremental in-place display).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProgress {
    pub done: usize,
    pub total: usize,
    pub items: Vec<TranslateSegment>,
}

// Local CPU inference can be slow on a long batch; give a generous per-request
// timeout so a legitimately slow translation doesn't get cut off.
const TIMEOUT: Duration = Duration::from_secs(300);
// Max characters of source text per chat request. Kept modest: smaller batches
// make a small model far less likely to drop or echo a line, at the cost of
// more requests. Sized well under the model's context window.
const CHAR_BUDGET: usize = 600;
// Hard cap on batches so a pathologically long article can't run for minutes.
// Segments beyond this keep their original text.
const MAX_BATCHES: usize = 40;
// Ceiling on single-segment retries per call (echo-detected + count-mismatch
// combined). Without it, an article that's already in the target language — or a
// model that echoes everything — would fire one extra serial request per
// segment. Beyond the budget we keep the original text.
const RETRY_BUDGET: usize = 30;
// Near-greedy for the first pass (deterministic-ish, faithful); a touch hotter
// on retry to break an echo/passthrough lock-in.
const PRIMARY_TEMP: f32 = 0.1;
const RETRY_TEMP: f32 = 0.3;
// Word-overlap at or above this (after normalization) counts as "not really
// translated" — near-verbatim echo. Conservative to avoid flagging cognate
// language pairs where a real translation legitimately shares some tokens.
const ECHO_SIMILARITY: f64 = 0.9;

fn build_client() -> Result<Client, TranslationError> {
    Client::builder()
        .timeout(TIMEOUT)
        // Translation endpoints are local (a managed sidecar or a self-hosted
        // server). A system/env proxy (e.g. a loopback Clash on 127.0.0.1:7890)
        // must NOT intercept these — it can't route to the sidecar's port and
        // the request fails with a generic "error sending request".
        .no_proxy()
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

// Normalize for echo comparison: collapse whitespace + lowercase.
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

// Set-based word overlap (Jaccard). Order-insensitive, so a reordered echo still
// scores high.
fn word_jaccard(a: &str, b: &str) -> f64 {
    use std::collections::HashSet;
    let aw: HashSet<&str> = a.split_whitespace().collect();
    let bw: HashSet<&str> = b.split_whitespace().collect();
    let union = aw.union(&bw).count();
    if union == 0 {
        return 1.0;
    }
    aw.intersection(&bw).count() as f64 / union as f64
}

/// Heuristic: did the model hand back the source essentially untranslated
/// (echo / passthrough)? Language-agnostic — a real translation replaces most
/// word tokens, so we only flag near-verbatim output. Exempts things that are
/// SUPPOSED to survive unchanged: URLs, pure numbers/punctuation, all-caps /
/// no-lowercase lines (acronyms, proper nouns), and very short strings.
///
/// Assumes the target language differs from the source. If a user points a
/// translation at same-language text, every segment looks echoed and gets one
/// (budget-capped) wasted retry — output stays correct, just extra work.
/// `source` must be the string actually sent to the model (whitespace-folded).
fn looks_untranslated(source: &str, translation: &str) -> bool {
    let s = source.trim();
    let t = translation.trim();
    if t.is_empty() || s.len() < 10 {
        return false;
    }
    let low = s.to_ascii_lowercase();
    if low.starts_with("http://") || low.starts_with("https://") || low.starts_with("www.") {
        return false;
    }
    if s.chars().all(|c| c.is_numeric() || c.is_ascii_punctuation() || c.is_whitespace()) {
        return false;
    }
    // No lowercase letter at all → acronym / proper-noun-ish; legitimately kept.
    if !s.chars().any(|c| c.is_lowercase()) {
        return false;
    }
    let ns = normalize(s);
    let nt = normalize(t);
    ns == nt || word_jaccard(&ns, &nt) >= ECHO_SIMILARITY
}

fn build_body(model: &str, target_lang: &str, segs: &[String], temperature: f32) -> String {
    let numbered = segs
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!(
        "You are a professional translation engine. Translate each numbered line into {0}. \
         Output ONLY the translations as the same numbered lines, in the same order, one per \
         line. Translate EVERY line fully into {0} — never leave a line in the original \
         language. Do NOT localize or substitute brand names, product names, company names, \
         apps, or other proper nouns; keep them verbatim (e.g. keep 'WhatsApp' as 'WhatsApp'). \
         Keep numbers, URLs, and inline markup as-is. Preserve any <gN>…</gN> and <xN/> \
         placeholder tags exactly, keeping them wrapped around the same words after \
         translation. Do not add commentary, notes, or the original text.",
        target_lang
    );
    // Only standard OpenAI sampling fields go in the body so a strict
    // OpenAI-compatible endpoint can't 400 on an unknown param. Managed-server
    // tuning (repeat penalty, top-k) is set via the llama-server CLI in
    // runtime.rs instead.
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": numbered }
        ],
        "temperature": temperature,
        "top_p": 0.95,
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
    temperature: f32,
) -> Result<Vec<String>, TranslationError> {
    let payload = build_body(model, target_lang, segs, temperature);
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

// Retry one segment at a hotter temperature. Ok(Some) = a usable retry;
// Ok(None) = content failure (keep original); Err(Network) bubbles to the caller.
async fn retry_one(
    client: &Client,
    url: &str,
    model: &str,
    target_lang: &str,
    seg: &str,
) -> Result<Option<String>, TranslationError> {
    match translate_batch(client, url, model, target_lang, &[seg.to_string()], RETRY_TEMP).await {
        Ok(v) => Ok(v.into_iter().next()),
        Err(e) if matches!(e, TranslationError::Network { .. }) => Err(e),
        Err(_) => Ok(None),
    }
}

// Core translation loop. `on_batch(done)` is called with the running count of
// finished segments after each batch, for progress reporting. Assumes inputs are
// already validated non-empty.
async fn run_translation(
    client: &Client,
    url: &str,
    model: &str,
    target_lang: &str,
    texts: &[String],
    // Called after each batch (incl. its retries) with the cumulative done count
    // and that batch's finished (global index, translation) pairs.
    mut on_batch: impl FnMut(usize, &[(usize, String)]),
) -> Result<Vec<String>, TranslationError> {
    let folded: Vec<String> = texts.iter().map(|t| collapse_ws(t)).collect();

    // Default to the original text; batches overwrite on success, and a content
    // failure leaves the original in place (partial translation is acceptable).
    let mut result = texts.to_vec();
    // Shared ceiling across both retry paths (echo + count-mismatch) so a
    // pathological article can't fan out into N serial extra requests.
    let mut retry_left = RETRY_BUDGET;
    let mut done = 0usize;

    for batch in chunk_segments(&folded, CHAR_BUDGET).into_iter().take(MAX_BATCHES) {
        let batch_texts: Vec<String> = batch.iter().map(|&i| folded[i].clone()).collect();
        match translate_batch(client, url, model, target_lang, &batch_texts, PRIMARY_TEMP).await {
            Ok(translations) => {
                for (bi, &i) in batch.iter().enumerate() {
                    if let Some(s) = translations.get(bi) {
                        result[i] = s.clone();
                    }
                }
                // Echo pass: some segments come back as the source verbatim (the
                // line count matched, so the batch "succeeded"). Retry those once,
                // hotter; only keep the retry if it's no longer an echo.
                for &i in &batch {
                    if retry_left == 0 {
                        break;
                    }
                    if looks_untranslated(&folded[i], &result[i]) {
                        retry_left -= 1;
                        match retry_one(client, url, model, target_lang, &folded[i]).await {
                            Ok(Some(s)) if !looks_untranslated(&folded[i], &s) => result[i] = s,
                            Ok(_) => {} // still echoed or no content → keep original
                            Err(e) => return Err(e),
                        }
                    }
                }
            }
            Err(e) => {
                // Transport failure → surface it; the whole translation fails.
                if matches!(e, TranslationError::Network { .. }) {
                    return Err(e);
                }
                // Content/parse failure (e.g. line-count mismatch) → retry each
                // segment on its own; keep the original for any that still won't
                // translate.
                for &i in &batch {
                    if retry_left == 0 {
                        break;
                    }
                    retry_left -= 1;
                    match retry_one(client, url, model, target_lang, &folded[i]).await {
                        Ok(Some(s)) => result[i] = s,
                        Ok(None) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
        }
        done += batch.len();
        // Snapshot this batch's final translations (after any echo/content
        // retries) for the incremental stream.
        let items: Vec<(usize, String)> =
            batch.iter().map(|&i| (i, result[i].clone())).collect();
        on_batch(done, &items);
    }

    Ok(result)
}

#[tauri::command]
pub async fn translate_segments(
    endpoint: String,
    model: String,
    target_lang: String,
    texts: Vec<String>,
    on_progress: Channel<TranslateProgress>,
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

    let client = build_client()?;
    let url = chat_url(&endpoint);
    let total = texts.len();

    let out = run_translation(&client, &url, &model, &target_lang, &texts, |done, items| {
        let _ = on_progress.send(TranslateProgress {
            done: done.min(total),
            total,
            items: items
                .iter()
                .map(|(index, text)| TranslateSegment {
                    index: *index,
                    text: text.clone(),
                })
                .collect(),
        });
    })
    .await?;

    // Ensure the bar reaches 100% even if MAX_BATCHES capped the tail.
    let _ = on_progress.send(TranslateProgress {
        done: total,
        total,
        items: Vec::new(),
    });
    Ok(out)
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

    #[test]
    fn echo_verbatim_is_untranslated() {
        let s = "The Federal Reserve raised interest rates today.";
        assert!(looks_untranslated(s, s));
        // Trailing/again-normalized whitespace still counts as an echo.
        assert!(looks_untranslated(s, "  The Federal   Reserve raised interest rates today. "));
    }

    #[test]
    fn real_translation_is_not_untranslated() {
        assert!(!looks_untranslated(
            "The Federal Reserve raised interest rates today.",
            "美联储今天上调了利率。"
        ));
    }

    #[test]
    fn reordered_near_verbatim_is_untranslated() {
        // Same words, shuffled → Jaccard 1.0 → flagged as an echo.
        assert!(looks_untranslated(
            "alpha beta gamma delta epsilon zeta eta theta",
            "beta alpha gamma epsilon delta theta zeta eta"
        ));
    }

    #[test]
    fn exemptions_are_not_untranslated() {
        // URL, pure digits/punct, all-caps proper nouns, and short strings are
        // supposed to survive translation unchanged.
        assert!(!looks_untranslated(
            "https://www.example.com/a/very/long/path",
            "https://www.example.com/a/very/long/path"
        ));
        assert!(!looks_untranslated("12345, 67890 (000)", "12345, 67890 (000)"));
        assert!(!looks_untranslated("NASA SPACEX BOEING LOCKHEED", "NASA SPACEX BOEING LOCKHEED"));
        assert!(!looks_untranslated("Breaking", "Breaking")); // < 10 chars
    }

    #[test]
    fn partial_overlap_is_not_untranslated() {
        // A real translation that keeps a couple of proper nouns is well below
        // the echo threshold.
        assert!(!looks_untranslated(
            "I use npm and git every single day for my work",
            "我每天都用 npm 和 git 工作"
        ));
    }

    #[tokio::test]
    async fn echoed_segment_is_retried_and_replaced() {
        use httpmock::prelude::*;
        let server = MockServer::start_async().await;
        let source = "The Federal Reserve raised interest rates today.";

        // First pass (temperature 0.1) echoes the source back untranslated.
        let echo = server
            .mock_async(|when, then| {
                when.method(POST).path("/chat/completions").body_contains("\"temperature\":0.1");
                then.status(200).header("content-type", "application/json").body(format!(
                    "{{\"choices\":[{{\"message\":{{\"content\":{}}}}}]}}",
                    serde_json::to_string(source).unwrap()
                ));
            })
            .await;
        // Retry (temperature 0.3) returns a real translation.
        let retry = server
            .mock_async(|when, then| {
                when.method(POST).path("/chat/completions").body_contains("\"temperature\":0.3");
                then.status(200).header("content-type", "application/json").body(
                    "{\"choices\":[{\"message\":{\"content\":\"美联储今天上调了利率。\"}}]}",
                );
            })
            .await;

        let client = build_client().unwrap();
        let url = chat_url(&server.url(""));
        let mut progress: Vec<usize> = Vec::new();
        let mut streamed: Vec<(usize, String)> = Vec::new();
        let out = run_translation(
            &client,
            &url,
            "m",
            "简体中文",
            &[source.to_string()],
            |d, items| {
                progress.push(d);
                streamed.extend(items.iter().cloned());
            },
        )
        .await
        .expect("ok");

        assert_eq!(out, vec!["美联储今天上调了利率。".to_string()]);
        assert_eq!(progress, vec![1]); // one batch of one segment → done=1
        // The finished segment is streamed with its global index + final text.
        assert_eq!(streamed, vec![(0, "美联储今天上调了利率。".to_string())]);

        echo.assert_async().await;
        retry.assert_async().await;
    }
}
