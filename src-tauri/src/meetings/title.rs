//! What a meeting is called.
//!
//! Two names, in sequence. The **placeholder**, `"{platform} meeting -
//! {MM/DD/YY}"`, is given the instant capture starts, by every path that starts
//! one: auto-detection, the panel button, the tray item and the global
//! shortcut. They used to disagree — detection produced "Zoom call" or whatever
//! the window title happened to say, while a manual start produced nothing at
//! all and the meeting showed up as "Untitled meeting".
//!
//! Then the **generated** name, written by a model from what was actually said
//! — "Q3 Pricing Review with Acme" rather than "Zoom meeting - 08/12/26", which
//! is the same for every Zoom call that day and says nothing about any of them.
//! It is drafted once enough has been said to know what the meeting is about,
//! corrected once more as the meeting finds its subject, and settled from the
//! wrap-up when it ends.
//!
//! The rule that makes this safe: a name the user typed is final. See
//! [`super::types::TitleSource`] and [`super::store::MeetingStore::set_ai_title`].

use std::sync::Arc;

use chrono::Local;
use log::debug;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use super::store::MeetingStore;
use super::types::{MeetingTitleEvent, TitleSource};
use crate::settings::{get_settings, MeetingSummaryBackend};

/// `"Google Meet meeting - 08/12/26"`.
///
/// The date is the *local* date, because it names the day the user had the
/// meeting, not the day UTC thought it was.
pub fn default_title(platform: &str) -> String {
    stamped_title(platform, Local::now().format("%m/%d/%y").to_string())
}

/// The placeholder a meeting would have been given when it started — for a
/// user who clears a name and hands naming back to Ghostly. Dated by the
/// meeting, not by today, so clearing last Tuesday's title gives back last
/// Tuesday's placeholder.
pub fn placeholder_for(platform: Option<&str>, started_at: i64) -> String {
    use chrono::TimeZone;
    let date = Local
        .timestamp_opt(started_at, 0)
        .single()
        .unwrap_or_else(Local::now)
        .format("%m/%d/%y")
        .to_string();
    stamped_title(platform.unwrap_or_default(), date)
}

/// Split out so the format is testable without freezing the clock.
fn stamped_title(platform: &str, date: String) -> String {
    let platform = platform.trim();
    if platform.is_empty() {
        // Nothing identified the app — better a dated meeting than an
        // "Untitled meeting" that sorts identically to every other one.
        return format!("Meeting - {date}");
    }
    format!("{platform} meeting - {date}")
}

/// Whether `bundle_id` is Ghostly itself — frontmost whenever the user starts a
/// meeting from the panel or the tray, and never the platform of the call.
pub fn is_ghostly(bundle_id: Option<&str>) -> bool {
    bundle_id.is_some_and(|id| id.eq_ignore_ascii_case(SELF_BUNDLE_ID))
}

/// Ghostly's own bundle identifier, which is never the platform of a meeting.
///
/// Pressing "Start meeting" in the panel, or picking it out of the tray, makes
/// Ghostly the frontmost app at the moment capture begins — so the obvious
/// implementation names every hand-started meeting "Ghostly meeting".
const SELF_BUNDLE_ID: &str = "com.getghostly.desktop";

/// The title for a meeting started by hand, from whatever app was in front.
///
/// The frontmost app is a weaker signal than a detected call — the user may
/// simply have had a browser focused — so an unrecognised browser page falls
/// back to the browser's own name rather than being discarded. Ghostly itself
/// is discarded, leaving a plain dated title.
pub fn for_frontmost_app(bundle_id: Option<&str>, display_name: Option<&str>) -> String {
    if is_ghostly(bundle_id) {
        return default_title("");
    }
    let platform = match (bundle_id, display_name) {
        (Some(bundle_id), Some(display_name)) => {
            super::platform::resolve(bundle_id, display_name).unwrap_or_else(|| display_name.into())
        }
        (_, Some(display_name)) => display_name.to_string(),
        _ => String::new(),
    };
    default_title(&platform)
}

// ---- Generated titles ------------------------------------------------------

/// Transcript, in characters, before a live meeting is worth naming.
///
/// About three minutes of conversation. Less than that is usually greetings and
/// "can everyone see my screen", and a title drawn from small talk is worse
/// than the placeholder — it is confidently about the wrong thing.
pub const LIVE_TITLE_MIN_CHARS: i64 = 3_000;

/// Transcript, in characters, at which a live title is drafted again.
///
/// Meetings wander into their subject. The first draft names what was being
/// discussed at minute three; by here it is clear what the meeting is for.
pub const LIVE_TITLE_REFRESH_CHARS: i64 = 14_000;

/// Longest generated title kept, in characters.
const MAX_TITLE_CHARS: usize = 72;

/// Most transcript sent to name a meeting.
const MAX_SOURCE_CHARS: usize = 10_000;

const TITLE_SYSTEM_PROMPT: &str = "\
You name meetings from their transcripts, the way a sharp assistant would label \
them in a calendar. You reply with the title and nothing else.";

const TITLE_INSTRUCTIONS: &str = "\
Write a title for this meeting.

Rules you must follow:
- 3 to 7 words, in Title Case.
- Name what the meeting is about, specifically: the project, decision, deal or \
topic. Good: \"Q3 Pricing Review with Acme\", \"Onboarding Flow Redesign \
Kickoff\", \"Hiring Plan for Platform Team\".
- Ignore greetings, small talk and audio checks.
- Include a company or person's name only when it is central to the meeting.
- Never include dates, times, or the app it was held on (Zoom, Meet, Teams).
- Never start with \"Meeting\", \"Discussion\", \"Call\" or \"Conversation\".
- No quotes, no trailing punctuation, no emoji, no markdown.
- Reply with the title only.";

/// Pulls a usable title out of whatever the model replied.
///
/// Models are told to answer with the title alone and mostly do, but small
/// on-device ones wrap it in quotes, bold it, prefix it with "Title:", or
/// apologise instead. All of that is cleaned or refused here, for every
/// backend, so nothing but a short clean name ever reaches the meeting row.
pub(crate) fn sanitize(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;

    let mut title = line.trim_start_matches(['#', '*', '-', '•', ' ']).trim();
    for prefix in ["title:", "meeting title:", "suggested title:"] {
        if title.len() >= prefix.len() && title[..prefix.len()].eq_ignore_ascii_case(prefix) {
            title = title[prefix.len()..].trim();
        }
    }
    let title = title
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '_' | '“' | '”' | '‘' | '’'))
        .trim_end_matches(['.', '!', '?', ':', ';', ','])
        .trim();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");

    if title.is_empty() || title.split(' ').count() > 12 {
        return None;
    }
    let lowered = title.to_lowercase();
    const REFUSALS: &[&str] = &[
        "i'm sorry",
        "i am sorry",
        "i can't",
        "i cannot",
        "as an ai",
        "unfortunately",
        "not enough",
        "no transcript",
        "insufficient",
        "unable to",
    ];
    if REFUSALS.iter().any(|r| lowered.contains(r)) {
        return None;
    }
    const GENERIC: &[&str] = &[
        "meeting",
        "untitled",
        "untitled meeting",
        "meeting title",
        "discussion",
        "conversation",
        "call",
        "general discussion",
        "team meeting",
    ];
    if GENERIC.contains(&lowered.as_str()) {
        return None;
    }

    if title.chars().count() <= MAX_TITLE_CHARS {
        return Some(title);
    }
    // Over-long: cut at a word boundary rather than mid-word.
    let mut cut = String::new();
    for word in title.split(' ') {
        if cut.chars().count() + word.chars().count() + 1 > MAX_TITLE_CHARS {
            break;
        }
        if !cut.is_empty() {
            cut.push(' ');
        }
        cut.push_str(word);
    }
    (!cut.is_empty()).then_some(cut)
}

/// At most `max` bytes from the start of `text`, cut on a character boundary.
fn head(text: &str, max: usize) -> &str {
    let end = (0..=text.len().min(max))
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    &text[..end]
}

/// The slice of a long transcript a title is drawn from: the opening, where
/// the agenda is usually stated, and the latest stretch, where the meeting has
/// found its subject.
fn title_source_text(transcript: &str) -> String {
    if transcript.len() <= MAX_SOURCE_CHARS {
        return transcript.to_string();
    }
    let tail = super::summarizer::truncate_from_end(transcript, MAX_SOURCE_CHARS * 3 / 5);
    format!(
        "{}\n[…]\n{}",
        head(transcript, MAX_SOURCE_CHARS * 2 / 5),
        tail
    )
}

/// Payload of `meeting-title-pending`: a name is being written for this
/// meeting, so the panel can show the title as in progress.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTitlePending {
    pub meeting_id: String,
    pub pending: bool,
}

/// Names a meeting from what was said, and tells every window.
///
/// `summary` is the wrap-up, when there is one: it is the meeting already
/// distilled by a larger model, and names it better than any slice of the raw
/// transcript. `force` is the user asking for a generated name outright, which
/// is the one time a name they typed may be replaced.
///
/// Returns `Ok(None)` when the meeting is the user's to name — not an error,
/// just nothing to do.
pub async fn generate(
    app: &AppHandle,
    store: &MeetingStore,
    meeting_id: &str,
    summary: Option<&str>,
    force: bool,
) -> Result<Option<String>, String> {
    if !force && store.title_source(meeting_id).unwrap_or_default() == TitleSource::User {
        return Ok(None);
    }

    let settings = get_settings(app);
    let backend = settings.meeting.summary_backend.resolve(&settings);
    if backend == MeetingSummaryBackend::Extractive {
        return Err(
            "Naming a meeting needs an AI model. Choose one in Settings → Meetings.".into(),
        );
    }

    let segments = store
        .list_segments(meeting_id)
        .map_err(|e| format!("Could not read the transcript: {e}"))?;
    let speakers = store.list_speakers(meeting_id).unwrap_or_default();
    let transcript = super::summarizer::render_transcript(&segments, &speakers);
    if transcript.trim().is_empty() {
        return Err("Nothing has been said yet.".into());
    }

    // The extractive fallback's "summary" is a handful of transcript sentences
    // with a footer, not a distillation, and would only mislead the model.
    let summary = summary.filter(|s| !s.contains("without an AI model") && !s.trim().is_empty());
    let source = match summary {
        Some(summary) => format!(
            "Summary of the meeting:\n{summary}\n\nOpening of the transcript:\n{}",
            head(&transcript, 2_500)
        ),
        None => format!("Transcript:\n{}", title_source_text(&transcript)),
    };
    let prompt = format!("{TITLE_INSTRUCTIONS}\n\n{source}");

    let pending = |pending: bool| {
        let _ = app.emit(
            "meeting-title-pending",
            MeetingTitlePending {
                meeting_id: meeting_id.to_string(),
                pending,
            },
        );
    };
    pending(true);
    let reply = super::summarizer::run_model(
        app,
        backend,
        TITLE_SYSTEM_PROMPT,
        &prompt,
        crate::max_gateway::Job::Fast,
    )
    .await;
    pending(false);

    let title = sanitize(&reply?).ok_or("The model didn't come up with a usable title.")?;
    let written = store
        .set_ai_title(meeting_id, &title, force)
        .map_err(|e| format!("Could not save the title: {e}"))?;
    if !written {
        // Renamed by the user while the model was thinking. Theirs stands.
        debug!("Meeting title: {meeting_id} was renamed meanwhile; keeping the user's name");
        return Ok(None);
    }

    if let Some(manager) = app.try_state::<Arc<super::MeetingManager>>() {
        manager.rename_active(meeting_id, Some(title.clone()), TitleSource::Ai);
    }
    let _ = app.emit(
        "meeting-title",
        MeetingTitleEvent {
            meeting_id: meeting_id.to_string(),
            title: title.clone(),
            source: TitleSource::Ai,
        },
    );
    Ok(Some(title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_title_passes_through() {
        assert_eq!(
            sanitize("Q3 Pricing Review with Acme"),
            Some("Q3 Pricing Review with Acme".to_string())
        );
    }

    #[test]
    fn decoration_models_add_is_stripped() {
        assert_eq!(
            sanitize("Title: \"Onboarding Flow Redesign Kickoff.\""),
            Some("Onboarding Flow Redesign Kickoff".to_string())
        );
        assert_eq!(
            sanitize("**Hiring Plan for Platform Team**\n\nThis title reflects…"),
            Some("Hiring Plan for Platform Team".to_string())
        );
        assert_eq!(
            sanitize("# Budget   Review"),
            Some("Budget Review".to_string())
        );
    }

    #[test]
    fn refusals_and_generic_names_are_not_titles() {
        assert_eq!(sanitize("I'm sorry, there is not enough context."), None);
        assert_eq!(sanitize("Meeting"), None);
        assert_eq!(sanitize("Untitled Meeting"), None);
        assert_eq!(sanitize("   "), None);
        assert_eq!(
            sanitize("this is far too long to be any kind of title that a person would ever put on a calendar"),
            None
        );
    }

    #[test]
    fn an_overlong_title_is_cut_on_a_word_boundary() {
        let long = "Comprehensive Quarterly Infrastructure Capacity Planning Review Session";
        let cut = sanitize(&format!("{long} Extended Edition Supplementary")).unwrap();
        assert!(cut.chars().count() <= MAX_TITLE_CHARS);
        assert!(!cut.ends_with(' '));
        assert!(long.starts_with(&cut) || cut.starts_with("Comprehensive"));
    }

    #[test]
    fn long_transcripts_keep_the_opening_and_the_latest_stretch() {
        let transcript = format!("{}{}", "a".repeat(20_000), "z".repeat(20_000));
        let source = title_source_text(&transcript);
        assert!(source.len() <= MAX_SOURCE_CHARS + 10);
        assert!(source.starts_with('a'));
        assert!(source.ends_with('z'));
    }

    #[test]
    fn ghostly_is_recognised_as_itself() {
        assert!(is_ghostly(Some("com.getghostly.desktop")));
        assert!(!is_ghostly(Some("us.zoom.xos")));
        assert!(!is_ghostly(None));
    }

    #[test]
    fn names_the_platform_and_the_date() {
        assert_eq!(
            stamped_title("Google Meet", "08/12/26".to_string()),
            "Google Meet meeting - 08/12/26"
        );
    }

    #[test]
    fn falls_back_when_nothing_is_identified() {
        assert_eq!(
            stamped_title("", "08/12/26".to_string()),
            "Meeting - 08/12/26"
        );
        assert_eq!(
            stamped_title("   ", "08/12/26".to_string()),
            "Meeting - 08/12/26"
        );
    }

    #[test]
    fn a_generated_title_is_produced_for_every_start_path() {
        // Only that it is non-empty and dated — the date itself is `now`.
        let title = for_frontmost_app(Some("us.zoom.xos"), Some("Zoom"));
        assert!(title.starts_with("Zoom meeting - "), "got {title}");

        let unknown = for_frontmost_app(None, None);
        assert!(unknown.starts_with("Meeting - "), "got {unknown}");
    }

    #[test]
    fn ghostly_never_names_a_meeting_after_itself() {
        // Starting from the panel button or the tray makes Ghostly frontmost,
        // which would otherwise produce "Ghostly meeting - 08/12/26".
        let title = for_frontmost_app(Some(SELF_BUNDLE_ID), Some("Ghostly"));
        assert!(title.starts_with("Meeting - "), "got {title}");
        // The dev build reports the same id under a lowercased name.
        let dev = for_frontmost_app(Some("com.getghostly.desktop"), Some("ghostly"));
        assert!(dev.starts_with("Meeting - "), "got {dev}");
    }
}
