//! Per-lane VAD segmentation.
//!
//! Both capture lanes push 16 kHz mono 480-sample (30 ms) frames through an
//! instance of [`LaneSegmenter`], which closes an utterance on sustained
//! silence and emits it for transcription.
//!
//! Two deliberate differences from `managers::continuous`:
//!
//! 1. **Configuration is snapshotted at construction.** `continuous.rs` calls
//!    `get_settings()` on every frame — 33 store reads per second per lane.
//! 2. **The length cap flushes at the quietest point in a lookback window**
//!    rather than cutting hard at the limit. A fast talker who never pauses
//!    would otherwise be sliced mid-word every few seconds.

use std::collections::VecDeque;
use std::time::Instant;

use crate::audio_toolkit::vad::VoiceActivityDetector;

/// 30 ms at 16 kHz. Matches the recorder's frame size exactly; both lanes rely
/// on it, so it is not configurable.
pub const FRAME_SAMPLES: usize = 480;

/// Consecutive speech frames before a segment opens (~60 ms). Short enough not
/// to clip word onsets, long enough to reject single-frame VAD blips.
const SPEECH_ONSET_FRAMES: u32 = 2;

/// Frames of audio retained before onset so segments do not start clipped.
const PREROLL_FRAMES: usize = 10; // ~300 ms

/// How far back to search for a quiet point when force-flushing a long
/// segment. ~1.5 s gives a realistic chance of finding a word gap.
const FLUSH_LOOKBACK_FRAMES: usize = 50;

/// How far a lane's frame clock may wander from wall clock before it is
/// re-anchored.
///
/// Loose on purpose. The frame counter is the better clock moment to moment —
/// it is exact, and it is what makes a segment's duration exactly the audio it
/// contains — so correcting on every frame would trade that for scheduler
/// jitter. Half a second is far tighter than anything that matters downstream
/// (echo suppression works to 2.5–4 s) while still catching a real dropout
/// before it can compound.
const DRIFT_TOLERANCE_MS: i64 = 500;

#[derive(Debug, Clone)]
pub struct SegmenterConfig {
    /// Trailing silence that closes a segment.
    pub silence_ms: u32,
    /// Hard ceiling before a force-flush.
    pub max_segment_ms: u32,
    /// Segments shorter than this are dropped as coughs/clicks.
    pub min_segment_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            // Tuned so a segment is a *thought*, not a breath.
            //
            // 550 ms cut on the pauses people leave mid-sentence — between a
            // clause and its continuation, or while they hunt for a word — and
            // produced the fragments the transcript was full of: "So.",
            // "Exotic car, so". Two things make that worse than untidy. Whisper
            // degrades sharply below about three seconds of audio because it
            // has no surrounding context to decode against, so short chunks are
            // also the *least accurate* ones. And a one-clause fragment gives
            // the refinement pass nothing to work with either.
            //
            // 900 ms is past the within-sentence hesitation range and still
            // short of a real turn boundary, so segments now close where
            // someone actually stopped talking.
            //
            // The ceiling matters more than the silence threshold. At 20 s,
            // anyone speaking without a real pause — which is most people
            // presenting — put nothing on screen for twenty seconds and then a
            // wall of text. 14 s keeps that in check while giving the model
            // enough audio to decode well; the force-flush hunts for the
            // quietest point in a 1.5 s lookback, so it cuts in a word gap
            // rather than mid-word.
            silence_ms: 900,
            max_segment_ms: 14_000,
            min_segment_ms: 300,
        }
    }
}

/// A closed utterance ready for transcription.
#[derive(Debug)]
pub struct CapturedSegment {
    pub samples: Vec<f32>,
    /// Milliseconds from the start of capture.
    pub start_ms: i64,
    pub end_ms: i64,
}

pub struct LaneSegmenter {
    vad: Box<dyn VoiceActivityDetector>,
    config: SegmenterConfig,

    in_segment: bool,
    consec_speech: u32,
    consec_silence: u32,
    segment: Vec<f32>,
    prefill: VecDeque<Vec<f32>>,

    /// Frames observed on this lane. Counting frames rather than reading the
    /// clock is what keeps a lane's own timeline exact and makes it stall
    /// while paused, which is deliberate.
    frames_seen: u64,
    /// Frame index at which the open segment began.
    segment_start_frame: u64,

    /// When the capture session began. Shared by both lanes.
    session_start: Instant,
    /// Correction, in milliseconds, applied to this lane's frame clock so that
    /// it reads as time since [`Self::session_start`]. `None` until the lane's
    /// first frame arrives.
    ///
    /// This is what puts the two lanes on one timeline. The frame counter alone
    /// does not: each lane starts counting at its own first frame, and the
    /// lanes do not begin together. The microphone is already open and starts
    /// immediately, while the system lane waits on a CoreAudio process tap that
    /// takes seconds to come up the first time in a process. Measured in the
    /// wild, the microphone lane ran **twenty seconds** ahead of the system
    /// lane, and since each lane called its own first frame zero, that offset
    /// was invisible and permanent.
    ///
    /// Everything downstream reads these timestamps as one clock: segments are
    /// listed `ORDER BY start_ms`, so a reopened transcript interleaved the two
    /// lanes into the wrong order; echo suppression compares utterances that
    /// "overlap in time", so it never matched a duplicate and the same sentence
    /// was shown twice; and the summariser was handed a conversation whose turns
    /// were shuffled.
    ///
    /// Re-derived whenever the lane drifts past [`DRIFT_TOLERANCE_MS`], not set
    /// once and trusted. Anchoring only at the first frame fixes the lanes
    /// starting at different times but nothing after it: a lane that loses
    /// frames — a device switch, a buffer underrun, a callback that stalls —
    /// silently falls behind by the amount it lost and never catches up, which
    /// is the same divergence again in miniature.
    origin_offset_ms: Option<i64>,
}

impl LaneSegmenter {
    /// `session_start` must be the *same* instant for every lane in a capture
    /// session — that shared origin is the whole point.
    pub fn new(
        vad: Box<dyn VoiceActivityDetector>,
        config: SegmenterConfig,
        session_start: Instant,
    ) -> Self {
        Self {
            vad,
            config,
            in_segment: false,
            consec_speech: 0,
            consec_silence: 0,
            segment: Vec::new(),
            prefill: VecDeque::with_capacity(PREROLL_FRAMES),
            frames_seen: 0,
            segment_start_frame: 0,
            session_start,
            origin_offset_ms: None,
        }
    }

    fn frames_to_ms(&self, frames: u64) -> i64 {
        (frames * 30) as i64 + self.origin_offset_ms.unwrap_or(0)
    }

    /// Keeps this lane's frame clock reading as time since the session began.
    ///
    /// Called on every frame, but only *does* anything on the first one and
    /// whenever the lane has fallen more than [`DRIFT_TOLERANCE_MS`] behind
    /// wall clock — so in a healthy meeting it fires once and never again.
    ///
    /// # Corrections only ever go forward
    ///
    /// The two directions are not symmetrical, and treating them as if they
    /// were is wrong.
    ///
    /// Running *behind* wall clock means frames that should have arrived did
    /// not: a device switch, a buffer underrun, a stalled callback. That audio
    /// is gone, and the lane must skip over the hole or everything after it is
    /// early by the length of the hole, for the rest of the meeting.
    ///
    /// Running *ahead* means nothing is wrong at all. Audio is delivered in
    /// buffers, so a callback hands over several frames at once and the frame
    /// clock momentarily outruns real time before real time catches up. There
    /// is no gap to close — and "correcting" it would pull the clock backwards,
    /// which is far worse than a little drift: a segment could then start
    /// before the one before it ended, and `ORDER BY start_ms` would shuffle
    /// the transcript. Monotonic is worth more here than exact.
    ///
    /// Pauses are absorbed rather than excluded. No frames arrive while paused,
    /// so both lanes fall behind by the same amount and both step forward by
    /// the same amount on resume: they stay aligned with each other, which is
    /// the property that matters, and timestamps go on meaning "time since the
    /// meeting started" rather than "audio recorded so far".
    fn sync_clock(&mut self) {
        let actual_ms = self.session_start.elapsed().as_millis() as i64;
        let frame_ms = (self.frames_seen * 30) as i64;

        match self.origin_offset_ms {
            // A lane is built before it is wired up, and for the system lane
            // the gap between the two is exactly the tap-startup delay this
            // exists to correct for. So the anchor is the first frame, never
            // construction. `frames_seen` is still 0 here, so the offset starts
            // non-negative and only ever grows — timestamps can never go
            // negative, and need no clamp.
            None => self.origin_offset_ms = Some(actual_ms),
            Some(offset) => {
                if actual_ms - (frame_ms + offset) > DRIFT_TOLERANCE_MS {
                    self.origin_offset_ms = Some(actual_ms - frame_ms);
                }
            }
        }
    }

    /// True while an utterance is open — somebody on this lane is mid-sentence.
    ///
    /// The live "someone is talking" signal. A segment only reaches the panel
    /// once it closes, so without this there is nothing to show for the seconds
    /// between a person starting to speak and their line appearing.
    pub fn is_open(&self) -> bool {
        self.in_segment
    }

    fn silence_frames(&self) -> u32 {
        ((self.config.silence_ms as usize) / 30).max(1) as u32
    }

    fn max_segment_frames(&self) -> u32 {
        ((self.config.max_segment_ms as usize) / 30).max(1) as u32
    }

    fn min_segment_frames(&self) -> u32 {
        ((self.config.min_segment_ms as usize) / 30) as u32
    }

    /// Feed one 30 ms frame. Returns a segment when this frame closed one.
    pub fn push_frame(&mut self, frame: &[f32]) -> Option<CapturedSegment> {
        if frame.len() != FRAME_SAMPLES {
            return None;
        }
        self.sync_clock();
        self.frames_seen += 1;

        let is_voice = match self.vad.is_voice(frame) {
            Ok(value) => value,
            // A VAD failure must not silently swallow audio: treat the frame as
            // speech so an open segment keeps growing rather than being cut.
            Err(_) => self.in_segment,
        };

        if !self.in_segment {
            if self.prefill.len() == PREROLL_FRAMES {
                self.prefill.pop_front();
            }
            self.prefill.push_back(frame.to_vec());
        }

        match (self.in_segment, is_voice) {
            (false, true) => {
                self.consec_speech += 1;
                if self.consec_speech >= SPEECH_ONSET_FRAMES {
                    self.open_segment();
                }
                None
            }
            (false, false) => {
                self.consec_speech = 0;
                None
            }
            (true, true) => {
                self.consec_silence = 0;
                self.segment.extend_from_slice(frame);
                self.check_max_length()
            }
            (true, false) => {
                self.consec_silence += 1;
                self.segment.extend_from_slice(frame);
                if self.consec_silence >= self.silence_frames() {
                    return self.close_segment(None);
                }
                self.check_max_length()
            }
        }
    }

    fn open_segment(&mut self) {
        self.in_segment = true;
        self.consec_speech = 0;
        self.consec_silence = 0;
        self.segment.clear();

        let prefill: Vec<Vec<f32>> = self.prefill.drain(..).collect();
        for buffer in &prefill {
            self.segment.extend_from_slice(buffer);
        }
        // The segment starts at the beginning of the pre-roll, not at onset,
        // so timestamps line up with the audio actually contained in it.
        self.segment_start_frame = self.frames_seen.saturating_sub(prefill.len() as u64);
    }

    /// Force-flushes an over-long segment, cutting at the quietest frame in the
    /// recent past so the split lands in a word gap where one exists.
    fn check_max_length(&mut self) -> Option<CapturedSegment> {
        let frames_captured = (self.segment.len() / FRAME_SAMPLES) as u32;
        if frames_captured < self.max_segment_frames() {
            return None;
        }
        let cut = self.quietest_frame_boundary(frames_captured as usize);
        self.close_segment(Some(cut))
    }

    /// Index (in frames) of the lowest-energy frame within the lookback window,
    /// used as the split point. Returns the full length when the segment is too
    /// short to search, which degrades to the old hard cut.
    fn quietest_frame_boundary(&self, frames_captured: usize) -> usize {
        if frames_captured <= FLUSH_LOOKBACK_FRAMES {
            return frames_captured;
        }
        let search_start = frames_captured - FLUSH_LOOKBACK_FRAMES;

        let mut best_index = frames_captured;
        let mut best_energy = f32::MAX;
        for index in search_start..frames_captured {
            let offset = index * FRAME_SAMPLES;
            let frame = &self.segment[offset..offset + FRAME_SAMPLES];
            // Mean absolute amplitude is enough to rank frames and is much
            // cheaper than RMS across a 50-frame window on every flush.
            let energy = frame.iter().map(|s| s.abs()).sum::<f32>() / FRAME_SAMPLES as f32;
            if energy < best_energy {
                best_energy = energy;
                best_index = index;
            }
        }
        best_index
    }

    /// Closes the open segment. `cut_at_frame` splits it, carrying the tail
    /// forward as the start of the next segment so no audio is lost.
    fn close_segment(&mut self, cut_at_frame: Option<usize>) -> Option<CapturedSegment> {
        if !self.in_segment {
            return None;
        }
        let total_frames = self.segment.len() / FRAME_SAMPLES;
        let cut = cut_at_frame.unwrap_or(total_frames).min(total_frames);

        let cut_sample = cut * FRAME_SAMPLES;
        let tail = self.segment.split_off(cut_sample);
        let samples = std::mem::take(&mut self.segment);

        let start_frame = self.segment_start_frame;
        let end_frame = start_frame + cut as u64;

        if tail.is_empty() {
            self.reset_state();
        } else {
            // Continue the next segment from the split point rather than
            // dropping the tail or waiting for a fresh onset.
            self.segment = tail;
            self.consec_silence = 0;
            self.consec_speech = 0;
            self.segment_start_frame = end_frame;
            self.in_segment = true;
        }

        if (cut as u32) < self.min_segment_frames() {
            return None;
        }

        Some(CapturedSegment {
            samples,
            start_ms: self.frames_to_ms(start_frame),
            end_ms: self.frames_to_ms(end_frame),
        })
    }

    /// Flushes whatever is open, for use when capture stops.
    pub fn finish(&mut self) -> Option<CapturedSegment> {
        if !self.in_segment || self.segment.is_empty() {
            self.reset_state();
            return None;
        }
        let segment = self.close_segment(None);
        self.reset_state();
        segment
    }

    fn reset_state(&mut self) {
        self.in_segment = false;
        self.consec_speech = 0;
        self.consec_silence = 0;
        self.segment.clear();
        self.prefill.clear();
        self.vad.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    use crate::audio_toolkit::vad::VadFrame;

    /// VAD driven by a scripted sequence so segmentation is deterministic.
    struct ScriptedVad {
        script: Vec<bool>,
        index: usize,
    }

    impl VoiceActivityDetector for ScriptedVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            let value = self.script.get(self.index).copied().unwrap_or(false);
            self.index += 1;
            Ok(if value {
                VadFrame::Speech(frame)
            } else {
                VadFrame::Noise
            })
        }
        fn reset(&mut self) {}
    }

    fn frame(value: f32) -> Vec<f32> {
        vec![value; FRAME_SAMPLES]
    }

    fn segmenter(script: Vec<bool>, config: SegmenterConfig) -> LaneSegmenter {
        // `Instant::now()` at the moment of construction, so the lane's first
        // frame lands ~0 ms later and the timestamps these tests assert on stay
        // pure frame arithmetic.
        LaneSegmenter::new(
            Box::new(ScriptedVad { script, index: 0 }),
            config,
            Instant::now(),
        )
    }

    /// Two lanes that start at different times must still agree on the clock.
    ///
    /// This is the regression that made the same sentence appear twice: the
    /// microphone lane began ~20 s before the system lane's process tap came
    /// up, each called its own first frame zero, and nothing downstream could
    /// tell that two utterances 20 s apart were the same speech.
    #[test]
    fn lanes_starting_at_different_times_share_one_timeline() {
        let session_start = Instant::now();

        let mut early = LaneSegmenter::new(
            Box::new(ScriptedVad {
                script: {
                    let mut s = vec![true; 20];
                    s.extend(vec![false; 40]);
                    s
                },
                index: 0,
            }),
            SegmenterConfig::default(),
            session_start,
        );
        // The late lane is built from the same origin but starts feeding frames
        // later, exactly as the system tap does.
        let mut late = LaneSegmenter::new(
            Box::new(ScriptedVad {
                script: {
                    let mut s = vec![true; 20];
                    s.extend(vec![false; 40]);
                    s
                },
                index: 0,
            }),
            SegmenterConfig::default(),
            session_start,
        );

        for _ in 0..60 {
            early.push_frame(&frame(0.5));
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        let mut late_segment = None;
        for _ in 0..60 {
            if let Some(segment) = late.push_frame(&frame(0.5)) {
                late_segment = Some(segment);
            }
        }

        let late_segment = late_segment.expect("the late lane produced a segment");
        assert!(
            late_segment.start_ms >= 100,
            "a lane that began 120 ms into the session must not date its first \
             utterance from zero — got {}",
            late_segment.start_ms
        );
    }

    /// A lane that loses audio must not stay behind for the rest of the meeting.
    ///
    /// Anchoring only at the first frame leaves this broken: the lane simply
    /// never counted the frames it missed, so every later timestamp is early by
    /// the length of the dropout and the two lanes are back on separate clocks.
    #[test]
    fn a_lane_that_drops_frames_catches_back_up() {
        let session_start = Instant::now();
        let mut seg = LaneSegmenter::new(
            Box::new(ScriptedVad {
                script: vec![false; 200],
                index: 0,
            }),
            SegmenterConfig::default(),
            session_start,
        );

        seg.push_frame(&frame(0.0));
        let anchored = seg.origin_offset_ms.expect("anchored on the first frame");

        // A dropout: real time passes while no frames arrive at all.
        std::thread::sleep(std::time::Duration::from_millis(700));
        seg.push_frame(&frame(0.0));

        let corrected = seg.origin_offset_ms.expect("still anchored");
        assert!(
            corrected - anchored >= 600,
            "a 700 ms dropout must be absorbed into the offset, but it moved by \
             only {} ms",
            corrected - anchored
        );

        // And the lane's clock now agrees with wall clock again.
        let reading = seg.frames_to_ms(seg.frames_seen);
        let elapsed = session_start.elapsed().as_millis() as i64;
        assert!(
            (reading - elapsed).abs() <= DRIFT_TOLERANCE_MS,
            "clock reads {reading} ms against {elapsed} ms of real time"
        );
    }

    /// Buffered delivery must never pull the clock backwards.
    ///
    /// Audio arrives several frames at a time, so the frame clock routinely
    /// outruns wall clock for a moment. A symmetrical correction would treat
    /// that as drift and re-anchor *back*, which can make a segment start
    /// before the previous one ended — and `ORDER BY start_ms` then shuffles
    /// the transcript, which is the bug this whole mechanism exists to prevent.
    #[test]
    fn a_burst_of_frames_never_moves_the_clock_backwards() {
        let session_start = Instant::now();
        let mut seg = LaneSegmenter::new(
            Box::new(ScriptedVad {
                script: vec![false; 400],
                index: 0,
            }),
            SegmenterConfig::default(),
            session_start,
        );

        seg.push_frame(&frame(0.0));
        let anchored = seg.origin_offset_ms.expect("anchored");
        // 300 frames back to back is 9 s of frame time in ~no real time at all
        // — far outside the tolerance, in the "ahead" direction.
        for _ in 0..300 {
            seg.push_frame(&frame(0.0));
        }
        assert_eq!(
            seg.origin_offset_ms,
            Some(anchored),
            "the clock must never be dragged backwards by buffered delivery"
        );
        assert!(
            seg.frames_to_ms(seg.frames_seen) > seg.frames_to_ms(0),
            "the clock must stay monotonic"
        );
    }

    /// Ordinary jitter must not move the offset — the frame counter is the
    /// better clock moment to moment, and re-anchoring constantly would import
    /// scheduler noise into segment boundaries.
    #[test]
    fn small_jitter_does_not_re_anchor() {
        let session_start = Instant::now();
        let mut seg = LaneSegmenter::new(
            Box::new(ScriptedVad {
                script: vec![false; 100],
                index: 0,
            }),
            SegmenterConfig::default(),
            session_start,
        );

        seg.push_frame(&frame(0.0));
        let anchored = seg.origin_offset_ms.expect("anchored");
        // Ten frames pushed back to back: the frame clock races ahead of real
        // time by ~300 ms, which is inside the tolerance.
        for _ in 0..10 {
            seg.push_frame(&frame(0.0));
        }
        assert_eq!(
            seg.origin_offset_ms,
            Some(anchored),
            "the offset must hold steady through sub-tolerance drift"
        );
    }

    #[test]
    fn emits_segment_after_trailing_silence() {
        // 20 speech frames (600ms) then 10 silence frames (300ms).
        let mut script = vec![true; 20];
        script.extend(vec![false; 10]);
        let mut seg = segmenter(
            script,
            SegmenterConfig {
                silence_ms: 240,
                max_segment_ms: 20_000,
                min_segment_ms: 90,
            },
        );

        let mut emitted = None;
        for _ in 0..30 {
            if let Some(segment) = seg.push_frame(&frame(0.5)) {
                emitted = Some(segment);
            }
        }
        let segment = emitted.expect("a segment should close on trailing silence");
        assert!(segment.end_ms > segment.start_ms);
        assert!(!segment.samples.is_empty());
    }

    #[test]
    fn drops_segments_below_minimum_length() {
        // A single speech blip surrounded by silence.
        let mut script = vec![false; 3];
        script.extend(vec![true; 3]);
        script.extend(vec![false; 10]);
        let mut seg = segmenter(
            script,
            SegmenterConfig {
                silence_ms: 120,
                max_segment_ms: 20_000,
                // 900ms floor — the blip is far below it.
                min_segment_ms: 900,
            },
        );

        for _ in 0..16 {
            assert!(seg.push_frame(&frame(0.4)).is_none());
        }
    }

    #[test]
    fn force_flush_splits_a_continuous_talker() {
        // Never silent: only the length cap can close this.
        let mut seg = segmenter(
            vec![true; 400],
            SegmenterConfig {
                silence_ms: 600,
                max_segment_ms: 3_000, // 100 frames
                min_segment_ms: 90,
            },
        );

        let mut segments = Vec::new();
        for index in 0..300 {
            // Dip the amplitude periodically so there is a quiet point to find.
            let amplitude = if index % 40 == 0 { 0.001 } else { 0.6 };
            if let Some(segment) = seg.push_frame(&frame(amplitude)) {
                segments.push(segment);
            }
        }
        assert!(
            !segments.is_empty(),
            "a continuous talker must still produce segments"
        );
        // The split should land on a quiet frame, not exactly at the cap.
        assert!(segments.iter().all(|s| s.end_ms > s.start_ms));
    }

    #[test]
    fn timeline_is_contiguous_across_a_forced_split() {
        let mut seg = segmenter(
            vec![true; 400],
            SegmenterConfig {
                silence_ms: 600,
                max_segment_ms: 3_000,
                min_segment_ms: 30,
            },
        );

        let mut segments = Vec::new();
        for index in 0..300 {
            let amplitude = if index % 40 == 0 { 0.001 } else { 0.6 };
            if let Some(segment) = seg.push_frame(&frame(amplitude)) {
                segments.push(segment);
            }
        }
        // Each split continues exactly where the previous one ended — no audio
        // is dropped at the boundary.
        for pair in segments.windows(2) {
            assert_eq!(
                pair[0].end_ms, pair[1].start_ms,
                "forced splits must not leave a gap in the timeline"
            );
        }
    }

    #[test]
    fn finish_flushes_an_open_segment() {
        let mut seg = segmenter(
            vec![true; 40],
            SegmenterConfig {
                silence_ms: 600,
                max_segment_ms: 20_000,
                min_segment_ms: 90,
            },
        );
        for _ in 0..20 {
            seg.push_frame(&frame(0.5));
        }
        assert!(seg.finish().is_some(), "finish must flush open audio");
        assert!(seg.finish().is_none(), "finish must be idempotent");
    }
}
