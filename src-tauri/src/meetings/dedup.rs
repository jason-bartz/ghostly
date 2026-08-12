//! Cross-lane duplicate suppression.
//!
//! Two lanes hear the same room. When the user is on speakers rather than
//! headphones their microphone picks up the remote participants; in the other
//! direction, a conferencing app that monitors or echoes the local mic puts the
//! user's own voice back onto the system lane. Either way the utterance is
//! transcribed twice.
//!
//! macOS voice processing removes most of this, but not all of it, and it is
//! unavailable when the user has selected a device Ghostly opens directly. This
//! is the backstop.
//!
//! # Why it is bidirectional
//!
//! It used to drop only *microphone* copies of system audio, on the reasoning
//! that the system lane is the correct home for a remote speaker. That left the
//! opposite leak — the user's own voice echoed onto the system lane — entirely
//! unsuppressed, and it was visible: the transcript showed the same sentence
//! twice, once as "You" and once as "Participant", worded slightly differently
//! because two different chunks of audio had been decoded.
//!
//! The transcript no longer prints speaker names, so a leak in either direction
//! now reads as the speaker stuttering the same sentence twice. Both directions
//! are suppressed, and the copy that survives is whichever lane produced it
//! first — echo always arrives after the sound that caused it, so the earlier
//! lane is the one that actually heard the speaker.
//!
//! The comparison is deliberately textual rather than acoustic. Echo arrives
//! attenuated and filtered, so waveform correlation is unreliable, but the two
//! transcripts of the same speech are nearly identical strings.

use std::collections::VecDeque;

use super::types::Lane;

/// How far apart two segments may be and still be considered the same speech.
///
/// Echo itself is near-instantaneous; the slack absorbs differences in where
/// each lane's VAD placed the boundaries. Now that a segment can run to 14 s,
/// two lanes can legitimately split the same speech at very different points,
/// so this is wider than the 2.5 s it was when segments capped out at 8.
const MAX_TIME_SKEW_MS: i64 = 4_000;

/// Similarity above which a segment is treated as an echo of the other lane.
///
/// Deliberately two-tier. A false positive silently deletes something that was
/// actually said, and the shorter the utterance the more likely two unrelated
/// remarks collide by chance — "yeah I think so too" is not rare. Long
/// utterances are the opposite: matching a dozen content words by accident
/// essentially does not happen, while the two decodings of the *same* long
/// utterance routinely disagree on enough filler words to miss a high bar.
const SIMILARITY_THRESHOLD_SHORT: f64 = 0.82;
const SIMILARITY_THRESHOLD_LONG: f64 = 0.68;

/// Word count at which an utterance is scored against the long threshold.
const LONG_UTTERANCE_WORDS: usize = 8;

/// Below this, an utterance is only suppressed on an *exact* match within
/// [`EXACT_MATCH_SKEW_MS`].
///
/// "Yeah", "mm-hm" and "right" are common backchannels and high-collision, so
/// scoring them by similarity would delete real ones — "right" and "right?"
/// are the same string to the normaliser but can easily be two people. An
/// identical short word on the *other* lane a second later is a different
/// matter: that is the speakers bleeding into the microphone, and rendering it
/// as two identical pills one above the other looks like a bug even when the
/// words are real.
const MIN_COMPARABLE_WORDS: usize = 3;

/// Window for the exact-match rule on very short utterances. Tighter than the
/// general skew, because the shorter the utterance the weaker the evidence.
const EXACT_MATCH_SKEW_MS: i64 = 2_500;

/// A recent utterance kept for comparison.
struct Recent {
    lane: Lane,
    normalized: String,
    start_ms: i64,
    end_ms: i64,
}

/// Sliding window of recent utterances from both lanes.
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

    /// Records an utterance as a candidate echo source for the *other* lane.
    ///
    /// Call this for every segment that is kept, on both lanes.
    pub fn record(&mut self, lane: Lane, text: &str, start_ms: i64, end_ms: i64) {
        let normalized = normalize(text);
        if normalized.is_empty() {
            return;
        }
        self.recent.push_back(Recent {
            lane,
            normalized,
            start_ms,
            end_ms,
        });
        self.evict_before(end_ms - self.window_ms);
    }

    /// Whether this utterance is an echo of something the other lane already
    /// reported.
    ///
    /// Only the opposite lane is consulted: one lane repeating itself is a
    /// speaker genuinely saying the same thing twice, which is not ours to
    /// delete.
    pub fn is_echo(&self, lane: Lane, text: &str, start_ms: i64, end_ms: i64) -> bool {
        let normalized = normalize(text);
        if normalized.is_empty() {
            return false;
        }
        let words = normalized.split_whitespace().count();

        // Very short utterances need to be identical, and close together.
        let (threshold, skew) = match words {
            w if w >= LONG_UTTERANCE_WORDS => (SIMILARITY_THRESHOLD_LONG, MAX_TIME_SKEW_MS),
            w if w >= MIN_COMPARABLE_WORDS => (SIMILARITY_THRESHOLD_SHORT, MAX_TIME_SKEW_MS),
            _ => (1.0, EXACT_MATCH_SKEW_MS),
        };

        self.recent.iter().any(|candidate| {
            if candidate.lane == lane {
                return false;
            }
            let overlaps =
                start_ms <= candidate.end_ms + skew && end_ms >= candidate.start_ms - skew;
            overlaps && similarity(&normalized, &candidate.normalized) >= threshold
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
        dedup.record(
            Lane::System,
            "So I think we should ship it on Friday.",
            1_000,
            4_000,
        );
        assert!(dedup.is_echo(
            Lane::Mic,
            "so i think we should ship it on friday",
            1_200,
            4_100
        ));
    }

    #[test]
    fn suppresses_the_users_own_voice_echoed_onto_the_system_lane() {
        // The direction that used to leak: the conferencing app monitors the
        // local mic, so what the user said comes back on the system lane a
        // moment later, decoded slightly differently.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(
            Lane::Mic,
            "Anyways, I'm gonna jump in and jump out. If you can jump in and jump \
             out a little bit as well today, but just to make sure that",
            10_000,
            17_000,
        );
        assert!(dedup.is_echo(
            Lane::System,
            "Anyways, I'm gonna jump in and jump out. If you can jump in and jump \
             out a little bit as well today, I think it'll be useful just to make \
             sure that they keep it.",
            10_400,
            17_800
        ));
    }

    #[test]
    fn keeps_distinct_speech_in_the_same_window() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(
            Lane::System,
            "So I think we should ship it on Friday.",
            1_000,
            4_000,
        );
        assert!(!dedup.is_echo(
            Lane::Mic,
            "Actually I had a completely different concern about the budget",
            1_200,
            4_100
        ));
    }

    #[test]
    fn keeps_a_repeat_on_the_same_lane() {
        // One lane hearing the same words twice is a speaker repeating
        // themselves, not an echo — deleting it would lose real speech.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(
            Lane::System,
            "Can everyone hear me alright at the back there",
            1_000,
            4_000,
        );
        assert!(!dedup.is_echo(
            Lane::System,
            "Can everyone hear me alright at the back there",
            5_000,
            8_000
        ));
    }

    #[test]
    fn keeps_user_speech_merely_contained_in_a_longer_remark() {
        // The words of the user's line all appear in the far-side sentence.
        // Containment is not echo — an intersection-over-minimum score would
        // read this as a perfect match and delete what the user actually said.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(
            Lane::System,
            "Yeah so I do think we should ship the thing on Friday I agree",
            1_000,
            5_000,
        );
        assert!(
            !dedup.is_echo(Lane::Mic, "yeah I think so", 1_500, 2_000),
            "a short user utterance contained in a longer remark must survive"
        );
    }

    #[test]
    fn keeps_identical_speech_far_apart_in_time() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(
            Lane::System,
            "Let us move on to the next item",
            1_000,
            4_000,
        );
        // Same words much later is someone genuinely repeating themselves.
        assert!(!dedup.is_echo(Lane::Mic, "let us move on to the next item", 40_000, 43_000));
    }

    #[test]
    fn suppresses_an_identical_backchannel_echoed_a_moment_later() {
        // Observed live: `say "Right."` produced "Right." on the system lane
        // and again on the microphone 1.5 s later, rendering as two identical
        // pills stacked on top of each other.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(Lane::System, "Right.", 15_911, 17_711);
        assert!(dedup.is_echo(Lane::Mic, "Right.", 14_430, 16_230));
    }

    #[test]
    fn keeps_a_backchannel_that_is_merely_similar() {
        // Short utterances demand an exact match — "yeah" and "yeah, no" are
        // two different answers, and one of them is a real one.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(Lane::System, "Yeah", 1_000, 1_500);
        assert!(!dedup.is_echo(Lane::Mic, "yeah no", 1_050, 1_600));
    }

    #[test]
    fn keeps_a_backchannel_repeated_later_in_the_conversation() {
        // Two people both saying "right" during a call is completely ordinary;
        // only a near-simultaneous identical one is echo.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(Lane::System, "Right", 1_000, 1_500);
        assert!(!dedup.is_echo(Lane::Mic, "right", 9_000, 9_500));
    }

    #[test]
    fn short_utterances_still_need_a_high_score() {
        // Five words, so the strict threshold applies: a two-word overlap must
        // not be enough to delete it.
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(Lane::System, "we should ship on Friday", 1_000, 3_000);
        assert!(!dedup.is_echo(Lane::Mic, "we should wait until Monday", 1_100, 3_100));
    }

    #[test]
    fn evicts_history_outside_the_window() {
        let mut dedup = CrossLaneDeduper::new();
        dedup.record(Lane::System, "something said a long time ago now", 0, 1_000);
        // Pushing a much later entry evicts the stale one.
        dedup.record(
            Lane::System,
            "a totally different remark entirely",
            60_000,
            61_000,
        );
        assert!(!dedup.is_echo(Lane::Mic, "something said a long time ago now", 0, 1_000));
    }

    #[test]
    fn normalize_strips_case_and_punctuation() {
        assert_eq!(
            normalize("Hello, World!  It's fine."),
            "hello world it s fine"
        );
    }
}
