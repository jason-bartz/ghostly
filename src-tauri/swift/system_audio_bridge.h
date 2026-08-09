#ifndef system_audio_bridge_h
#define system_audio_bridge_h

#include <stdint.h>

// C-compatible declarations for the system-audio capture Swift bridge.
//
// Captures macOS system audio (everything except Ghostly's own output) using
// CoreAudio process taps — `AudioHardwareCreateProcessTap`, available on
// macOS 14.2+. Unlike ScreenCaptureKit this needs no Screen Recording
// permission and lights no purple capture indicator.

#ifdef __cplusplus
extern "C" {
#endif

// Invoked on a CoreAudio IO thread for every captured buffer.
//
// `samples` is non-interleaved mono float32 (the tap is created as a mono
// mixdown, so there is exactly one channel). `frame_count` is the number of
// float samples. `sample_rate` is the tap's native rate — resampling to
// 16 kHz happens on the Rust side via the existing rubato pipeline.
//
// REAL-TIME CONTEXT: this runs on an audio render thread. The implementation
// must not allocate, block on a contended lock, or perform I/O.
typedef void (*GhostlySystemAudioCallback)(const float *samples,
                                           int32_t frame_count,
                                           double sample_rate,
                                           void *userdata);

// 1 when the running OS supports process taps (macOS 14.2+), else 0.
int32_t ghostly_system_audio_supported(void);

// Begin capture. Returns 0 on success, or a non-zero error code:
//   -1 unsupported OS
//   -2 already running
//   -3 could not resolve our own audio process object
//   -4 tap creation failed (most likely TCC denial)
//   -5 could not read the tap's UID or stream format
//   -6 no default output device to clock the aggregate against
//   -7 aggregate device creation failed
//   -8 IOProc creation or start failed
// Call ghostly_system_audio_last_error() for a human-readable description.
int32_t ghostly_system_audio_start(GhostlySystemAudioCallback callback,
                                   void *userdata);

// Stop capture and tear down the tap, aggregate device, and IOProc.
// Idempotent — safe to call when not running.
void ghostly_system_audio_stop(void);

// 1 while capture is active.
int32_t ghostly_system_audio_is_running(void);

// Native sample rate of the active tap, or 0 when not running.
double ghostly_system_audio_sample_rate(void);

// Description of the most recent failure. Returns a pointer to a heap string
// the caller must release with ghostly_system_audio_free_string(), or NULL
// when there is no recorded error.
char *ghostly_system_audio_last_error(void);

// Newline-separated bundle identifiers of every audio process currently
// capturing microphone input, excluding Ghostly itself.
//
// This is the meeting-detection signal. It is per-process, unlike
// `kAudioDevicePropertyDeviceIsRunningSomewhere`, which reports only that
// *some* process holds the device — a property Ghostly's own always-on
// microphone stream trips, making it useless for detecting anyone else.
//
// Distinguishes "Slack is running" (true all day) from "Slack is in a huddle"
// (true only during a call), which an application allowlist cannot do.
// Requires no permission beyond what capture already needs.
//
// Returns NULL on failure; an empty result is an empty string. Caller owns the
// string and must release it with ghostly_system_audio_free_string().
char *ghostly_processes_using_microphone(void);

void ghostly_system_audio_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* system_audio_bridge_h */
