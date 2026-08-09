//! Shared Meeting Mode types.
//!
//! Everything crossing the Tauri boundary derives `specta::Type` so the
//! TypeScript bindings stay generated rather than hand-written.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which capture lane a segment came from.
///
/// This is the cheapest speaker signal available: the microphone is definitionally
/// the user, the system tap is definitionally everyone else. Correct two-way
/// attribution with no model involved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    /// Local microphone — the user, plus anyone in the room with them.
    Mic,
    /// System audio tap — remote participants.
    System,
}

impl Lane {
    pub fn as_str(self) -> &'static str {
        match self {
            Lane::Mic => "mic",
            Lane::System => "system",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "system" => Lane::System,
            _ => Lane::Mic,
        }
    }
}

/// What kind of participant a speaker row represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerKind {
    /// The user. Always exactly one per meeting, always the mic lane.
    Me,
    /// A participant the user has named.
    Named,
    /// A distinct voice we can separate but cannot name.
    Unknown,
}

impl SpeakerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SpeakerKind::Me => "me",
            SpeakerKind::Named => "named",
            SpeakerKind::Unknown => "unknown",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "me" => SpeakerKind::Me,
            "named" => SpeakerKind::Named,
            _ => SpeakerKind::Unknown,
        }
    }
}

/// How a segment came to be attributed to its speaker. Drives whether the UI
/// presents a label as fact or as a guess, and protects manual labels from
/// being overwritten by the end-of-meeting re-clustering pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LabelSource {
    /// Implied by the capture lane. Certain.
    LaneDefault,
    /// Grouped by voice-embedding similarity. Provisional.
    Cluster,
    /// Matched against a stored voiceprint. Provisional but stronger.
    Voiceprint,
    /// The user said so. Authoritative — never overwritten.
    Manual,
}

impl LabelSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LabelSource::LaneDefault => "lane",
            LabelSource::Cluster => "cluster",
            LabelSource::Voiceprint => "voiceprint",
            LabelSource::Manual => "manual",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "cluster" => LabelSource::Cluster,
            "voiceprint" => LabelSource::Voiceprint,
            "manual" => LabelSource::Manual,
            _ => LabelSource::LaneDefault,
        }
    }
}

/// How a meeting capture was initiated. Recorded per meeting so the consent
/// story is auditable after the fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DetectionSource {
    /// The user pressed start.
    Manual,
    /// Detected and confirmed through the prompt.
    Prompted,
    /// Detected and started by the countdown.
    AutoConnect,
}

impl DetectionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DetectionSource::Manual => "manual",
            DetectionSource::Prompted => "prompted",
            DetectionSource::AutoConnect => "auto",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "prompted" => DetectionSource::Prompted,
            "auto" => DetectionSource::AutoConnect,
            _ => DetectionSource::Manual,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: Option<String>,
    /// Unix seconds.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub app_bundle_id: Option<String>,
    pub app_display_name: Option<String>,
    pub detection_source: DetectionSource,
    /// False when the far side was not captured — the transcript is the user's
    /// side only, and the UI must say so.
    pub captured_system_audio: bool,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeaker {
    pub id: String,
    pub meeting_id: String,
    pub display_name: Option<String>,
    pub kind: SpeakerKind,
    pub lane: Lane,
    /// Index of the embedding cluster this speaker corresponds to, when
    /// diarization produced it.
    pub cluster_index: Option<i64>,
    pub voiceprint_id: Option<String>,
    /// Set when the user named or reassigned this speaker.
    pub pinned: bool,
    /// Stable index into the UI's speaker palette.
    pub color_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegment {
    pub id: i64,
    pub meeting_id: String,
    pub speaker_id: Option<String>,
    pub lane: Lane,
    /// Milliseconds from the start of the meeting.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub label_source: LabelSource,
    /// Overlapping speech. Never used to create or move a cluster centroid,
    /// because a mixed embedding is meaningless.
    pub is_crosstalk: bool,
}

/// A segment before it has been written to the database.
#[derive(Debug, Clone)]
pub struct NewSegment {
    pub speaker_id: Option<String>,
    pub lane: Lane,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub label_source: LabelSource,
    pub is_crosstalk: bool,
    /// Speaker embedding, when diarization is active.
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SummaryKind {
    /// Background summary of a fixed window, produced as the meeting runs.
    Rolling,
    /// User-requested "catch me up".
    CatchUp,
    /// End-of-meeting wrap-up.
    Final,
}

impl SummaryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SummaryKind::Rolling => "rolling",
            SummaryKind::CatchUp => "catch_up",
            SummaryKind::Final => "final",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "catch_up" => SummaryKind::CatchUp,
            "final" => SummaryKind::Final,
            _ => SummaryKind::Rolling,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummary {
    pub id: i64,
    pub meeting_id: String,
    pub created_at: i64,
    pub covers_from_ms: i64,
    pub covers_to_ms: i64,
    pub kind: SummaryKind,
    pub body: String,
}

/// Snapshot of the live capture session, polled by the panel on mount and
/// pushed on every change.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatus {
    pub active: bool,
    pub meeting_id: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<i64>,
    /// True when the far-side lane is actually running. False means mic-only,
    /// which the panel surfaces explicitly rather than silently degrading.
    pub system_audio_active: bool,
    pub app_display_name: Option<String>,
    /// Populated when the system lane failed to start, so the UI can explain
    /// why the transcript is one-sided.
    pub system_audio_error: Option<String>,
    /// Capture is open but ignoring audio.
    pub paused: bool,
}

impl Default for MeetingStatus {
    fn default() -> Self {
        Self {
            active: false,
            meeting_id: None,
            title: None,
            started_at: None,
            system_audio_active: false,
            app_display_name: None,
            system_audio_error: None,
            paused: false,
        }
    }
}

/// Emitted whenever a segment is committed, so the panel can append without
/// re-querying.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegmentEvent {
    pub segment: MeetingSegment,
    pub speaker: Option<MeetingSpeaker>,
}

/// Emitted when a call is detected and the user must choose, or a countdown is
/// running.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectedEvent {
    pub bundle_id: String,
    pub display_name: String,
    /// Seconds remaining before capture starts automatically. `None` means the
    /// user must confirm explicitly.
    pub countdown_secs: Option<u32>,
}

/// Emitted when a remote speaker appears to address the user by name.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMentionEvent {
    pub meeting_id: String,
    pub text: String,
    pub speaker_name: Option<String>,
}

/// Emitted when the capture session starts or stops.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatusEvent {
    pub status: MeetingStatus,
}
