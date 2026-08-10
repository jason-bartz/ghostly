//! Encrypted sync across a user's Macs.
//!
//! Vocabulary, word corrections, prompts, profiles and correction phrases —
//! carried between machines without the server ever being able to read them.
//!
//! - [`crypto`] holds the passphrase-derived key and the sealed envelope.
//! - [`records`] holds what a syncable item is and how two devices agree.
//! - [`bridge`] maps `AppSettings` collections to records and back.

pub mod bridge;
pub mod crypto;
pub mod engine;
pub mod records;
pub mod transport;
