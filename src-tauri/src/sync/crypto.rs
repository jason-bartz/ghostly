//! End-to-end encryption for synced records.
//!
//! # The guarantee
//!
//! The server stores opaque blobs. It never sees a key, a passphrase, or a
//! plaintext, and it cannot be compelled to produce any of them because it has
//! never held them. That is the only property here worth defending, and every
//! decision below serves it.
//!
//! # Key derivation
//!
//! Argon2id over a user-chosen passphrase and a random per-account salt. The
//! salt is not a secret and is stored server-side so a new Mac can derive the
//! same key from the same passphrase; the passphrase is never transmitted, in
//! any form, including hashed.
//!
//! The cost parameters are deliberately above the crate defaults. Derivation
//! happens when sync is set up and when a new device joins — twice in a user's
//! life, not per request — so a second of CPU is free to us and expensive to
//! anyone brute-forcing a stolen blob store.
//!
//! # Forgetting the passphrase means losing the data
//!
//! There is no recovery path, no escrow, no reset link. That is what "the
//! server cannot read it" costs, and the setup UI has to say so in those words
//! rather than in a footnote.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Argon2id cost. ~64 MiB and 3 passes: comfortably above interactive
/// guidance, and unnoticeable at the frequency this actually runs.
const KDF_MEM_KIB: u32 = 65_536;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 4;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24; // XChaCha20
const KEY_LEN: usize = 32;

/// A derived sync key. Zeroed on drop so it does not linger in freed memory.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SyncKey([u8; KEY_LEN]);

impl std::fmt::Debug for SyncKey {
    /// Never print the key, even by accident in a log line or a panic message.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncKey(<redacted>)")
    }
}

/// Serialise a derived key for the OS keychain.
///
/// Only ever handed to `keychain::set_secret`. The passphrase it came from is
/// never stored anywhere, in any form.
pub fn export_key(key: &SyncKey) -> String {
    B64.encode(key.0)
}

/// Read a key back out of the keychain.
pub fn import_key(encoded: &str) -> Option<SyncKey> {
    let bytes = B64.decode(encoded).ok()?;
    let arr: [u8; KEY_LEN] = bytes.try_into().ok()?;
    Some(SyncKey(arr))
}

/// A fresh random salt, base64 for storage.
pub fn new_salt() -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    B64.encode(salt)
}

/// Derive the sync key from a passphrase and the account's salt.
pub fn derive_key(passphrase: &str, salt_b64: &str) -> Result<SyncKey, String> {
    let salt = B64
        .decode(salt_b64)
        .map_err(|_| "The sync salt is corrupt.".to_string())?;
    if salt.len() < SALT_LEN {
        return Err("The sync salt is too short.".to_string());
    }

    let params = Params::new(KDF_MEM_KIB, KDF_ITERATIONS, KDF_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| format!("Bad KDF parameters: {}", e))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {}", e))?;
    Ok(SyncKey(key))
}

/// Encrypt `plaintext`, binding it to `record_id`.
///
/// The record id is authenticated but not encrypted, so a server that swaps
/// one user's blob into another record — or replays an old blob under a new
/// id — produces a decryption failure rather than silently wrong data. The
/// server cannot read anything either way; this stops it *rearranging* things.
///
/// Wire format: `base64(nonce || ciphertext)`.
pub fn seal(key: &SyncKey, record_id: &str, plaintext: &[u8]) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(key.0.as_ref().into());

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: record_id.as_bytes(),
            },
        )
        .map_err(|_| "Encryption failed.".to_string())?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypt a blob produced by [`seal`] for the same `record_id`.
///
/// A wrong passphrase, a tampered blob, and a blob moved to a different record
/// are all the same error here — authenticated encryption cannot tell them
/// apart, and the caller should not pretend otherwise to the user.
pub fn open(key: &SyncKey, record_id: &str, blob_b64: &str) -> Result<Vec<u8>, String> {
    let raw = B64
        .decode(blob_b64)
        .map_err(|_| "This record is corrupt.".to_string())?;
    if raw.len() <= NONCE_LEN {
        return Err("This record is truncated.".to_string());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.0.as_ref().into());

    cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: record_id.as_bytes(),
            },
        )
        .map_err(|_| "Could not decrypt — wrong passphrase, or the record was altered.".to_string())
}

/// A value that proves a passphrase matches the account's, without revealing
/// it and without the server learning anything usable.
///
/// It is simply a known constant sealed under the derived key. A second Mac
/// derives its key from what the user typed and tries to open this; success
/// means the passphrases match. The server stores it as one more opaque blob
/// and can verify nothing itself, which is the point — it must not be able to
/// mount an offline guessing attack any cheaper than against the real data.
pub const VERIFIER_PLAINTEXT: &[u8] = b"ghostly-sync-v1";
pub const VERIFIER_RECORD_ID: &str = "__verifier__";

pub fn make_verifier(key: &SyncKey) -> Result<String, String> {
    seal(key, VERIFIER_RECORD_ID, VERIFIER_PLAINTEXT)
}

pub fn check_verifier(key: &SyncKey, verifier_b64: &str) -> bool {
    matches!(
        open(key, VERIFIER_RECORD_ID, verifier_b64),
        Ok(v) if v == VERIFIER_PLAINTEXT
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_for(pass: &str, salt: &str) -> SyncKey {
        derive_key(pass, salt).expect("derives")
    }

    #[test]
    fn round_trips() {
        let salt = new_salt();
        let key = key_for("correct horse battery staple", &salt);
        let sealed = seal(&key, "vocab:1", b"Kubernetes").unwrap();
        assert_eq!(open(&key, "vocab:1", &sealed).unwrap(), b"Kubernetes");
    }

    #[test]
    fn the_same_passphrase_and_salt_derive_the_same_key() {
        // The whole new-device flow depends on this.
        let salt = new_salt();
        let a = key_for("hunter2 hunter2", &salt);
        let b = key_for("hunter2 hunter2", &salt);
        let sealed = seal(&a, "r", b"payload").unwrap();
        assert_eq!(open(&b, "r", &sealed).unwrap(), b"payload");
    }

    #[test]
    fn a_different_salt_derives_a_different_key() {
        let sealed = seal(&key_for("same passphrase", &new_salt()), "r", b"x").unwrap();
        let other = key_for("same passphrase", &new_salt());
        assert!(open(&other, "r", &sealed).is_err());
    }

    #[test]
    fn the_wrong_passphrase_cannot_decrypt() {
        let salt = new_salt();
        let sealed = seal(&key_for("right passphrase", &salt), "r", b"secret").unwrap();
        assert!(open(&key_for("wrong passphrase", &salt), "r", &sealed).is_err());
    }

    #[test]
    fn a_blob_moved_to_another_record_will_not_open() {
        // A server that shuffles blobs between records must produce an error,
        // not plausible-looking wrong data.
        let salt = new_salt();
        let key = key_for("pass", &salt);
        let sealed = seal(&key, "vocab:1", b"Kubernetes").unwrap();
        assert!(open(&key, "vocab:2", &sealed).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let salt = new_salt();
        let key = key_for("pass", &salt);
        let sealed = seal(&key, "r", b"the original value").unwrap();

        let mut raw = B64.decode(&sealed).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(open(&key, "r", &B64.encode(raw)).is_err());
    }

    #[test]
    fn nonces_do_not_repeat_across_seals() {
        // Reusing a nonce under one key is the classic way to destroy a stream
        // cipher's confidentiality, so identical plaintexts must not produce
        // identical blobs.
        let salt = new_salt();
        let key = key_for("pass", &salt);
        let a = seal(&key, "r", b"same").unwrap();
        let b = seal(&key, "r", b"same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn the_verifier_accepts_only_the_right_passphrase() {
        let salt = new_salt();
        let verifier = make_verifier(&key_for("the passphrase", &salt)).unwrap();
        assert!(check_verifier(&key_for("the passphrase", &salt), &verifier));
        assert!(!check_verifier(&key_for("not it", &salt), &verifier));
    }

    #[test]
    fn garbage_input_is_an_error_not_a_panic() {
        let key = key_for("pass", &new_salt());
        assert!(open(&key, "r", "not base64!!").is_err());
        assert!(open(&key, "r", "").is_err());
        assert!(open(&key, "r", &B64.encode([0u8; 8])).is_err());
        assert!(derive_key("pass", "not base64!!").is_err());
    }

    #[test]
    fn a_key_survives_the_keychain_round_trip() {
        let salt = new_salt();
        let key = key_for("pass", &salt);
        let restored = import_key(&export_key(&key)).expect("imports");
        let sealed = seal(&key, "r", b"x").unwrap();
        assert_eq!(open(&restored, "r", &sealed).unwrap(), b"x");
        assert!(import_key("nonsense").is_none());
    }

    #[test]
    fn the_key_never_prints_itself() {
        let key = key_for("pass", &new_salt());
        assert_eq!(format!("{:?}", key), "SyncKey(<redacted>)");
    }
}
