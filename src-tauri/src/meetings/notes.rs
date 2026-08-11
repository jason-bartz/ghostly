//! The notepad, and the AI pass that finishes it.
//!
//! # What "enhance" means here
//!
//! Not "summarise the meeting" — that is [`super::summarizer`], and it already
//! runs by itself when a meeting ends. This takes the half-sentences someone
//! typed *while* they were talking and completes them from the transcript: the
//! number they did not catch, the name they abbreviated, the bullet they
//! abandoned mid-word when the conversation moved on.
//!
//! That distinction drives every decision below. The user's notes are the
//! skeleton and the transcript is the filler, never the other way round — a
//! model handed both and asked for "notes" will happily throw away the human's
//! structure and write its own, which produces a fine summary and a useless
//! enhancement.
//!
//! # Both versions are kept
//!
//! [`super::store::MeetingStore::set_enhanced_notes`] writes a separate column.
//! The user's own words are never overwritten, so a disappointing enhancement
//! costs nothing and can be re-run.

use log::warn;
use tauri::AppHandle;

use crate::settings::get_settings;

use super::store::MeetingStore;
use super::summarizer;
use super::types::SummaryKind;

/// How much of the prompt budget the transcript may take. The rest is the
/// user's notes, which are never condensed — they are the thing being worked
/// on, and summarising the input to a summariser loses the very details this
/// feature exists to recover.
const TRANSCRIPT_BUDGET: usize = 9_000;

/// Ceiling on the notes themselves. Far above any real notepad; it exists so a
/// pasted document cannot push the transcript out of the prompt entirely.
const NOTES_BUDGET: usize = 6_000;

const NOTES_SYSTEM_PROMPT: &str = "\
You finish someone's meeting notes for them. You are given two documents: the \
notes they typed during the meeting, and the transcript of what was actually \
said. Their notes are the skeleton and they are always right. The transcript is \
only there to complete them. You never invent anything that is not in one of \
the two documents.";

/// Instructions for the enhancement pass.
///
/// The order of these rules is deliberate: every one of the "keep theirs"
/// instructions comes before any of the "add yours" instructions, because a
/// model that reads the standard sections first starts writing a summary and
/// treats the user's notes as source material for it.
const NOTES_INSTRUCTIONS: &str = "\
Rewrite the notes below into the notes the user would have written if they had \
had time, using the transcript to complete them.

Build it like this:
- Start from their notes. Keep every heading they wrote, in the order they \
wrote it, spelled the way they spelled it. Keep their bullets and their wording.
- Complete each of their points from the transcript: the figure they did not \
catch, the name they abbreviated, the answer to the question they left hanging, \
the sentence they stopped typing halfway through.
- Turn shorthand into full sentences, but keep their voice. Do not make it \
longer than it needs to be.
- Only after all of their own material, add the standard sections below for \
anything the meeting settled that their notes do not already cover.
- If a note disagrees with the transcript, keep the note as they wrote it.

Standard sections, in this order, and only when there is something to put in \
them:

Decisions: decisions that were made.
Action items: one bullet each, written as the owner's name, an em dash, then \
what they agreed to do, and a due date if one was given.
Open questions: anything left unresolved or deferred.

Rules you must follow:
- Never invent a fact, a name, a figure or a commitment that is not in the \
notes or the transcript.
- A heading is a word or two followed by a colon, alone on its line. Bullets \
start with \"- \".
- Plain text only. No asterisks, no bold, no markdown headings, no code fences.
- Do not mention the notes, the transcript or yourself. Write only the finished \
notes.";

/// Enhances a meeting's notes and stores the result.
///
/// Returns the enhanced body. The user's own notes are untouched either way.
pub async fn enhance(
    app: &AppHandle,
    store: &MeetingStore,
    meeting_id: &str,
) -> Result<String, String> {
    let notes = store
        .get_notes(meeting_id)
        .map_err(|e| format!("Could not read the notes: {e}"))?
        .notes
        .unwrap_or_default();

    let transcript = transcript_for(app, store, meeting_id).await?;

    let body = if notes.trim().is_empty() {
        // Nothing to build on. Writing the record from the transcript alone is
        // exactly the wrap-up, so it goes through that path rather than a
        // second prompt that would say the same thing slightly differently —
        // and unlike the enhancement prompt, it degrades all the way down to
        // extractive, so an empty notepad never produces a dead button.
        summarizer::summarize(app, &transcript, SummaryKind::Final).await?
    } else {
        let settings = get_settings(app);
        let backend = settings.meeting.summary_backend.resolve(&settings);
        let prompt = format!(
            "{NOTES_INSTRUCTIONS}\n\nTheir notes:\n{}\n\nTranscript:\n{}",
            truncate_from_start(&notes, NOTES_BUDGET),
            transcript,
        );
        match summarizer::run_model(app, backend, NOTES_SYSTEM_PROMPT, &prompt).await {
            Ok(raw) => {
                let cleaned = clean_notes(&raw);
                // A model that answered with nothing but filler has effectively
                // failed, and returning its empty string would look like the
                // enhancement had wiped the user's notes.
                if cleaned.trim().is_empty() {
                    merged_fallback(&notes, &transcript)
                } else {
                    cleaned
                }
            }
            Err(e) => {
                // No model, or the model failed. Stitching the two documents
                // together is not an enhancement, but it is honest, it is
                // useful, and it keeps the button alive.
                warn!("Meeting notes: enhancement unavailable ({e}), merging instead");
                merged_fallback(&notes, &transcript)
            }
        }
    };

    let at = chrono::Utc::now().timestamp();
    if let Err(e) = store.set_enhanced_notes(meeting_id, &body, at) {
        warn!("Meeting notes: could not persist the enhancement: {e}");
    }
    Ok(body)
}

/// The transcript to work from, condensed if the meeting was a long one.
async fn transcript_for(
    app: &AppHandle,
    store: &MeetingStore,
    meeting_id: &str,
) -> Result<String, String> {
    let segments = store
        .list_segments(meeting_id)
        .map_err(|e| format!("Could not read the transcript: {e}"))?;
    if segments.is_empty() {
        return Err("There is no transcript to enhance these notes from.".to_string());
    }
    let speakers = store.list_speakers(meeting_id).unwrap_or_default();
    let full = summarizer::render_transcript(&segments, &speakers);

    if full.len() <= TRANSCRIPT_BUDGET {
        return Ok(full);
    }
    let condensed = summarizer::condense(app, &full).await;
    Ok(summarizer::truncate_from_end(&condensed, TRANSCRIPT_BUDGET))
}

/// What the user gets when there is no model to run.
///
/// Their notes, verbatim and first, with the transcript's highest-signal
/// sentences under a heading that says exactly where they came from. Nobody
/// will mistake this for the AI pass, which is the point.
fn merged_fallback(notes: &str, transcript: &str) -> String {
    let extract = summarizer::extractive_summary(transcript);
    // `extractive_summary` labels its own output "Missed:", which belongs to
    // the catch-up vocabulary and makes no sense at the bottom of a notepad.
    let body = extract
        .lines()
        .filter(|line| !line.trim_end().eq_ignore_ascii_case("missed:"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{}\n\nFrom the transcript:\n{}",
        notes.trim_end(),
        body.trim()
    )
}

/// Tidies a model's notes without flattening them.
///
/// Deliberately not [`summarizer::clean_summary`], which drops every blank line
/// — correct for a summary in a small panel, wrong for a page of notes, where
/// the blank line between sections is most of the readability. This keeps the
/// paragraph structure and only removes the things a model adds against
/// instructions: emphasis markers, code fences, and empty-section filler.
pub fn clean_notes(raw: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut blank_pending = false;

    for line in raw.lines() {
        let trimmed_raw = line.trim();
        // Fences arrive as a bare ``` or ```markdown wrapping the whole answer.
        if trimmed_raw.starts_with("```") {
            continue;
        }

        let cleaned = summarizer::strip_markdown(line);
        let trimmed = cleaned.trim();

        if trimmed.is_empty() {
            // Runs of blank lines collapse to one, and leading blanks are
            // dropped entirely rather than pushing the notes down the pane.
            blank_pending = !out.is_empty();
            continue;
        }
        if summarizer::is_filler(trimmed) {
            continue;
        }

        // A heading always gets air above it, whether the model left one or
        // not — this is what makes the user's own sections read as sections.
        let wants_gap = is_heading(trimmed)
            && out
                .last()
                .is_some_and(|previous| !previous.is_empty() && !is_heading(previous));
        if blank_pending || wants_gap {
            out.push(String::new());
            blank_pending = false;
        }
        out.push(trimmed.to_string());
    }

    // A trailing heading has nothing under it, which is the one shape
    // `clean_notes` can fix without guessing.
    while out.last().is_some_and(|last| is_heading(last)) {
        out.pop();
        while out.last().is_some_and(|last| last.is_empty()) {
            out.pop();
        }
    }

    out.join("\n").trim().to_string()
}

/// A section heading: a short label alone on its line, ending in a colon.
///
/// Unlike [`summarizer`]'s equivalent this does not check the label against a
/// list. The whole promise of enhancement is that the user's own headings
/// survive, and "Pricing:" is not on anybody's list.
fn is_heading(line: &str) -> bool {
    let bare = line.trim();
    if bare.starts_with("- ") {
        return false;
    }
    match bare.split_once(':') {
        Some((head, rest)) => {
            rest.trim().is_empty()
                && !head.trim().is_empty()
                && head.split_whitespace().count() <= 4
        }
        None => false,
    }
}

/// Keeps the *beginning* when trimming notes — the opposite of a transcript.
/// Notes are written top-down and their first lines carry the structure.
fn truncate_from_start(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let end = (0..=max_chars)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_headings_survive_cleaning() {
        // The heading a summariser would not recognise is exactly the one that
        // must not be thrown away.
        let raw = "**Pricing:**\n- Landed on $40k\n\n**Decisions:**\n- Ship Friday";
        let cleaned = clean_notes(raw);
        assert!(cleaned.contains("Pricing:"));
        assert!(cleaned.contains("Decisions:"));
        assert!(!cleaned.contains('*'));
    }

    #[test]
    fn blank_lines_between_sections_are_kept() {
        // `clean_summary` drops these, which is why notes need their own pass.
        let cleaned = clean_notes("Pricing:\n- $40k\n\nTimeline:\n- Friday");
        assert_eq!(cleaned, "Pricing:\n- $40k\n\nTimeline:\n- Friday");
    }

    #[test]
    fn a_missing_gap_before_a_heading_is_inserted() {
        let cleaned = clean_notes("- We agreed the number\nDecisions:\n- Ship Friday");
        assert_eq!(
            cleaned,
            "- We agreed the number\n\nDecisions:\n- Ship Friday"
        );
    }

    #[test]
    fn runs_of_blank_lines_collapse() {
        assert_eq!(
            clean_notes("Notes:\n- one\n\n\n\n- two"),
            "Notes:\n- one\n\n- two"
        );
    }

    #[test]
    fn code_fences_and_filler_sections_are_dropped() {
        let raw = "```markdown\nPricing:\n- $40k\n\nOpen questions:\nNone.\n```";
        let cleaned = clean_notes(raw);
        assert!(!cleaned.contains("```"));
        assert!(!cleaned.contains("None"));
        // The heading whose only body was filler goes with it.
        assert!(!cleaned.contains("Open questions:"));
        assert_eq!(cleaned, "Pricing:\n- $40k");
    }

    #[test]
    fn bullets_are_not_mistaken_for_headings() {
        // A bullet can contain a colon; treating it as a heading would insert
        // a blank line into the middle of a list.
        let cleaned = clean_notes("Actions:\n- Priya: draft the runbook\n- Alex: review it");
        assert_eq!(
            cleaned,
            "Actions:\n- Priya: draft the runbook\n- Alex: review it"
        );
    }

    #[test]
    fn the_fallback_keeps_the_users_words_first_and_whole() {
        let notes = "Pricing:\n- 40k?";
        let merged = merged_fallback(
            notes,
            "You: We settled on forty thousand for the pilot year.\n\
             Participant: Forty thousand works for the pilot year budget.",
        );
        assert!(merged.starts_with("Pricing:\n- 40k?"));
        assert!(merged.contains("From the transcript:"));
        // The catch-up vocabulary has no business in a notepad.
        assert!(!merged.contains("Missed:"));
    }

    #[test]
    fn notes_are_truncated_from_the_top_down() {
        let text = "héading:\n".repeat(500);
        let trimmed = truncate_from_start(&text, 100);
        assert!(trimmed.len() <= 100);
        assert!(text.starts_with(&trimmed), "the opening must be kept");
    }

    #[test]
    fn enhancement_never_returns_an_empty_document() {
        // Whatever the model does, the user must not watch their notes vanish.
        assert!(!merged_fallback("Pricing:\n- 40k?", "   ").trim().is_empty());
    }
}
