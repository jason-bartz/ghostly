# Meeting Mode — deep design

Status: exploration, not committed. Written 2026-08-08.
Companion to [shortcuts-quiet-mode-meeting-mode.md](./shortcuts-quiet-mode-meeting-mode.md).

Live meeting transcription you can read _during_ the call, with per-speaker
attribution and optional auto-connect. No bot joins the call; nothing leaves the
device by default.

---

## 0. Verified findings (2026-08-08)

Measured on this machine (macOS 26.5.1, Xcode SDK 26.4) and by reading the
source, not inferred. Several of these **invalidate parts of the original
design** below; the affected sections have been corrected in place.

**Process taps work, and are cheaper than expected.** A standalone Swift shim
using `CATapDescription(monoGlobalTapButExcludeProcesses:)` +
`AudioHardwareCreateProcessTap` + a private aggregate device captured real
audio: 373 IO callbacks / 190,976 frames in 4 s at 48 kHz mono, peak amplitude
0.021. No Screen Recording permission, no separate TCC prompt, no purple
indicator. `AudioHardwareCreateProcessTap` is `API_AVAILABLE(macos(14.2))` —
14.2, not the 14.4 assumed below.

**First `start()` blocks for 10+ seconds.** The first tap creation in a process
stalls while coreaudiod builds the tap and aggregate device; subsequent calls
return immediately. `start()` must never be called on the main thread. Not
predicted anywhere in the original design.

**`AppContext.bundle_id` does not contain bundle identifiers.** `active-win-pos-rs`
0.8.4 fills `app_name` from `kCGWindowOwnerName` (verified at
`mac/platform_api.rs:96`), a _display_ name, and `frontmost.rs:35-38` copies it
straight into `AppContext.bundle_id`. Confirmed empirically: NSWorkspace reports
Zoom as display name `zoom.us` / bundle id `us.zoom.xos`.

This is a **pre-existing bug beyond Meeting Mode** — every bundle-id entry in
`profiles::category_apps` (`com.tinyspeck.slackmacgap`, `com.microsoft.teams2`,
`com.apple.MobileSMS`, …) can never match, so the Style/category system silently
fails for those apps. Zoom appears to work only because its display name happens
to be spelled like a bundle id. Fixed by the new `app_identity` bridge; the
existing category matcher should be migrated onto it separately.

**`kAudioDevicePropertyDeviceIsRunningSomewhere` is unusable as designed.** It is
per-device (the existing watcher listens only on `kAudioObjectSystemObject`),
and it is self-referential: Ghostly's own always-on mic stream makes the default
input "running somewhere", so the signal is true whenever Ghostly holds the
stream. §3 has been rewritten around NSWorkspace instead.

**Window titles need Screen Recording.** `kCGWindowName` is readable for other
apps' windows only with that permission, which Ghostly does not request. Google
Meet tab-title detection cannot be a required signal.

**`transcribe()` discards timestamps.** It requests `TimestampGranularity::Segment`
then returns only `result.text` (transcription.rs:567-570). Diarization needs a
breaking signature change plus a `transcription_mock.rs` mirror.

**The summarizer must not reuse the refinement path.** `refinement_enabled` is a
hard kill switch (actions.rs:398) and `deterministic_cleanup_in_ai_apps`
force-disables post-processing whenever an AI chat app is frontmost — a meeting
summary triggered while Claude or Cursor is focused would silently do nothing.
Catch Me Up needs its own gate. Also: `send_chat_completion_stream` is
OpenAI-SSE-only with a 30 s timeout and no retries, and Apple Intelligence needs
macOS **26.0+** at runtime (not 15.x) with no chunking anywhere in the codebase.

**Two landmines.** `cleanup_by_time` ends in `_ => unreachable!()`
(history.rs:669), so adding a `RecordingRetentionPeriod` variant is a runtime
panic rather than a compile error. And `on_window_event`'s `CloseRequested` arm
(lib.rs:835) does not branch on window label — it calls `prevent_close()` and
flips the activation policy for _any_ window, so a new panel must be special-cased
there.

**`ort` must be version-pinned.** ONNX Runtime is already in the tree
transitively via transcribe-rs and vad-rs. Adding `ort` as a direct dependency at
a different version or with different linking features would load two ONNX
Runtime C libraries into one process.

---

## 1. Capture architecture

### Two lanes

| Lane       | Source             | Default attribution                 |
| ---------- | ------------------ | ----------------------------------- |
| **Mic**    | existing cpal path | You (+ anyone in the room with you) |
| **System** | new Swift shim     | Remote participants                 |

Each lane runs its own VAD + ASR pipeline, merged onto a shared millisecond
timeline. This alone gives correct You-vs-Others attribution with no ML.

### System audio on macOS

| Option                                                   | macOS | Permission surface            | Verdict                                                                          |
| -------------------------------------------------------- | ----- | ----------------------------- | -------------------------------------------------------------------------------- |
| CoreAudio process taps (`AudioHardwareCreateProcessTap`) | 14.4+ | "System Audio Recording Only" | **Preferred** — per-process, gentle prompt, no purple screen-recording indicator |
| ScreenCaptureKit audio-only `SCStream`                   | 13+   | Screen Recording              | Fallback for 13.0–14.3                                                           |
| Virtual driver (BlackHole)                               | any   | installer                     | Reject                                                                           |

Runtime-gated capability. `tauri.conf.json` declares
`minimumSystemVersion: 10.15` — do **not** bump it; Meeting Mode simply reports
"requires macOS 13" on older systems.

Implementation mirrors the existing FFI precedent: a Swift file exposing a C ABI
that pushes 16 kHz mono f32 frames into Rust, exactly as
`swift/apple_intelligence.swift` ↔ `apple_intelligence.rs` does today. That
precedent is the main reason this is tractable.

Needs: `com.apple.security.device.audio-input` is already in
`Entitlements.plist`; add the audio-capture entitlement and the matching
Info.plist usage description.

### Use VoiceProcessingIO for the mic lane

Strong recommendation, and it solves a problem that would otherwise be a
guaranteed bug. If the user is on **speakers rather than headphones**, the mic
lane picks up the remote participants — so every remote utterance appears
twice, once attributed to "You". Opening the mic through
`kAudioUnitSubType_VoiceProcessingIO` gives free acoustic echo cancellation plus
noise suppression from the OS.

cpal doesn't expose VPIO, so this rides on the same CoreAudio Swift shim being
written for system audio. Belt-and-braces: also do **cross-lane text dedup** —
if a mic-lane segment's text closely matches a system-lane segment within a
±2 s window, drop the mic copy. Cheap, robust, catches whatever AEC misses.

### Fan-out on the raw frame slot (blocking issue)

`AudioRecordingManager::set_raw_frame_listener` is a **single-slot** callback
([audio.rs:294](../../src-tauri/src/managers/audio.rs#L294)) — installing a
listener replaces the previous one. Continuous dictation already owns that slot.
Meeting Mode needs it too, and both can plausibly be active.

Change to a keyed multi-listener registry
(`add_raw_frame_listener(id, cb) -> ListenerHandle`) before building on it. Small
refactor, but it's a prerequisite, not a nice-to-have.

Similarly `MicrophoneMode` is an exclusive enum (`AlwaysOn | OnDemand |
Continuous`). Meeting Mode is not a fourth mutually-exclusive mode — it's a
_capture session_ that keeps the stream open and composes with dictation. Model
it as a separate concern rather than another enum variant, so push-to-talk into
Slack still works mid-meeting. The dictation shortcut should tag a span on the
already-open stream instead of opening a second one.

### Engine and cost

Parakeet TDT int8 for latency. Two concurrent lanes doubles ASR compute — this
needs measuring before it's promised. Mitigations: VAD gating (silence is free),
a battery-saver cadence, and keeping the model resident for the meeting's
duration (interacts with `model_unload_timeout`).

**Test item:** confirm Ghostly can open the input device concurrently with
Zoom/Teams. CoreAudio normally allows shared input access and these apps don't
take hog mode, but a single-client USB interface is worth verifying.

---

## 2. Speaker assignment

Three layers, each independently useful. Ship them in order.

### Layer 1 — Lanes (free, no ML)

Mic = You, System = Others. Already described. "You" never needs labeling, which
also means the user's own voiceprint is enrolled for free from the mic lane.

### Layer 2 — Diarization by embedding + clustering

Needed because "Others" is 2–8 people, and because hybrid meetings put multiple
people on the **mic** lane too (conference room: 4 in-person + 3 remote). Both
lanes get diarized — don't assume the mic lane is one person.

**Model.** A speaker-embedding ONNX model producing a fixed-dim vector per
speech segment. `ort` is already in the dependency graph via `vad-rs` /
`transcribe-rs`, so an extra session is feasible — it would need promoting to a
direct dependency.

Licensing matters here for a commercially licensed binary: prefer **WeSpeaker**
or **3D-Speaker ERes2Net** (Apache-2.0). Avoid pyannote's gated models — the
terms-acceptance flow is incompatible with shipping weights in an installer.
Size is ~6–25 MB, downloaded alongside `silero_vad_v4.onnx`.

Cost is negligible relative to ASR — a few ms per segment.

**Clustering.** Speaker count is unknown, so use threshold-based agglomerative
clustering on cosine distance, not k-means.

Run it twice:

- **Online**, during the meeting: assign each segment to the nearest existing
  centroid, or spawn a new speaker if distance exceeds threshold. Labels are
  provisional. This is what the live panel shows.
- **Offline**, at meeting end: full re-clustering over all embeddings, which is
  substantially more accurate, then rewrite the stored transcript. Surface it
  honestly as a brief "refining speakers…" pass. Any manual labels the user
  already applied are pinned and must survive re-clustering.

**Known failure modes, and what to do:**

- _Short segments._ Embeddings need ≥ ~1 s of speech. Backchannels ("yeah",
  "mhm") won't cluster reliably — attach them to the temporally adjacent
  speaker rather than spawning bogus clusters.
- _Overlapping speech._ Two people at once yields a garbage embedding. Detect
  and mark the segment `crosstalk`; never let it create or move a centroid.
- _Echo bleed._ Handled upstream by VPIO + cross-lane dedup (§1).

### Layer 3 — Naming the clusters

Clustering gives you "Speaker 2". Names have to come from somewhere:

1. **Calendar attendees** (EventKit). If a calendar event is in progress with a
   video link, its attendee list is a high-quality candidate roster. Turns
   labeling into picking from 5 names instead of typing.
2. **Accessibility API scraping.** Teams and Slack are Electron with rich AX
   trees; Google Meet in a browser exposes participant names and speaking
   indicators through the DOM's AX representation. Zoom's AX tree is partial.
   Where it works, reading "Sarah Chen is speaking" at time T and binding it to
   whichever cluster is active at T gives **ground-truth labels with no ML** —
   accumulate agreement over several observations before committing a binding.
3. **On-device OCR** (Vision `VNRecognizeTextRequest`) on periodic screenshots
   of the meeting window, reading name labels off video tiles and detecting the
   active-speaker highlight. App-agnostic, but heavier and more fragile than AX.
   `xcap` is already a dependency for screenshots. Treat as a later fallback,
   and note it re-introduces the Screen Recording permission that process taps
   let you avoid.
4. **Manual assignment.** Always required regardless of the above.

**Manual UX**, which has to be good because the automation will be imperfect:

- Click a speaker chip → rename, or pick from the roster. Renaming retroactively
  relabels every segment in that cluster.
- **Merge** two clusters (same person split in two) and **split** (one cluster
  holding two people). These are the two corrections diarization always needs.
- Post-meeting speaker review: each cluster with a play button for a
  representative 3 s sample, so you can identify people by ear. Requires
  retaining segment audio — ties into `recording_retention_period`.

### Layer 4 — Persistent voiceprints (the compounding feature)

Label Sarah once; recognize her in every future meeting. Store centroid
embeddings keyed to a person, match new clusters against the library, and offer
"Is this Sarah?" as a one-click confirm — with confirmations strengthening the
centroid. After a few weeks of recurring standups, everyone auto-labels. This is
the feature that makes the whole thing feel magical rather than tedious.

**Privacy obligations are real and specific here.** Voiceprints are regulated
biometric identifiers under Illinois BIPA and comparable laws elsewhere —
notably, these are identifiers of _third parties who never installed Ghostly_.
Requirements: strictly opt-in and off by default, separate from Meeting Mode's
own consent; local-only storage, never synced; per-person deletion plus a
one-click "delete all voiceprints"; clear explanatory copy. Worth a look from
someone who does this professionally before it ships.

### Data model

```rust
struct Meeting {
    id, title, started_at, ended_at,
    app_bundle_id, detection_source, // Manual | AutoConnect | Calendar
}

struct MeetingSegment {
    id, meeting_id,
    lane: Lane,              // Mic | System
    start_ms, end_ms,
    text: String,
    speaker_id: Option<String>,
    embedding: Option<Vec<f32>>,
    label_source: LabelSource, // Lane | Cluster | Voiceprint | Accessibility | Manual
    is_crosstalk: bool,
}

struct Speaker {
    id, meeting_id,
    display_name: Option<String>,
    kind: SpeakerKind,       // Me | Named | Unknown
    voiceprint_id: Option<String>,
    pinned: bool,            // manual label — survives offline re-clustering
}

struct Voiceprint {         // global, cross-meeting, opt-in
    id, person_name,
    centroid: Vec<f32>, sample_count,
    created_at, last_seen_at,
}
```

Lives in the existing SQLite DB alongside history (`managers/history.rs`), with
its own retention policy. `label_source` is what lets the UI distinguish "we
guessed" from "you told us" and drives both the confirm prompts and
re-clustering pinning.

---

## 3. Auto-connect

### Detection signals

**Revised after §0.** The original plan led with
`kAudioDevicePropertyDeviceIsRunningSomewhere`; that signal is self-referential
(Ghostly's own always-on mic trips it) and per-device, so it is dropped. Window
titles need Screen Recording, so they can only ever be a bonus.

| Signal                                          | Mechanism                                    | Strength                                                                                             |
| ----------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Conferencing app running, by **real** bundle id | `app_identity::running_apps()` (NSWorkspace) | **Primary.** Genuine identifiers, no permission needed, covers apps that aren't frontmost            |
| That app is frontmost                           | `app_identity::frontmost_bundle_id()`        | Confidence boost, not a requirement — people alt-tab during calls                                    |
| Calendar event with a video link, now           | EventKit                                     | Strongest _semantic_ signal; also yields the meeting title and an attendee roster for speaker naming |
| Browser window title / URL                      | `AppContext.window_title`                    | Google Meet only, and **only if** Screen Recording happens to be granted. Never required             |

`app_identity` is already built (`swift/app_identity.swift` +
`src/app_identity.rs`) and is the same bridge that fixes the broken category
matcher described in §0.

**Rule: a known conferencing app must be running.** Title matching alone
false-positives on a browser tab named "Meet the Press". Since the mic-in-use
signal is unavailable, lean on the bundle-id allowlist plus a launch/terminate
notification stream, and accept that a _newly popular_ conferencing app needs an
allowlist entry — an honest trade for a signal that actually works.

A future refinement worth measuring: `kAudioHardwarePropertyProcessObjectList`
exposes per-process audio objects, so it is possible to ask "is _Zoom_
specifically running audio" rather than "is the device busy", which sidesteps
the self-reference problem. That is a strictly better signal than the
allowlist-plus-launch-notification approach if it proves reliable.

Cases to test explicitly: Slack huddles (should fire), 1:1 Zoom (should fire),
QuickTime/Voice Memos recording (should not), another dictation app (should
not), Continuity phone calls, FaceTime.

### The countdown, not the silent start

Auto-connect should never mean "recording began and you didn't notice."

```text
┌──────────────────────────────────────────┐
│ 🎙  Zoom call detected                    │
│    Starting transcript in 4…             │
│    [ Cancel ]  [ Never for Zoom ]        │
└──────────────────────────────────────────┘
```

A 5-second countdown toast is auto by default and vetoable without action. It's
also the per-meeting affirmative moment that makes the consent story defensible
(§5).

### Per-app policy

`Off | Ask | Auto` per detected app, plus a global master switch. "Ask" shows
the prompt and waits; "Auto" shows the countdown. Ratchet up gently: after the
user manually starts on Zoom three times, offer "always auto-connect for Zoom?"
rather than presuming.

**Exclusions:** skip auto-connect when the meeting or calendar title matches
user-defined patterns (`1:1`, `therapy`, `HR`, `interview`) or when the calendar
event is marked private. Small feature, disproportionate trust payoff.

### Auto-stop

Stop when the other process releases the mic **and** the conferencing window is
gone, debounced ~20–30 s — apps briefly release the device on mute/unmute and
device switches, and stopping mid-meeting is much worse than stopping 30 s late.
Also stop on window close and on display sleep.

### Pre-roll buffer

Meetings open with "quick context before we dive in," and detection always lags
slightly. A rolling ~60 s ring buffer means the transcript starts _before_
detection fired.

- Cost is trivial: 60 s of 16 kHz mono i16 ≈ 1.9 MB, memory-resident, never
  written to disk. It's the same idea as `PREROLL_FRAMES` in
  [continuous.rs:37](../../src-tauri/src/managers/continuous.rs#L37), scaled up.
- **Requires the mic to already be open**, i.e. `always_on_microphone`. If
  that's off, auto-connect starts cleanly at detection with no pre-roll. State
  this plainly in the UI rather than silently degrading.
- **Mic lane only.** Keeping a system-audio capture open continuously to get
  system pre-roll would hold a capture indicator on all day — unacceptable.
  Open the system lane on detection.
- In practice the gap is small anyway: conferencing apps grab the mic at join
  time, usually before anyone speaks.
- An always-on rolling buffer is a privacy decision regardless of how small.
  Gate it behind the auto-connect setting with explicit copy.

---

## 4. Catch Me Up

**Trigger:** panel button + global shortcut.
**Window:** "since I last caught up" (better default than a fixed 5 minutes).

**Rolling summarization.** Summarize every ~5 minutes in the background; on
demand, summarize the summaries. A 60-minute meeting never becomes a 20k-token
prompt, and the button feels instant.

**Model ladder:** Apple Intelligence on-device → configured cloud provider
(behind a _separate_ opt-in from the existing refinement provider — meeting
content is a different sensitivity class) → extractive local fallback (TF-IDF,
no LLM). The fallback exists so the button is never dead.

**Output structure — matters more than the model:**

- One line: what they're discussing _right now_
- 3–5 bullets: what you missed
- **Decisions made**
- **Anything asked of you** — matched against the user's name
- **One suggested re-entry line** you could actually say

That last item is the differentiator. The job isn't "what did I miss," it's "how
do I not look absent."

Speaker labels make all of this dramatically better: "Sarah asked you to own the
migration timeline" beats "someone asked about the timeline." Diarization and
Catch Me Up compound.

Stream the output — `llm_client.rs` already supports streaming.

### Adjacent live assists

- **Name-mention alert** — "Jason, what do you think?" on the Others lane fires
  a notification. Highest-value item for precisely the user who needs Catch Me
  Up, and it gets much more reliable once you know who's speaking.
- **Replay last 30 s** as text.
- **Dictionary priming** — feed `custom_words` into the meeting ASR prompt so
  product names transcribe correctly.
- **Bookmark shortcut** to mark a moment in the transcript.

---

## 5. Consent, ethics, legal

Heavier than for dictation, and heavier still with auto-connect and voiceprints,
because both involve third parties who never installed the app.

- **Auto-connect defaults off**, opt-in behind an explainer that names
  two-party-consent jurisdictions.
- **The countdown toast is the per-meeting affirmative moment.** Preserve it;
  don't offer a "skip the countdown" setting.
- **Always-visible indicator**: tray icon state + live panel. macOS's own mic
  and capture indicators reinforce this at the OS level — a reason to prefer
  process taps, whose indicator is honest without being alarming.
- **Local by default.** Transcripts never leave the device unless cloud
  summarization is explicitly opted into, separately from refinement.
- **Disclosure helper**: a one-tap snippet to tell participants you're
  transcribing — which is, neatly, just a Shortcut (see the companion doc).
- **Retention**: default meeting transcripts to auto-delete, reusing
  `recording_retention_period`. Audio retention is separate and shorter, but
  needed for the speaker-review-by-ear UI.
- **Voiceprints**: separately opt-in, local-only, per-person and bulk deletion.
  Get professional review before shipping.

---

## 6. Build order

| Phase                   | Contents                                                                                                                                         | Rough size |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **P0 — Plumbing**       | Multi-listener frame fan-out; Swift CoreAudio shim (system tap + VPIO mic); two-lane capture; meeting session model + DB tables; debug-only view | ~1.5 weeks |
| **P1 — Usable product** | Live panel window; manual start/stop; You-vs-Others labels; cross-lane dedup; Catch Me Up with rolling summaries; transcript export              | ~2 weeks   |
| **P2 — Auto-connect**   | Detection service; countdown toast; per-app policy + exclusions; auto-stop debounce; mic pre-roll buffer                                         | ~1 week    |
| **P3 — Speakers**       | ONNX embedder; online + offline clustering; speaker chips, rename, merge/split; post-meeting review-by-ear; calendar roster                      | ~2.5 weeks |
| **P4 — Recognition**    | Persistent voiceprints w/ consent flow; AX active-speaker binding; name-mention alerts                                                           | ~2 weeks   |

Auto-connect lands before speaker assignment deliberately: the detection code is
needed anyway to power P1's "meeting detected — listen in?" prompt, so P2 is
mostly UI and policy on top of work already done, while P3 is a genuine new
subsystem. It's the cheaper of the two asks and it's what makes the feature feel
effortless.

P4 is where the product stops being a transcript and starts being a memory —
but it also carries the most legal surface. Don't rush it.

---

## 7. Open questions

1. **Minimum macOS: 13 or 14.4?** Process taps have a far gentler permission
   prompt and no purple indicator. What share of the user base is on 14.4+?
   Shipping 14.4-only is dramatically better UX if the population allows.
2. **Dual-lane Parakeet int8 RTF** on target hardware — determines whether the
   two lanes run concurrently or must share one serialized engine.
3. **Concurrent input-device access** alongside Zoom/Teams, especially on
   single-client USB interfaces.
4. **Does adding the audio-capture entitlement disturb notarization or the
   updater flow?**
5. **Speaker embedding model licensing** — confirm Apache-2.0 weights that can
   ship in a commercial installer.
6. **AX scraping reliability** per app and per version. Zoom in particular may
   not be worth the maintenance burden; measure before building on it.
7. **Licensing tier** — Meeting Mode is the most plausible Pro upsell anchor in
   the product. Decide before the UI is built, not after.
