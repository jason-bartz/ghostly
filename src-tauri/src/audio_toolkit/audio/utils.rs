use anyhow::{anyhow, Result};
use hound::{WavReader, WavSpec, WavWriter};
use log::debug;
use rubato::{FftFixedIn, Resampler};
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Read a WAV file and return normalised f32 samples.
pub fn read_wav_samples<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>> {
    let reader = WavReader::open(file_path.as_ref())?;
    let samples = reader
        .into_samples::<i16>()
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
        .collect::<Result<Vec<f32>, _>>()?;
    Ok(samples)
}

/// Verify a WAV file by reading it back and checking the sample count.
pub fn verify_wav_file<P: AsRef<Path>>(file_path: P, expected_samples: usize) -> Result<()> {
    let reader = WavReader::open(file_path.as_ref())?;
    let actual_samples = reader.len() as usize;
    if actual_samples != expected_samples {
        anyhow::bail!(
            "WAV sample count mismatch: expected {}, got {}",
            expected_samples,
            actual_samples
        );
    }
    Ok(())
}

/// Decode any supported audio file format to 16kHz mono f32 samples.
/// Supports WAV, MP3, FLAC, OGG/Vorbis, AAC/M4A, and more via Symphonia.
pub fn read_audio_file_samples<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>> {
    let path = file_path.as_ref();
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| anyhow!("Unsupported audio format: {}", e))?;

    let mut format = probed.format;

    // Find the default audio track
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("No audio track found"))?
        .clone();

    let track_id = track.id;
    let in_sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("Unknown sample rate"))? as usize;
    let in_channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("Unsupported codec: {}", e))?;

    // Collect all mono f32 samples at original sample rate
    let mut raw_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(_)) => break,
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("Decode error: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("Decode error: {}", e)),
        };

        // Convert to f32 and mix down to mono
        let frames = decoded.frames();
        match decoded {
            AudioBufferRef::F32(buf) => {
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| buf.chan(ch)[frame])
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
            AudioBufferRef::S16(buf) => {
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| buf.chan(ch)[frame] as f32 / i16::MAX as f32)
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
            AudioBufferRef::S32(buf) => {
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| buf.chan(ch)[frame] as f32 / i32::MAX as f32)
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
            AudioBufferRef::F64(buf) => {
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| buf.chan(ch)[frame] as f32)
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
            AudioBufferRef::U8(buf) => {
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| (buf.chan(ch)[frame] as f32 - 128.0) / 128.0)
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
            _ => {
                // For other formats, convert via f64
                let mut tmp = decoded.make_equivalent::<f32>();
                decoded.convert(&mut tmp);
                for frame in 0..frames {
                    let sample: f32 = (0..in_channels)
                        .map(|ch| tmp.chan(ch)[frame])
                        .sum::<f32>()
                        / in_channels as f32;
                    raw_samples.push(sample);
                }
            }
        }
    }

    if raw_samples.is_empty() {
        return Err(anyhow!("Audio file contains no samples"));
    }

    const TARGET_SAMPLE_RATE: usize = 16_000;

    // Resample if necessary
    if in_sample_rate == TARGET_SAMPLE_RATE {
        return Ok(raw_samples);
    }

    const CHUNK_SIZE: usize = 1024;
    let mut resampler =
        FftFixedIn::<f32>::new(in_sample_rate, TARGET_SAMPLE_RATE, CHUNK_SIZE, 1, 1)
            .map_err(|e| anyhow!("Failed to create resampler: {}", e))?;

    let mut resampled: Vec<f32> = Vec::new();
    let mut pos = 0;

    while pos + CHUNK_SIZE <= raw_samples.len() {
        let chunk = &raw_samples[pos..pos + CHUNK_SIZE];
        let out = resampler
            .process(&[chunk], None)
            .map_err(|e| anyhow!("Resampling error: {}", e))?;
        resampled.extend_from_slice(&out[0]);
        pos += CHUNK_SIZE;
    }

    // Process remaining samples (padded with zeros)
    if pos < raw_samples.len() {
        let mut last_chunk = raw_samples[pos..].to_vec();
        last_chunk.resize(CHUNK_SIZE, 0.0);
        let out = resampler
            .process(&[&last_chunk], None)
            .map_err(|e| anyhow!("Resampling error: {}", e))?;
        resampled.extend_from_slice(&out[0]);
    }

    debug!(
        "Decoded audio file: {} samples at {}Hz → {} samples at 16kHz",
        raw_samples.len(),
        in_sample_rate,
        resampled.len()
    );

    Ok(resampled)
}

/// Save audio samples as a WAV file
pub fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}
