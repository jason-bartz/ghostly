//! In-flight cancellation for the streaming LLM pipeline.
//!
//! The transcribe pipeline opens an SSE stream to the provider while the user
//! waits. If the user hits the cancel shortcut mid-stream, we need a way to
//! tell the ongoing stream loop to stop pumping bytes and return early so the
//! app can return to idle.
//!
//! A single shared `AtomicBool` is kept in Tauri state. The action that opens
//! a stream calls `begin()` which resets the flag and returns a handle; the
//! stream loop checks the flag between chunks. `cancel_current_operation`
//! sets the flag and the stream returns with a cancellation error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct StreamCancellation {
    /// Token handed to the current stream loop. The stream polls this to
    /// abort mid-chunk.
    active: Mutex<Option<Arc<AtomicBool>>>,
    /// Sticky flag for the current operation. Set when cancel fires; read by
    /// the paste path to skip output. Cleared on `reset()` at the start of
    /// each new transcribe operation.
    cancelled: AtomicBool,
}

impl Default for StreamCancellation {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamCancellation {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }

    /// Clear all cancellation state at the start of a new transcribe operation
    /// so a stale flag from the previous run can't skip this one's output.
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::Relaxed);
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }

    /// Start tracking a new stream. Returns the cancel token the stream loop
    /// should check. The token is pre-seeded with any already-fired cancel so
    /// a cancel that races begin() still propagates.
    pub fn begin(&self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(
            self.cancelled.load(Ordering::Relaxed),
        ));
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(token.clone());
        token
    }

    /// Signal cancellation. Sets the sticky flag and trips any active stream
    /// token. Safe to call when nothing is running (just latches the flag).
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = slot.as_ref() {
            token.store(true, Ordering::Relaxed);
        }
    }

    /// True if `cancel()` has fired since the last `reset()`. Used by the
    /// paste path to skip output when the user asked to cancel.
    pub fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Clear the tracked token once a stream finishes normally. Does not
    /// clear the sticky cancelled flag — that survives until `reset()`.
    pub fn end(&self) {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }
}
