//! Meeting Mode — live dual-lane meeting transcription.
//!
//! Ghostly does not join the call. It captures the microphone (the user) and,
//! via a CoreAudio process tap, the system audio mix (everyone else), then
//! transcribes both onto a shared timeline. Nothing leaves the device unless
//! the user explicitly opts into cloud summarisation or cloud refinement.
//!
//! | Module | Responsibility |
//! | --- | --- |
//! | [`types`] | Shared types crossing the Tauri boundary |
//! | [`store`] | SQLite persistence |
//! | [`lane`] | Per-lane VAD segmentation |
//! | [`dedup`] | Cross-lane echo suppression |
//! | [`speakers`] | Speaker attribution and clustering |
//! | [`session`] | The capture engine |
//! | [`refine`] | AI cleanup of live transcript blocks |
//! | [`summarizer`] | "Catch me up" |
//! | [`notes`] | The notepad, and the AI pass that finishes it |
//! | [`detector`] | Auto-connect |
//! | [`platform`] | Which service a call is on, including in a browser tab |
//! | [`title`] | The default `"{platform} meeting - {MM/DD/YY}"` name |
//! | [`mentions`] | Direct-address alerts |

pub mod dedup;
pub mod detector;
pub mod lane;
pub mod mentions;
pub mod notes;
pub mod panel;
pub mod platform;
pub mod refine;
pub mod session;
pub mod speakers;
pub mod store;
pub mod summarizer;
pub mod title;
pub mod types;

pub use session::MeetingManager;
pub use store::MeetingStore;
