//! Learning your vocabulary from the corrections you make.
//!
//! Every voice edit is a labelled pair: the text Ghostly produced, and the
//! text the user wanted. Over a week those pairs contain the handful of proper
//! nouns and jargon that the transcription model gets wrong every single time —
//! a colleague's name, a product, an acronym. Feeding them back into custom
//! vocabulary is the difference between an app you correct forever and one that
//! stops needing correcting.
//!
//! # What leaves the machine
//!
//! **Word pairs, never transcripts.** A local word-level diff turns
//! `("send this to Kubernetes", "send this to Kubernetes")` into the single
//! candidate `kubernetes → Kubernetes`, and only that pair is ever sent. The
//! model's job is narrow: decide which candidates are durable vocabulary the
//! user will say again, and which are one-off rewordings that would be wrong
//! to apply automatically. It never sees the sentences they came from.
//!
//! That ordering is not an optimisation. Sending whole transcripts to be mined
//! would be a different product with a different privacy claim.
//!
//! # Why not the Batch API
//!
//! The plan called for nightly Batch API runs at 50% off. Batch is the right
//! tool for a large corpus, but after the local diff the daily payload is a few
//! dozen short word pairs — well under a cent on the fast model. Halving that
//! does not pay for submit/poll/retrieve plumbing, a 24-hour completion SLA, or
//! the gateway endpoints Batch would need that `/v1/chat/completions` already
//! provides. One small call a day is cheaper end to end.

use crate::managers::history::HistoryManager;
use crate::max_gateway::{Job, Target};
use crate::settings::{get_settings, write_settings};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Longest run of pending pairs considered in one pass. A user who has been
/// offline for a month should not produce a single enormous prompt.
const MAX_PAIRS_PER_RUN: usize = 200;

/// Candidates sent to the model in one pass, after deduplication.
const MAX_CANDIDATES_PER_RUN: usize = 60;

/// A word must be corrected this many times before it is even a candidate.
///
/// One correction is usually a typo of speech or a change of mind. Two is a
/// pattern. This threshold is what keeps the vocabulary list from filling with
/// noise, and it does more for quality than anything the model does afterwards.
const MIN_OCCURRENCES: u32 = 2;

/// A word-level substitution observed between what Ghostly wrote and what the
/// user kept.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Candidate {
    pub wrong: String,
    pub correct: String,
}

/// What a learning pass concluded, for the UI card.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LearnedTerm {
    pub wrong: String,
    pub correct: String,
    pub learned_at: i64,
}

// ── Local diff ──────────────────────────────────────────────────────────────

/// Split into comparable word tokens, keeping the original spelling.
fn words(text: &str) -> Vec<&str> {
    text.split_whitespace().collect()
}

/// Strip leading/trailing punctuation so `Kubernetes,` and `Kubernetes` match.
fn core(word: &str) -> &str {
    word.trim_matches(|c: char| !c.is_alphanumeric())
}

/// Word-level substitutions between `before` and `after`.
///
/// A plain longest-common-subsequence walk. Anything that is not a clean
/// one-for-one substitution — an insertion, a deletion, a whole clause
/// rewritten — is dropped rather than guessed at. Vocabulary learning wants
/// high precision and cares nothing for recall: a wrong entry corrupts every
/// future transcript, a missed one costs nothing.
pub fn substitutions(before: &str, after: &str) -> Vec<Candidate> {
    let a = words(before);
    let b = words(after);
    if a.is_empty() || b.is_empty() || a.len().abs_diff(b.len()) > 0 {
        // Different word counts mean something was inserted or removed, and
        // aligning across that is where false pairs come from.
        return Vec::new();
    }

    let mut out = Vec::new();
    for (wa, wb) in a.iter().zip(b.iter()) {
        let (ca, cb) = (core(wa), core(wb));
        if ca.is_empty() || cb.is_empty() || ca == cb {
            continue;
        }
        // Case-only changes are real vocabulary signal ("kubernetes" →
        // "Kubernetes"). Wholesale different words usually are not — they are
        // the user rewording — unless they are close enough to be a
        // mis-hearing of the same term.
        if !ca.eq_ignore_ascii_case(cb) && !plausible_mishearing(ca, cb) {
            continue;
        }
        out.push(Candidate {
            wrong: ca.to_string(),
            correct: cb.to_string(),
        });
    }
    out
}

/// Whether two words are close enough that one is plausibly a mis-transcription
/// of the other, rather than the user changing their mind.
///
/// Length-scaled edit distance: "kubernets"/"kubernetes" yes, "cat"/"dog" no.
fn plausible_mishearing(a: &str, b: &str) -> bool {
    let (la, lb) = (a.chars().count(), b.chars().count());
    if la < 4 || lb < 4 {
        return false; // short words differ for too many innocent reasons
    }
    let allowed = (la.max(lb) / 3).max(1);
    edit_distance(a, b) <= allowed
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

// ── Capture ─────────────────────────────────────────────────────────────────

/// Note that the user edited `before` into `after`.
///
/// Cheap and synchronous: it writes one row. The analysis happens later, on a
/// schedule, so nothing here is in the path of a paste.
pub fn record_edit(app: &AppHandle, before: &str, after: &str) {
    if before.trim() == after.trim() {
        return;
    }
    let Some(history) = app.try_state::<Arc<HistoryManager>>() else {
        return;
    };
    for candidate in substitutions(before, after) {
        if let Err(err) = history.record_learning_candidate(&candidate.wrong, &candidate.correct) {
            debug!("Failed to record learning candidate: {}", err);
        }
    }
}

// ── The daily pass ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT: &str = "\
You are filtering a list of word corrections a speech-to-text user made repeatedly.

For each pair, decide whether the corrected form is a durable vocabulary item — a \
proper noun, a product, a person's name, an acronym, a technical term, a spelling the \
user consistently prefers — that should be applied automatically to future \
transcriptions.

Reject anything that is a one-off rewording, a grammatical change, a change of tone, \
an ordinary English word that happens to have been mistyped, or a correction whose \
right answer depends on the sentence it appears in.

Return only a JSON array of the pairs to keep, each as {\"wrong\":\"…\",\"correct\":\"…\"}, \
using the exact strings given. Return [] if none qualify. No prose.";

/// Run one learning pass: read pending candidates, filter locally, ask the
/// model which are durable, and write the survivors into custom vocabulary.
///
/// Returns the terms learned, for the card.
pub async fn run_pass(app: &AppHandle) -> Result<Vec<LearnedTerm>, String> {
    let history = app
        .try_state::<Arc<HistoryManager>>()
        .ok_or("History is unavailable.")?
        .inner()
        .clone();

    let pending = history
        .pending_learning_candidates(MIN_OCCURRENCES, MAX_PAIRS_PER_RUN)
        .map_err(|e| format!("Failed to read learning candidates: {}", e))?;

    if pending.is_empty() {
        debug!("Learning pass: nothing pending");
        return Ok(Vec::new());
    }

    // Never re-propose something the user already has, or already rejected by
    // deleting. `word_corrections` is the record of both.
    let existing: HashSet<String> = history
        .get_word_corrections()
        .map_err(|e| format!("Failed to read word corrections: {}", e))?
        .into_iter()
        .map(|c| c.wrong.to_lowercase())
        .collect();

    let candidates: Vec<Candidate> = pending
        .into_iter()
        .filter(|c| !existing.contains(&c.wrong.to_lowercase()))
        .take(MAX_CANDIDATES_PER_RUN)
        .collect();

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let settings = get_settings(app);
    let provider_id = settings.post_process_provider_id.clone();
    let Some(target) = Target::resolve(&settings, &provider_id) else {
        return Err("No AI provider is configured.".to_string());
    };
    if target.api_key.trim().is_empty() {
        return Err("No AI provider is configured.".to_string());
    }

    // Only the pairs travel. The sentences they came from never leave.
    let list = candidates
        .iter()
        .map(|c| format!("{} -> {}", c.wrong, c.correct))
        .collect::<Vec<_>>()
        .join("\n");

    let raw = crate::max_gateway::send_chat_completion(
        &settings,
        target.for_job(Job::Fast),
        format!("{}\n\nPairs:\n{}", SYSTEM_PROMPT, list),
        None,
        None,
    )
    .await
    .map_err(|e| format!("Learning pass failed: {}", e))?
    .unwrap_or_default();

    let keep = parse_keepers(&raw, &candidates);
    let now = chrono::Utc::now().timestamp();
    let mut learned = Vec::new();

    for candidate in keep {
        match history.upsert_learned_correction(&candidate.wrong, &candidate.correct) {
            Ok(()) => learned.push(LearnedTerm {
                wrong: candidate.wrong.clone(),
                correct: candidate.correct.clone(),
                learned_at: now,
            }),
            Err(err) => warn!("Failed to save learned term: {}", err),
        }
    }

    // Proper nouns also belong in the transcription model's vocabulary hint,
    // where they prevent the mistake instead of correcting it afterwards.
    if !learned.is_empty() {
        let mut settings = get_settings(app);
        let known: HashSet<String> = settings
            .custom_words
            .iter()
            .map(|w| w.to_lowercase())
            .collect();
        let mut added = false;
        for term in &learned {
            if !known.contains(&term.correct.to_lowercase()) {
                settings.custom_words.push(term.correct.clone());
                added = true;
            }
        }
        if added {
            write_settings(app, settings);
        }
    }

    // Clear what was considered either way: a candidate the model rejected
    // should not be re-sent every night for the rest of time.
    if let Err(err) = history.clear_learning_candidates() {
        warn!("Failed to clear learning candidates: {}", err);
    }

    if !learned.is_empty() {
        info!("Learning pass: learned {} term(s)", learned.len());
    }
    Ok(learned)
}

/// Pull the kept pairs out of the model's reply.
///
/// Cross-checked against the candidates that were sent: a model that
/// hallucinates a pair, or edits the spelling of one, must not have that
/// written into the user's vocabulary.
fn parse_keepers(raw: &str, sent: &[Candidate]) -> Vec<Candidate> {
    let start = match raw.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match raw.rfind(']') {
        Some(i) if i > start => i,
        _ => return Vec::new(),
    };

    #[derive(Deserialize)]
    struct Pair {
        wrong: String,
        correct: String,
    }

    let parsed: Vec<Pair> = match serde_json::from_str(&raw[start..=end]) {
        Ok(p) => p,
        Err(err) => {
            debug!("Learning pass: unparseable reply ({})", err);
            return Vec::new();
        }
    };

    let allowed: HashSet<(String, String)> = sent
        .iter()
        .map(|c| (c.wrong.clone(), c.correct.clone()))
        .collect();

    parsed
        .into_iter()
        .filter(|p| allowed.contains(&(p.wrong.clone(), p.correct.clone())))
        .map(|p| Candidate {
            wrong: p.wrong,
            correct: p.correct,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(w: &str, c: &str) -> Candidate {
        Candidate {
            wrong: w.to_string(),
            correct: c.to_string(),
        }
    }

    #[test]
    fn finds_a_capitalisation_fix() {
        let subs = substitutions("deploy to kubernetes today", "deploy to Kubernetes today");
        assert_eq!(subs, vec![pair("kubernetes", "Kubernetes")]);
    }

    #[test]
    fn finds_a_mishearing_of_a_long_term() {
        let subs = substitutions("ask kubernets about it", "ask Kubernetes about it");
        assert_eq!(subs, vec![pair("kubernets", "Kubernetes")]);
    }

    #[test]
    fn ignores_rewording() {
        // The user changed their mind. Learning "great -> excellent" would
        // rewrite the word everywhere, forever.
        assert!(substitutions("that is great news", "that is excellent news").is_empty());
    }

    #[test]
    fn ignores_edits_that_change_the_word_count() {
        // Insertions and deletions mean the columns no longer line up, and
        // aligning across them is where false pairs come from.
        assert!(substitutions("send it to Bob", "send it to Bob now").is_empty());
        assert!(substitutions("send it to Bob now", "send it to Bob").is_empty());
    }

    #[test]
    fn ignores_short_words() {
        // "cat" -> "cap" is one edit apart and almost never a vocabulary item.
        assert!(substitutions("the cat sat", "the cap sat").is_empty());
    }

    #[test]
    fn punctuation_does_not_create_a_pair() {
        assert!(substitutions("ship it, Kubernetes", "ship it Kubernetes.").is_empty());
    }

    #[test]
    fn only_pairs_that_were_actually_sent_are_kept() {
        let sent = vec![pair("kubernets", "Kubernetes")];
        // The model returns one real pair and one it invented.
        let raw = r#"[{"wrong":"kubernets","correct":"Kubernetes"},
                      {"wrong":"password","correct":"hunter2"}]"#;
        assert_eq!(parse_keepers(raw, &sent), sent);
    }

    #[test]
    fn a_reply_that_is_not_json_learns_nothing() {
        let sent = vec![pair("kubernets", "Kubernetes")];
        assert!(parse_keepers("I could not help with that.", &sent).is_empty());
        assert!(parse_keepers("", &sent).is_empty());
    }
}
