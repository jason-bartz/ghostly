//! Encrypted sync across a user's Macs.
//!
//! Vocabulary, word corrections, prompts, profiles and correction phrases —
//! carried between machines without the server ever being able to read them.
//!
//! - [`crypto`] holds the passphrase-derived key and the sealed envelope.
//! - [`records`] holds what a syncable item is and how two devices agree.
//!
//! Transport and the settings-store bridge are not built yet; see
//! `docs/GHOSTLY-MAX.md` for what remains.

pub mod crypto;
pub mod records;
