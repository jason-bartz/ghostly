//! Live cleanup of transcript lines.
//!
//! Whisper is good at dictation, where someone speaks deliberately into a
//! headset. A meeting is the opposite: overlapping conversational speech, far
//! field audio on the system lane, three-word utterances with no surrounding
//! context. The raw output is legible but rough — missing punctuation,
//! sentence-case failures, proper nouns mangled into whatever is phonetically
//! nearest. A small model fixes all of that for a handful of tokens per line.
//!
//! # Why this works on blocks, not lines
//!
//! It used to send one segment at a time. That put the model in the worst
//! possible position: the unit it was asked to correct was a VAD chunk, which
//! is a *pause*, not a sentence, so it routinely received half a clause with no
//! way to know how the other half ended. It could fix casing and spelling and
//! essentially nothing else — it could not join "there's just, yeah, some work
//! to be done" to the clause that finished the thought, because it never saw
//! it.
//!
//! Segments are now accumulated into a **block** — consecutive segments from
//! one lane, separated by less than [`BLOCK_GAP_MS`] — and the block is
//! corrected in one request. The model sees the whole thought, so it can
//! repunctuate across the seams, spell a name consistently the first time it
//! appears, and resolve a fragment against what follows it.
//!
//! The block is sent as numbered lines and must come back as the same numbered
//! lines. That keeps the mapping back onto segment rows exact — each row keeps
//! its own timestamps and its own id — while still letting the model move
//! wording across a seam, since the panel renders a block's lines as one
//! paragraph. A reply with the wrong number of lines is rejected wholesale.
//!
//! # Trust
//!
//! Model output is only accepted when it still looks like the same speech. An
//! LLM handed a fragment will happily answer it, translate it, or explain that
//! it cannot help — all of which would be written into the user's transcript as
//! something a colleague said. [`accept_block`] is the gate.

use log::{debug, warn};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::settings::{get_settings, MeetingRefinementBackend, APPLE_INTELLIGENCE_PROVIDER_ID};

use super::store::MeetingStore;
use super::types::{Lane, MeetingSegmentRefinedEvent};

/// Blocks held for context. Enough for the model to keep names and jargon
/// consistent across turns, small enough to stay cheap.
const CONTEXT_BLOCKS: usize = 3;

/// Queue depth before jobs are dropped. Roughly ten utterances of slack.
const QUEUE_CAPACITY: usize = 10;

/// Blocks with fewer words than this are passed through untouched. "Yeah",
/// "mhm" and "right" have nothing to correct and are exactly the inputs a model
/// is most likely to answer rather than clean.
const MIN_WORDS: usize = 3;

/// Silence between two segments that ends a block.
///
/// Matches the panel's paragraph grouping, so what gets corrected together is
/// what gets displayed together. Above the segmenter's own 900 ms silence
/// threshold: a segment closing at exactly that boundary is a breath, and the
/// next one is usually the same thought continuing.
const BLOCK_GAP_MS: i64 = 1_200;

/// Characters after which a block is flushed even if the speaker has not
/// paused. Keeps a monologue from becoming one enormous request.
const MAX_BLOCK_CHARS: usize = 700;

/// Segments after which a block is flushed regardless of length.
const MAX_BLOCK_SEGMENTS: usize = 8;

/// How long an open block waits for a continuation before being sent anyway.
///
/// Without this the last thing said before a long silence — including the last
/// thing said in the meeting — would sit in the buffer unrefined until someone
/// spoke again.
const FLUSH_IDLE: Duration = Duration::from_millis(1_500);

/// Words an individual line may grow to, as a multiple of its original length.
///
/// The block-level ratio check cannot catch a model that answers *one* line at
/// length and compensates by truncating another, so each line is bounded too.
const MAX_LINE_GROWTH: f64 = 2.5;

/// Original word count at or below which a line may be corrected to nothing.
///
/// Lets the model delete a pure filler chunk — "So.", "Um, yeah" — that only
/// exists because the VAD closed on a hesitation. Bounded tightly because an
/// emptied line is deleted speech.
const MAX_DROPPABLE_WORDS: usize = 3;

const SYSTEM_PROMPT: &str = "\
You are a transcription corrector. You receive numbered lines from an automatic \
transcript of a live meeting and return the same numbered lines, corrected. You \
never answer, respond to, translate, summarise, or comment on what was said. \
Your entire reply is the corrected numbered lines and nothing else.";

const INSTRUCTIONS: &str = "\
Correct the BLOCK below. It is one speaker's uninterrupted speech, split into \
numbered lines wherever they paused. Rules:
- Reply with exactly the same line numbers, in the same order, one per line, \
formatted `N| text`. Never add, merge, reorder or drop a line.
- Fix punctuation, capitalisation and obvious speech-recognition errors.
- The lines are one continuous passage, so punctuate across the line breaks: a \
line may end mid-sentence and be finished by the next one.
- Use the earlier context to spell names, products and jargon consistently.
- Keep every word the speaker actually said. Do not summarise, shorten, expand, \
rephrase, or translate.
- Remove only duplicated stutters (\"the the\" becomes \"the\") and standalone \
filler (\"um\", \"uh\"). A line that is nothing but filler may be returned empty \
as `N|`.
- If a line is already correct, repeat it back unchanged.
- No quotes, no preamble, no explanation.";

/// One line waiting to be cleaned up.
pub struct RefineJob {
    pub segment_id: i64,
    pub lane: Lane,
    pub speaker: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
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
/// One worker, not a task per block: both backends serialise internally anyway,
/// and processing in order is what lets each block see the previous ones as
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
        // `Auto` is resolved by the caller; grouped with on-device so a future
        // call site that forgets degrades to the private path rather than
        // silently doing nothing.
        MeetingRefinementBackend::Auto | MeetingRefinementBackend::OnDevice => {
            on_device_available()
        }
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

/// Consecutive segments from one speaker, accumulated until they stop talking.
struct Block {
    lane: Lane,
    speaker: String,
    /// `(segment_id, text)` in the order they were spoken.
    lines: Vec<(i64, String)>,
    last_end_ms: i64,
    chars: usize,
}

impl Block {
    fn new(job: &RefineJob) -> Self {
        Self {
            lane: job.lane,
            speaker: job.speaker.clone(),
            lines: vec![(job.segment_id, job.text.clone())],
            last_end_ms: job.end_ms,
            chars: job.text.len(),
        }
    }

    /// Whether this job continues the block, or begins a new one.
    ///
    /// A different lane is a different speaker, and a gap wider than
    /// [`BLOCK_GAP_MS`] is a new thought even from the same one.
    fn accepts(&self, job: &RefineJob) -> bool {
        job.lane == self.lane
            && job.start_ms - self.last_end_ms < BLOCK_GAP_MS
            && self.lines.len() < MAX_BLOCK_SEGMENTS
            && self.chars + job.text.len() <= MAX_BLOCK_CHARS
    }

    fn push(&mut self, job: RefineJob) {
        self.chars += job.text.len();
        self.last_end_ms = job.end_ms;
        self.lines.push((job.segment_id, job.text));
    }

    /// The block as one passage, for the context window.
    fn rendered(&self) -> String {
        let joined: Vec<&str> = self.lines.iter().map(|(_, text)| text.as_str()).collect();
        format!("{}: {}", self.speaker, joined.join(" "))
    }

    fn word_count(&self) -> usize {
        self.lines
            .iter()
            .map(|(_, text)| text.split_whitespace().count())
            .sum()
    }
}

fn refine_worker(
    app: AppHandle,
    store: MeetingStore,
    meeting_id: String,
    backend: MeetingRefinementBackend,
    rx: mpsc::Receiver<RefineJob>,
) {
    let mut context: Vec<String> = Vec::with_capacity(CONTEXT_BLOCKS);
    let mut open: Option<Block> = None;

    loop {
        match rx.recv_timeout(FLUSH_IDLE) {
            Ok(job) => match open.take() {
                // The block is still growing.
                Some(mut block) if block.accepts(&job) => {
                    block.push(job);
                    open = Some(block);
                }
                // The speaker changed, or paused long enough to end a thought.
                Some(block) => {
                    flush(&app, &store, &meeting_id, backend, &mut context, block);
                    open = Some(Block::new(&job));
                }
                None => open = Some(Block::new(&job)),
            },
            // Nobody has spoken for a while: send what we have rather than
            // hold the last thought of the meeting hostage.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(block) = open.take() {
                    flush(&app, &store, &meeting_id, backend, &mut context, block);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if let Some(block) = open.take() {
        flush(&app, &store, &meeting_id, backend, &mut context, block);
    }

    debug!("Meeting refinement worker exiting");
}

/// Corrects one block and writes the results back, line by line.
fn flush(
    app: &AppHandle,
    store: &MeetingStore,
    meeting_id: &str,
    backend: MeetingRefinementBackend,
    context: &mut Vec<String>,
    block: Block,
) {
    if block.word_count() < MIN_WORDS {
        push_context(context, block.rendered());
        return;
    }

    let prompt = build_prompt(context, &block);
    // `block_on` rather than an async task: this thread exists precisely so
    // that one block is in flight at a time.
    let result = tauri::async_runtime::block_on(run_backend(app, backend, &prompt));

    let raw = match result {
        Ok(text) => text,
        Err(e) => {
            warn!("Meeting: refinement failed, keeping the verbatim lines ({e})");
            push_context(context, block.rendered());
            return;
        }
    };

    let Some(refined) = parse_reply(&raw, block.lines.len()) else {
        debug!("Meeting: refinement reply did not line up with the block, ignoring it");
        push_context(context, block.rendered());
        return;
    };

    let originals: Vec<&str> = block.lines.iter().map(|(_, text)| text.as_str()).collect();
    if !accept_block(&originals, &refined) {
        debug!("Meeting: rejected a refinement that changed the block too much");
        push_context(context, block.rendered());
        return;
    }

    let joined: Vec<&str> = refined
        .iter()
        .map(String::as_str)
        .filter(|line| !line.is_empty())
        .collect();
    push_context(context, format!("{}: {}", block.speaker, joined.join(" ")));

    for ((segment_id, original), corrected) in block.lines.iter().zip(refined) {
        if &corrected == original {
            continue;
        }
        if let Err(e) = store.update_segment_text(*segment_id, &corrected) {
            warn!("Meeting: could not save a refined line: {e}");
            continue;
        }
        let _ = app.emit(
            "meeting-segment-refined",
            MeetingSegmentRefinedEvent {
                meeting_id: meeting_id.to_string(),
                segment_id: *segment_id,
                text: corrected,
            },
        );
    }
}

fn push_context(context: &mut Vec<String>, block: String) {
    context.push(block);
    if context.len() > CONTEXT_BLOCKS {
        context.remove(0);
    }
}

fn build_prompt(context: &[String], block: &Block) -> String {
    let mut prompt = String::from(INSTRUCTIONS);
    if !context.is_empty() {
        prompt.push_str("\n\nEarlier speech, for context only — do not correct or repeat it:\n");
        prompt.push_str(&context.join("\n"));
    }
    prompt.push_str("\n\nBLOCK (speaker: ");
    prompt.push_str(&block.speaker);
    prompt.push_str("):\n");
    for (index, (_, text)) in block.lines.iter().enumerate() {
        prompt.push_str(&format!("{}| {}\n", index + 1, text));
    }
    prompt
}

async fn run_backend(
    app: &AppHandle,
    backend: MeetingRefinementBackend,
    prompt: &str,
) -> Result<String, String> {
    match backend {
        MeetingRefinementBackend::Off => Err("Refinement is off".to_string()),
        MeetingRefinementBackend::Auto | MeetingRefinementBackend::OnDevice => on_device(prompt),
        MeetingRefinementBackend::Cloud => cloud(app, prompt).await,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn on_device(prompt: &str) -> Result<String, String> {
    // 0 means "do not truncate" — this is a word cap on finished output, not a
    // generation limit, and truncating a corrected block would be worse than
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

    let response = crate::max_gateway::send_chat_completion(
        &settings,
        crate::max_gateway::Target {
            provider,
            model,
            api_key,
        },
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

/// Pulls `N| text` lines out of a reply, in order, or `None` if they do not
/// line up with the block that was sent.
///
/// Strict about the count on purpose. A reply with the wrong number of lines
/// means the model merged, split or dropped something, and there is then no
/// way to know which correction belongs to which segment row — writing them
/// back positionally would silently attribute one person's words to another
/// timestamp.
fn parse_reply(raw: &str, expected: usize) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::with_capacity(expected);

    for line in raw.lines() {
        let line = line.trim();
        let Some((number, rest)) = line.split_once('|') else {
            continue;
        };
        let Ok(index) = number.trim().parse::<usize>() else {
            continue;
        };
        // Numbers must arrive in order, starting at one. Anything else is the
        // model improvising a structure of its own.
        if index != out.len() + 1 {
            return None;
        }
        out.push(strip_wrappers(rest));
    }

    (out.len() == expected).then_some(out)
}

/// Strips the wrappers models add despite being told not to.
fn strip_wrappers(raw: &str) -> String {
    let mut text = raw.trim();
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

/// Whether a refined block is still recognisably the same speech.
///
/// Word count is the cheap, robust signal: correcting punctuation and spelling
/// barely moves it, while answering the block, translating it, or refusing it
/// all move it a lot. The lower bound is looser than the old per-line gate
/// because removing "um"s and stutters legitimately shortens a block.
fn accept_block(originals: &[&str], refined: &[String]) -> bool {
    if originals.len() != refined.len() {
        return false;
    }
    if refined.iter().all(|line| line.is_empty()) {
        return false;
    }

    let before: usize = originals
        .iter()
        .map(|line| line.split_whitespace().count())
        .sum();
    let after: usize = refined
        .iter()
        .map(|line| line.split_whitespace().count())
        .sum();
    if before == 0 {
        return false;
    }
    let ratio = after as f64 / before as f64;
    if !(0.55..=1.5).contains(&ratio) {
        return false;
    }

    for (original, corrected) in originals.iter().zip(refined) {
        let original_words = original.split_whitespace().count();
        let corrected_words = corrected.split_whitespace().count();
        // Only genuinely tiny lines may be corrected away entirely.
        if corrected_words == 0 && original_words > MAX_DROPPABLE_WORDS {
            return false;
        }
        // And no single line may balloon — that is a model answering one line
        // at length and trimming another to keep the block's total in range.
        if original_words > 0 && corrected_words as f64 > original_words as f64 * MAX_LINE_GROWTH {
            return false;
        }
    }

    // Models refuse in a small number of recognisable ways, and a refusal can
    // easily land inside the length window.
    let lowered = refined.join(" ").to_lowercase();
    const REFUSALS: &[&str] = &[
        "i cannot",
        "i can't",
        "i'm unable",
        "i am unable",
        "as an ai",
        "sorry, i",
        "corrected line",
        "here is the corrected",
        "here are the corrected",
    ];
    !REFUSALS.iter().any(|phrase| lowered.contains(phrase))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(segment_id: i64, lane: Lane, text: &str, start_ms: i64, end_ms: i64) -> RefineJob {
        RefineJob {
            segment_id,
            lane,
            speaker: "You".to_string(),
            text: text.to_string(),
            start_ms,
            end_ms,
        }
    }

    #[test]
    fn a_block_grows_across_a_short_pause() {
        let block = Block::new(&job(1, Lane::Mic, "there's some work to be done", 0, 2_000));
        assert!(block.accepts(&job(
            2,
            Lane::Mic,
            "and some ongoing conversations",
            2_600,
            4_000
        )));
    }

    #[test]
    fn a_block_ends_at_a_real_pause() {
        let block = Block::new(&job(1, Lane::Mic, "there's some work to be done", 0, 2_000));
        assert!(!block.accepts(&job(2, Lane::Mic, "okay anything else", 4_000, 5_000)));
    }

    #[test]
    fn a_block_ends_when_the_lane_changes() {
        let block = Block::new(&job(1, Lane::Mic, "there's some work to be done", 0, 2_000));
        assert!(!block.accepts(&job(
            2,
            Lane::System,
            "yeah a hundred percent",
            2_100,
            3_000
        )));
    }

    #[test]
    fn a_block_is_capped() {
        let mut block = Block::new(&job(1, Lane::Mic, "a word", 0, 500));
        for index in 2..=MAX_BLOCK_SEGMENTS as i64 {
            let start = index * 600;
            assert!(block.accepts(&job(index, Lane::Mic, "a word", start, start + 500)));
            block.push(job(index, Lane::Mic, "a word", start, start + 500));
        }
        let start = (MAX_BLOCK_SEGMENTS as i64 + 1) * 600;
        assert!(!block.accepts(&job(99, Lane::Mic, "a word", start, start + 500)));
    }

    #[test]
    fn parse_reply_reads_numbered_lines() {
        let parsed = parse_reply(
            "1| There's some work to be done,\n2| and some conversations.",
            2,
        );
        assert_eq!(
            parsed,
            Some(vec![
                "There's some work to be done,".to_string(),
                "and some conversations.".to_string()
            ])
        );
    }

    #[test]
    fn parse_reply_tolerates_preamble_and_strips_wrappers() {
        let parsed = parse_reply(
            "Here you go:\n1| \"Let's ship it.\"\n2| Sarah: Sounds good.",
            2,
        );
        assert_eq!(
            parsed,
            Some(vec![
                "Let's ship it.".to_string(),
                "Sounds good.".to_string()
            ])
        );
    }

    #[test]
    fn parse_reply_allows_an_emptied_line() {
        let parsed = parse_reply("1|\n2| There's some work to be done.", 2);
        assert_eq!(
            parsed,
            Some(vec![
                String::new(),
                "There's some work to be done.".to_string()
            ])
        );
    }

    #[test]
    fn parse_reply_rejects_a_mismatched_count() {
        // The model merged two lines into one.
        assert_eq!(parse_reply("1| There's some work to be done.", 2), None);
        // …or invented a third.
        assert_eq!(parse_reply("1| One.\n2| Two.\n3| Three.", 2), None);
    }

    #[test]
    fn parse_reply_rejects_reordered_lines() {
        assert_eq!(parse_reply("2| Second.\n1| First.", 2), None);
    }

    #[test]
    fn accept_block_allows_ordinary_corrections() {
        assert!(accept_block(
            &["so i think we should ship it monday", "if the tests pass"],
            &[
                "So I think we should ship it Monday,".to_string(),
                "if the tests pass.".to_string()
            ]
        ));
    }

    #[test]
    fn accept_block_allows_dropping_a_filler_fragment() {
        assert!(accept_block(
            &[
                "so",
                "anyways i've got a whole write up i put together for them"
            ],
            &[
                String::new(),
                "Anyways, I've got a whole write-up I put together for them.".to_string()
            ]
        ));
    }

    #[test]
    fn accept_block_rejects_deleting_real_speech() {
        assert!(!accept_block(
            &["we should postpone the migration until staging is rebuilt"],
            &[String::new()]
        ));
    }

    #[test]
    fn accept_block_rejects_answers_and_refusals() {
        // The model answered the question instead of correcting it.
        assert!(!accept_block(
            &["what did we decide about the migration"],
            &[
                "You decided to postpone the migration until the next sprint, once \
               the staging environment has been rebuilt and signed off."
                    .to_string()
            ]
        ));
        assert!(!accept_block(
            &["can you hear me"],
            &["I cannot hear you.".to_string()]
        ));
    }

    #[test]
    fn accept_block_rejects_one_line_ballooning() {
        // Total stays in range because the second line was gutted to pay for
        // the first — which the block-level ratio alone would not catch.
        assert!(!accept_block(
            &[
                "what about the budget",
                "we agreed the budget was fine last quarter and nobody objected"
            ],
            &[
                "The budget question was raised and discussed at some length by \
                 everyone present in the room."
                    .to_string(),
                "Fine.".to_string()
            ]
        ));
    }
}
