//! Stages a captured screenshot + transcription so the user can focus a target
//! text field before pasting. Solves the UX problem that the user is looking at
//! content (not in a text field) at the moment of capture.

use std::sync::Mutex;

/// A screenshot + transcription waiting to be pasted into the user's chosen app.
#[derive(Debug, Clone)]
pub struct StagedCapture {
    pub png: Vec<u8>,
    pub text: String,
}

/// Managed state wrapper. Only one staged capture at a time — a new capture
/// replaces any existing one.
#[derive(Debug, Default)]
pub struct StagedCaptureState {
    inner: Mutex<Option<StagedCapture>>,
}

impl StagedCaptureState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Replace any staged capture with a new one.
    pub fn set(&self, png: Vec<u8>, text: String) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(StagedCapture { png, text });
        }
    }

    /// Take the staged capture, leaving the slot empty.
    pub fn take(&self) -> Option<StagedCapture> {
        self.inner.lock().ok().and_then(|mut s| s.take())
    }

    /// Clear any staged capture.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = None;
        }
    }
}
