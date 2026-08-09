//! Cross-lane duplicate suppression.
//!
//! When the user is on speakers rather than headphones, their microphone picks
//! up the remote participants. Without suppression every remote utterance is
//! transcribed twice — once correctly on the system lane, and once on the mic
//! lane where it is wrongly attributed to the user.
//!
//! macOS voice processing removes most of this, but not all of it, and it is
//! unavailable when the user has selected a device Ghostly opens directly. This
//! is the backstop: if a microphone segment closely matches a system segment
//! that overlaps it in time, the microphone copy is dropped.
//!
//! The comparison is deliberately textual rather than acoustic. Echo arrives
//! attenuated and filtered, so waveform correlation is unreliable, but the two
//! transcripts of the same speech are nearly identical strings.

use std::collections::VecDeque;

/// How far apart two segments may be and still be considered the same speech.
/// Echo is near-instantaneous; the slack absorbs differences in where each
/// lane's VAD placed the boundaries.
const MAX_TIME_SKEW_MS: i64 = 2_500;

/// Similarity above which a microphone segment is treated as echo. Set high
/// because a false positive silently deletes something the user actually said,
/// which is far worse than letting one echoed line through.
const SIMILARITY_THRESHOLD: f64 = 0.82;

/// Recent system-lane text kept for comparison.
struct Recent {
    normalized: String,
    start_ms: i64,
    end_ms: i64,
}

/// Sliding window of recent far-side utterances.
pub struct CrossLaneDeduper {
    recent: VecDeque<Recent>,
    window_ms: i64,
}

impl Default for CrossLaneDeduper {
    fn default() -> Self {
        Self::new()
    }
}

impl CrossLaneDeduper {
    pub fn new() -> Self {
        Self {
            recent: VecDeque::new(),
            // Only a few seconds of history is ever relevant, and keeping the
            // window tight bounds both memory and comparison cost.
            window_ms: 15_000,
        }
    }

    /// Record a system-lane utterance as a candidate echo source.
    pub fn record_system(&mut self, text: &str, start_ms: i64, end_ms: i64) {
        let normalized = normalize(text);
        if normalized.is_empty() {
            return;
        }
        self.recent.push_back(Recent {
            normalized,
            start_ms,
            end_ms,
        });
        self.evict_before(end_ms - self.window_ms);
    }

    /// Whether a microphone-lane utterance is an echo of recent far-side audio.
    pub fn is_echo(&self, text: &str, start_ms: i64, end_ms: i64) -> bool {
        let normalized = normalize(text);
        // Very short utterances ("yeah", "mm-hm") are both common backchannels
        // and high-collision, so never suppress them — the cost of wrongly
        // deleting a real "yes" outweighs one duplicated word.
        if normalized.split_whitespace().count() < 3 {
            return false;
        }

        self.recent.iter().any(|candidate| {
            let overlaps = start_ms <= candidate.end_ms + MAX_TIME_SKEW_MS
                && end_ms >= candidate.start_ms - MAX_TIME_SKEW_MS;
            overlaps && similarity(&normalized, &candidate.normalized) >= SIMILARITY_THRESHOLD
        })
    }

    fn evict_before(&mut self, cutoff_ms: i64) {
        while let Some(front) = self.recent.front() {
            if front.end_ms < cutoff_ms {
                self.recent.pop_front();
            } else {
                break;
            }
        }
    }
}

/// Lowercase, strip punctuation, collapse whitespace. Two transcripts of the
/// same speech differ mostly in casing and punctuation, so removing both makes
/// the comparison far more stable.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = true;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim_end().to_string()
}

/// Word-level Jaccard similarity (intersection over **union**).
///
/// Whisper renders the same speech slightly differently in each lane — an extra
/// filler word, a different contraction — so exact equality is useless.
///
/// Dividing by the union rather than the smaller set is deliberate and matters:
/// with `min` as the denominator, *any* short utterance whose words all happen
/// to appear somewhere in a longer far-side sentence scores 1.0. A user saying
/// "yeah I think so too" while a participant says "…yeah so I do think we
/// should…" would score a perfect match and the user's line would be deleted.
/// Union scoring requires the two utterances to be substantially the *same*
/// length and content, which is what an echo actually is.
fn similarity(a: &str, b: &str) -> f64 {
    let a_set: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let b_set: std::collections::HashSet<&str> = b.split_whitespace().collect();
    if a_set.is_empty() || b_set.is_empty() {
        return 0.0;
    }

    let intersection = a_set.intersection(&b_set).count();
    let union = a_set.union(&b_set).count();
    if union == 0 {
        return 0.0;
    }
    intersection as f64 / union as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_a_near_identical_overlapping_utterance() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system("So I think we should ship it on Friday.", 1_000, 4_000);
        assert!(dedup.is_echo("so i think we should ship it on friday", 1_200, 4_100));
    }

    #[test]
    fn keeps_distinct_speech_in_the_same_window() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system("So I think we should ship it on Friday.", 1_000, 4_000);
        assert!(!dedup.is_echo(
            "Actually I had a completely different concern about the budget",
            1_200,
            4_100
        ));
    }

    #[test]
    fn keeps_user_speech_merely_contained_in_a_longer_remark() {
        // The words of the user's line all appear in the far-side sentence.
        // Containment is not echo — an intersection-over-minimum score would
        // read this as a perfect match and delete what the user actually said.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system(
            "Yeah so I do think we should ship the thing on Friday I agree",
            1_000,
            5_000,
        );
        assert!(
            !dedup.is_echo("yeah I think so", 1_500, 2_000),
            "a short user utterance contained in a longer remark must survive"
        );
    }

    #[test]
    fn keeps_identical_speech_far_apart_in_time() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system("Let us move on to the next item", 1_000, 4_000);
        // Same words much later is someone genuinely repeating themselves.
        assert!(!dedup.is_echo("let us move on to the next item", 40_000, 43_000));
    }

    #[test]
    fn never_suppresses_short_backchannels() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system("Yeah", 1_000, 1_500);
        assert!(!dedup.is_echo("yeah", 1_050, 1_600));
    }

    #[test]
    fn evicts_history_outside_the_window() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record_system("something said a long time ago now", 0, 1_000);
        // Pushing a much later entry evicts the stale one.
        dedup.record_system("a totally different remark entirely", 60_000, 61_000);
        assert!(!dedup.is_echo("something said a long time ago now", 0, 1_000));
    }

    #[test]
    fn normalize_strips_case_and_punctuation() {
        assert_eq!(
            normalize("Hello, World!  It's fine."),
            "hello world it s fine"
        );
    }
}
