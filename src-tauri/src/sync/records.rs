//! What gets synced, and how two Macs agree on it.
//!
//! # Scope
//!
//! Settings-shaped data: custom vocabulary, word corrections, prompts,
//! profiles, correction phrases. Not transcripts, not meetings, not audio.
//!
//! That boundary is deliberate. Carrying your vocabulary and prompts to a new
//! Mac is the thing people actually want, it is kilobytes, and every record is
//! independently replaceable — the worst a bad merge can do is restore a word
//! you deleted. Syncing history would be gigabytes of the most sensitive data
//! the app holds, to solve a problem nobody has asked for.
//!
//! # Conflict resolution
//!
//! Last write wins, per record, on a wall-clock timestamp, with tombstones for
//! deletes.
//!
//! Clock skew is the obvious objection, and it is a real one: two Macs
//! disagreeing by a minute can pick the older edit. The alternative is vector
//! clocks or CRDTs, which cost an order of magnitude more code and buy
//! correctness for a conflict that, for this data, is worth one word. A lost
//! edit here means retyping a vocabulary entry.
//!
//! Deletes are tombstones rather than row removals, because a plain delete is
//! indistinguishable from "this device has not seen that record yet" — and
//! that ambiguity is exactly how deleted entries come back from the dead when
//! an old laptop is opened.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which collection a record belongs to.
///
/// Part of the record id rather than a separate server column: the server is
/// meant to see opaque blobs, and a `kind` column would tell it which features
/// each customer uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Vocabulary,
    WordCorrection,
    Prompt,
    Profile,
    CorrectionPhrase,
}

impl RecordKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordKind::Vocabulary => "vocabulary",
            RecordKind::WordCorrection => "word_correction",
            RecordKind::Prompt => "prompt",
            RecordKind::Profile => "profile",
            RecordKind::CorrectionPhrase => "correction_phrase",
        }
    }
}

/// A syncable item, before encryption.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Stable across devices: `kind:natural-key`. Two Macs that add the same
    /// vocabulary word independently must produce the same id, or the word
    /// arrives twice.
    pub id: String,
    pub kind: RecordKind,
    /// Unix milliseconds. Milliseconds rather than seconds because two edits
    /// in the same second are common when a user is working through a list.
    pub updated_at: i64,
    /// `None` is a tombstone: the record existed and was deleted.
    pub payload: Option<serde_json::Value>,
}

impl Record {
    pub fn is_tombstone(&self) -> bool {
        self.payload.is_none()
    }
}

/// Build the cross-device id for a record.
///
/// Natural keys are lowercased where the underlying data is case-insensitive
/// (a vocabulary word), and left alone where it is not (a profile id).
pub fn record_id(kind: RecordKind, natural_key: &str) -> String {
    let key = match kind {
        RecordKind::Vocabulary | RecordKind::WordCorrection | RecordKind::CorrectionPhrase => {
            natural_key.trim().to_lowercase()
        }
        RecordKind::Prompt | RecordKind::Profile => natural_key.trim().to_string(),
    };
    format!("{}:{}", kind.as_str(), key)
}

/// Which of two versions of the same record should survive.
///
/// Ties go to the tombstone. When two devices touch a record in the same
/// millisecond there is no signal to choose by, and "the delete sticks" is the
/// predictable rule — a resurrected entry the user deliberately removed is
/// more annoying than an edit they can make again.
pub fn winner<'a>(local: &'a Record, remote: &'a Record) -> &'a Record {
    debug_assert_eq!(local.id, remote.id);
    match local.updated_at.cmp(&remote.updated_at) {
        std::cmp::Ordering::Greater => local,
        std::cmp::Ordering::Less => remote,
        std::cmp::Ordering::Equal => {
            if remote.is_tombstone() {
                remote
            } else {
                local
            }
        }
    }
}

/// Merge a batch of remote records into the local set.
///
/// Returns the merged set, and the records that changed locally — the caller
/// applies those to the real stores, so nothing is written for a record the
/// remote agreed with.
pub fn merge(local: Vec<Record>, remote: Vec<Record>) -> (Vec<Record>, Vec<Record>) {
    use std::collections::HashMap;

    let mut merged: HashMap<String, Record> =
        local.into_iter().map(|r| (r.id.clone(), r)).collect();
    let mut changed = Vec::new();

    for incoming in remote {
        match merged.get(&incoming.id) {
            Some(existing) => {
                let keep = winner(existing, &incoming).clone();
                if keep != *existing {
                    changed.push(keep.clone());
                    merged.insert(keep.id.clone(), keep);
                }
            }
            None => {
                changed.push(incoming.clone());
                merged.insert(incoming.id.clone(), incoming);
            }
        }
    }

    let mut out: Vec<Record> = merged.into_values().collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    (out, changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(id: &str, at: i64, payload: Option<serde_json::Value>) -> Record {
        Record {
            id: id.to_string(),
            kind: RecordKind::Vocabulary,
            updated_at: at,
            payload,
        }
    }

    #[test]
    fn the_same_word_on_two_macs_is_the_same_record() {
        assert_eq!(
            record_id(RecordKind::Vocabulary, " Kubernetes "),
            record_id(RecordKind::Vocabulary, "kubernetes")
        );
    }

    #[test]
    fn profile_ids_keep_their_case() {
        // Profile ids are opaque identifiers, not words. Lowercasing them
        // would merge two distinct profiles into one.
        assert_ne!(
            record_id(RecordKind::Profile, "Slack"),
            record_id(RecordKind::Profile, "slack")
        );
    }

    #[test]
    fn the_newer_edit_wins() {
        let older = rec("vocabulary:k", 1_000, Some(json!("Kubernetes")));
        let newer = rec("vocabulary:k", 2_000, Some(json!("kubernetes")));
        assert_eq!(winner(&older, &newer), &newer);
        assert_eq!(winner(&newer, &older), &newer);
    }

    #[test]
    fn a_delete_beats_an_edit_at_the_same_instant() {
        let edit = rec("vocabulary:k", 5_000, Some(json!("Kubernetes")));
        let delete = rec("vocabulary:k", 5_000, None);
        assert!(winner(&edit, &delete).is_tombstone());
    }

    #[test]
    fn a_later_edit_beats_an_earlier_delete() {
        // Deleting and then re-adding must work; a tombstone is not permanent.
        let delete = rec("vocabulary:k", 1_000, None);
        let readd = rec("vocabulary:k", 2_000, Some(json!("Kubernetes")));
        assert!(!winner(&delete, &readd).is_tombstone());
    }

    #[test]
    fn merging_reports_only_what_actually_changed() {
        let local = vec![
            rec("vocabulary:a", 1_000, Some(json!("A"))),
            rec("vocabulary:b", 5_000, Some(json!("B-local"))),
        ];
        let remote = vec![
            // identical: must not be reported as a change
            rec("vocabulary:a", 1_000, Some(json!("A"))),
            // older than local: local wins, no change
            rec("vocabulary:b", 2_000, Some(json!("B-remote"))),
            // unseen: a change
            rec("vocabulary:c", 3_000, Some(json!("C"))),
        ];

        let (merged, changed) = merge(local, remote);
        assert_eq!(merged.len(), 3);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "vocabulary:c");

        let b = merged.iter().find(|r| r.id == "vocabulary:b").unwrap();
        assert_eq!(b.payload, Some(json!("B-local")));
    }

    #[test]
    fn a_stale_device_cannot_resurrect_a_deleted_record() {
        // The laptop that was in a drawer still has the word; the tombstone
        // is newer, so opening the laptop must not bring it back.
        let stale_device = vec![rec("vocabulary:k", 1_000, Some(json!("Kubernetes")))];
        let server_says_deleted = vec![rec("vocabulary:k", 9_000, None)];

        let (merged, changed) = merge(stale_device, server_says_deleted);
        assert!(merged[0].is_tombstone());
        assert_eq!(changed.len(), 1);
    }

    #[test]
    fn merging_is_idempotent() {
        // Sync runs repeatedly; a second pass over the same remote data must
        // report no further changes, or the UI would claim endless activity.
        let local = vec![rec("vocabulary:a", 1_000, Some(json!("A")))];
        let remote = vec![rec("vocabulary:b", 2_000, Some(json!("B")))];

        let (once, first_changes) = merge(local, remote.clone());
        assert_eq!(first_changes.len(), 1);
        let (twice, second_changes) = merge(once.clone(), remote);
        assert_eq!(once, twice);
        assert!(second_changes.is_empty());
    }
}
