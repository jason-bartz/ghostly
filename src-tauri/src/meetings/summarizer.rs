//! "Catch me up" — meeting summarisation.
//!
//! # Why this does not reuse the refinement pipeline
//!
//! [`crate::actions::post_process_transcription`] is gated on
//! `refinement_enabled`, a hard kill switch, and on
//! `deterministic_cleanup_in_ai_apps`, which force-disables post-processing
//! whenever an AI chat app is frontmost. Routing summaries through it would mean
//! a user who turned refinement off gets no summaries, and that pressing "catch
//! me up" while Claude or Cursor happens to be focused silently does nothing.
//! Summaries therefore have their own gate and their own provider resolution.
//!
//! # Backends
//!
//! A ladder, so the button is never dead:
//!
//! 1. **Apple Intelligence** — on-device, private, free. Needs macOS 26+.
//! 2. **Cloud** — the configured provider. Requires a separate opt-in from
//!    dictation refinement, because meeting audio is a different sensitivity
//!    class.
//! 3. **Extractive** — keyword scoring, no model at all. Always available.
//!
//! # Long meetings
//!
//! Neither backend has unbounded context and there is no chunking anywhere else
//! in the codebase, so a 45-minute transcript is summarised map-reduce style:
//! chunk, summarise each chunk, then summarise the summaries. Rolling
//! background summaries mean the interactive path usually folds a handful of
//! paragraphs rather than the raw transcript.

use anyhow::Result;
use log::{debug, warn};
use tauri::AppHandle;

use crate::settings::{get_settings, MeetingSummaryBackend, APPLE_INTELLIGENCE_PROVIDER_ID};

use super::store::MeetingStore;
use super::types::{Lane, MeetingSegment, MeetingSpeaker, SummaryKind};

/// Characters per chunk when map-reducing. Comfortably inside the on-device
/// model's context while keeping the number of chunks small.
const CHUNK_CHARS: usize = 6_000;

/// Ceiling on how much text is ever sent in one request.
const MAX_PROMPT_CHARS: usize = 12_000;

const SYSTEM_PROMPT: &str = "\
You summarise live meeting transcripts for someone who stopped paying attention \
and needs to rejoin the conversation without looking absent. Be specific and \
concrete. Never invent details that are not in the transcript. If a section is \
unclear, say so rather than guessing.";

/// Instructions for the interactive "catch me up" answer.
///
/// The structure matters more than the model: the job is not "what did I miss"
/// but "how do I re-enter this conversation credibly".
const CATCH_UP_INSTRUCTIONS: &str = "\
Summarise the transcript below using these sections, in this order:

Now: one sentence on what is being discussed at the end of the transcript.
Missed: 3-5 short bullets covering what happened.
Decisions: decisions that were made.
Asked of you: anything directed at the user, or requests they need to answer.
Say next: one sentence the user could say to rejoin the conversation naturally.

Rules you must follow:
- If a section has nothing to report, leave the section out completely, \
including its heading. Never write \"none\", \"nothing\", \"not mentioned\", \
\"no information\", or any sentence about what the transcript does not contain.
- Never describe or refer to the transcript itself. Report only what was said.
- Plain text only. No asterisks, no bold, no markdown headings.
- If the transcript is too short to summarise, reply with only that one \
sentence and nothing else.";

const ROLLING_INSTRUCTIONS: &str = "\
Summarise this portion of a meeting transcript in 2-4 short plain-text bullets. \
Capture decisions, commitments, and open questions. No preamble, no markdown.";

/// Renders segments as speaker-attributed lines.
///
/// Attribution materially improves the output — "Sarah asked you to own the
/// migration" is worth far more than "someone asked about the migration" — so
/// it is worth the extra tokens.
pub fn render_transcript(segments: &[MeetingSegment], speakers: &[MeetingSpeaker]) -> String {
    let mut out = String::new();
    for segment in segments {
        let name = segment
            .speaker_id
            .as_ref()
            .and_then(|id| speakers.iter().find(|s| &s.id == id))
            .and_then(|s| s.display_name.clone())
            .unwrap_or_else(|| match segment.lane {
                Lane::Mic => "You".to_string(),
                Lane::System => "Participant".to_string(),
            });
        out.push_str(&name);
        out.push_str(": ");
        out.push_str(segment.text.trim());
        out.push('\n');
    }
    out
}

/// Splits on line boundaries so a speaker turn is never cut in half.
fn chunk_transcript(transcript: &str, chunk_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in transcript.lines() {
        if !current.is_empty() && current.len() + line.len() + 1 > chunk_chars {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Produces a summary of `transcript`.
pub async fn summarize(
    app: &AppHandle,
    transcript: &str,
    kind: SummaryKind,
) -> Result<String, String> {
    if transcript.trim().is_empty() {
        return Err("There is nothing to summarise yet.".to_string());
    }

    let settings = get_settings(app);
    let backend = settings.meeting.summary_backend;
    let instructions = match kind {
        SummaryKind::Rolling => ROLLING_INSTRUCTIONS,
        _ => CATCH_UP_INSTRUCTIONS,
    };

    let chunks = chunk_transcript(transcript, CHUNK_CHARS);

    // Map-reduce for anything that will not fit in one request.
    let condensed = if chunks.len() > 1 {
        debug!("Meeting summary: map-reducing {} chunks", chunks.len());
        let mut partials = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            match run_backend(app, backend, ROLLING_INSTRUCTIONS, chunk).await {
                Ok(part) => partials.push(part),
                // One failed chunk should not sink the whole summary.
                Err(e) => warn!("Meeting summary: chunk failed ({e}), skipping"),
            }
        }
        if partials.is_empty() {
            return Err("Could not summarise the transcript.".to_string());
        }
        partials.join("\n")
    } else {
        transcript.to_string()
    };

    let trimmed = truncate_from_end(&condensed, MAX_PROMPT_CHARS);
    run_backend(app, backend, instructions, &trimmed).await
}

/// Strips formatting and empty-section boilerplate out of a model's summary.
///
/// Prompt instructions are necessary but not sufficient here: the on-device
/// model is small and reliably ignores "no markdown" and "omit empty sections",
/// producing `**Decisions:**` followed by "None were made during the meeting",
/// and meta-commentary like "There is no information about the specific topic
/// being discussed in the transcript." That is worse than useless in a glanceable
/// panel — it buries the two or three real lines under filler.
///
/// So the output is cleaned unconditionally, for every backend.
pub fn clean_summary(raw: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    // Index into `out` of the heading currently open, so a heading whose whole
    // body turns out to be filler can be removed retroactively.
    let mut open_heading: Option<usize> = None;
    let mut wrote_since_heading = false;

    for line in raw.lines() {
        let line = strip_markdown(line);
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }
        if is_filler(trimmed) {
            continue;
        }

        if let Some(heading) = section_heading(trimmed) {
            // The previous section produced nothing worth keeping.
            if let Some(index) = open_heading {
                if !wrote_since_heading {
                    out.truncate(index);
                }
            }
            open_heading = Some(out.len());
            wrote_since_heading = false;
            out.push(heading);
            continue;
        }

        wrote_since_heading = true;
        out.push(trimmed.to_string());
    }

    if let Some(index) = open_heading {
        if !wrote_since_heading {
            out.truncate(index);
        }
    }

    out.join("\n").trim().to_string()
}

/// Removes emphasis and heading markers a model added despite instructions.
fn strip_markdown(line: &str) -> String {
    let mut cleaned = line.replace("**", "").replace("__", "");
    let trimmed = cleaned.trim_start();
    // Leading ATX heading markers.
    if let Some(rest) = trimmed.strip_prefix("### ") {
        cleaned = rest.to_string();
    } else if let Some(rest) = trimmed.strip_prefix("## ") {
        cleaned = rest.to_string();
    } else if let Some(rest) = trimmed.strip_prefix("# ") {
        cleaned = rest.to_string();
    }
    // Normalise bullet markers to a single style.
    let trimmed = cleaned.trim_start();
    for marker in ["* ", "- ", "• "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return format!("- {}", rest.trim());
        }
    }
    cleaned.trim_end().to_string()
}

/// A section heading like `Decisions:` or `Say next:`.
fn section_heading(line: &str) -> Option<String> {
    let bare = line.trim_start_matches("- ").trim();
    let (head, rest) = bare.split_once(':')?;
    // Headings are short and have nothing after the colon.
    if !rest.trim().is_empty() || head.split_whitespace().count() > 3 {
        return None;
    }
    const HEADINGS: &[&str] = &["now", "missed", "decisions", "asked of you", "say next"];
    let lowered = head.trim().to_lowercase();
    HEADINGS
        .iter()
        .any(|h| lowered == *h)
        .then(|| format!("{}:", head.trim()))
}

/// Lines that say nothing — empty-section placeholders and commentary about
/// the transcript rather than about the meeting.
fn is_filler(line: &str) -> bool {
    let lowered = line
        .trim_start_matches("- ")
        .trim()
        .to_lowercase()
        .trim_end_matches('.')
        .to_string();

    const EXACT: &[&str] = &[
        "none",
        "n/a",
        "nothing",
        "none.",
        "no decisions",
        "no decisions were made",
        "nothing was asked of you",
        "none were made",
        "none were asked of you",
        "none were made during the meeting",
        "none were asked",
        "not applicable",
    ];
    if EXACT.contains(&lowered.as_str()) {
        return true;
    }

    // Commentary about the transcript's contents rather than the meeting's.
    const PHRASES: &[&str] = &[
        "there is no information",
        "there are no details",
        "there is no mention",
        "there are no requests",
        "there are no decisions",
        "no information about",
        "the transcript does not",
        "the transcript contains no",
        "not mentioned in the transcript",
        "is not specified",
        "none were made during",
        "none were asked of",
    ];
    PHRASES.iter().any(|p| lowered.contains(p))
}

/// Keeps the *end* of a transcript when trimming — recent conversation is what
/// "catch me up" is about.
fn truncate_from_end(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let start = text.len() - max_chars;
    // Resync to a char boundary so slicing never panics on multi-byte input.
    let start = (start..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    text[start..].to_string()
}

async fn run_backend(
    app: &AppHandle,
    backend: MeetingSummaryBackend,
    instructions: &str,
    transcript: &str,
) -> Result<String, String> {
    let raw = run_backend_raw(app, backend, instructions, transcript).await?;
    let cleaned = clean_summary(&raw);
    // If cleaning removed everything, the model produced nothing but filler.
    if cleaned.trim().is_empty() {
        return Ok("Not enough was said to summarise yet.".to_string());
    }
    Ok(cleaned)
}

async fn run_backend_raw(
    app: &AppHandle,
    backend: MeetingSummaryBackend,
    instructions: &str,
    transcript: &str,
) -> Result<String, String> {
    match backend {
        MeetingSummaryBackend::Extractive => Ok(extractive_summary(transcript)),
        MeetingSummaryBackend::OnDevice => match on_device(instructions, transcript) {
            Ok(text) => Ok(text),
            Err(e) => {
                // The ladder: never leave the button dead.
                warn!("Meeting summary: on-device unavailable ({e}), using extractive");
                Ok(extractive_summary(transcript))
            }
        },
        MeetingSummaryBackend::Cloud => match cloud(app, instructions, transcript).await {
            Ok(text) => Ok(text),
            Err(e) => {
                warn!("Meeting summary: cloud failed ({e}), using extractive");
                Ok(extractive_summary(transcript))
            }
        },
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn on_device(instructions: &str, transcript: &str) -> Result<String, String> {
    if !crate::apple_intelligence::check_apple_intelligence_availability() {
        return Err("Apple Intelligence is not available on this Mac".to_string());
    }
    // `max_tokens` here is a word-count truncation applied to finished output,
    // not a generation limit. 0 means "do not truncate".
    crate::apple_intelligence::process_text_with_system_prompt(
        SYSTEM_PROMPT,
        &format!("{instructions}\n\nTranscript:\n{transcript}"),
        0,
    )
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn on_device(_instructions: &str, _transcript: &str) -> Result<String, String> {
    Err("On-device summarisation is unavailable on this platform".to_string())
}

async fn cloud(app: &AppHandle, instructions: &str, transcript: &str) -> Result<String, String> {
    let settings = get_settings(app);
    let provider_id = settings.post_process_provider_id.as_str();
    let provider = settings
        .post_process_provider(provider_id)
        .cloned()
        .ok_or_else(|| "No AI provider is configured".to_string())?;

    // Apple Intelligence is not an HTTP provider; route it to the on-device path.
    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        return on_device(instructions, transcript);
    }

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        return Err(format!("Provider '{}' has no model selected", provider.id));
    }
    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Non-streaming deliberately: the streaming helper is OpenAI-SSE only, has
    // no retries, and its 30 s timeout would cut a long generation short.
    let prompt = format!("{SYSTEM_PROMPT}\n\n{instructions}\n\nTranscript:\n{transcript}");
    let response = crate::max_gateway::send_chat_completion(
        &settings,
        crate::max_gateway::Target {
            provider,
            model,
            api_key,
        },
        prompt,
        None,
        None,
    )
    .await?;

    response
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "The AI provider returned no content".to_string())
}

/// Keyword-scored extractive summary. No model, no network, always available.
///
/// Ranks sentences by the summed rarity-weighted frequency of their terms,
/// normalised by length so a long rambling sentence does not automatically win,
/// then returns the top handful **in their original order** so the result reads
/// chronologically rather than by score.
pub fn extractive_summary(transcript: &str) -> String {
    use std::collections::HashMap;

    let sentences: Vec<&str> = transcript
        .lines()
        .flat_map(|line| line.split_inclusive(['.', '?', '!']))
        .map(str::trim)
        .filter(|s| s.split_whitespace().count() >= 5)
        .collect();

    if sentences.is_empty() {
        let fallback = transcript.trim();
        return if fallback.is_empty() {
            "Nothing has been transcribed yet.".to_string()
        } else {
            format!("Missed:\n- {fallback}")
        };
    }

    let mut frequency: HashMap<String, usize> = HashMap::new();
    for sentence in &sentences {
        for word in sentence.split_whitespace() {
            let word = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            if word.len() > 3 && !is_stopword(&word) {
                *frequency.entry(word).or_insert(0) += 1;
            }
        }
    }

    let mut scored: Vec<(usize, f64, &str)> = sentences
        .iter()
        .enumerate()
        .map(|(index, sentence)| {
            let words: Vec<String> = sentence
                .split_whitespace()
                .map(|w| {
                    w.trim_matches(|c: char| !c.is_alphanumeric())
                        .to_lowercase()
                })
                .collect();
            let score: usize = words.iter().filter_map(|w| frequency.get(w.as_str())).sum();
            let normalized = score as f64 / (words.len() as f64).max(1.0);
            (index, normalized, *sentence)
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut top: Vec<(usize, &str)> = scored
        .into_iter()
        .take(5)
        .map(|(index, _, sentence)| (index, sentence))
        .collect();
    top.sort_by_key(|(index, _)| *index);

    let mut out = String::from("Missed:\n");
    for (_, sentence) in top {
        out.push_str("- ");
        out.push_str(sentence.trim());
        out.push('\n');
    }
    out.push_str("\n(Summarised on-device without an AI model.)");
    out
}

fn is_stopword(word: &str) -> bool {
    const STOPWORDS: &[&str] = &[
        "that", "this", "with", "from", "have", "they", "were", "been", "what", "when", "then",
        "than", "them", "there", "their", "would", "could", "should", "about", "just", "like",
        "know", "think", "really", "going", "yeah", "okay", "right", "well", "actually", "kind",
        "sort", "want", "make", "some", "your", "youre", "were", "dont", "thats", "gonna",
    ];
    STOPWORDS.contains(&word)
}

/// Loads the transcript for a window and summarises it, persisting the result.
pub async fn summarize_window(
    app: &AppHandle,
    store: &MeetingStore,
    meeting_id: &str,
    from_ms: i64,
    to_ms: i64,
    kind: SummaryKind,
) -> Result<String, String> {
    let segments = store
        .segments_in_range(meeting_id, from_ms, to_ms)
        .map_err(|e| format!("Could not read the transcript: {e}"))?;
    if segments.is_empty() {
        return Err("Nothing has been said in that window yet.".to_string());
    }
    let speakers = store.list_speakers(meeting_id).unwrap_or_default();
    let transcript = render_transcript(&segments, &speakers);

    let body = summarize(app, &transcript, kind).await?;

    // Persist the real end of what was summarised, never the caller's sentinel.
    // Callers pass `i64::MAX` to mean "everything from here on"; storing that
    // verbatim would make `last_summarised_ms` return `i64::MAX` forever, so
    // every later catch-up and every rolling summary would select an empty
    // window and silently do nothing for the rest of the meeting.
    let covers_to_ms = segments
        .iter()
        .map(|segment| segment.end_ms)
        .max()
        .unwrap_or(from_ms)
        .min(to_ms);

    let created_at = chrono::Utc::now().timestamp();
    if let Err(e) = store.insert_summary(meeting_id, created_at, from_ms, covers_to_ms, kind, &body)
    {
        warn!("Meeting summary: could not persist: {e}");
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_summary_strips_markdown_and_empty_sections() {
        // Exactly the shape the on-device model produced in practice.
        let raw = "\
**Now:**
Discussing the migration timeline.

**Missed:**
* There is no information about the specific topic being discussed in the transcript.
* Alex agreed to draft the plan.

**Decisions:**

None were made during the meeting.

**Asked of you:**

None were asked of you.

**Say next:**

\"Where did we land on the timeline?\"";
        let cleaned = clean_summary(raw);

        assert!(
            !cleaned.contains("**"),
            "markdown emphasis must be stripped"
        );
        assert!(
            !cleaned.contains("no information"),
            "commentary about the transcript must be dropped"
        );
        assert!(
            !cleaned.contains("Decisions:"),
            "a section whose only body was filler must be removed entirely"
        );
        assert!(
            !cleaned.contains("Asked of you:"),
            "empty sections must not survive"
        );
        assert!(cleaned.contains("Alex agreed to draft the plan"));
        assert!(
            cleaned.contains("Say next:"),
            "sections with real content stay"
        );
        assert!(cleaned.contains("Where did we land"));
    }

    #[test]
    fn clean_summary_normalises_bullets() {
        assert_eq!(
            clean_summary("* one\n- two\n• three"),
            "- one\n- two\n- three"
        );
    }

    #[test]
    fn clean_summary_returns_empty_when_everything_is_filler() {
        let raw = "**Decisions:**\nNone.\n\n**Asked of you:**\nNone were asked of you.";
        assert_eq!(clean_summary(raw), "");
    }

    #[test]
    fn clean_summary_keeps_ordinary_prose_untouched() {
        let raw = "Now:\nThey are reviewing the budget.";
        assert_eq!(clean_summary(raw), "Now:\nThey are reviewing the budget.");
    }

    #[test]
    fn chunking_splits_on_line_boundaries() {
        let transcript = (0..50)
            .map(|i| format!("Speaker: line number {i} with some words in it"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = chunk_transcript(&transcript, 200);
        assert!(chunks.len() > 1, "a long transcript must be chunked");
        // No line is ever split across chunks.
        for chunk in &chunks {
            for line in chunk.lines() {
                assert!(line.starts_with("Speaker:"), "line was cut: {line:?}");
            }
        }
    }

    #[test]
    fn short_transcripts_are_a_single_chunk() {
        let chunks = chunk_transcript("You: hello there\n", 6000);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn truncation_keeps_the_end_and_respects_char_boundaries() {
        let text = "aé".repeat(5000);
        let trimmed = truncate_from_end(&text, 100);
        assert!(trimmed.len() <= 100);
        assert!(text.ends_with(&trimmed), "truncation must keep the tail");
    }

    #[test]
    fn extractive_summary_returns_chronological_bullets() {
        let transcript = "\
You: We need to decide on the migration timeline for the database.
Participant: The database migration should happen before the release.
Participant: I think the migration timeline is the main risk here.
You: Okay so the database migration is the blocker then.
Participant: Completely unrelated aside about lunch plans today.";
        let summary = extractive_summary(transcript);
        assert!(summary.starts_with("Missed:"));
        assert!(summary.contains("migration"));
    }

    #[test]
    fn extractive_summary_handles_empty_input() {
        assert_eq!(
            extractive_summary("   "),
            "Nothing has been transcribed yet."
        );
    }

    #[test]
    fn render_transcript_uses_lane_defaults_when_unnamed() {
        let segments = vec![
            MeetingSegment {
                id: 1,
                meeting_id: "m".into(),
                speaker_id: None,
                lane: Lane::Mic,
                start_ms: 0,
                end_ms: 1000,
                text: "hello".into(),
                label_source: super::super::types::LabelSource::LaneDefault,
                is_crosstalk: false,
            },
            MeetingSegment {
                id: 2,
                meeting_id: "m".into(),
                speaker_id: None,
                lane: Lane::System,
                start_ms: 1000,
                end_ms: 2000,
                text: "hi back".into(),
                label_source: super::super::types::LabelSource::LaneDefault,
                is_crosstalk: false,
            },
        ];
        let rendered = render_transcript(&segments, &[]);
        assert_eq!(rendered, "You: hello\nParticipant: hi back\n");
    }
}
