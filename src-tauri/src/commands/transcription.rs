use crate::managers::transcription::TranscriptionManager;
use crate::settings::{
    get_settings, write_settings, ModelUnloadTimeout, APPLE_INTELLIGENCE_PROVIDER_ID,
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn set_model_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.model_unload_timeout = timeout;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn get_model_load_status(
    transcription_manager: State<TranscriptionManager>,
) -> Result<ModelLoadStatus, String> {
    Ok(ModelLoadStatus {
        is_loaded: transcription_manager.is_model_loaded(),
        current_model: transcription_manager.get_current_model(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn unload_model_manually(
    transcription_manager: State<TranscriptionManager>,
) -> Result<(), String> {
    transcription_manager
        .unload_model()
        .map_err(|e| format!("Failed to unload model: {}", e))
}

/// Validate the currently-configured AI provider by sending a tiny roundtrip
/// request. Returns Ok on success, Err with a human-readable reason otherwise.
/// Lets the user catch misconfigurations (bad key, wrong model, dead endpoint)
/// before they hit them mid-transcription.
#[tauri::command]
#[specta::specta]
pub async fn test_post_process_connection(app: AppHandle) -> Result<(), String> {
    let settings = get_settings(&app);
    let provider = settings
        .active_post_process_provider()
        .ok_or("No AI provider is selected.")?
        .clone();
    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        return Err("No model selected for this provider.".to_string());
    }

    // Apple Intelligence has a separate native code path — just probe the
    // availability check instead of making an HTTP call.
    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if crate::apple_intelligence::check_apple_intelligence_availability() {
                return Ok(());
            }
            return Err("Apple Intelligence isn't available on this device.".to_string());
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return Err(
                "Apple Intelligence requires an Apple Silicon Mac running macOS Tahoe or later."
                    .to_string(),
            );
        }
    }

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if api_key.trim().is_empty() {
        return Err("No API key configured for this provider.".to_string());
    }

    // Minimal ping — keep content short to stay well below any rate quota.
    let result = crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        "Reply with the single word: ok".to_string(),
        None,
        None,
    )
    .await;

    match result {
        Ok(_) => Ok(()),
        Err(e) => Err(short_error(&e)),
    }
}

/// Trim verbose HTTP bodies down to a single readable line for toast display.
fn short_error(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.len() <= 160 {
        return trimmed.to_string();
    }
    let mut s: String = trimmed.chars().take(157).collect();
    s.push_str("...");
    s
}
