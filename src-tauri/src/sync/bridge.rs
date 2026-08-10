//! The map between what the app stores and what gets synced.
//!
//! This is the only file in `sync` that can destroy data, so it is written to
//! be boring: every collection is read into records the same way, and applied
//! back the same way, with no collection-specific cleverness.
//!
//! # Timestamps
//!
//! Most of these collections are plain values in `AppSettings` with no
//! per-item modified time — a vocabulary word is a `String` in a `Vec`. There
//! is nowhere to put a timestamp without changing every one of those shapes and
//! migrating existing installs.
//!
//! So the local side carries one timestamp per collection, in
//! `sync_touched_at`, updated whenever that collection is written. Within a
//! collection every record shares it. The practical effect is that editing one
//! vocabulary word makes the whole vocabulary list "newer" — a device that
//! edited a different word a minute earlier loses it.
//!
//! That is a real cost and it is the one this design accepts. Per-item
//! timestamps for five collections mean five schema migrations, and the thing
//! being protected is a word the user can retype. Revisit it if prompts start
//! carrying anything expensive to recreate.

use crate::profiles::Profile;
use crate::settings::{AppSettings, LLMPrompt};
use crate::sync::records::{record_id, Record, RecordKind};
use serde_json::json;
use std::collections::HashMap;

/// Read every syncable collection out of settings as records.
pub fn to_records(settings: &AppSettings, touched_at: i64) -> Vec<Record> {
    let mut out = Vec::new();

    for word in &settings.custom_words {
        if word.trim().is_empty() {
            continue;
        }
        out.push(Record {
            id: record_id(RecordKind::Vocabulary, word),
            kind: RecordKind::Vocabulary,
            updated_at: touched_at,
            // The word itself, not just its id — the id is lowercased, and the
            // user's capitalisation is the whole point of a vocabulary entry.
            payload: Some(json!({ "word": word })),
        });
    }

    for phrase in &settings.correction_phrases {
        if phrase.trim().is_empty() {
            continue;
        }
        out.push(Record {
            id: record_id(RecordKind::CorrectionPhrase, phrase),
            kind: RecordKind::CorrectionPhrase,
            updated_at: touched_at,
            payload: Some(json!({ "phrase": phrase })),
        });
    }

    for prompt in &settings.post_process_prompts {
        out.push(Record {
            id: record_id(RecordKind::Prompt, &prompt.id),
            kind: RecordKind::Prompt,
            updated_at: touched_at,
            payload: serde_json::to_value(prompt).ok(),
        });
    }

    for profile in &settings.profiles {
        out.push(Record {
            id: record_id(RecordKind::Profile, &profile.id),
            kind: RecordKind::Profile,
            updated_at: touched_at,
            payload: serde_json::to_value(profile).ok(),
        });
    }

    out
}

/// What changed locally after a merge.
#[derive(Debug, Default)]
pub struct Applied {
    pub vocabulary: usize,
    pub phrases: usize,
    pub prompts: usize,
    pub profiles: usize,
}

impl Applied {
    pub fn total(&self) -> usize {
        self.vocabulary + self.phrases + self.prompts + self.profiles
    }
}

/// Write merged records back into settings.
///
/// Takes the *full* merged set rather than a delta, and rebuilds each
/// collection from it. Applying deltas would mean reasoning about what is
/// missing from a partial list, which is where "the sync deleted everything"
/// bugs live.
///
/// A record whose payload does not deserialize is skipped, not defaulted. A
/// prompt from a newer app version is better left alone than replaced with a
/// blank one.
pub fn apply(settings: &mut AppSettings, merged: &[Record]) -> Applied {
    let mut applied = Applied::default();

    let mut vocabulary: Vec<String> = Vec::new();
    let mut phrases: Vec<String> = Vec::new();
    let mut prompts: HashMap<String, LLMPrompt> = HashMap::new();
    let mut profiles: HashMap<String, Profile> = HashMap::new();

    for record in merged {
        let Some(payload) = record.payload.as_ref() else {
            continue; // tombstone: simply absent from the rebuilt collection
        };
        match record.kind {
            RecordKind::Vocabulary => {
                if let Some(w) = payload.get("word").and_then(|v| v.as_str()) {
                    vocabulary.push(w.to_string());
                }
            }
            RecordKind::CorrectionPhrase => {
                if let Some(p) = payload.get("phrase").and_then(|v| v.as_str()) {
                    phrases.push(p.to_string());
                }
            }
            RecordKind::Prompt => {
                if let Ok(prompt) = serde_json::from_value::<LLMPrompt>(payload.clone()) {
                    prompts.insert(prompt.id.clone(), prompt);
                }
            }
            RecordKind::Profile => {
                if let Ok(profile) = serde_json::from_value::<Profile>(payload.clone()) {
                    profiles.insert(profile.id.clone(), profile);
                }
            }
            // Word corrections live in the history database rather than
            // settings, and are applied by the caller.
            RecordKind::WordCorrection => {}
        }
    }

    vocabulary.sort();
    vocabulary.dedup();
    phrases.sort();
    phrases.dedup();

    if settings.custom_words != vocabulary {
        applied.vocabulary = vocabulary.len();
        settings.custom_words = vocabulary;
    }
    if settings.correction_phrases != phrases {
        applied.phrases = phrases.len();
        settings.correction_phrases = phrases;
    }

    let mut new_prompts: Vec<LLMPrompt> = prompts.into_values().collect();
    new_prompts.sort_by(|a, b| a.id.cmp(&b.id));
    // An empty prompt set means the remote has never synced prompts, not that
    // the user deleted all of them — replacing a working set with nothing is
    // the one mistake here that is not recoverable by retyping a word.
    if !new_prompts.is_empty() && !same(&settings.post_process_prompts, &new_prompts) {
        applied.prompts = new_prompts.len();
        settings.post_process_prompts = new_prompts;
    }

    let mut new_profiles: Vec<Profile> = profiles.into_values().collect();
    new_profiles.sort_by(|a, b| a.id.cmp(&b.id));
    if !same(&settings.profiles, &new_profiles) {
        applied.profiles = new_profiles.len();
        settings.profiles = new_profiles;
    }

    applied
}

/// Whether two collections are already identical.
///
/// Compared as serialised JSON rather than with `PartialEq`. `Profile` nests
/// several types that would each need the derive, and this file has no
/// business widening the public API of shared structs to answer a question it
/// asks twice.
fn same<T: serde::Serialize>(a: &[T], b: &[T]) -> bool {
    match (serde_json::to_value(a), serde_json::to_value(b)) {
        (Ok(x), Ok(y)) => x == y,
        // Unserialisable means "assume different", so the caller writes rather
        // than silently skipping a real update.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn a_word_survives_a_round_trip_with_its_capitalisation() {
        let mut settings = get_default_settings();
        settings.custom_words = vec!["Kubernetes".to_string()];
        let records = to_records(&settings, 1_000);

        let mut fresh = get_default_settings();
        fresh.custom_words.clear();
        apply(&mut fresh, &records);
        assert_eq!(fresh.custom_words, vec!["Kubernetes".to_string()]);
    }

    #[test]
    fn a_tombstone_removes_the_word() {
        let mut settings = get_default_settings();
        settings.custom_words = vec!["Kubernetes".to_string()];
        let mut records = to_records(&settings, 1_000);
        records[0].payload = None;

        apply(&mut settings, &records);
        assert!(settings.custom_words.is_empty());
    }

    #[test]
    fn an_unparseable_prompt_is_skipped_not_blanked() {
        // A prompt written by a newer app version must not be replaced with a
        // default one just because this build cannot read it.
        let mut settings = get_default_settings();
        let before = serde_json::to_value(&settings.post_process_prompts).unwrap();
        let records = vec![Record {
            id: "prompt:x".to_string(),
            kind: RecordKind::Prompt,
            updated_at: 1,
            payload: Some(json!({ "unexpected": "shape" })),
        }];
        apply(&mut settings, &records);
        assert_eq!(
            serde_json::to_value(&settings.post_process_prompts).unwrap(),
            before
        );
    }

    #[test]
    fn applying_the_same_records_twice_changes_nothing_the_second_time() {
        let mut settings = get_default_settings();
        settings.custom_words = vec!["Kubernetes".to_string(), "Tauri".to_string()];
        let records = to_records(&settings, 1_000);

        let first = apply(&mut settings, &records);
        let second = apply(&mut settings, &records);
        assert_eq!(second.total(), 0, "second apply reported {:?}", second);
        let _ = first;
    }

    #[test]
    fn two_spellings_of_one_word_collapse_to_one_record() {
        // Otherwise a Mac that has "Kubernetes" and a Mac that has
        // "kubernetes" would each keep both after a sync.
        let mut settings = get_default_settings();
        settings.custom_words = vec!["Kubernetes".to_string(), "kubernetes".to_string()];
        let records = to_records(&settings, 1_000);
        let vocab: std::collections::HashSet<&str> = records
            .iter()
            .filter(|r| r.kind == RecordKind::Vocabulary)
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(vocab.len(), 1);
    }
}
