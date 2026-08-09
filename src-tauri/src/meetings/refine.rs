//! Live cleanup of transcript lines.
//!
//! Whisper is good at dictation, where someone speaks deliberately into a
//! headset. A meeting is the opposite: overlapping conversational speech, far
//! field audio on the system lane, three-word utterances with no surrounding
//! context. The raw output is legible but rough — missing punctuation,
//! sentence-case failures, proper nouns mangled into whatever is phonetically
//! nearest. A small model fixes all of that for a handful of tokens per line.
//!
//! # Shape
//!
//! The transcription worker never waits on this. It emits the raw line the
//! moment it has one — the panel must stay live — and hands the line to a
//! single refinement worker, which replaces the text in place and emits
//! [`MeetingSegmentRefinedEvent`]. If the model is slower than the
//! conversation, jobs are dropped rather than queued: a correction that lands
//! two minutes late is worse than no correction.
//!
//! # Trust
//!
//! Model output is only accepted when it still looks like the same sentence.
//! An LLM handed a fragment will happily answer it, translate it, or explain
//! that it cannot help — all of which would be written into the user's
//! transcript as something a colleague said. [`accept`] is the gate.

use log::{debug, warn};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};

use crate::settings::{get_settings, MeetingRefinementBackend, APPLE_INTELLIGENCE_PROVIDER_ID};

use super::store::MeetingStore;
use super::types::MeetingSegmentRefinedEvent;

/// Lines held for context. Enough for the model to keep names and jargon
/// consistent across turns, small enough to stay cheap.
const CONTEXT_LINES: usize = 4;

/// Queue depth before jobs are dropped. Roughly ten utterances of slack.
const QUEUE_CAPACITY: usize = 10;

/// Lines shorter than this are passed through untouched. "Yeah", "mhm" and
/// "right" have nothing to correct and are exactly the inputs a model is most
/// likely to answer rather than clean.
const MIN_WORDS: usize = 3;

const SYSTEM_PROMPT: &str = "\
You are a transcription corrector. You receive one line of an automatic \
transcript of a live meeting and return the same line, corrected. You never \
answer, respond to, translate, summarise, or comment on the line. Your entire \
reply is the corrected line and nothing else.";

const INSTRUCTIONS: &str = "\
Correct the LINE below. Rules:
- Fix punctuation, capitalisation and obvious speech-recognition errors.
- Use the earlier context to spell names, products and jargon consistently.
- Keep every word the speaker actually said. Do not summarise, shorten, \
expand, rephrase, or translate.
- Remove nothing except duplicated stutters (\"the the\" becomes \"the\").
- If the line is already correct, repeat it back unchanged.
- Reply with the corrected line only. No quotes, no preamble, no explanation.";

/// One line waiting to be cleaned up.
pub struct RefineJob {
    pub segment_id: i64,
    pub speaker: String,
    pub text: String,
}

/// Handle held by the capture session.
///
/// The worker thread is detached rather than joined — see [`RefineHandle::finish`].
pub struct RefineHandle {
    tx: Option<mpsc::SyncSender<RefineJob>>,
}

impl RefineHandle {
    /// Queues a line. Returns immediately, and silently drops the job when the
    /// worker is behind.
    pub fn submit(&self, job: RefineJob) {
        if let Some(tx) = &self.tx {
            if tx.try_send(job).is_err() {
                debug!("Meeting: refinement is behind, keeping the verbatim line");
            }
        }
    }

    /// Stops accepting lines and lets whatever is queued finish in the
    /// background.
    ///
    /// Deliberately does not join. Ending a meeting must be instant, and a
    /// cloud request in flight can take seconds; the worker writes its result
    /// to the store and emits it tagged with the meeting id, so a correction
    /// landing after the meeting ended still reaches the right transcript.
    pub fn finish(mut self) {
        // Dropping the sender is what ends the worker's `recv` loop.
        self.tx = None;
    }
}

/// Starts the refinement worker, unless refinement is switched off.
///
/// One worker, not a task per line: both backends serialise internally anyway,
/// and processing in order is what lets each line see the previous ones as
/// context.
pub fn spawn(
    app: AppHandle,
    store: MeetingStore,
    meeting_id: String,
    backend: MeetingRefinementBackend,
) -> Option<RefineHandle> {
    if backend == MeetingRefinementBackend::Off {
        return None;
    }
    if !backend_is_reachable(&app, backend) {
        debug!("Meeting: no refinement backend is configured, transcript stays verbatim");
        return None;
    }

    let (tx, rx) = mpsc::sync_channel::<RefineJob>(QUEUE_CAPACITY);
    std::thread::Builder::new()
        .name("ghostly-meeting-refine".into())
        .spawn(move || refine_worker(app, store, meeting_id, backend, rx))
        .ok()?;

    Some(RefineHandle { tx: Some(tx) })
}

/// Whether the chosen backend can actually run, checked once at session start.
///
/// Without this, an unconfigured cloud provider would mean one failed request
/// per utterance for the whole meeting.
fn backend_is_reachable(app: &AppHandle, backend: MeetingRefinementBackend) -> bool {
    match backend {
        MeetingRefinementBackend::Off => false,
        MeetingRefinementBackend::OnDevice => on_device_available(),
        MeetingRefinementBackend::Cloud => {
            let settings = get_settings(app);
            let Some(provider) = settings
                .post_process_provider(settings.post_process_provider_id.as_str())
                .cloned()
            else {
                return false;
            };
            if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
                return on_device_available();
            }
            settings
                .post_process_models
                .get(&provider.id)
                .is_some_and(|model| !model.trim().is_empty())
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn on_device_available() -> bool {
    crate::apple_intelligence::check_apple_intelligence_availability()
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn on_device_available() -> bool {
    false
}

fn refine_worker(
    app: AppHandle,
    store: MeetingStore,
    meeting_id: String,
    backend: MeetingRefinementBackend,
    rx: mpsc::Receiver<RefineJob>,
) {
    let mut context: Vec<String> = Vec::with_capacity(CONTEXT_LINES);

    while let Ok(job) = rx.recv() {
        let line = format!("{}: {}", job.speaker, job.text);

        if job.text.split_whitespace().count() < MIN_WORDS {
            push_context(&mut context, line);
            continue;
        }

        let prompt = build_prompt(&context, &job.speaker, &job.text);
        // `block_on` rather than an async task: this thread exists precisely so
        // that one line is in flight at a time.
        let result = tauri::async_runtime::block_on(run_backend(&app, backend, &prompt));

        let refined = match result {
            Ok(text) => text,
            Err(e) => {
                warn!("Meeting: refinement failed, keeping the verbatim line ({e})");
                push_context(&mut context, line);
                continue;
            }
        };

        let refined = tidy(&refined);
        if !accept(&job.text, &refined) {
            debug!("Meeting: rejected a refinement that changed the line too much");
            push_context(&mut context, line);
            continue;
        }

        push_context(&mut context, format!("{}: {}", job.speaker, refined));

        if refined == job.text {
            continue;
        }
        if let Err(e) = store.update_segment_text(job.segment_id, &refined) {
            warn!("Meeting: could not save a refined line: {e}");
            continue;
        }
        let _ = app.emit(
            "meeting-segment-refined",
            MeetingSegmentRefinedEvent {
                meeting_id: meeting_id.clone(),
                segment_id: job.segment_id,
                text: refined,
            },
        );
    }

    debug!("Meeting refinement worker exiting");
}

fn push_context(context: &mut Vec<String>, line: String) {
    context.push(line);
    if context.len() > CONTEXT_LINES {
        context.remove(0);
    }
}

fn build_prompt(context: &[String], speaker: &str, text: &str) -> String {
    let mut prompt = String::from(INSTRUCTIONS);
    if !context.is_empty() {
        prompt.push_str("\n\nEarlier lines, for context only — do not correct or repeat them:\n");
        prompt.push_str(&context.join("\n"));
    }
    prompt.push_str("\n\nLINE (speaker: ");
    prompt.push_str(speaker);
    prompt.push_str("):\n");
    prompt.push_str(text);
    prompt
}

async fn run_backend(
    app: &AppHandle,
    backend: MeetingRefinementBackend,
    prompt: &str,
) -> Result<String, String> {
    match backend {
        MeetingRefinementBackend::Off => Err("Refinement is off".to_string()),
        MeetingRefinementBackend::OnDevice => on_device(prompt),
        MeetingRefinementBackend::Cloud => cloud(app, prompt).await,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn on_device(prompt: &str) -> Result<String, String> {
    // 0 means "do not truncate" — this is a word cap on finished output, not a
    // generation limit, and truncating a corrected sentence would be worse than
    // leaving it uncorrected.
    crate::apple_intelligence::process_text_with_system_prompt(SYSTEM_PROMPT, prompt, 0)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn on_device(_prompt: &str) -> Result<String, String> {
    Err("On-device refinement is unavailable on this platform".to_string())
}

async fn cloud(app: &AppHandle, prompt: &str) -> Result<String, String> {
    let settings = get_settings(app);
    let provider = settings
        .post_process_provider(settings.post_process_provider_id.as_str())
        .cloned()
        .ok_or_else(|| "No AI provider is configured".to_string())?;

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        return on_device(prompt);
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

    let response = crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        prompt.to_string(),
        None,
        None,
    )
    .await?;

    response
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "The AI provider returned no content".to_string())
}

/// Strips the wrappers models add despite being told not to.
fn tidy(raw: &str) -> String {
    // Multi-line output is nearly always the model explaining itself; the
    // correction, when there is one, is the first non-empty line.
    let first = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");

    let mut text = first.trim();
    for (open, close) in [('"', '"'), ('\'', '\''), ('“', '”')] {
        if text.starts_with(open) && text.ends_with(close) && text.chars().count() > 1 {
            text = text[open.len_utf8()..text.len() - close.len_utf8()].trim();
        }
    }
    // A model told the speaker's name sometimes echoes the "Name: " prefix.
    if let Some((head, rest)) = text.split_once(": ") {
        if head.split_whitespace().count() <= 3 && !rest.trim().is_empty() {
            text = rest.trim();
        }
    }
    text.to_string()
}

/// Whether a refinement is still recognisably the same utterance.
///
/// Word count is the cheap, robust signal: correcting punctuation and spelling
/// barely moves it, while answering the line, translating it, or refusing it
/// all move it a lot.
fn accept(original: &str, refined: &str) -> bool {
    if refined.is_empty() {
        return false;
    }
    let before = original.split_whitespace().count();
    let after = refined.split_whitespace().count();
    if before == 0 {
        return false;
    }
    let ratio = after as f64 / before as f64;
    if !(0.6..=1.6).contains(&ratio) {
        return false;
    }
    // Models refuse in a small number of recognisable ways, and a refusal can
    // easily land inside the length window.
    let lowered = refined.to_lowercase();
    const REFUSALS: &[&str] = &[
        "i cannot",
        "i can't",
        "i'm unable",
        "i am unable",
        "as an ai",
        "sorry, i",
        "the line is",
        "corrected line:",
        "here is the corrected",
    ];
    !REFUSALS.iter().any(|phrase| lowered.contains(phrase))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_strips_quotes_and_speaker_prefix() {
        assert_eq!(tidy("\"Let's ship it.\""), "Let's ship it.");
        assert_eq!(tidy("Sarah: Let's ship it."), "Let's ship it.");
        assert_eq!(
            tidy("Let's ship it.\n\nI fixed the casing."),
            "Let's ship it."
        );
    }

    #[test]
    fn accept_allows_ordinary_corrections() {
        assert!(accept(
            "so i think we should ship it monday",
            "So I think we should ship it Monday."
        ));
    }

    #[test]
    fn accept_rejects_answers_and_refusals() {
        // The model answered the question instead of correcting it.
        assert!(!accept(
            "what did we decide about the migration",
            "You decided to postpone the migration until the next sprint, once \
             the staging environment has been rebuilt and signed off."
        ));
        assert!(!accept("can you hear me", "I cannot hear you."));
        assert!(!accept("can you hear me", ""));
    }
}
