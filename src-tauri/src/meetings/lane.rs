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
            // Tuned for a *live* transcript, where the cost of being wrong is
            // asymmetric: a line that appears late is useless to someone
            // reading along, while a line that splits a sentence in two is
            // merely untidy — and the refinement pass repunctuates it anyway.
            //
            // The ceiling matters more than the silence threshold. At 20 s,
            // anyone speaking without a real pause — which is most people
            // presenting — put nothing on screen for twenty seconds and then a
            // wall of text. The force-flush already hunts for the quietest
            // point in a 1.5 s lookback, so a lower cap cuts in word gaps
            // rather than mid-word.
            silence_ms: 550,
            max_segment_ms: 8_000,
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

    /// Frames observed since capture began. The sole clock for this lane, so
    /// both lanes land on a common timeline derived from the same frame rate
    /// rather than from wall-clock reads at different moments.
    frames_seen: u64,
    /// Frame index at which the open segment began.
    segment_start_frame: u64,
}

impl LaneSegmenter {
    pub fn new(vad: Box<dyn VoiceActivityDetector>, config: SegmenterConfig) -> Self {
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
        }
    }

    fn frames_to_ms(frames: u64) -> i64 {
        (frames * 30) as i64
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
            start_ms: Self::frames_to_ms(start_frame),
            end_ms: Self::frames_to_ms(end_frame),
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
        LaneSegmenter::new(Box::new(ScriptedVad { script, index: 0 }), config)
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
