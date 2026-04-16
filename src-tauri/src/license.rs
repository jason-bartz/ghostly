//! License activation, validation, and token verification.
//!
//! Talks to the Ghostly license worker (a Cloudflare Workers deployment) over
//! HTTPS and verifies the returned Ed25519-signed tokens offline using a
//! hard-coded public key. Credentials (license key + most recent token) are
//! persisted to the macOS Keychain.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use keyring::Entry;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

pub const PUBLIC_KEY_HEX: &str = "edb85e3473155524e63647805e0a3f1eb0c2a09aead12813b29d43e5732e18bc";

pub const DEFAULT_BASE: &str = "https://ghostly-license-server.aged-art-e321.workers.dev";

const KEYCHAIN_SERVICE: &str = "com.getghostly.desktop.license";
const KEYCHAIN_ACCOUNT: &str = "default";

/// Absolute grace period: after `expires_at`, the token is still considered
/// acceptable for offline use for this many seconds, after which it is a hard
/// reject regardless of network reachability.
const OFFLINE_GRACE_SECS: u64 = 30 * 86400;

static VERIFY_KEY: Lazy<VerifyingKey> = Lazy::new(|| {
    let bytes = hex::decode(PUBLIC_KEY_HEX).expect("valid hex public key");
    let arr: [u8; 32] = bytes.as_slice().try_into().expect("32-byte public key");
    VerifyingKey::from_bytes(&arr).expect("valid Ed25519 public key")
});

static MACHINE_ID_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn base_url() -> String {
    std::env::var("GHOSTLY_LICENSE_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LicenseError {
    InvalidKey,
    Revoked,
    DeviceLimitReached {
        limit: u32,
        active_devices: Vec<ActiveDevice>,
    },
    NotActivated,
    NetworkError {
        message: String,
    },
    InvalidToken,
    NotReady,
}

impl std::fmt::Display for LicenseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LicenseError::InvalidKey => write!(f, "invalid license key"),
            LicenseError::Revoked => write!(f, "license revoked"),
            LicenseError::DeviceLimitReached { limit, .. } => {
                write!(f, "device limit reached ({})", limit)
            }
            LicenseError::NotActivated => write!(f, "no license activated"),
            LicenseError::NetworkError { message } => write!(f, "network error: {}", message),
            LicenseError::InvalidToken => write!(f, "invalid token"),
            LicenseError::NotReady => write!(f, "not ready"),
        }
    }
}

impl std::error::Error for LicenseError {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActiveDevice {
    pub machine_id: Option<String>,
    #[serde(default)]
    pub machine_name: Option<String>,
    pub activated_at: Option<i64>,
    pub last_validated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TokenPayload {
    pub key: String,
    pub email: String,
    pub machine_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub product_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivateResponseRaw {
    token: String,
    email: String,
}

#[derive(Debug, Deserialize)]
struct ValidateResponseRaw {
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct StatusResponse {
    pub email: String,
    pub created_at: Option<i64>,
    pub revoked: bool,
    pub active_devices: Vec<ActiveDevice>,
}

#[derive(Debug, Deserialize)]
struct BySessionRaw {
    key: String,
    email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BySession {
    pub key: String,
    pub email: String,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    active_devices: Option<Vec<ActiveDevice>>,
}

fn parse_error_status(status: u16, body: &str) -> LicenseError {
    let parsed: Option<ErrorBody> = serde_json::from_str(body).ok();
    let err_code = parsed
        .as_ref()
        .and_then(|b| b.error.clone())
        .unwrap_or_default();
    match (status, err_code.as_str()) {
        (404, "invalid_key") | (404, _) => LicenseError::InvalidKey,
        (403, "revoked") => LicenseError::Revoked,
        (403, _) => LicenseError::Revoked,
        (409, "device_limit_reached") => LicenseError::DeviceLimitReached {
            limit: parsed.as_ref().and_then(|b| b.limit).unwrap_or(3),
            active_devices: parsed
                .as_ref()
                .and_then(|b| b.active_devices.clone())
                .unwrap_or_default(),
        },
        (409, _) => LicenseError::DeviceLimitReached {
            limit: 3,
            active_devices: vec![],
        },
        _ => LicenseError::NetworkError {
            message: format!("http {}: {}", status, body),
        },
    }
}

// ---------------- Token verification ----------------

pub fn verify_token(token: &str) -> Result<TokenPayload, LicenseError> {
    let mut parts = token.split('.');
    let payload_b64 = parts.next().ok_or(LicenseError::InvalidToken)?;
    let sig_b64 = parts.next().ok_or(LicenseError::InvalidToken)?;
    if parts.next().is_some() {
        return Err(LicenseError::InvalidToken);
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| LicenseError::InvalidToken)?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| LicenseError::InvalidToken)?;

    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| LicenseError::InvalidToken)?;
    let signature = Signature::from_bytes(&sig_arr);

    VERIFY_KEY
        .verify(&payload_bytes, &signature)
        .map_err(|_| LicenseError::InvalidToken)?;

    let payload: TokenPayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| LicenseError::InvalidToken)?;

    // Hard reject tokens past their expiry + offline grace period.
    let now = chrono::Utc::now().timestamp();
    if now > payload.expires_at.saturating_add(OFFLINE_GRACE_SECS as i64) {
        return Err(LicenseError::InvalidToken);
    }

    Ok(payload)
}

/// True when the token is within the strict `expires_at` window (not yet
/// requiring a re-validate). When stale-but-within-grace, callers may still
/// trust it if the network is unreachable.
pub fn token_is_fresh(payload: &TokenPayload) -> bool {
    chrono::Utc::now().timestamp() < payload.expires_at
}

// ---------------- Machine identity ----------------

pub fn machine_id() -> String {
    {
        let guard = MACHINE_ID_CACHE.lock().unwrap();
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }

    let uuid = raw_hw_uuid().unwrap_or_else(|| {
        // Fallback: hash hostname. Still stable on a given machine.
        machine_name()
    });

    let mut hasher = Sha256::new();
    hasher.update(uuid.as_bytes());
    let hex_digest = hex::encode(hasher.finalize());

    let mut guard = MACHINE_ID_CACHE.lock().unwrap();
    *guard = Some(hex_digest.clone());
    hex_digest
}

#[cfg(target_os = "macos")]
fn raw_hw_uuid() -> Option<String> {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformUUID") {
            // line looks like:  "IOPlatformUUID" = "XXXXXXXX-XXXX-..."
            if let Some(start) = line.rfind('=') {
                let tail = line[start + 1..].trim();
                let trimmed = tail.trim_matches('"').trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn raw_hw_uuid() -> Option<String> {
    None
}

pub fn machine_name() -> String {
    if let Ok(output) = Command::new("scutil")
        .arg("--get")
        .arg("ComputerName")
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Ok(output) = Command::new("hostname").output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "Mac".to_string()
}

// ---------------- Keychain storage ----------------

fn entry() -> Option<Entry> {
    match Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(e) => Some(e),
        Err(err) => {
            log::warn!("License keychain entry open failed: {}", err);
            None
        }
    }
}

pub fn store_key_and_token(key: &str, token: &str) -> bool {
    let Some(e) = entry() else {
        return false;
    };
    let combined = format!("{}\x1e{}", key, token);
    match e.set_password(&combined) {
        Ok(()) => true,
        Err(err) => {
            log::warn!("Failed to store license in keychain: {}", err);
            false
        }
    }
}

pub fn load_key_and_token() -> Option<(String, String)> {
    let e = entry()?;
    match e.get_password() {
        Ok(s) => {
            let mut parts = s.splitn(2, '\x1e');
            let k = parts.next()?.to_string();
            let t = parts.next()?.to_string();
            Some((k, t))
        }
        Err(keyring::Error::NoEntry) => None,
        Err(err) => {
            log::warn!("Failed to load license from keychain: {}", err);
            None
        }
    }
}

pub fn clear_credentials() {
    if let Some(e) = entry() {
        let _ = e.delete_password();
    }
}

// ---------------- Helpers ----------------

pub fn mask_key(key: &str) -> String {
    // Expected shape: GHOSTLY-XXXX-XXXX-XXXX (four groups). Keep first segment
    // intact + last group for visual identification.
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() < 2 {
        return key.to_string();
    }
    let last = parts[parts.len() - 1];
    let mut masked = String::new();
    masked.push_str(parts[0]);
    for p in &parts[1..parts.len() - 1] {
        masked.push('-');
        for _ in 0..p.len() {
            masked.push('*');
        }
    }
    masked.push('-');
    masked.push_str(last);
    masked
}

// ---------------- Worker HTTP calls ----------------

pub async fn activate(key: &str, mid: &str, mname: &str) -> Result<(String, String), LicenseError> {
    let url = format!("{}/license/activate", base_url());
    let resp = http()
        .post(&url)
        .json(&serde_json::json!({
            "key": key,
            "machine_id": mid,
            "machine_name": mname,
        }))
        .send()
        .await
        .map_err(|e| LicenseError::NetworkError {
            message: e.to_string(),
        })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        let parsed: ActivateResponseRaw =
            serde_json::from_str(&body).map_err(|_| LicenseError::InvalidToken)?;
        Ok((parsed.token, parsed.email))
    } else {
        Err(parse_error_status(status, &body))
    }
}

pub async fn validate(key: &str, mid: &str) -> Result<String, LicenseError> {
    let url = format!("{}/license/validate", base_url());
    let resp = http()
        .post(&url)
        .json(&serde_json::json!({ "key": key, "machine_id": mid }))
        .send()
        .await
        .map_err(|e| LicenseError::NetworkError {
            message: e.to_string(),
        })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        let parsed: ValidateResponseRaw =
            serde_json::from_str(&body).map_err(|_| LicenseError::InvalidToken)?;
        Ok(parsed.token)
    } else {
        Err(parse_error_status(status, &body))
    }
}

pub async fn deactivate(key: &str, mid: &str) -> Result<(), LicenseError> {
    let url = format!("{}/license/deactivate", base_url());
    let resp = http()
        .post(&url)
        .json(&serde_json::json!({ "key": key, "machine_id": mid }))
        .send()
        .await
        .map_err(|e| LicenseError::NetworkError {
            message: e.to_string(),
        })?;
    let status = resp.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(parse_error_status(status, &body))
    }
}

pub async fn status(key: &str) -> Result<StatusResponse, LicenseError> {
    let url = format!("{}/license/status?key={}", base_url(), urlencode(key));
    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| LicenseError::NetworkError {
            message: e.to_string(),
        })?;
    let status_code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status_code == 200 {
        serde_json::from_str::<StatusResponse>(&body).map_err(|e| LicenseError::NetworkError {
            message: format!("bad status payload: {}", e),
        })
    } else {
        Err(parse_error_status(status_code, &body))
    }
}

pub async fn by_session(session_id: &str) -> Result<BySession, LicenseError> {
    let url = format!("{}/license/by-session", base_url());
    let resp = http()
        .post(&url)
        .json(&serde_json::json!({ "session_id": session_id }))
        .send()
        .await
        .map_err(|e| LicenseError::NetworkError {
            message: e.to_string(),
        })?;
    let status_code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status_code == 200 {
        let raw: BySessionRaw =
            serde_json::from_str(&body).map_err(|_| LicenseError::NetworkError {
                message: "bad by-session payload".into(),
            })?;
        Ok(BySession {
            key: raw.key,
            email: raw.email,
        })
    } else if status_code == 404 {
        Err(LicenseError::NotReady)
    } else {
        Err(parse_error_status(status_code, &body))
    }
}

fn urlencode(s: &str) -> String {
    // Minimal URL-encoding for the subset of characters that can appear in
    // a license key (alphanumerics and dashes). Avoids pulling in a full
    // percent-encoding crate.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}
