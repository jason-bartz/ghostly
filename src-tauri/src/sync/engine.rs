//! Setting up, unlocking, and running a sync.
//!
//! # Where the key lives
//!
//! Derived from the passphrase, then kept in the OS keychain — never the
//! passphrase itself, and never on disk in the settings store. Argon2id at
//! these parameters takes about a second, which is right for a login and wrong
//! for every app launch.
//!
//! Losing the keychain entry costs the user one passphrase prompt. Losing the
//! passphrase costs them the data, and nothing here can change that.
//!
//! # Order of operations
//!
//! Pull, merge, apply, then push. Pulling first means a device that has been
//! away sees the world before it argues with it, and the push that follows
//! carries the merged result rather than a stale local view.

use crate::settings::{get_settings, write_settings};
use crate::sync::bridge;
use crate::sync::crypto::{self, SyncKey};
use crate::sync::records::{merge, Record};
use crate::sync::transport::{self, WireRecord};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

const KEYCHAIN_ACCOUNT: &str = "sync";

/// What the UI needs to render the sync pane.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncStatus {
    /// The user turned sync on for this Mac.
    pub enabled: bool,
    /// The account has key material on the server.
    pub set_up: bool,
    /// This Mac holds the derived key, so it can actually sync.
    pub unlocked: bool,
    /// Unix ms of the last successful sync, 0 if never.
    pub last_synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncOutcome {
    pub pulled: usize,
    pub pushed: usize,
    pub applied: usize,
}

fn store_key(key: &crypto::SyncKey) -> Result<(), String> {
    crate::keychain::set_secret(KEYCHAIN_ACCOUNT, &crypto::export_key(key))
        .then_some(())
        .ok_or_else(|| "Couldn't save the sync key to the keychain.".to_string())
}

fn load_key() -> Option<SyncKey> {
    crypto::import_key(&crate::keychain::get_secret(KEYCHAIN_ACCOUNT)?)
}

fn forget_key() {
    crate::keychain::delete_secret(KEYCHAIN_ACCOUNT);
}

/// Turn sync on for this account for the first time.
///
/// Fails rather than overwriting if the account already has key material —
/// that would orphan every record already stored under the old key, and the
/// user would see an empty sync rather than an error.
pub async fn setup(app: &AppHandle, passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < 8 {
        return Err("Use at least 8 characters.".to_string());
    }
    if transport::get_meta().await?.is_some() {
        return Err(
            "This account already has sync set up. Enter the existing passphrase instead."
                .to_string(),
        );
    }

    let salt = crypto::new_salt();
    let key = crypto::derive_key(passphrase, &salt)?;
    let verifier = crypto::make_verifier(&key)?;

    transport::create_meta(&salt, &verifier).await?;
    store_key(&key)?;

    let mut settings = get_settings(app);
    settings.sync_enabled = true;
    settings.sync_salt = Some(salt);
    settings.sync_watermark_ms = 0;
    write_settings(app, settings);

    info!("Sync set up for this account");
    Ok(())
}

/// Join an account that already has sync, from a second Mac.
pub async fn unlock(app: &AppHandle, passphrase: &str) -> Result<(), String> {
    let meta = transport::get_meta()
        .await?
        .ok_or("Sync isn't set up for this account yet.")?;

    let key = crypto::derive_key(passphrase, &meta.salt)?;
    if !crypto::check_verifier(&key, &meta.verifier) {
        return Err("That passphrase doesn't match this account.".to_string());
    }
    store_key(&key)?;

    let mut settings = get_settings(app);
    settings.sync_enabled = true;
    settings.sync_salt = Some(meta.salt);
    // A new device has seen nothing, so it must pull from the beginning.
    settings.sync_watermark_ms = 0;
    write_settings(app, settings);

    info!("Sync unlocked on this Mac");
    Ok(())
}

pub fn status(app: &AppHandle) -> SyncStatus {
    let settings = get_settings(app);
    SyncStatus {
        enabled: settings.sync_enabled,
        set_up: settings.sync_salt.is_some(),
        unlocked: load_key().is_some(),
        last_synced_at: settings.sync_last_synced_ms,
    }
}

/// Stop syncing this Mac and forget its key.
///
/// Local data is untouched — turning sync off must never look like a delete.
/// The account's records stay on the server for the user's other Macs.
pub fn disable(app: &AppHandle) {
    forget_key();
    let mut settings = get_settings(app);
    settings.sync_enabled = false;
    settings.sync_watermark_ms = 0;
    write_settings(app, settings);
}

/// Wipe the account's sync data and key material entirely.
///
/// The only way to change a passphrase, and the user's escape hatch. Local
/// data survives; it is the server copy that goes.
pub async fn reset(app: &AppHandle) -> Result<(), String> {
    transport::reset().await?;
    forget_key();
    let mut settings = get_settings(app);
    settings.sync_enabled = false;
    settings.sync_salt = None;
    settings.sync_watermark_ms = 0;
    settings.sync_last_synced_ms = 0;
    write_settings(app, settings);
    Ok(())
}

/// One full cycle: pull, merge, apply locally, push what this Mac knows.
pub async fn run(app: &AppHandle) -> Result<SyncOutcome, String> {
    let settings = get_settings(app);
    if !settings.sync_enabled {
        return Err("Sync is off on this Mac.".to_string());
    }
    let key = load_key().ok_or("Sync is locked. Enter your passphrase.")?;

    // ── Pull ────────────────────────────────────────────────────────────
    let pulled = transport::pull(settings.sync_watermark_ms).await?;
    let mut remote: Vec<Record> = Vec::new();
    for wire in &pulled.records {
        match &wire.blob {
            None => remote.push(Record {
                id: wire.id.clone(),
                kind: kind_of(&wire.id),
                updated_at: wire.updated_at,
                payload: None,
            }),
            Some(blob) => match crypto::open(&key, &wire.id, blob) {
                Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(payload) => remote.push(Record {
                        id: wire.id.clone(),
                        kind: kind_of(&wire.id),
                        updated_at: wire.updated_at,
                        payload: Some(payload),
                    }),
                    Err(e) => warn!("Sync: undecodable record {}: {}", wire.id, e),
                },
                // One bad record must not fail the whole sync — a single
                // corrupt blob would otherwise wedge the account forever.
                Err(e) => warn!("Sync: could not decrypt {}: {}", wire.id, e),
            },
        }
    }

    // ── Merge and apply ─────────────────────────────────────────────────
    let local = bridge::to_records(&settings, settings.sync_touched_ms);
    let (merged, changed) = merge(local, remote);

    let mut settings = get_settings(app);
    let applied = bridge::apply(&mut settings, &merged);
    settings.sync_watermark_ms = pulled.now;
    settings.sync_last_synced_ms = pulled.now;
    write_settings(app, settings);

    // ── Push ────────────────────────────────────────────────────────────
    //
    // Everything this Mac holds, not just what changed. The server's write is
    // monotonic, so re-sending an unchanged record is a no-op — and sending
    // the full set is what makes a first sync from an established Mac work at
    // all.
    let settings = get_settings(app);
    let to_push = bridge::to_records(&settings, settings.sync_touched_ms);
    let mut wire = Vec::with_capacity(to_push.len());
    for record in &to_push {
        let blob = match &record.payload {
            Some(payload) => {
                let bytes = serde_json::to_vec(payload)
                    .map_err(|e| format!("Couldn't encode a record: {}", e))?;
                Some(crypto::seal(&key, &record.id, &bytes)?)
            }
            None => None,
        };
        wire.push(WireRecord {
            id: record.id.clone(),
            blob,
            updated_at: record.updated_at,
        });
    }
    transport::push(&wire).await?;

    debug!(
        "Sync: pulled {}, applied {}, pushed {}",
        pulled.records.len(),
        applied.total(),
        wire.len()
    );
    Ok(SyncOutcome {
        pulled: pulled.records.len(),
        pushed: wire.len(),
        applied: applied.total(),
    })
}

/// Recover the record kind from its id.
///
/// The kind is not stored server-side on purpose — a `kind` column would tell
/// the server which features each customer uses — so it is read back off the
/// id prefix that the client itself wrote.
fn kind_of(record_id: &str) -> crate::sync::records::RecordKind {
    use crate::sync::records::RecordKind::*;
    match record_id.split(':').next().unwrap_or("") {
        "vocabulary" => Vocabulary,
        "word_correction" => WordCorrection,
        "prompt" => Prompt,
        "profile" => Profile,
        _ => CorrectionPhrase,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::records::RecordKind;

    #[test]
    fn record_kinds_survive_the_round_trip_through_the_id() {
        // The server never stores the kind, so this mapping is the only way
        // back. Getting it wrong silently files records into the wrong
        // collection.
        for kind in [
            RecordKind::Vocabulary,
            RecordKind::WordCorrection,
            RecordKind::Prompt,
            RecordKind::Profile,
            RecordKind::CorrectionPhrase,
        ] {
            let id = crate::sync::records::record_id(kind, "example");
            assert_eq!(kind_of(&id), kind, "id was {}", id);
        }
    }
}
