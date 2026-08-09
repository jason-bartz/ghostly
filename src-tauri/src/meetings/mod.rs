//! Meeting Mode — live dual-lane meeting transcription.
//!
//! Ghostly does not join the call. It captures the microphone (the user) and,
//! via a CoreAudio process tap, the system audio mix (everyone else), then
//! transcribes both onto a shared timeline. Nothing leaves the device unless
//! the user explicitly opts into cloud summarisation.
//!
//! | Module | Responsibility |
//! | --- | --- |
//! | [`types`] | Shared types crossing the Tauri boundary |
//! | [`store`] | SQLite persistence |
//! | [`lane`] | Per-lane VAD segmentation |
//! | [`dedup`] | Cross-lane echo suppression |
//! | [`speakers`] | Speaker attribution and clustering |
//! | [`session`] | The capture engine |
//! | [`summarizer`] | "Catch me up" |
//! | [`detector`] | Auto-connect |
//! | [`mentions`] | Direct-address alerts |

pub mod dedup;
pub mod detector;
pub mod lane;
pub mod mentions;
pub mod panel;
pub mod session;
pub mod speakers;
pub mod store;
pub mod summarizer;
pub mod types;

pub use session::MeetingManager;
pub use store::MeetingStore;
