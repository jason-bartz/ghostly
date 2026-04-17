use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

// Size of the visible dB window beneath the tracked peak. Keeps the
// spectral shape intact while normalizing baseline loudness across devices.
const DB_RANGE: f32 = 40.0;
// Adaptive peak tracking: fast attack (rises quickly to new loud speech)
// and slow release (stays stable across short pauses).
const PEAK_ATTACK: f32 = 0.15;
const PEAK_RELEASE: f32 = 0.002;
// Floor the peak so a silent room doesn't collapse the range onto ambient
// noise — quiet mics should still *look* quiet when nobody's speaking.
const PEAK_FLOOR: f32 = -25.0;
// Noise gate offset above the tracked per-bucket noise floor.
const GATE_MARGIN_DB: f32 = 4.0;
const GAIN: f32 = 1.3;
const CURVE_POWER: f32 = 0.7;

pub struct AudioVisualiser {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bucket_ranges: Vec<(usize, usize)>,
    fft_input: Vec<Complex32>,
    noise_floor: Vec<f32>,
    peak_db: f32,
    buffer: Vec<f32>,
    window_size: usize,
    buckets: usize,
}

impl AudioVisualiser {
    pub fn new(
        sample_rate: u32,
        window_size: usize,
        buckets: usize,
        freq_min: f32,
        freq_max: f32,
    ) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(window_size);

        // Pre-compute Hann window
        let window: Vec<f32> = (0..window_size)
            .map(|i| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / window_size as f32).cos())
            })
            .collect();

        // Pre-compute bucket frequency ranges
        let nyquist = sample_rate as f32 / 2.0;
        let freq_min = freq_min.min(nyquist);
        let freq_max = freq_max.min(nyquist);

        let mut bucket_ranges = Vec::with_capacity(buckets);

        for b in 0..buckets {
            // Use logarithmic spacing for better perceptual representation
            let log_start = (b as f32 / buckets as f32).powi(2);
            let log_end = ((b + 1) as f32 / buckets as f32).powi(2);

            let start_hz = freq_min + (freq_max - freq_min) * log_start;
            let end_hz = freq_min + (freq_max - freq_min) * log_end;

            let start_bin = ((start_hz * window_size as f32) / sample_rate as f32) as usize;
            let mut end_bin = ((end_hz * window_size as f32) / sample_rate as f32) as usize;

            // Ensure each bucket has at least one bin
            if end_bin <= start_bin {
                end_bin = start_bin + 1;
            }

            // Clamp to valid range
            let start_bin = start_bin.min(window_size / 2);
            let end_bin = end_bin.min(window_size / 2);

            bucket_ranges.push((start_bin, end_bin));
        }

        Self {
            fft,
            window,
            bucket_ranges,
            fft_input: vec![Complex32::new(0.0, 0.0); window_size],
            noise_floor: vec![-40.0; buckets], // Initialize to reasonable noise floor
            peak_db: PEAK_FLOOR,
            buffer: Vec::with_capacity(window_size * 2),
            window_size,
            buckets,
        }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        // Add new samples to buffer
        self.buffer.extend_from_slice(samples);

        // Only process if we have enough samples
        if self.buffer.len() < self.window_size {
            return None;
        }

        // Take the required window of samples
        let window_samples = &self.buffer[..self.window_size];

        // Remove DC component
        let mean = window_samples.iter().sum::<f32>() / self.window_size as f32;

        // Apply window function and prepare FFT input
        for (i, &sample) in window_samples.iter().enumerate() {
            let windowed_sample = (sample - mean) * self.window[i];
            self.fft_input[i] = Complex32::new(windowed_sample, 0.0);
        }

        // Perform FFT
        self.fft.process(&mut self.fft_input);

        // Pass 1: compute per-bucket dB, track the frame's max for peak updates,
        // and adapt the per-bucket noise floor when we're sitting below signal.
        let mut bucket_dbs = vec![-80.0f32; self.buckets];
        let mut frame_max_db = f32::NEG_INFINITY;

        for (bucket_idx, &(start_bin, end_bin)) in self.bucket_ranges.iter().enumerate() {
            if start_bin >= end_bin || end_bin > self.fft_input.len() / 2 {
                continue;
            }

            let mut power_sum = 0.0;
            for bin_idx in start_bin..end_bin {
                let magnitude = self.fft_input[bin_idx].norm();
                power_sum += magnitude * magnitude;
            }

            let avg_power = power_sum / (end_bin - start_bin) as f32;

            let db = if avg_power > 1e-12 {
                20.0 * (avg_power.sqrt() / self.window_size as f32).log10()
            } else {
                -80.0
            };

            bucket_dbs[bucket_idx] = db;
            if db > frame_max_db {
                frame_max_db = db;
            }

            // Only update noise floor when signal is quiet (below current floor + 10dB)
            if db < self.noise_floor[bucket_idx] + 10.0 {
                const NOISE_ALPHA: f32 = 0.001;
                self.noise_floor[bucket_idx] =
                    NOISE_ALPHA * db + (1.0 - NOISE_ALPHA) * self.noise_floor[bucket_idx];
            }
        }

        // Adaptive peak: fast attack up, slow release down, clamped so silence
        // can't drag the range down onto the noise floor.
        let alpha = if frame_max_db > self.peak_db {
            PEAK_ATTACK
        } else {
            PEAK_RELEASE
        };
        self.peak_db = alpha * frame_max_db + (1.0 - alpha) * self.peak_db;
        if self.peak_db < PEAK_FLOOR {
            self.peak_db = PEAK_FLOOR;
        }

        // Pass 2: normalize each bucket against the peak-relative window, with
        // a soft noise gate so ambient room tone doesn't light up the bars.
        let db_max = self.peak_db;
        let db_min = self.peak_db - DB_RANGE;
        let mut buckets = vec![0.0; self.buckets];

        for (bucket_idx, &db) in bucket_dbs.iter().enumerate() {
            let gate = self.noise_floor[bucket_idx] + GATE_MARGIN_DB;
            if db < gate {
                continue;
            }
            let normalized = ((db - db_min) / (db_max - db_min)).clamp(0.0, 1.0);
            buckets[bucket_idx] = (normalized * GAIN).powf(CURVE_POWER).clamp(0.0, 1.0);
        }

        // Apply light smoothing to reduce jitter
        for i in 1..buckets.len() - 1 {
            buckets[i] = buckets[i] * 0.7 + buckets[i - 1] * 0.15 + buckets[i + 1] * 0.15;
        }

        // Clear processed samples from buffer
        self.buffer.clear();

        Some(buckets)
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        // Reset noise floor to initial values
        self.noise_floor.fill(-40.0);
        self.peak_db = PEAK_FLOOR;
    }
}
