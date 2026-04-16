//! Tauri command surface for the licensing flow. Thin wrappers around
//! `crate::license` that also sync `settings.is_pro` and persist.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::license::{self, BySession, LicenseError, StatusResponse};
use crate::settings::{get_settings, write_settings};

pub const PAYMENT_LINK: &str = "https://buy.stripe.com/bJeaEW52q3ZI14y4j4eME01";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LicenseState {
    pub is_licensed: bool,
    pub key_masked: Option<String>,
    pub email: Option<String>,
    pub expires_at: Option<i64>,
    pub machine_id: String,
}

fn current_state(app: &AppHandle) -> LicenseState {
    let settings = get_settings(app);
    let mid = license::machine_id();
    if !settings.is_pro {
        return LicenseState {
            is_licensed: false,
            key_masked: None,
            email: None,
            expires_at: None,
            machine_id: mid,
        };
    }
    let Some((key, token)) = license::load_key_and_token() else {
        return LicenseState {
            is_licensed: false,
            key_masked: None,
            email: None,
            expires_at: None,
            machine_id: mid,
        };
    };
    let payload = license::verify_token(&token).ok();
    LicenseState {
        is_licensed: true,
        key_masked: Some(license::mask_key(&key)),
        email: payload.as_ref().map(|p| p.email.clone()),
        expires_at: payload.as_ref().map(|p| p.expires_at),
        machine_id: mid,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn activate_license(app: AppHandle, key: String) -> Result<LicenseState, LicenseError> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(LicenseError::InvalidKey);
    }
    let mid = license::machine_id();
    let mname = license::machine_name();
    let (token, _email) = license::activate(&key, &mid, &mname).await?;

    // Verify offline before accepting.
    let payload = license::verify_token(&token)?;
    if payload.machine_id != mid {
        return Err(LicenseError::InvalidToken);
    }

    license::store_key_and_token(&key, &token);

    let mut settings = get_settings(&app);
    settings.is_pro = true;
    write_settings(&app, settings);

    Ok(current_state(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn deactivate_license(app: AppHandle) -> Result<(), LicenseError> {
    let Some((key, _token)) = license::load_key_and_token() else {
        return Err(LicenseError::NotActivated);
    };
    let mid = license::machine_id();

    // Best-effort remote deactivation. Local clear runs regardless so the
    // user always ends in an unlicensed state.
    let remote = license::deactivate(&key, &mid).await;

    license::clear_credentials();
    let mut settings = get_settings(&app);
    settings.is_pro = false;
    write_settings(&app, settings);

    match remote {
        Ok(()) => Ok(()),
        Err(LicenseError::NetworkError { .. }) => Ok(()), // local state is cleared; worker sees stale entry
        Err(e) => Err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn deactivate_remote_device(
    _app: AppHandle,
    machine_id: String,
) -> Result<(), LicenseError> {
    let Some((key, _token)) = license::load_key_and_token() else {
        return Err(LicenseError::NotActivated);
    };
    license::deactivate(&key, &machine_id).await
}

/// Refresh the stored token via the worker. On explicit revoke/invalid the
/// local credentials are cleared and `is_pro` is flipped off. On network
/// errors we preserve state as long as the existing token is within the
/// absolute grace window.
#[tauri::command]
#[specta::specta]
pub async fn revalidate_license(app: AppHandle) -> Result<LicenseState, String> {
    let Some((key, token)) = license::load_key_and_token() else {
        return Ok(current_state(&app));
    };
    let mid = license::machine_id();

    match license::validate(&key, &mid).await {
        Ok(new_token) => {
            if let Ok(payload) = license::verify_token(&new_token) {
                if payload.machine_id == mid {
                    license::store_key_and_token(&key, &new_token);
                    let mut settings = get_settings(&app);
                    if !settings.is_pro {
                        settings.is_pro = true;
                        write_settings(&app, settings);
                    }
                }
            }
            Ok(current_state(&app))
        }
        Err(LicenseError::InvalidKey) | Err(LicenseError::Revoked) => {
            license::clear_credentials();
            let mut settings = get_settings(&app);
            settings.is_pro = false;
            write_settings(&app, settings);
            Ok(current_state(&app))
        }
        Err(LicenseError::NetworkError { .. }) => {
            // Keep is_pro flag if existing token is still within hard expiry.
            match license::verify_token(&token) {
                Ok(_) => Ok(current_state(&app)),
                Err(_) => {
                    license::clear_credentials();
                    let mut settings = get_settings(&app);
                    settings.is_pro = false;
                    write_settings(&app, settings);
                    Ok(current_state(&app))
                }
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_license_state(app: AppHandle) -> LicenseState {
    current_state(&app)
}

#[tauri::command]
#[specta::specta]
pub async fn get_device_list(_app: AppHandle) -> Result<StatusResponse, LicenseError> {
    let Some((key, _token)) = license::load_key_and_token() else {
        return Err(LicenseError::NotActivated);
    };
    license::status(&key).await
}

#[tauri::command]
#[specta::specta]
pub async fn activate_from_session(
    app: AppHandle,
    session_id: String,
) -> Result<LicenseState, LicenseError> {
    let BySession { key, .. } = license::by_session(&session_id).await?;
    activate_license(app, key).await
}

#[tauri::command]
#[specta::specta]
pub fn open_payment_link(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(PAYMENT_LINK, None::<String>)
        .map_err(|e| format!("Failed to open payment link: {}", e))
}
