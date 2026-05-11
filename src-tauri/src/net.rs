use base64::Engine;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub final_url: String,
    pub body_base64: String,
}

#[derive(thiserror::Error, Debug)]
pub enum NetError {
    #[error("invalid method: {0}")]
    InvalidMethod(String),
    #[error("reqwest: {0}")]
    Reqwest(#[from] reqwest::Error),
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

pub async fn fetch(req: FetchRequest) -> Result<FetchResponse, NetError> {
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let method = match req.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        "HEAD" => Method::HEAD,
        "PATCH" => Method::PATCH,
        other => return Err(NetError::InvalidMethod(other.to_string())),
    };

    let client = Client::builder()
        .timeout(timeout)
        .gzip(true)
        .brotli(true)
        .user_agent(concat!("fluent-reader-tauri/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let mut builder = client.request(method, &req.url);
    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }
    let resp = builder.send().await?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let mut headers_out: Vec<(String, String)> = Vec::with_capacity(resp.headers().len());
    for (name, value) in resp.headers().iter() {
        if let Ok(value_str) = value.to_str() {
            headers_out.push((name.as_str().to_string(), value_str.to_string()));
        }
    }
    let bytes = resp.bytes().await?;
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(FetchResponse {
        status,
        headers: headers_out,
        final_url,
        body_base64,
    })
}

#[tauri::command]
pub async fn net_fetch(input: FetchRequest) -> Result<FetchResponse, String> {
    fetch(input).await.map_err(|e| e.to_string())
}
