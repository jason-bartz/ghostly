//! Thin wrapper around the OS keychain (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service) for storing LLM provider API keys.
//!
//! All functions are defensive: if the OS keychain is unavailable or returns
//! an error, they log and return gracefully. Callers must be prepared for
//! failure and fall back to plaintext storage so the app remains usable on
//! platforms or configurations where the keychain can't be reached.

use keyring::Entry;
use log::{debug, warn};

const SERVICE: &str = "computer.ghostly.api_keys";

fn entry(provider_id: &str) -> Option<Entry> {
    match Entry::new(SERVICE, provider_id) {
        Ok(e) => Some(e),
        Err(err) => {
            warn!(
                "Failed to open keychain entry for provider '{}': {}",
                provider_id, err
            );
            None
        }
    }
}

/// Store an API key for `provider_id`. Returns true on success.
pub fn set_api_key(provider_id: &str, key: &str) -> bool {
    let Some(e) = entry(provider_id) else {
        return false;
    };
    match e.set_password(key) {
        Ok(()) => {
            debug!("Saved API key for '{}' to OS keychain", provider_id);
            true
        }
        Err(err) => {
            warn!(
                "Failed to save API key for '{}' to keychain: {}",
                provider_id, err
            );
            false
        }
    }
}

/// Retrieve an API key for `provider_id`. Returns None if no entry exists,
/// the keychain is unavailable, or reading failed.
pub fn get_api_key(provider_id: &str) -> Option<String> {
    let e = entry(provider_id)?;
    match e.get_password() {
        Ok(pw) => Some(pw),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => {
            warn!(
                "Failed to read API key for '{}' from keychain: {}",
                provider_id, err
            );
            None
        }
    }
}

/// Delete an API key entry. Silently no-ops if the entry doesn't exist.
pub fn delete_api_key(provider_id: &str) {
    if let Some(e) = entry(provider_id) {
        let _ = e.delete_password();
    }
}
