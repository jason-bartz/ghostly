//! Speaker identity for a meeting.
//!
//! Two layers:
//!
//! 1. **Lane attribution** — the microphone is the user, the system tap is
//!    everyone else. Free, exact, and always applied.
//! 2. **Naming** — the user turns "Participant" into "Sarah", and can merge or
//!    reassign speakers by hand. Authoritative and never overwritten.
//!
//! There used to be a third layer here: online and offline clustering of the
//! far-side lane by voice-embedding similarity, complete with a centroid
//! implementation, a re-clustering pass and an `EmbeddingProvider` seam. None
//! of it ever ran — it needs a speaker-embedding model that is not bundled, so
//! `NewSegment.embedding` is always `None` and every entry point was
//! unreachable. It has been removed rather than left as ~230 lines that read
//! like a working feature. `meeting_segments.embedding` and
//! `meeting_speakers.cluster_index` stay in the schema so the data model does
//! not have to be re-migrated if a model is ever bundled.

use anyhow::Result;

use super::store::MeetingStore;
use super::types::{Lane, MeetingSpeaker, SpeakerKind};

/// Resolves which speaker a segment belongs to, creating rows on demand.
pub struct SpeakerRegistry<'a> {
    store: &'a MeetingStore,
    meeting_id: String,
    me: Option<MeetingSpeaker>,
    others: Option<MeetingSpeaker>,
}

impl<'a> SpeakerRegistry<'a> {
    pub fn new(store: &'a MeetingStore, meeting_id: &str) -> Self {
        Self {
            store,
            meeting_id: meeting_id.to_string(),
            me: None,
            others: None,
        }
    }

    /// The speaker a lane's audio is attributed to before clustering runs.
    pub fn speaker_for(&mut self, lane: Lane) -> Result<MeetingSpeaker> {
        match lane {
            Lane::Mic => {
                if let Some(existing) = &self.me {
                    return Ok(existing.clone());
                }
                let speaker = self.create(Lane::Mic, SpeakerKind::Me, Some("You"), 0)?;
                self.me = Some(speaker.clone());
                Ok(speaker)
            }
            Lane::System => {
                if let Some(existing) = &self.others {
                    return Ok(existing.clone());
                }
                // Unnamed rather than "Others": clustering may later split this
                // into real people, and a placeholder that reads like a name
                // would be misleading in the meantime.
                let speaker = self.create(Lane::System, SpeakerKind::Unknown, None, 1)?;
                self.others = Some(speaker.clone());
                Ok(speaker)
            }
        }
    }

    fn create(
        &self,
        lane: Lane,
        kind: SpeakerKind,
        display_name: Option<&str>,
        color_index: i64,
    ) -> Result<MeetingSpeaker> {
        let speaker = MeetingSpeaker {
            id: format!("spk_{}_{}", self.meeting_id, lane.as_str()),
            meeting_id: self.meeting_id.clone(),
            display_name: display_name.map(str::to_string),
            kind,
            lane,
            cluster_index: None,
            voiceprint_id: None,
            pinned: false,
            color_index,
        };
        self.store.upsert_speaker(&speaker)?;
        Ok(speaker)
    }
}
