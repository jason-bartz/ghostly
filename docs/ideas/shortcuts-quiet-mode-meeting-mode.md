# Feature ideation: Shortcuts, Quiet Mode, Meeting Mode

Status: exploration, not committed. Written 2026-08-08.

Three features inspired by Willow / Wispr Flow, designed against Ghostly's actual
architecture rather than as greenfield specs.

---

## What Ghostly already has that these build on

| Substrate                                                           | Where                                                      | Reused by                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| VAD-segmented always-on capture loop                                | `managers/continuous.rs`                                   | Meeting Mode                    |
| Raw 16 kHz frame listener tap                                       | `AudioRecordingManager::set_raw_frame_listener`            | Quiet Mode, Meeting Mode        |
| Frontmost-app detection (bundle id + window title)                  | `frontmost.rs`                                             | Meeting Mode, Shortcuts scoping |
| CoreAudio device property listeners                                 | `helpers/audio_device_watcher.rs`                          | Meeting auto-detect             |
| Word-boundary phrase matcher                                        | `edit_intent::apply_correction_phrases`                    | Shortcuts                       |
| Fuzzy/phonetic word correction (`strsim`, `natural`, phonetics map) | `settings.rs`, dictionary                                  | Shortcuts trigger matching      |
| On-device LLM via Swift FFI                                         | `apple_intelligence.rs` + `swift/apple_intelligence.swift` | Catch Me Up                     |
| Streaming cloud LLM (OpenAI-compat + Anthropic)                     | `llm_client.rs`                                            | Catch Me Up                     |
| Category/style resolver keyed on app                                | `profiles.rs`                                              | Shortcuts scoping               |
| SQLite history + retention policy                                   | `managers/history.rs`                                      | Meeting transcripts             |
| Floating overlay window infra                                       | `overlay.rs`                                               | Live transcript panel           |
| Parakeet TDT int8 (fast ONNX ASR)                                   | `managers/model.rs`                                        | Meeting Mode (latency)          |

Notable gaps: **no system-audio capture** (cpal is mic-only), and **no screen
recording / audio-capture entitlement** in `Entitlements.plist`.

---

# 1. Shortcuts (voice-triggered snippets)

Say a trigger phrase mid-dictation; Ghostly substitutes saved text verbatim.

## Core design decisions

**Inline substitution, not command-only.** The whole value is
`"Hi Sarah — insert my booking link — talk soon"` producing one clean sentence
with the URL in the middle. A command-only model ("say only the trigger") is
strictly less useful and no easier to build. Same scanning shape as
`apply_correction_phrases`, which already handles word boundaries and
case-insensitivity.

**Verb-gated triggers by default.** The dominant failure is false positives:
"my address" is a phrase people genuinely say. So a trigger fires only as
`<verb> <name>`, where verb ∈ a configurable set (`insert`, `paste`, `drop in`,
`add my`). Per-shortcut escape hatch: _"match bare name"_ for names that are
unambiguous ("my zelle handle"). Ship a ~200-entry common-phrase blocklist and
warn at authoring time when a bare trigger collides with it.

**Verbatim protection through the refinement pass.** This is the important
detail and the easiest thing to get wrong. Pipeline order:

```
raw transcript
  → correction phrases ("scratch that")
  → shortcut match  →  replace each hit with sentinel ⟦S1⟧, ⟦S2⟧…
  → dictionary / word correction
  → LLM refinement (sentinels survive as opaque tokens)
  → sentinel → literal expansion text
  → paste
```

Expanding _before_ refinement lets the model rewrite your email signature.
Expanding _after_ refinement means the model may have already mangled the
trigger phrase. Sentinels give you both: refined surrounding prose, byte-exact
snippet. Needs a prompt line telling the model to preserve `⟦…⟧` tokens
untouched, plus a post-check that every sentinel survived (if one didn't, fall
back to the unrefined text with expansions applied).

**Trigger names auto-register as dictionary vocab.** A shortcut named
"Zelle handle" is useless if Whisper transcribes "sell handle". Push every
trigger's distinctive tokens into the Whisper initial prompt through the
existing `custom_words` path, and let users add a phonetic hint via the
existing `custom_word_phonetics` map. Essentially free given what's built.

**Fuzzy matching on the trigger.** `word_correction_threshold` + `strsim` +
Soundex already exist for the dictionary. Reuse them so "insert my callender
link" resolves. Threshold should be _tighter_ than dictionary matching —
a wrong expansion is worse than a wrong word.

## Scope and variables

- **Scope**: `global | category | app`. Categories already exist
  (`CategoryId::{PersonalMessages, WorkMessages, Email, Coding, Other}`), so
  "my signature" can resolve to the work sig in Mail and the casual one in
  Messages. Resolution order: app → category → global.
- **Variables** (v2): `{{date}}`, `{{time}}`, `{{clipboard}}`, `{{selection}}`,
  `{{cursor}}` (post-paste caret placement via enigo arrow keys).
- **Slot filling** (v3, LLM tier): "insert invoice for Acme, four thousand"
  against a template with named slots. Only worth it once the literal tier is
  proven.

## Schema

Store on `AppSettings` (specta-typed → free TS bindings), sized for hundreds of
entries; migrate to SQLite only if users exceed that.

```rust
pub struct Shortcut {
    pub id: String,
    pub name: String,              // "booking link"
    pub triggers: Vec<String>,     // aliases: ["booking link", "calendar link"]
    pub kind: ShortcutKind,        // Text | Keystroke | Script  (v1 ships Text)
    pub body: String,
    pub match_mode: MatchMode,     // VerbGated (default) | Bare
    pub scope: ShortcutScope,      // Global | Category(CategoryId) | App(Vec<MatchRule>)
    pub enabled: bool,
}
```

Reserving `kind` now means action shortcuts ("press ⌘S", run
`external_script_path`) drop in later without a migration.

## UX

- New Settings tab **Shortcuts**, sibling to Dictionary. Table: trigger,
  preview, scope, match mode. Live "try it" box that shows what a sample
  utterance would expand to.
- **Create from history**: select a past transcription → "Save as shortcut".
  Lowest-friction authoring path, and history is already there.
- **Expansion feedback**: the overlay shows a chip — `↳ booking link` — after a
  substitution, so a wrong expansion is immediately visible rather than
  discovered three sentences later.
- History entries record raw + expanded so a bad expansion is recoverable.
- Import from espanso YAML / TextExpander — cheap, and a real switching lever.

## Phasing

1. Literal + verb-gated, global/category scope, sentinel protection, vocab
   auto-registration, settings CRUD, overlay chip.
2. Variables, fuzzy trigger matching, per-app scope, import.
3. Slot filling, keystroke/script kinds, voice authoring ("save that as…").

---

# 2. "Whisper Mode" → split it into **Quiet Mode** and **Noisy Mode**

## Naming

Do not ship the phrase "Whisper mode" in an app whose ASR engine is literally
named Whisper — support threads will be unresolvable. And the marketed feature
is actually three unrelated engineering problems bundled under one label.
Proposal: **Quiet Mode** (whispered/low-volume speech), **Noisy Mode**
(background noise), and treat fast speech as a bug class to fix unconditionally
rather than a mode. A single **Adaptive** toggle can auto-engage either.

## A. Quiet / whispered speech

Two independent failures: the VAD doesn't fire, and the ASR degrades. Whispered
speech is unvoiced — no F0 — which is far outside Whisper's training
distribution.

Fixes in cost order:

1. **Gain normalization.** Normalize each segment to ~−20 dBFS RMS with a
   soft limiter before the model. Slots into the existing resample stage. Real
   WER gains for near-silent input; pair with (3) so you don't just amplify the
   noise floor.
2. **VAD retune + energy fallback.** Silero at 0.45 misses whispers. Quiet Mode
   swaps in: threshold ≈ 0.25, longer pre-roll, shorter `min_segment_ms`,
   longer hangover. Plus a parallel gate — if Silero says no but 300–3400 Hz
   band energy exceeds an adaptive noise floor by N dB _and_ spectral flatness
   looks speech-like, treat as voice. `rustfft` is already a dependency.
3. **Hallucination guard (ship unconditionally, not just in Quiet Mode).**
   Quiet and noisy input is the number-one cause of Whisper hallucinating
   "Thank you for watching!" and subtitle credits. Rule: segment RMS below
   threshold **and** output matches a known-hallucination pattern → drop
   silently. Highest perceived-quality-per-line-of-code item in this whole
   document.
4. **Confidence-triggered second pass.** Run the fast model; if confidence is
   poor, re-run the same audio on the accuracy model. Requires
   `transcribe-rs` to expose avg logprob / no-speech probability — **verify
   before committing**. Proxies if not: characters-per-second far outside
   normal range, or output length near zero for a long segment.

## B. Background noise

- **Voice Isolation nudge.** macOS has a system mic mode that does this well
  and for free. `AVCaptureDevice.showSystemUserInterface(.microphoneModes)`
  opens the picker; mic mode is readable. Add a Health check: "Voice Isolation
  is off for your mic — turn it on." Fits the existing HealthSettings pattern
  and costs almost nothing.
- **Local denoiser.** ONNX runtime already ships. GTCRN (~24k params, 16 kHz,
  streaming-capable) or DeepFilterNet3 as a downloadable resource next to
  `silero_vad_v4.onnx`. Runs on the frame stream ahead of VAD. This is the
  strongest option and matches the local-first stance. Budget real-time-factor
  measurement before promising it.
- Spectral subtraction as a lightweight fallback for older machines.

## C. Fast speakers

Three concrete bugs, none of which need a "mode":

1. **Force-flush cuts mid-word.** `continuous.rs` hard-cuts at
   `max_segment_ms`. Fix: flush at the lowest-energy point in a lookback
   window, and carry ~200 ms of overlap into the next segment with word-level
   dedup on the text side.
2. **Perceived slowdown.** The worker queue is `sync_channel(2)` — a fast
   talker fills it and segments get _dropped_ (`try_send` → `Full` → warn).
   Deepen the queue and apply backpressure instead of dropping. Ordering is
   already preserved by the single sequential worker; keep that invariant.
3. **Fixed silence threshold.** Adapt `continuous_silence_ms` from the user's
   observed median inter-word pause over a rolling window. Fast talkers get a
   shorter threshold automatically.

Parakeet TDT is materially better than Whisper on fast speech and much faster —
worth surfacing as the recommended engine for anyone who trips the fast-speech
heuristics.

## Product surface

One toggle per mode plus **Adaptive** (default on): sample RMS/SNR for the
first ~500 ms of a recording and engage the matching profile, showing a subtle
overlay label so it's never invisible. Manual override always available, plus a
shortcut for the "I'm in a library right now" case.

Add a **Mic Check** to Health settings: record 3 s, report noise floor, SNR,
clipping, and recommend Voice Isolation / gain / denoiser. Diagnostic value and
a genuinely differentiated onboarding moment.

---

# 3. Meeting Mode ("join meeting", without being a bot)

The pitch: live transcript you can read _during_ the call, plus a **Catch Me Up**
button that summarizes the last few minutes. No bot joins the call, nothing is
uploaded, no post-call email from a robot.

Name it **Meeting Mode** with the action labeled **Listen in** — "join meeting"
implies Ghostly enters the call, which is exactly the thing it doesn't do.

## The hard part: system audio

Ghostly captures mic only. Hearing the _other_ participants needs system audio.

| Option                                                   | macOS | Permission                    | Verdict                                                          |
| -------------------------------------------------------- | ----- | ----------------------------- | ---------------------------------------------------------------- |
| ScreenCaptureKit audio-only `SCStream`                   | 13+   | Screen Recording              | **Primary path.** Exclude own process.                           |
| CoreAudio process taps (`AudioHardwareCreateProcessTap`) | 14.4+ | "System Audio Recording Only" | **Preferred where available** — per-process, far gentler prompt. |
| Virtual driver (BlackHole etc.)                          | any   | installer + kext-adjacent     | Reject. Kills the install experience.                            |

Recommendation: process taps on 14.4+, ScreenCaptureKit on 13.0–14.3, feature
unavailable below 13. `tauri.conf.json` declares `minimumSystemVersion: 10.15`,
so this must be a runtime-gated capability with a clear "requires macOS 13+"
state — not a hard bump.

Implementation shape: a second Swift shim exposing a C ABI that yields 16 kHz
mono f32 frames into Rust, exactly mirroring
`swift/apple_intelligence.swift` ↔ `apple_intelligence.rs`. The precedent is
already in the repo, which meaningfully de-risks this.

`Entitlements.plist` needs the audio-capture entitlement; Info.plist needs the
matching usage description.

## Auto-detection

Mirrors the existing frontmost-app detection, with a better generic signal:

1. **Mic-in-use by another process** — CoreAudio
   `kAudioDevicePropertyDeviceIsRunningSomewhere`. Catches _every_ conferencing
   app, including ones nobody enumerated. `helpers/audio_device_watcher.rs`
   already installs CoreAudio property listeners; this is an extension, not new
   infrastructure.
2. **Known bundle ids** — Zoom (`us.zoom.xos`, `zoom.us`), Teams
   (`com.microsoft.teams2`), Slack (`com.tinyspeck.slackmacgap`), Webex,
   Discord, FaceTime. Most already listed in `profiles::category_apps`.
3. **Browser window title** for Google Meet (`Meet — …`, `meet.google.com`).
4. **Calendar** (v3, EventKit): an event with a video link starting now is both
   a strong signal and a free meeting title.

Confidence rule: (1) AND (2 or 3) → high confidence → show a **non-modal
prompt**: "Zoom call detected — listen in? ⌥⌘M". Never auto-start recording by
default; per-app opt-in auto-start is available but always shows the indicator.

## Consent, ethics, legal

Non-negotiable, and a genuine differentiator against bot-based tools:

- Explicit start action by default. Auto-start is opt-in, per app, and visible.
- Persistent recording indicator: tray icon state + live panel. macOS's own
  orange mic dot and purple screen-recording dot reinforce this at the OS level.
- Onboarding copy that names two-party-consent jurisdictions and recommends
  disclosure. Ship an optional one-tap disclosure snippet (which is, neatly, a
  Shortcut).
- **Local by default.** Transcript never leaves the device. Catch Me Up defaults
  to Apple Intelligence on-device when available; using a cloud provider for
  meeting summaries requires a separate explicit opt-in, distinct from the
  existing refinement provider setting.
- Retention: reuse `recording_retention_period` machinery; default meeting
  transcripts to auto-delete.

## Two audio lanes = free diarization

Mic lane → **You**. System lane → **Others**. Two independent VAD + ASR
pipelines, merged on a shared timeline. That gives correct 2-way speaker
attribution with no diarization model at all — the single highest
value-to-effort item in the feature.

Distinguishing individual remote speakers needs speaker embeddings
(ECAPA-style ONNX + online clustering). Defer; "Others" is enough for v1, and
many conferencing apps expose an active-speaker name in the window title as a
partial cheat.

## Live panel

A resizable always-on-top window (bigger than the current overlay, but
`overlay.rs` establishes the pattern): rolling transcript, auto-scroll with
scroll-lock on manual scroll, speaker labels, timestamps, search, and a
bookmark shortcut to mark a moment.

Engine choice: **Parakeet TDT int8** for latency. Two concurrent lanes doubles
compute — measure before promising. Mitigations: VAD-gated so silence costs
nothing, and a battery-saver cadence.

Contention to resolve: while a meeting is live the user still wants push-to-talk
dictation into other apps. The mic stream is already open, so the dictation
shortcut should _tag a span_ on the existing stream rather than open a second
one. `AudioRecordingManager`'s mode system needs a `Meeting` mode that composes
with dictation instead of excluding it.

## Catch Me Up

The feature people will actually tell their friends about.

**Trigger**: panel button + global shortcut.

**Window**: last N minutes (default 5), or "since I last caught up" — the more
useful default in practice.

**Model ladder**: Apple Intelligence on-device → configured cloud provider (if
separately opted in) → extractive local fallback (TF-IDF keyword extraction, no
LLM). The fallback matters: the button must never do nothing.

**Rolling summarization**: summarize every ~5 minutes in the background and
summarize-the-summaries on demand. Keeps a 60-minute meeting from becoming a
20k-token prompt, and makes the button feel instant.

**Output structure** — this matters more than the model:

- One line: _what they're discussing right now_
- 3–5 bullets: what happened while you were gone
- **Decisions made**
- **Anything asked of you** (match against the user's name from settings)
- **Suggested re-entry line** — one sentence you could say to rejoin the
  conversation credibly

That last item is the differentiator. Nobody else does it, and it's the actual
job-to-be-done: not "what did I miss" but "how do I not look absent."

Stream the output (`llm_client.rs` already streams) so text appears in ~1 s.

## Adjacent live-assist ideas

- **Name-mention alert.** "Jason, what do you think?" on the Others lane →
  notification. Enormous value for exactly the user who needs Catch Me Up.
- **Replay last 30 s** as text — cheaper and less awkward than "sorry, could you
  repeat that."
- **Acronym/jargon chips** — detect unfamiliar acronyms, show a definition.
- **Dictionary priming** — feed `custom_words` into the meeting ASR prompt so
  product names transcribe correctly.

## Post-meeting artifacts

Even a "not a bot" tool should leave something behind: full transcript, summary,
action items, "copy as notes", markdown export. Store as a `meetings` table
alongside history (`session.rs` already models a session concept). Optional file
export for Obsidian/Notes.

## Cost and thermals

An hour of continuous dual-lane ASR is a real battery and fan event. Parakeet
int8 + VAD gating + a battery-saver cadence, and be honest about it in the UI.
Interacts with `model_unload_timeout` — the model must stay resident for the
meeting's duration.

## Phasing

0. **Mic-only pilot.** Panel + Catch Me Up on the mic lane alone. Validates the
   UX with zero new permissions. Be explicit that it captures your side only —
   it degrades badly with headphones, so this is a prototype, not a shipped tier.
1. **System audio.** ScreenCaptureKit/process-tap lane, two-lane attribution,
   live panel, manual start, on-device Catch Me Up.
2. **Auto-detect + prompt**, meeting history and artifacts, action items,
   name-mention alerts.
3. **Calendar integration**, remote-speaker diarization, per-app auto-start.

---

## Cross-feature synergies

- The system-audio lane generalizes beyond meetings: transcribe any playing
  audio (a video, a voice memo, a podcast) — a whole second feature for free.
- Quiet Mode matters most on calls (whispering in a cafe), so it lands well
  before or with Meeting Mode.
- Shortcuts are the disclosure snippet for meeting consent, and the "here's my
  calendar link" reply during a call.
- Quiet Mode's hallucination guard protects meeting transcripts during silence,
  where hallucination is otherwise rampant.

## Suggested order

**Shortcuts** first — self-contained, no new permissions, ships in days, and
it's the most-requested category of the three. **Quiet Mode** second, where the
hallucination guard and gain normalization are quick wins that improve every
existing user's daily experience. **Meeting Mode** last and largest; it's a
month of work with an entitlement change, a new Swift shim, a new window class,
and a legal-copy pass.

## Open questions to resolve before committing

1. Does `transcribe-rs` expose per-segment confidence (avg logprob /
   no-speech probability)? Gates the two-pass fallback and parts of the
   hallucination guard.
2. Measured RTF of dual-lane Parakeet int8 on the target machine — determines
   whether two-lane live transcription is viable or needs to serialize.
3. Minimum macOS for Meeting Mode: 13 (ScreenCaptureKit) or 14.4 (process taps,
   much friendlier permission prompt)? Affects addressable users.
4. Does adding the audio-capture entitlement disturb the existing notarization
   and updater flow?
5. Licensing tier: are these Pro-gated? Meeting Mode in particular is a
   plausible upsell anchor.
