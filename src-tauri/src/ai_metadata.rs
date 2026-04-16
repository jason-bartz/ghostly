//! AI-assisted metadata generation for history entries.
//!
//! Uses the user's existing post-process LLM provider + API key to produce a
//! short title and a small set of tags from a transcription's content. Reuses
//! the provider selection so users don't have to configure anything new — if
//! they already have Claude/OpenAI/etc. set up for refinement, this works.

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::llm_client;
use crate::settings::{AppSettings, APPLE_INTELLIGENCE_PROVIDER_ID};
use log::{debug, error, warn};
use serde::Deserialize;

const BASE_SYSTEM_PROMPT: &str = "You generate concise metadata for a voice transcription. \
Given the transcribed text, return a JSON object with two fields: \
`title` (a short, specific title, 3-7 words, no trailing punctuation) and \
`tags` (an array of tags as described below).";

/// Build the system prompt with tag instructions scoped to the user's existing
/// tag vocabulary. The AI selects from `existing_tags` only; if the user has
/// none yet, no tags are applied.
fn system_prompt(existing_tags: &[String]) -> String {
    if existing_tags.is_empty() {
        format!(
            "{} The user has no existing tags yet, so `tags` MUST be an empty array [].",
            BASE_SYSTEM_PROMPT
        )
    } else {
        let list = existing_tags
            .iter()
            .map(|t| format!("\"{}\"", t))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{} Choose 0-5 tags that apply to this transcription from this exact list: [{}]. \
Do NOT invent new tags. Only use tags verbatim from that list. \
If none of the listed tags apply, return an empty array. \
Do not alter casing, pluralization, or spacing — return tags exactly as listed.",
            BASE_SYSTEM_PROMPT, list
        )
    }
}

#[derive(Debug, Deserialize)]
struct AiMetadata {
    title: String,
    #[serde(default)]
    tags: Vec<String>,
}

pub struct GeneratedMetadata {
    pub title: String,
    pub tags: Vec<String>,
}

/// Generate a title and tags for the given transcription text. Returns `None`
/// if no provider is configured, no model is set, the transcription is empty,
/// or the LLM call fails. Callers should treat `None` as "keep existing
/// metadata" — never clobber user-set values with a failed call.
///
/// `existing_tags` is the full list of tags the user has already used. The AI
/// selects 0-5 tags from this list only — no new tags are created. If empty,
/// the AI returns no tags.
pub async fn generate(
    settings: &AppSettings,
    transcription: &str,
    existing_tags: &[String],
) -> Option<GeneratedMetadata> {
    let trimmed = transcription.trim();
    if trimmed.is_empty() {
        return None;
    }

    let system = system_prompt(existing_tags);

    let provider_id = settings.post_process_provider_id.as_str();
    let provider = settings.post_process_provider(provider_id).cloned()?;

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        debug!(
            "Skipping AI metadata: no model configured for provider '{}'",
            provider.id
        );
        return None;
    }

    // Truncate very long transcriptions so we don't blow the context window
    // on entries with tens of thousands of tokens. The first ~2000 chars are
    // enough for title/tag inference in practice.
    let input = if trimmed.chars().count() > 2000 {
        trimmed.chars().take(2000).collect::<String>() + "…"
    } else {
        trimmed.to_string()
    };

    // Apple Intelligence: native Swift path, no HTTP / structured-output schema.
    // Ask for JSON in the prompt and parse defensively below.
    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                debug!("AI metadata: Apple Intelligence selected but not currently available");
                return None;
            }
            let token_limit = model.trim().parse::<i32>().unwrap_or(0);
            let user_content = format!(
                "Return ONLY valid JSON, no markdown.\n\nTranscription:\n{}",
                input
            );
            let content = match apple_intelligence::process_text_with_system_prompt(
                &system,
                &user_content,
                token_limit,
            ) {
                Ok(s) if !s.trim().is_empty() => s,
                Ok(_) => {
                    warn!("AI metadata: Apple Intelligence returned empty response");
                    return None;
                }
                Err(e) => {
                    error!("AI metadata: Apple Intelligence request failed: {}", e);
                    return None;
                }
            };
            return parse_metadata(&content, existing_tags);
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return None;
        }
    }

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "tags": {
                "type": "array",
                "items": { "type": "string" },
                "maxItems": 5
            }
        },
        "required": ["title", "tags"],
        "additionalProperties": false
    });

    // Reasoning disabled for providers where it adds latency without value here.
    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(llm_client::ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    let result = if provider.supports_structured_output {
        llm_client::send_chat_completion_with_schema(
            &provider,
            api_key,
            &model,
            input,
            Some(system.clone()),
            Some(schema),
            reasoning_effort,
            reasoning,
        )
        .await
    } else {
        // Providers without structured output: ask for JSON in the prompt and
        // parse defensively below.
        let prompt = format!(
            "{}\n\nReturn ONLY valid JSON, no markdown.\n\nTranscription:\n{}",
            system, input
        );
        llm_client::send_chat_completion(
            &provider,
            api_key,
            &model,
            prompt,
            reasoning_effort,
            reasoning,
        )
        .await
    };

    let content = match result {
        Ok(Some(c)) => c,
        Ok(None) => {
            warn!("AI metadata: LLM returned no content");
            return None;
        }
        Err(e) => {
            error!("AI metadata request failed: {}", e);
            return None;
        }
    };

    parse_metadata(&content, existing_tags)
}

fn parse_metadata(content: &str, existing_tags: &[String]) -> Option<GeneratedMetadata> {
    // Some providers wrap JSON in markdown fences; strip them before parsing.
    let cleaned = strip_json_fences(content.trim());
    let parsed: AiMetadata = match serde_json::from_str(cleaned) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                "AI metadata: failed to parse JSON response: {} (raw: {})",
                e, cleaned
            );
            return None;
        }
    };

    let title = parsed.title.trim().to_string();
    if title.is_empty() {
        return None;
    }

    // Only accept tags from the user's existing vocabulary. Case-insensitive
    // match back to the canonical stored form, drop anything else.
    let canonical: std::collections::HashMap<String, String> = existing_tags
        .iter()
        .map(|t| (t.trim().to_lowercase(), t.clone()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let tags: Vec<String> = parsed
        .tags
        .into_iter()
        .filter_map(|t| canonical.get(&t.trim().to_lowercase()).cloned())
        .filter(|t| seen.insert(t.clone()))
        .take(5)
        .collect();

    Some(GeneratedMetadata { title, tags })
}

fn strip_json_fences(s: &str) -> &str {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("```json").or_else(|| s.strip_prefix("```")) {
        rest.trim_end_matches("```").trim()
    } else {
        s
    }
}
