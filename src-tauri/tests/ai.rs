use folio::ai::{complete, endpoint, AiRequest};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;

fn request(url: &str) -> AiRequest {
    serde_json::from_value(json!({
        "endpoint_url": url, "api_key": "secret-test-key", "model": "my-model",
        "action": "ask", "text": "Page two says hello.", "question": "What does it say?"
    }))
    .unwrap()
}

#[test]
fn endpoint_accepts_base_or_complete_url_without_duplicating_path() {
    for (input, expected) in [
        (
            "https://example.com/v1/",
            "https://example.com/v1/chat/completions",
        ),
        (
            "https://example.com/api/chat/completions",
            "https://example.com/api/chat/completions",
        ),
        (
            "http://localhost:11434/v1",
            "http://localhost:11434/v1/chat/completions",
        ),
        (
            "http://[::1]:8080/v1",
            "http://[::1]:8080/v1/chat/completions",
        ),
    ] {
        assert_eq!(endpoint(input).unwrap().as_str(), expected);
    }
}

#[test]
fn endpoint_rejects_unsafe_or_ambiguous_addresses() {
    for url in [
        "not a url",
        "file:///tmp/test",
        "http://example.com/v1",
        "https://user:password@example.com/v1",
        "https://example.com/v1?key=secret",
        "https://example.com/v1#fragment",
    ] {
        assert!(endpoint(url).is_err(), "accepted {url}");
    }
}

// A real local server checks the Rust transport, not a replacement HTTP client.
fn server(status: &str, body: Value) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let body = body.to_string();
    let status = status.to_owned();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (url, handle)
}

#[tokio::test]
async fn sends_selected_context_question_model_and_bearer_key() {
    let (url, handle) = server(
        "200 OK",
        json!({"choices":[{"message":{"content":"It says hello."}}]}),
    );
    assert_eq!(complete(request(&url)).await.unwrap(), "It says hello.");
    let raw = handle.join().unwrap();
    assert!(raw.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(raw
        .to_lowercase()
        .contains("authorization: bearer secret-test-key"));
    let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["model"], "my-model");
    assert_eq!(body["stream"], false);
    let user = body["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("Page two says hello."));
    assert!(user.contains("What does it say?"));
}

#[tokio::test]
async fn summary_works_without_question_or_local_api_key() {
    let (url, handle) = server(
        "200 OK",
        json!({"choices":[{"message":{"content":"A summary."}}]}),
    );
    let mut input = request(&url);
    input.action = "summarize".into();
    input.question.clear();
    input.api_key.clear();
    assert_eq!(complete(input).await.unwrap(), "A summary.");
    let raw = handle.join().unwrap();
    assert!(!raw.to_lowercase().contains("authorization:"));
    assert!(raw.contains("Summarize"));
}

#[tokio::test]
async fn rejects_empty_question_context_model_and_oversized_input_before_sending() {
    for field in ["text", "question", "model", "action"] {
        let mut input = serde_json::to_value(request("http://127.0.0.1:1/v1")).unwrap();
        input[field] = json!("");
        assert!(complete(serde_json::from_value(input).unwrap())
            .await
            .is_err());
    }
    let mut input = request("http://127.0.0.1:1/v1");
    input.text = "x".repeat(120_001);
    assert!(complete(input).await.unwrap_err().contains("120000"));
}

#[tokio::test]
async fn reports_http_and_malformed_responses_without_exposing_secrets() {
    for (status, body, expected) in [
        (
            "401 Unauthorized",
            json!({"error":{"message":"secret-test-key"}}),
            "401",
        ),
        ("200 OK", json!({"choices": []}), "text answer"),
        (
            "200 OK",
            json!({"choices":[{"message":{"content":null}}]}),
            "text answer",
        ),
        ("302 Found", json!({}), "302"),
    ] {
        let (url, handle) = server(status, body);
        let error = complete(request(&url)).await.unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("secret-test-key"));
        handle.join().unwrap();
    }
}
