use crate::settings::PostProcessProvider;
use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: Value,
}

#[derive(Debug, Serialize)]
struct JsonSchema {
    name: String,
    strict: bool,
    schema: Value,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: String,
    json_schema: JsonSchema,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct ReasoningConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

/// Build headers for API requests based on provider type
fn build_headers(provider: &PostProcessProvider, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    // Common headers
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://github.com/jason-bartz/ghostly"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("Ghostly/1.0 (+https://github.com/jason-bartz/ghostly)"),
    );
    headers.insert("X-Title", HeaderValue::from_static("Ghostly"));

    // Provider-specific auth headers
    if !api_key.is_empty() {
        if provider.id == "anthropic" {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|e| format!("Invalid API key header value: {}", e))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| format!("Invalid authorization header value: {}", e))?,
            );
        }
    }

    Ok(headers)
}

/// Maximum time to wait for a single LLM HTTP request. Prevents the UI from
/// hanging indefinitely when a provider endpoint is unresponsive.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Total attempts (initial + retries) for transient LLM failures.
const MAX_ATTEMPTS: u32 = 3;

/// Base backoff delay; doubles each retry (1s, 2s).
const BACKOFF_BASE: std::time::Duration = std::time::Duration::from_secs(1);

/// Returns true for HTTP statuses that may succeed on retry: rate limiting
/// (429) and transient server errors (5xx).
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

/// Create an HTTP client with provider-specific headers
fn create_client(provider: &PostProcessProvider, api_key: &str) -> Result<reqwest::Client, String> {
    let headers = build_headers(provider, api_key)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Send a chat completion request to an OpenAI-compatible API
/// Returns Ok(Some(content)) on success, Ok(None) if response has no content,
/// or Err on actual errors (HTTP, parsing, etc.)
pub async fn send_chat_completion(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    prompt: String,
    reasoning_effort: Option<String>,
    reasoning: Option<ReasoningConfig>,
) -> Result<Option<String>, String> {
    send_chat_completion_with_schema(
        provider,
        api_key,
        model,
        prompt,
        None,
        None,
        reasoning_effort,
        reasoning,
    )
    .await
}

/// Send a chat completion request with structured output support
/// When json_schema is provided, uses structured outputs mode
/// system_prompt is used as the system message when provided
/// reasoning_effort sets the OpenAI-style top-level field (e.g., "none", "low", "medium", "high")
/// reasoning sets the OpenRouter-style nested object (effort + exclude)
pub async fn send_chat_completion_with_schema(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    user_content: String,
    system_prompt: Option<String>,
    json_schema: Option<Value>,
    reasoning_effort: Option<String>,
    reasoning: Option<ReasoningConfig>,
) -> Result<Option<String>, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    debug!("Sending chat completion request to: {}", url);

    let client = create_client(provider, &api_key)?;

    // Build messages vector
    let mut messages = Vec::new();

    // Add system prompt if provided
    if let Some(system) = system_prompt {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: Value::String(system),
        });
    }

    // Add user message
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: Value::String(user_content),
    });

    // Build response_format if schema is provided
    let response_format = json_schema.map(|schema| ResponseFormat {
        format_type: "json_schema".to_string(),
        json_schema: JsonSchema {
            name: "transcription_output".to_string(),
            strict: true,
            schema,
        },
    });

    let request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        response_format,
        reasoning_effort,
        reasoning,
        stream: None,
    };

    // Retry transient failures (429 rate limits, 5xx server errors, network
    // errors) with exponential backoff. Non-retryable errors (4xx, bad request)
    // abort immediately.
    let mut last_error: Option<String> = None;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            let delay = BACKOFF_BASE * (1u32 << (attempt - 1));
            debug!(
                "Retrying LLM request in {:?} (attempt {}/{})",
                delay,
                attempt + 1,
                MAX_ATTEMPTS
            );
            tokio::time::sleep(delay).await;
        }

        let send_result = client.post(&url).json(&request_body).send().await;

        match send_result {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let completion: ChatCompletionResponse = response
                        .json()
                        .await
                        .map_err(|e| format!("Failed to parse API response: {}", e))?;
                    return Ok(completion
                        .choices
                        .first()
                        .and_then(|choice| choice.message.content.clone()));
                }

                let error_text = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "Failed to read error response".to_string());
                let msg = format!("API request failed with status {}: {}", status, error_text);

                if is_retryable_status(status) && attempt + 1 < MAX_ATTEMPTS {
                    last_error = Some(msg);
                    continue;
                }
                return Err(msg);
            }
            Err(e) => {
                let msg = format!("HTTP request failed: {}", e);
                // Retry network-level failures (including timeouts). reqwest
                // doesn't expose a clean "transient" predicate, so retry all
                // send errors within the attempt budget.
                if attempt + 1 < MAX_ATTEMPTS {
                    last_error = Some(msg);
                    continue;
                }
                return Err(msg);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "LLM request failed with no error detail".to_string()))
}

/// Send a chat completion request that includes a single image attached to the
/// user message. Uses the OpenAI-compatible multipart content format
/// (`[{type: text}, {type: image_url, image_url: {url: data:…}}]`).
/// Works for OpenAI, OpenRouter, and any OpenAI-compat gateway that supports
/// vision. Anthropic's native `/messages` endpoint uses a different shape; we
/// rely on the provider exposing an OpenAI-compat vision endpoint.
pub async fn send_chat_completion_with_image(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    user_text: String,
    image_png: &[u8],
    system_prompt: Option<String>,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    debug!(
        "Sending vision chat completion to: {} ({} bytes image)",
        url,
        image_png.len()
    );

    let client = create_client(provider, &api_key)?;

    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(image_png));

    let user_content = serde_json::json!([
        { "type": "text", "text": user_text },
        { "type": "image_url", "image_url": { "url": data_url } },
    ]);

    let mut messages = Vec::new();
    if let Some(system) = system_prompt {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: Value::String(system),
        });
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    let request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        response_format: None,
        reasoning_effort: None,
        reasoning: None,
        stream: None,
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "Vision API request failed with status {}: {}",
            status, error_text
        ));
    }

    let completion: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    Ok(completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone()))
}

/// Fetch available models from an OpenAI-compatible API
/// Returns a list of model IDs
pub async fn fetch_models(
    provider: &PostProcessProvider,
    api_key: String,
) -> Result<Vec<String>, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/models", base_url);

    debug!("Fetching models from: {}", url);

    let client = create_client(provider, &api_key)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!(
            "Model list request failed ({}): {}",
            status, error_text
        ));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = Vec::new();

    // Handle OpenAI format: { data: [ { id: "..." }, ... ] }
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for entry in data {
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            } else if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    // Handle array format: [ "model1", "model2", ... ]
    else if let Some(array) = parsed.as_array() {
        for entry in array {
            if let Some(model) = entry.as_str() {
                models.push(model.to_string());
            }
        }
    }

    Ok(models)
}

/// Stream a chat completion from an OpenAI-compatible endpoint. Calls
/// `on_delta(chunk)` for every text fragment as it arrives and returns the
/// full accumulated text when the stream ends. Returns `Err` on network
/// failures, HTTP errors, or when `cancel` is signaled.
///
/// This path intentionally uses legacy (unstructured) chat completion — no
/// JSON schema — because partial SSE chunks don't parse as valid JSON and we
/// want to show clean token text in the overlay. The prompt itself tells the
/// model to "return only the cleaned text," which works reliably without the
/// structured-output guardrail for the providers we stream to.
///
/// Only OpenAI-format SSE is supported (OpenAI, OpenRouter, Groq, Z.AI,
/// Cerebras, Ollama-style custom servers). Anthropic's `/v1/messages` uses a
/// different event schema and is not streamed in v1.
pub async fn send_chat_completion_stream<F>(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    prompt: String,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    mut on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    use futures_util::StreamExt;
    use std::sync::atomic::Ordering;

    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    debug!("Opening streaming chat completion to: {}", url);

    let client = create_client(provider, &api_key)?;

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: Value::String(prompt),
    }];

    // Match reasoning handling from the non-streaming path so reasoning tokens
    // don't leak into the streamed text for providers that expose them.
    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    let request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        response_format: None,
        reasoning_effort,
        reasoning,
        stream: Some(true),
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "API request failed with status {}: {}",
            status, error_text
        ));
    }

    let mut byte_stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut buffer = String::new();

    'stream: while let Some(chunk) = byte_stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        let bytes = chunk.map_err(|e| format!("stream read failed: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines. SSE events end with "\n\n"; we handle each
        // line independently and ignore blank lines.
        loop {
            let Some(newline_pos) = buffer.find('\n') else {
                break;
            };
            let line = buffer[..newline_pos]
                .trim_end_matches('\r')
                .to_string();
            buffer.drain(..=newline_pos);

            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                break 'stream;
            }

            // Each SSE data payload is a JSON object with `choices[0].delta.content`.
            // Missing fields are tolerated — some providers emit role-only deltas
            // at the start or usage-only chunks at the end.
            let Ok(val) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(content) = val
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
            {
                if !content.is_empty() {
                    accumulated.push_str(content);
                    on_delta(content);
                }
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }

    Ok(accumulated)
}
