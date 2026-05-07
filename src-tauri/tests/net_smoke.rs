use base64::Engine;
use fluent_reader_lib::net::{self, FetchRequest};
use httpmock::prelude::*;
use std::collections::HashMap;
use std::time::Duration;

fn b64_decode(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).expect("base64 decode")
}

fn header(resp: &net::FetchResponse, key: &str) -> Option<String> {
    resp.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
}

#[tokio::test]
async fn fetch_200_with_headers_and_body() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/feed.xml");
            then.status(200)
                .header("content-type", "application/rss+xml; charset=utf-8")
                .header("etag", "\"abc123\"")
                .body("<rss><channel>hello</channel></rss>");
        })
        .await;

    let resp = net::fetch(FetchRequest {
        url: server.url("/feed.xml"),
        method: None,
        headers: None,
        timeout_ms: None,
    })
    .await
    .expect("fetch ok");

    assert_eq!(resp.status, 200);
    assert_eq!(header(&resp, "etag").as_deref(), Some("\"abc123\""));
    assert!(header(&resp, "content-type")
        .map(|v| v.contains("application/rss+xml"))
        .unwrap_or(false));
    assert_eq!(resp.final_url, server.url("/feed.xml"));
    assert_eq!(b64_decode(&resp.body_base64), b"<rss><channel>hello</channel></rss>");
    mock.assert_async().await;
}

#[tokio::test]
async fn fetch_follows_redirect_chain() {
    let server = MockServer::start_async().await;
    let _r1 = server
        .mock_async(|when, then| {
            when.method(GET).path("/old");
            then.status(301).header("location", "/middle");
        })
        .await;
    let _r2 = server
        .mock_async(|when, then| {
            when.method(GET).path("/middle");
            then.status(302).header("location", "/new");
        })
        .await;
    let _final = server
        .mock_async(|when, then| {
            when.method(GET).path("/new");
            then.status(200).body("final");
        })
        .await;

    let resp = net::fetch(FetchRequest {
        url: server.url("/old"),
        method: None,
        headers: None,
        timeout_ms: None,
    })
    .await
    .expect("fetch ok");

    assert_eq!(resp.status, 200);
    assert!(resp.final_url.ends_with("/new"));
    assert_eq!(b64_decode(&resp.body_base64), b"final");
}

#[tokio::test]
async fn fetch_respects_timeout() {
    let server = MockServer::start_async().await;
    let _mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/slow");
            then.status(200).delay(Duration::from_secs(3));
        })
        .await;

    let result = net::fetch(FetchRequest {
        url: server.url("/slow"),
        method: None,
        headers: None,
        timeout_ms: Some(200),
    })
    .await;

    assert!(result.is_err(), "200ms timeout should reject 3s response");
}

#[tokio::test]
async fn fetch_passes_custom_headers_and_method() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api")
                .header("authorization", "Bearer xyz")
                .header("user-agent", "custom-ua/1.0");
            then.status(204);
        })
        .await;

    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), "Bearer xyz".to_string());
    headers.insert("User-Agent".to_string(), "custom-ua/1.0".to_string());

    let resp = net::fetch(FetchRequest {
        url: server.url("/api"),
        method: Some("POST".into()),
        headers: Some(headers),
        timeout_ms: None,
    })
    .await
    .expect("fetch ok");

    assert_eq!(resp.status, 204);
    assert!(resp.body_base64.is_empty());
    mock.assert_async().await;
}

#[tokio::test]
async fn fetch_surfaces_4xx_status_without_error() {
    let server = MockServer::start_async().await;
    let _mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/missing");
            then.status(404).body("not here");
        })
        .await;

    let resp = net::fetch(FetchRequest {
        url: server.url("/missing"),
        method: None,
        headers: None,
        timeout_ms: None,
    })
    .await
    .expect("4xx is not a transport error");

    assert_eq!(resp.status, 404);
    assert_eq!(b64_decode(&resp.body_base64), b"not here");
}
