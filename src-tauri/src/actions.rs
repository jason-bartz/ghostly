#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::{is_microphone_access_denied, is_no_input_device_error};
use crate::clipboard::PasteOptions;
use crate::edit_intent;
use crate::frontmost;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;
use crate::managers::usage::{LimitCheck, UsageManager};
use crate::profiles::{self, ResolvedOverrides};
use crate::screenshot;
use crate::session::{self, SessionBuffer, SessionEntry};
use crate::settings::{
    get_settings, AppSettings, VoiceEditReplaceStrategy, APPLE_INTELLIGENCE_PROVIDER_ID,
};
use crate::shortcut;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{
    self, emit_transcription_preview, show_processing_overlay, show_recording_overlay,
    show_transcribing_overlay,
};
use crate::TranscriptionCoordinator;
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct RecordingErrorEvent {
    error_type: String,
    detail: Option<String>,
}

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
struct FinishGuard(AppHandle);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
    /// When true, this shortcut path forces the voice-edit branch regardless
    /// of prefix detection. Used by the dedicated "edit last transcription"
    /// shortcut so users can revise without risking false positives on content.
    force_voice_edit: bool,
    /// When true, captures a screenshot on start() and routes the transcription
    /// through a vision-capable LLM with the image attached.
    capture_screenshot: bool,
    /// Stash for the screenshot PNG captured in start(), consumed in stop().
    /// Always present on the struct; only populated when capture_screenshot is true.
    captured_image: Arc<Mutex<Option<Vec<u8>>>>,
}

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Small on-device models — notably Apple Intelligence — sometimes ignore the
/// "return only the cleaned text" rule and prefix their response with a
/// conversational preamble like `Sure! Here's the cleaned-up text:\n\n"..."`.
/// Strip the preamble and any wrapping quotes it brought along, but only when
/// both signals are present so normal dictation that happens to start with
/// "Here's..." isn't damaged.
static LLM_PREAMBLE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"(?i)^\s*",
        r"(?:",
        // Variant 1: optional lead ("Sure!", "Okay,", etc.) + here's/here is/below is/this is ... : \n+
        r"(?:sure|okay|alright|got it|certainly|of course|absolutely|yes|here you go)[,.!]?\s+",
        r"(?:here(?:'s| is)|below is|this is)[^\n]*:\s*\n+",
        r"|",
        // Variant 2: bare "Here's the <adjective> text:" with no lead-in
        r"here(?:'s| is)\s+(?:the|your|a|an)\s+",
        r"(?:cleaned|cleaned-up|cleanup|rewritten|revised|edited|formatted|corrected|final|processed|polished|refined|updated)",
        r"[^\n]*:\s*\n+",
        r")",
    ))
    .expect("valid llm preamble regex")
});

fn strip_llm_preamble(s: &str) -> String {
    let Some(m) = LLM_PREAMBLE_RE.find(s) else {
        return s.to_string();
    };
    let after = s[m.end()..].trim();

    // Preamble was present; the AI often wraps the actual content in matching
    // straight or curly double quotes. Strip them if they wrap the entire
    // remainder. Only runs in the preamble-matched branch so we don't strip
    // legitimate user-dictated quotes when there's no preamble signal.
    let chars: Vec<char> = after.chars().collect();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        let is_wrapped = matches!((first, last), ('"', '"') | ('\u{201C}', '\u{201D}'));
        if is_wrapped {
            return chars[1..chars.len() - 1]
                .iter()
                .collect::<String>()
                .trim()
                .to_string();
        }
    }
    after.to_string()
}

/// Combined cleanup applied to raw LLM output before it's displayed or pasted.
fn clean_llm_output(s: &str) -> String {
    strip_llm_preamble(&strip_invisible_chars(s))
}

/// Event payload emitted when AI refinement fails for a real reason (network,
/// bad key, provider error) — not graceful skips like "no prompt selected".
/// Frontend listens and shows a toast; pipeline still pastes the raw transcript.
#[derive(Clone, serde::Serialize)]
struct PostProcessFailedEvent {
    message: String,
}

fn emit_post_process_failed(app: &AppHandle, message: impl Into<String>) {
    let payload = PostProcessFailedEvent {
        message: message.into(),
    };
    if let Err(e) = app.emit("post-process-failed", payload) {
        warn!("Failed to emit post-process-failed event: {}", e);
    }
}

fn emit_screenshot_qa_failed(app: &AppHandle, message: impl Into<String>) {
    let payload = PostProcessFailedEvent {
        message: message.into(),
    };
    if let Err(e) = app.emit("screenshot-qa-failed", payload) {
        warn!("Failed to emit screenshot-qa-failed event: {}", e);
    }
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

async fn post_process_transcription(
    settings: &AppSettings,
    transcription: &str,
    overrides: &ResolvedOverrides,
    app: &AppHandle,
) -> Option<String> {
    // Profile may redirect to a different provider (e.g. Apple Intelligence for
    // Slack). Fall back to the global selection if the override id doesn't exist.
    let provider_id = overrides
        .provider_id
        .as_deref()
        .filter(|id| settings.post_process_provider(id).is_some())
        .unwrap_or(settings.post_process_provider_id.as_str());
    let provider = match settings.post_process_provider(provider_id).cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    // Prompt selection precedence:
    //   1. Explicit `prompt_id` override (prompt shortcuts, advanced custom
    //      rules) — lookup in `post_process_prompts`.
    //   2. Style-system composed prompt (category + cleanup level).
    //   3. Globally-selected prompt.
    let prompt = if let Some(id) = overrides.prompt_id.clone() {
        match settings.post_process_prompts.iter().find(|p| p.id == id) {
            Some(p) => p.prompt.clone(),
            None => {
                debug!(
                    "Post-processing skipped because prompt '{}' was not found",
                    id
                );
                return None;
            }
        }
    } else if let Some(composed) = overrides.composed_prompt.clone() {
        composed
    } else {
        let selected_prompt_id = match settings.post_process_selected_prompt_id.clone() {
            Some(id) => id,
            None => {
                debug!("Post-processing skipped because no prompt is selected");
                return None;
            }
        };

        match settings
            .post_process_prompts
            .iter()
            .find(|prompt| prompt.id == selected_prompt_id)
        {
            Some(prompt) => prompt.prompt.clone(),
            None => {
                debug!(
                    "Post-processing skipped because prompt '{}' was not found",
                    selected_prompt_id
                );
                return None;
            }
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Non-Apple providers stream via SSE so the user sees tokens arriving in the
    // overlay in real time. The Apple Intelligence path below is synchronous
    // Swift FFI and can't stream, so it falls through to the existing code.
    if provider.id != APPLE_INTELLIGENCE_PROVIDER_ID {
        return post_process_transcription_streaming(
            &provider,
            api_key,
            &model,
            &prompt,
            transcription,
            app,
        )
        .await;
    }

    // Disable reasoning for providers where post-processing rarely benefits from it.
    // - custom: top-level reasoning_effort (works for local OpenAI-compat servers)
    // - openrouter: nested reasoning object; exclude:true also keeps reasoning text
    //   out of the response so it can't pollute structured-output JSON parsing
    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(crate::llm_client::ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    // Handle Apple Intelligence separately since it uses native Swift APIs.
    // Unlike HTTP providers, we do NOT split the prompt into instructions + user
    // content. Apple's on-device Foundation Model is small enough that when the
    // user turn is a standalone conversational query (e.g. "how do I install
    // TensorFlow"), it treats `instructions` as weak guidance and just answers
    // the question. Bundling the full template — rules AND transcript — into
    // one user message frames the transcription as data rather than bait.
    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                debug!("Apple Intelligence selected but not currently available on this device");
                return None;
            }

            let user_content = prompt.replace("${output}", transcription);
            let token_limit = model.trim().parse::<i32>().unwrap_or(0);
            return match apple_intelligence::process_text_with_system_prompt(
                "",
                &user_content,
                token_limit,
            ) {
                Ok(result) => {
                    if result.trim().is_empty() {
                        debug!("Apple Intelligence returned an empty response");
                        return None;
                    }
                    let result = clean_llm_output(&result);
                    // Hallucination guard: on-device Apple Intelligence
                    // occasionally answers the transcription as a question
                    // instead of cleaning it, producing output many times
                    // longer than the input (e.g. a TensorFlow tutorial in
                    // response to "how do I install tensorflow"). Drop the
                    // result and fall back to the raw transcript when output
                    // dwarfs input.
                    let input_len = transcription.chars().count();
                    let output_len = result.chars().count();
                    if output_len > input_len.saturating_mul(3) && output_len > input_len + 300 {
                        warn!(
                            "Apple Intelligence output looks like a hallucination ({} chars from {} chars input); falling back to raw transcript",
                            output_len, input_len
                        );
                        emit_post_process_failed(
                            app,
                            "AI refinement produced an off-topic response. Pasted raw transcription instead.",
                        );
                        return None;
                    }
                    debug!(
                        "Apple Intelligence post-processing succeeded. Output length: {} chars",
                        result.len()
                    );
                    Some(result)
                }
                Err(err) => {
                    error!("Apple Intelligence post-processing failed: {}", err);
                    None
                }
            };
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            debug!("Apple Intelligence provider selected on unsupported platform");
            return None;
        }
    }

    if provider.supports_structured_output {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(&prompt);
        let user_content = transcription.to_string();

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            reasoning_effort.clone(),
            reasoning.clone(),
        )
        .await
        {
            Ok(Some(content)) => {
                // Parse the JSON response to extract the transcription field.
                // If the response isn't valid JSON or is missing the expected
                // field, fall back to the raw (non-post-processed) transcript
                // rather than pasting malformed content like `{"foo":"bar"}`.
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = clean_llm_output(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Some(result);
                        } else {
                            error!(
                                "Structured output response missing '{}' field; falling back to raw transcript",
                                TRANSCRIPTION_FIELD
                            );
                            emit_post_process_failed(
                                app,
                                "AI refinement returned a malformed response. Pasted raw transcription instead.",
                            );
                            return None;
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}; falling back to raw transcript",
                            e
                        );
                        emit_post_process_failed(
                            app,
                            "AI refinement returned malformed JSON. Pasted raw transcription instead.",
                        );
                        return None;
                    }
                }
            }
            Ok(None) => {
                error!("LLM API response has no content");
                emit_post_process_failed(
                    app,
                    "AI refinement returned no content. Pasted raw transcription instead.",
                );
                return None;
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        reasoning_effort,
        reasoning,
    )
    .await
    {
        Ok(Some(content)) => {
            let content = clean_llm_output(&content);
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some(content)
        }
        Ok(None) => {
            error!("LLM API response has no content");
            emit_post_process_failed(
                app,
                "AI refinement returned no content. Pasted raw transcription instead.",
            );
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            emit_post_process_failed(
                app,
                format!(
                    "AI refinement failed: {}. Pasted raw transcription instead.",
                    short_error_reason(&e)
                ),
            );
            None
        }
    }
}

/// Streaming post-processing path used for all non-Apple-Intelligence
/// providers. Emits `transcription-preview` events as tokens arrive so the
/// overlay updates in real time, then returns the full accumulated text for
/// pasting. Uses the legacy prompt format (with `${output}` substitution)
/// rather than structured JSON output because partial SSE chunks can't be
/// validated against a schema mid-flight.
///
/// Returns `Some(text)` on success, `None` on cancellation or failure. Failure
/// cases emit a `post-process-failed` event so the user sees a toast.
async fn post_process_transcription_streaming(
    provider: &crate::settings::PostProcessProvider,
    api_key: String,
    model: &str,
    prompt_template: &str,
    transcription: &str,
    app: &AppHandle,
) -> Option<String> {
    let processed_prompt = prompt_template.replace("${output}", transcription);

    let Some(cancel_state) = app.try_state::<Arc<crate::stream_cancel::StreamCancellation>>()
    else {
        warn!("StreamCancellation state missing; streaming aborted.");
        return None;
    };
    let cancel_token = cancel_state.begin();

    // Stream deltas into a shared buffer and re-emit the full accumulated
    // text to the overlay on every tick. Sending the accumulated string
    // (rather than the delta) matches the existing `transcription-preview`
    // contract where each event replaces what the overlay displays.
    let preview_buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let app_for_delta = app.clone();
    let preview_for_delta = Arc::clone(&preview_buffer);
    let on_delta = move |delta: &str| {
        let snapshot = {
            let mut guard = preview_for_delta.lock().unwrap_or_else(|e| e.into_inner());
            guard.push_str(delta);
            guard.clone()
        };
        emit_transcription_preview(&app_for_delta, &snapshot);
    };

    let result = crate::llm_client::send_chat_completion_stream(
        provider,
        api_key,
        model,
        processed_prompt,
        Arc::clone(&cancel_token),
        on_delta,
    )
    .await;

    cancel_state.end();

    match result {
        Ok(text) => {
            let cleaned = clean_llm_output(&text);
            if cleaned.trim().is_empty() {
                emit_post_process_failed(
                    app,
                    "AI refinement returned no content. Pasted raw transcription instead.",
                );
                None
            } else {
                debug!(
                    "Streaming post-processing succeeded for provider '{}'. Output length: {} chars",
                    provider.id,
                    cleaned.len()
                );
                Some(cleaned)
            }
        }
        Err(e) if e == "cancelled" => {
            debug!("Streaming post-processing cancelled by user");
            None
        }
        Err(e) => {
            error!(
                "Streaming post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id, e
            );
            emit_post_process_failed(
                app,
                format!(
                    "AI refinement failed: {}. Pasted raw transcription instead.",
                    short_error_reason(&e)
                ),
            );
            None
        }
    }
}

/// Extract a short, user-friendly reason from an LLM error string. Keeps
/// toasts readable instead of dumping full HTTP bodies.
fn short_error_reason(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.len() <= 120 {
        return trimmed.to_string();
    }
    let mut s: String = trimmed.chars().take(117).collect();
    s.push_str("...");
    s
}

async fn maybe_convert_chinese_variant(
    settings: &AppSettings,
    transcription: &str,
) -> Option<String> {
    let is_simplified = settings.selected_language == "zh-Hans";
    let is_traditional = settings.selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("selected_language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        settings.selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2tw
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

/// Decide whether this transcription should be routed as a voice-edit
/// operation against the most recent session entry. Returns the prior entry
/// plus the active replace strategy when it should.
fn maybe_voice_edit_context(
    app: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
    app_ctx: Option<&crate::frontmost::AppContext>,
    force: bool,
) -> Option<(SessionEntry, VoiceEditReplaceStrategy)> {
    if !force {
        if !settings.voice_editing_enabled {
            return None;
        }
        if !settings.voice_edit_prefix_detection {
            return None;
        }
        if !edit_intent::detect_prefix(transcription) {
            return None;
        }
    }
    let sb = app.try_state::<std::sync::Arc<SessionBuffer>>()?;
    let prior = sb.latest_for_edit(
        Instant::now(),
        app_ctx,
        settings.session_idle_timeout_secs,
        settings.voice_edit_replace_strategy,
    )?;
    Some((prior, settings.voice_edit_replace_strategy))
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    process_transcription_output_with_overrides(
        app,
        transcription,
        post_process,
        &ResolvedOverrides::default(),
    )
    .await
}

pub(crate) async fn process_transcription_output_with_overrides(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
    overrides: &ResolvedOverrides,
) -> ProcessedTranscription {
    let settings = get_settings(app);
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;

    // Apply word corrections before any other processing
    if let Some(history_manager) = app.try_state::<Arc<HistoryManager>>() {
        final_text = history_manager.apply_word_corrections(&final_text);
    }

    if let Some(converted_text) = maybe_convert_chinese_variant(&settings, &final_text).await {
        final_text = converted_text;
    }

    // Profile can force post-process on or off; otherwise inherit the caller's flag.
    let effective_post_process = overrides.post_process_enabled.unwrap_or(post_process);

    if effective_post_process {
        if let Some(processed_text) =
            post_process_transcription(&settings, &final_text, overrides, app).await
        {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;

            let prompt_id = overrides
                .prompt_id
                .clone()
                .or_else(|| settings.post_process_selected_prompt_id.clone());
            if let Some(prompt_id) = prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
    }
}

/// System prompt used for voice-edit operations. The previous transcription is
/// provided as context; the new utterance is the instruction. The model must
/// return ONLY the revised text with no commentary. Not user-editable in v1.
const VOICE_EDIT_SYSTEM_PROMPT: &str = "You are a text editor. The user will give you a previous piece of text and a short verbal instruction describing how to modify it. Return ONLY the revised text. No commentary, no quoting, no preamble. Preserve the user's language and tone unless the instruction says otherwise.";

/// Run a voice-edit LLM call against the prior session entry's final text.
/// Returns None if post-process isn't usable (no provider / no model / no key).
pub(crate) async fn voice_edit_via_llm(
    settings: &AppSettings,
    prior_text: &str,
    instruction: &str,
    overrides: &ResolvedOverrides,
) -> Option<String> {
    let provider_id = overrides
        .provider_id
        .as_deref()
        .filter(|id| settings.post_process_provider(id).is_some())
        .unwrap_or(settings.post_process_provider_id.as_str());
    let provider = settings.post_process_provider(provider_id).cloned()?;
    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        return None;
    }
    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    let user_content = format!(
        "Previous text:\n---\n{}\n---\n\nInstruction: {}",
        prior_text, instruction
    );

    // Apple Intelligence: native path, no HTTP. Bundle the system prompt into
    // the user message so the on-device model treats the prior text + instruction
    // as input to act on, not as a conversational turn to respond to freely.
    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                return None;
            }
            let bundled = format!("{}\n\n{}", VOICE_EDIT_SYSTEM_PROMPT, user_content);
            let token_limit = model.trim().parse::<i32>().unwrap_or(0);
            return apple_intelligence::process_text_with_system_prompt("", &bundled, token_limit)
                .ok()
                .map(|s| clean_llm_output(&s))
                .filter(|s| !s.trim().is_empty());
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return None;
        }
    }

    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(crate::llm_client::ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    if provider.supports_structured_output {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "revised_text": { "type": "string" } },
            "required": ["revised_text"],
            "additionalProperties": false
        });
        if let Ok(Some(content)) = crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content.clone(),
            Some(VOICE_EDIT_SYSTEM_PROMPT.to_string()),
            Some(schema),
            reasoning_effort.clone(),
            reasoning.clone(),
        )
        .await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(s) = json.get("revised_text").and_then(|v| v.as_str()) {
                    let cleaned = clean_llm_output(s);
                    if !cleaned.trim().is_empty() {
                        return Some(cleaned);
                    }
                }
            }
            let cleaned = clean_llm_output(&content);
            if !cleaned.trim().is_empty() {
                return Some(cleaned);
            }
        }
    }

    // Legacy chat completion
    let full_prompt = format!("{}\n\n{}", VOICE_EDIT_SYSTEM_PROMPT, user_content);
    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        full_prompt,
        reasoning_effort,
        reasoning,
    )
    .await
    {
        Ok(Some(content)) => {
            let cleaned = clean_llm_output(&content);
            if cleaned.trim().is_empty() {
                None
            } else {
                Some(cleaned)
            }
        }
        _ => None,
    }
}

/// Legacy: send the screenshot + dictated question to a vision LLM.
/// Kept for potential future use as an alternative mode; the default flow now
/// pastes the image + transcribed text directly without an LLM round-trip.
#[allow(dead_code)]
async fn screenshot_qa_via_llm(
    app: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
    image_png: &[u8],
) -> Option<String> {
    let provider_id = settings.post_process_provider_id.as_str();
    let provider = match settings.post_process_provider(provider_id).cloned() {
        Some(p) => p,
        None => {
            error!("Screenshot Q&A: no provider selected");
            emit_screenshot_qa_failed(
                app,
                "No AI provider selected. Configure one in Settings → AI Refinement.",
            );
            return None;
        }
    };

    if !provider.supports_vision {
        error!(
            "Screenshot Q&A: provider '{}' does not support vision. Switch to OpenAI, OpenRouter, Z.AI, or Groq.",
            provider.id
        );
        emit_screenshot_qa_failed(
            app,
            format!(
                "'{}' doesn't support vision. Switch to OpenAI, OpenRouter, Z.AI, or Groq.",
                provider.label
            ),
        );
        return None;
    }

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        error!(
            "Screenshot Q&A: provider '{}' has no model configured",
            provider.id
        );
        emit_screenshot_qa_failed(
            app,
            format!(
                "No model selected for '{}'. Pick one in Settings → AI Refinement.",
                provider.label
            ),
        );
        return None;
    }

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Prefer the builtin screenshot Q&A prompt; fall back to a minimal inline
    // prompt if the user deleted the builtin.
    let system_prompt = settings
        .post_process_prompts
        .iter()
        .find(|p| p.id == "builtin_screenshot_qa")
        .map(|p| build_system_prompt(&p.prompt))
        .unwrap_or_else(|| {
            "You are a vision assistant. Look at the screenshot and answer the user's dictated question concisely. Return only the answer."
                .to_string()
        });

    match crate::llm_client::send_chat_completion_with_image(
        &provider,
        api_key,
        &model,
        transcription.to_string(),
        image_png,
        Some(system_prompt),
    )
    .await
    {
        Ok(Some(content)) => {
            let cleaned = clean_llm_output(&content);
            if cleaned.trim().is_empty() {
                error!("Screenshot Q&A: LLM returned empty content");
                emit_screenshot_qa_failed(
                    app,
                    "The AI returned an empty response. Try asking again.",
                );
                None
            } else {
                Some(cleaned)
            }
        }
        Ok(None) => {
            error!("Screenshot Q&A: LLM returned no content");
            emit_screenshot_qa_failed(
                app,
                "The AI returned no response. Check your API key and model.",
            );
            None
        }
        Err(e) => {
            error!("Screenshot Q&A LLM call failed: {}", e);
            emit_screenshot_qa_failed(app, short_error_reason(&e));
            None
        }
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

        // Free-tier weekly cap: block the start path before we flip any UI
        // state or touch the microphone. `check_limit` also emits the soft
        // 80% warning on first crossing.
        let settings_for_limit = get_settings(app);
        let is_pro = settings_for_limit.effective_is_pro();
        if let Some(um) = app.try_state::<Arc<UsageManager>>() {
            match um.check_limit(is_pro) {
                LimitCheck::OverLimit => {
                    debug!("Free-tier weekly limit reached; blocking recording start");
                    let _ = app.emit("usage-limit-reached", ());
                    return;
                }
                LimitCheck::FirstWarning => {
                    let _ = app.emit("usage-warning", ());
                }
                LimitCheck::Allowed => {}
            }
        }

        // Clear any stale cancellation state from a previous operation so the
        // paste path at the end doesn't mistakenly skip output.
        if let Some(sc) = app.try_state::<Arc<crate::stream_cancel::StreamCancellation>>() {
            sc.reset();
        }

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        // Load ASR model and VAD model in parallel
        tm.initiate_model_load();
        let rm_clone = Arc::clone(&rm);
        std::thread::spawn(move || {
            if let Err(e) = rm_clone.preload_vad() {
                debug!("VAD pre-load failed: {}", e);
            }
        });

        let binding_id = binding_id.to_string();
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        // When the dedicated edit shortcut is used, show a clickable chip
        // strip (Shorten / Lengthen / Fix grammar / Rephrase). Clicking a chip
        // rewrites the text currently in the focused field; speaking instead
        // falls through to the normal voice-edit flow.
        if self.force_voice_edit && binding_id == "edit_last_transcription" {
            let settings = get_settings(app);
            if settings.overlay_position != crate::settings::OverlayPosition::None {
                crate::overlay::emit_edit_mode(app);
            }
        }

        // Capture screenshot synchronously before recording begins so the image
        // reflects the screen state at the moment the user triggered the shortcut.
        if self.capture_screenshot {
            match screenshot::capture_primary_png() {
                Ok(png) => {
                    if let Ok(mut slot) = self.captured_image.lock() {
                        *slot = Some(png);
                    }
                }
                Err(e) => {
                    error!("Screenshot capture failed: {}", e);
                    if let Ok(mut slot) = self.captured_image.lock() {
                        *slot = None;
                    }
                }
            }
        }

        // Get the microphone mode to determine audio feedback timing
        let settings = get_settings(app);
        let is_always_on = settings.always_on_microphone;
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error: Option<String> = None;
        if is_always_on {
            // Always-on mode: Play audio feedback immediately, then apply mute after sound finishes
            debug!("Always-on mode: Playing audio feedback immediately");
            let rm_clone = Arc::clone(&rm);
            let app_clone = app.clone();
            // The blocking helper exits immediately if audio feedback is disabled,
            // so we can always reuse this thread to ensure mute happens right after playback.
            std::thread::spawn(move || {
                play_feedback_sound_blocking(&app_clone, SoundType::Start);
                rm_clone.apply_mute();
            });

            if let Err(e) = rm.try_start_recording(&binding_id) {
                debug!("Recording failed: {}", e);
                recording_error = Some(e);
            }
        } else {
            // On-demand mode: Start recording first, then play audio feedback, then apply mute
            // This allows the microphone to be activated before playing the sound
            debug!("On-demand mode: Starting recording first, then audio feedback");
            let recording_start_time = Instant::now();
            match rm.try_start_recording(&binding_id) {
                Ok(()) => {
                    debug!("Recording started in {:?}", recording_start_time.elapsed());
                    // Small delay to ensure microphone stream is active
                    let app_clone = app.clone();
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        debug!("Handling delayed audio feedback/mute sequence");
                        // Helper handles disabled audio feedback by returning early, so we reuse it
                        // to keep mute sequencing consistent in every mode.
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
                        rm_clone.apply_mute();
                    });
                }
                Err(e) => {
                    debug!("Failed to start recording: {}", e);
                    recording_error = Some(e);
                }
            }
        }

        if recording_error.is_none() {
            // Dynamically register the cancel shortcut in a separate task to avoid deadlock
            shortcut::register_cancel_shortcut(app);
        } else {
            // Starting failed (for example due to blocked microphone permissions).
            // Revert UI state so we don't stay stuck in the recording overlay.
            utils::hide_recording_overlay(app);
            change_tray_icon(app, TrayIconState::Idle);
            if let Some(err) = recording_error {
                let error_type = if is_microphone_access_denied(&err) {
                    "microphone_permission_denied"
                } else if is_no_input_device_error(&err) {
                    "no_input_device"
                } else {
                    "unknown"
                };
                let _ = app.emit(
                    "recording-error",
                    RecordingErrorEvent {
                        error_type: error_type.to_string(),
                        detail: Some(err),
                    },
                );
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        change_tray_icon(app, TrayIconState::Transcribing);
        show_transcribing_overlay(app);

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
                                                 // `post_process` on the action is now a "force on" signal. The actual
                                                 // runtime decision is made once `settings_snapshot` is available (see
                                                 // below) and ORs this with has_working_llm().
        let force_post_process = self.post_process;
        let force_voice_edit = self.force_voice_edit;
        let capture_screenshot = self.capture_screenshot;
        let captured_image_slot = Arc::clone(&self.captured_image);

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard(ah.clone());
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            if let Some(samples) = rm.stop_recording(&binding_id) {
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_time.elapsed(),
                    samples.len()
                );

                if samples.is_empty() {
                    debug!("Recording produced no audio samples; skipping persistence");
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                } else {
                    // Save WAV concurrently with transcription
                    let sample_count = samples.len();
                    let file_name = format!("ghostly-{}.wav", chrono::Utc::now().timestamp());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_path_for_verify = wav_path.clone();
                    let samples_for_wav = samples.clone();
                    let wav_handle = tauri::async_runtime::spawn_blocking(move || {
                        crate::audio_toolkit::save_wav_file(&wav_path, &samples_for_wav)
                    });

                    // Transcribe concurrently with WAV save
                    let transcription_time = Instant::now();
                    let transcription_result = tm.transcribe(samples);

                    // Await WAV save and verify
                    let wav_saved = match wav_handle.await {
                        Ok(Ok(())) => {
                            match crate::audio_toolkit::verify_wav_file(
                                &wav_path_for_verify,
                                sample_count,
                            ) {
                                Ok(()) => true,
                                Err(e) => {
                                    error!("WAV verification failed: {}", e);
                                    false
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            error!("Failed to save WAV file: {}", e);
                            false
                        }
                        Err(e) => {
                            error!("WAV save task panicked: {}", e);
                            false
                        }
                    };

                    match transcription_result {
                        Ok(transcription) => {
                            debug!(
                                "Transcription completed in {:?}: '{}'",
                                transcription_time.elapsed(),
                                transcription
                            );

                            // Record this session's audio duration against the
                            // weekly usage counter. Pro users are recorded too
                            // (for vanity stats); only the cap check differs.
                            // Empty transcriptions still cost microphone time,
                            // but we only charge on the Ok path to match the
                            // "only successful transcriptions" rule.
                            if let Some(um) = ah.try_state::<Arc<UsageManager>>() {
                                let duration_secs = (sample_count as u64)
                                    / (crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE as u64);
                                let word_count = transcription.split_whitespace().count() as u64;
                                um.record(duration_secs, word_count);
                            }

                            // Show the transcription text in the overlay immediately so the user
                            // can see what was captured before it's pasted.
                            if !transcription.is_empty() {
                                emit_transcription_preview(&ah, &transcription);
                            }

                            // Resolve the current frontmost app and any matching profile.
                            // Done at post-transcribe time so profile selection reflects
                            // where the paste will actually land.
                            let settings_snapshot = get_settings(&ah);
                            // Runtime post-process decision: force-on from the
                            // action (e.g. edit_last_transcription), else auto —
                            // on whenever an LLM is connected and this isn't a
                            // screenshot flow.
                            let post_process = force_post_process
                                || (!capture_screenshot && settings_snapshot.has_working_llm());
                            let app_ctx = frontmost::current().ok().flatten();
                            let overrides = profiles::resolve_with_builtins(
                                &settings_snapshot,
                                app_ctx.as_ref(),
                            );
                            if let Some(name) = &overrides.profile_name {
                                debug!("Active profile: '{}'", name);
                            }

                            // Correction phrase filtering (intra-recording): if the user
                            // said "scratch that" (or any configured phrase) mid-speech,
                            // discard everything up to and including the last occurrence
                            // so only what follows gets pasted.
                            debug!(
                                "Correction phrases: enabled={}, phrases={:?}",
                                settings_snapshot.correction_phrases_enabled,
                                settings_snapshot.correction_phrases
                            );
                            let transcription = if settings_snapshot.correction_phrases_enabled {
                                let corrected = edit_intent::apply_correction_phrases(
                                    &transcription,
                                    &settings_snapshot.correction_phrases,
                                );
                                debug!(
                                    "Correction phrases: before={:?} after={:?}",
                                    transcription, corrected
                                );
                                if corrected != transcription {
                                    // Update the overlay so the user sees what will
                                    // actually be pasted after the correction.
                                    emit_transcription_preview(&ah, &corrected);
                                }
                                corrected
                            } else {
                                transcription
                            };

                            // If the correction phrase consumed the entire utterance,
                            // nothing to paste — save history and return.
                            if transcription.is_empty() {
                                if wav_saved {
                                    let source_app = rm.take_source_app();
                                    if let Err(err) = hm.save_entry(
                                        file_name,
                                        String::new(),
                                        false,
                                        None,
                                        None,
                                        source_app,
                                    ) {
                                        error!(
                                            "Failed to save correction-consumed history: {}",
                                            err
                                        );
                                    }
                                }
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                                return;
                            }

                            // Screenshot + dictate branch: stage the capture and show the
                            // staged overlay. The user focuses their target text field, then
                            // presses the confirm shortcut to actually paste.
                            if capture_screenshot {
                                let image =
                                    captured_image_slot.lock().ok().and_then(|mut s| s.take());
                                match image {
                                    Some(png) => {
                                        // Save history entry with the transcription
                                        if wav_saved {
                                            let source_app = rm.take_source_app();
                                            if let Err(err) = hm.save_entry(
                                                file_name,
                                                transcription.clone(),
                                                true,
                                                None,
                                                Some("Screenshot + Dictate".to_string()),
                                                source_app,
                                            ) {
                                                error!(
                                                    "Failed to save screenshot history: {}",
                                                    err
                                                );
                                            }
                                        }

                                        // Stage the capture for later confirm-paste
                                        let staged = ah.state::<Arc<
                                            crate::staged_capture::StagedCaptureState,
                                        >>();
                                        staged.set(png.clone(), transcription.clone());

                                        // Arm the paste shortcut now that there's something
                                        // to paste. It stays hot until ConfirmScreenshotPasteAction
                                        // fires or cancel_staged_capture clears it.
                                        crate::shortcut::register_confirm_paste_shortcut(&ah);

                                        // Look up the user's confirm shortcut so the overlay
                                        // can display it as a hint.
                                        let confirm_shortcut = settings_snapshot
                                            .bindings
                                            .get("confirm_screenshot_paste")
                                            .map(|b| b.current_binding.clone())
                                            .unwrap_or_default();

                                        let ah_clone = ah.clone();
                                        let png_for_overlay = png.clone();
                                        let text_for_overlay = transcription.clone();
                                        let _ = ah.run_on_main_thread(move || {
                                            utils::show_staged_overlay(
                                                &ah_clone,
                                                &png_for_overlay,
                                                &text_for_overlay,
                                                if confirm_shortcut.is_empty() {
                                                    None
                                                } else {
                                                    Some(confirm_shortcut.as_str())
                                                },
                                            );
                                            change_tray_icon(&ah_clone, TrayIconState::Idle);
                                        });
                                        return;
                                    }
                                    None => {
                                        warn!(
                                            "Screenshot capture missing; aborting screenshot dictate"
                                        );
                                        emit_screenshot_qa_failed(
                                            &ah,
                                            "Screenshot capture failed. Check that Screen Recording permission is granted in System Settings → Privacy & Security.",
                                        );
                                        utils::hide_recording_overlay(&ah);
                                        change_tray_icon(&ah, TrayIconState::Idle);
                                        return;
                                    }
                                }
                            }

                            // Voice-edit branch: if enabled, prefix matches, and the session buffer
                            // has a replaceable prior entry in the same app, treat this utterance
                            // as an edit instruction rather than content.
                            let edit_context = maybe_voice_edit_context(
                                &ah,
                                &settings_snapshot,
                                &transcription,
                                app_ctx.as_ref(),
                                force_voice_edit,
                            );

                            if let Some((prior, strategy)) = edit_context {
                                if post_process {
                                    show_processing_overlay(&ah);
                                }
                                match voice_edit_via_llm(
                                    &settings_snapshot,
                                    &prior.final_text,
                                    &transcription,
                                    &overrides,
                                )
                                .await
                                {
                                    Some(revised) => {
                                        if wav_saved {
                                            // Record the edit as a history entry so it's auditable.
                                            let source_app = rm.take_source_app();
                                            if let Err(err) = hm.save_entry(
                                                file_name,
                                                transcription.clone(),
                                                post_process,
                                                Some(revised.clone()),
                                                Some(VOICE_EDIT_SYSTEM_PROMPT.to_string()),
                                                source_app,
                                            ) {
                                                error!(
                                                    "Failed to save voice-edit history entry: {}",
                                                    err
                                                );
                                            }
                                        }

                                        let replace_chars = match strategy {
                                            VoiceEditReplaceStrategy::SelectAndPaste => {
                                                Some(prior.pasted_len_utf16)
                                            }
                                            VoiceEditReplaceStrategy::RepasteOnly
                                            | VoiceEditReplaceStrategy::Off => None,
                                        };

                                        let ah_clone = ah.clone();
                                        let revised_for_paste = revised.clone();
                                        let append_space_override = overrides.append_trailing_space;
                                        let _ = ah.run_on_main_thread(move || {
                                            let opts = PasteOptions {
                                                append_trailing_space: append_space_override,
                                                replace_prior_chars: replace_chars,
                                                suppress_auto_submit: true,
                                            };
                                            if let Err(e) = crate::clipboard::paste_with_options(
                                                revised_for_paste,
                                                ah_clone.clone(),
                                                opts,
                                            ) {
                                                error!("Voice-edit paste failed: {}", e);
                                                let _ = ah_clone.emit("paste-error", ());
                                            }
                                            utils::hide_recording_overlay(&ah_clone);
                                            change_tray_icon(&ah_clone, TrayIconState::Idle);
                                        });

                                        // Replace the latest session entry with the revised text
                                        // so subsequent edits chain off the new content.
                                        if let Some(sb) =
                                            ah.try_state::<std::sync::Arc<SessionBuffer>>()
                                        {
                                            let new_entry = SessionEntry {
                                                raw_transcript: transcription.clone(),
                                                final_text: revised.clone(),
                                                pasted_len_utf16: session::utf16_len(&revised),
                                                app: app_ctx.clone().unwrap_or_default(),
                                                paste_method: settings_snapshot.paste_method,
                                                auto_submitted: false,
                                                at: Instant::now(),
                                            };
                                            // Drop the prior entry and push the replacement.
                                            sb.clear();
                                            sb.push(
                                                new_entry,
                                                settings_snapshot.session_buffer_size,
                                            );
                                        }
                                        return;
                                    }
                                    None => {
                                        warn!(
                                            "Voice-edit LLM call returned nothing; falling back to focused-field edit"
                                        );
                                        // fall through to focused-field fallback below
                                    }
                                }
                            }

                            // Explicit edit shortcut fired but the voice-edit path didn't
                            // produce a result (no prior session entry, or LLM returned
                            // nothing). Treat the transcription as an instruction and apply
                            // it to the focused field — same pathway as the click-chip
                            // flow, but with the user's spoken instruction.
                            if force_voice_edit && binding_id == "edit_last_transcription" {
                                show_processing_overlay(&ah);
                                match crate::commands::edit_chip::edit_focused_field_with_instruction(
                                    &ah,
                                    &transcription,
                                )
                                .await
                                {
                                    Ok(revised) => {
                                        if wav_saved {
                                            let source_app = rm.take_source_app();
                                            if let Err(err) = hm.save_entry(
                                                file_name,
                                                transcription.clone(),
                                                true,
                                                Some(revised),
                                                Some(VOICE_EDIT_SYSTEM_PROMPT.to_string()),
                                                source_app,
                                            ) {
                                                error!(
                                                    "Failed to save focused-field edit history: {}",
                                                    err
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        warn!("Focused-field edit failed: {}", e);
                                        #[derive(Clone, serde::Serialize)]
                                        struct PostProcessFailedEvent {
                                            message: String,
                                        }
                                        let _ = ah.emit(
                                            "post-process-failed",
                                            PostProcessFailedEvent { message: e },
                                        );
                                    }
                                }
                                crate::overlay::emit_edit_chip_done(&ah);
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                                return;
                            }

                            if post_process {
                                show_processing_overlay(&ah);
                            }
                            let processed = process_transcription_output_with_overrides(
                                &ah,
                                &transcription,
                                post_process,
                                &overrides,
                            )
                            .await;

                            // Save to history if WAV was saved
                            if wav_saved {
                                let source_app = rm.take_source_app();
                                if let Err(err) = hm.save_entry(
                                    file_name,
                                    transcription.clone(),
                                    post_process,
                                    processed.post_processed_text.clone(),
                                    processed.post_process_prompt.clone(),
                                    source_app,
                                ) {
                                    error!("Failed to save history entry: {}", err);
                                }
                            }

                            // Skip paste if the user cancelled mid-operation.
                            // The raw transcript would otherwise fall through
                            // and paste anyway, which is the wrong outcome for
                            // an explicit cancel.
                            let was_cancelled = ah
                                .try_state::<Arc<crate::stream_cancel::StreamCancellation>>()
                                .map(|sc| sc.was_cancelled())
                                .unwrap_or(false);

                            if processed.final_text.is_empty() || was_cancelled {
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                            } else {
                                let ah_clone = ah.clone();
                                let paste_time = Instant::now();
                                let final_text = processed.final_text.clone();
                                let append_space_override = overrides.append_trailing_space;
                                ah.run_on_main_thread(move || {
                                    let opts = PasteOptions {
                                        append_trailing_space: append_space_override,
                                        replace_prior_chars: None,
                                        suppress_auto_submit: false,
                                    };
                                    match crate::clipboard::paste_with_options(
                                        final_text,
                                        ah_clone.clone(),
                                        opts,
                                    ) {
                                        Ok(()) => debug!(
                                            "Text pasted successfully in {:?}",
                                            paste_time.elapsed()
                                        ),
                                        Err(e) => {
                                            error!("Failed to paste transcription: {}", e);
                                            let _ = ah_clone.emit("paste-error", ());
                                        }
                                    }
                                    utils::hide_recording_overlay(&ah_clone);
                                    change_tray_icon(&ah_clone, TrayIconState::Idle);
                                })
                                .unwrap_or_else(|e| {
                                    error!("Failed to run paste on main thread: {:?}", e);
                                    utils::hide_recording_overlay(&ah);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                });

                                // Push to session buffer for future voice-edit operations.
                                if settings_snapshot.voice_editing_enabled {
                                    if let Some(sb) =
                                        ah.try_state::<std::sync::Arc<SessionBuffer>>()
                                    {
                                        let entry = SessionEntry {
                                            raw_transcript: transcription,
                                            final_text: processed.final_text.clone(),
                                            pasted_len_utf16: {
                                                let base =
                                                    session::utf16_len(&processed.final_text);
                                                let trailing =
                                                    overrides.append_trailing_space.unwrap_or(
                                                        settings_snapshot.append_trailing_space,
                                                    );
                                                if trailing {
                                                    base + 1
                                                } else {
                                                    base
                                                }
                                            },
                                            app: app_ctx.unwrap_or_default(),
                                            paste_method: settings_snapshot.paste_method,
                                            auto_submitted: settings_snapshot.auto_submit,
                                            at: Instant::now(),
                                        };
                                        sb.push(entry, settings_snapshot.session_buffer_size);
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            debug!("Global Shortcut Transcription error: {}", err);
                            // Save entry with empty text so user can retry. We
                            // haven't computed the runtime post_process value
                            // yet on this path (transcription failed before we
                            // read settings), so fall back to the explicit
                            // force flag.
                            if wav_saved {
                                let source_app = rm.take_source_app();
                                if let Err(save_err) = hm.save_entry(
                                    file_name,
                                    String::new(),
                                    force_post_process,
                                    None,
                                    None,
                                    source_app,
                                ) {
                                    error!("Failed to save failed history entry: {}", save_err);
                                }
                            }
                            utils::hide_recording_overlay(&ah);
                            change_tray_icon(&ah, TrayIconState::Idle);
                        }
                    }
                }
            } else {
                debug!("No samples retrieved from recording stop");
                utils::hide_recording_overlay(&ah);
                change_tray_icon(&ah, TrayIconState::Idle);
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Confirm Screenshot Paste Action: triggered when the user focuses their
// target text field and presses the confirm shortcut. Reads the staged capture,
// pastes the image + text, and clears the state.
#[cfg(target_os = "macos")]
struct ConfirmScreenshotPasteAction;

#[cfg(target_os = "macos")]
impl ShortcutAction for ConfirmScreenshotPasteAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        let state = app.state::<Arc<crate::staged_capture::StagedCaptureState>>();
        let capture = match state.take() {
            Some(c) => c,
            None => {
                // Shortcut fired without a staged capture — either we were
                // slow to unregister or the user pressed the combo after
                // clearing. Drop the registration so normal Cmd+V works.
                debug!("Confirm screenshot paste: no staged capture");
                crate::shortcut::unregister_confirm_paste_shortcut(app);
                return;
            }
        };

        // Reads the `image_paste_uses_shift` flag off the matched built-in
        // profile, if any. VS Code is the only current case — Copilot Chat
        // requires Shift+Cmd+V to attach images.
        let use_shift = crate::frontmost::current()
            .ok()
            .flatten()
            .and_then(|ctx| crate::profiles::match_builtin_profile(&ctx))
            .map(|profile| profile.image_paste_uses_shift)
            .unwrap_or(false);

        // Hand the rest of the work to a tokio worker. Two reasons:
        //   1. handy-keys dispatches shortcut handlers from its manager
        //      thread. A synchronous unregister round-trip from the handler
        //      would self-deadlock the mpsc channel the manager owns.
        //   2. The unregister MUST complete before we simulate Cmd+V,
        //      otherwise the manager's blocking event tap re-consumes our
        //      own synthetic keystroke and the target app never sees the
        //      paste. Returning from the handler frees the manager thread
        //      to process the unregister command; we then proceed.
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            // Synchronous unregister from a worker thread is safe —
            // the manager thread is no longer blocked on us.
            let settings = crate::settings::get_settings(&app_clone);
            if let Some(binding) = settings.bindings.get("confirm_screenshot_paste").cloned() {
                if !binding.current_binding.is_empty() {
                    let _ = crate::shortcut::unregister_shortcut(&app_clone, binding);
                }
            }

            let app_for_paste = app_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                if let Err(e) =
                    crate::clipboard_image::paste_image(&capture.png, &app_for_paste, use_shift)
                {
                    error!("Image paste failed during confirm: {}", e);
                    let _ = app_for_paste.emit("paste-error", ());
                    utils::hide_recording_overlay(&app_for_paste);
                    return;
                }

                std::thread::sleep(std::time::Duration::from_millis(300));

                let opts = PasteOptions {
                    append_trailing_space: None,
                    replace_prior_chars: None,
                    suppress_auto_submit: false,
                };
                if let Err(e) =
                    crate::clipboard::paste_with_options(capture.text, app_for_paste.clone(), opts)
                {
                    error!("Text paste during confirm failed: {}", e);
                    let _ = app_for_paste.emit("paste-error", ());
                }

                utils::hide_recording_overlay(&app_for_paste);
            });
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
            force_voice_edit: false,
            capture_screenshot: false,
            captured_image: Arc::new(Mutex::new(None)),
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "edit_last_transcription".to_string(),
        Arc::new(TranscribeAction {
            post_process: true,
            force_voice_edit: true,
            capture_screenshot: false,
            captured_image: Arc::new(Mutex::new(None)),
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_screenshot".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
            force_voice_edit: false,
            capture_screenshot: true,
            captured_image: Arc::new(Mutex::new(None)),
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    #[cfg(target_os = "macos")]
    map.insert(
        "confirm_screenshot_paste".to_string(),
        Arc::new(ConfirmScreenshotPasteAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod tests {
    use super::strip_llm_preamble;

    #[test]
    fn strips_sure_heres_preamble_with_quoted_body() {
        let input = "Sure! Here's the cleaned-up text:\n\n\"Pick up bread.\"";
        assert_eq!(strip_llm_preamble(input), "Pick up bread.");
    }

    #[test]
    fn strips_bare_heres_preamble() {
        let input = "Here's the cleaned text:\n\nHello world.";
        assert_eq!(strip_llm_preamble(input), "Hello world.");
    }

    #[test]
    fn strips_curly_quotes_when_preamble_matched() {
        let input = "Okay, here is the transcript:\n\n\u{201C}Hello.\u{201D}";
        assert_eq!(strip_llm_preamble(input), "Hello.");
    }

    #[test]
    fn preserves_content_without_preamble() {
        let input = "Pick up bread.";
        assert_eq!(strip_llm_preamble(input), "Pick up bread.");
    }

    #[test]
    fn preserves_real_content_that_happens_to_start_with_here_is() {
        let input = "Here is the bug I found in line 12.";
        assert_eq!(strip_llm_preamble(input), input);
    }

    #[test]
    fn preserves_user_dictated_quotes_when_no_preamble() {
        let input = "\"quote this verbatim\"";
        assert_eq!(strip_llm_preamble(input), input);
    }

    #[test]
    fn strips_preamble_without_quotes() {
        let input = "Sure, here's the cleaned-up version:\n\nHello world.";
        assert_eq!(strip_llm_preamble(input), "Hello world.");
    }

    #[test]
    fn strips_multiline_body_preserving_internal_content() {
        let input = "Sure! Here's the cleaned text:\n\n\"Line one.\nLine two.\"";
        assert_eq!(strip_llm_preamble(input), "Line one.\nLine two.");
    }
}
