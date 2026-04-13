use crate::frontmost::AppContext;
use crate::settings::{PasteMethod, VoiceEditReplaceStrategy};
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct SessionEntry {
    pub raw_transcript: String,
    pub final_text: String,
    pub pasted_len_utf16: usize,
    pub app: AppContext,
    pub paste_method: PasteMethod,
    pub auto_submitted: bool,
    pub at: Instant,
}

impl SessionEntry {
    pub fn is_replaceable(&self) -> bool {
        if self.auto_submitted {
            return false;
        }
        match self.paste_method {
            PasteMethod::CtrlV
            | PasteMethod::Direct
            | PasteMethod::ShiftInsert
            | PasteMethod::CtrlShiftV => true,
            PasteMethod::ExternalScript | PasteMethod::None => false,
        }
    }
}

pub struct SessionBuffer {
    inner: Mutex<VecDeque<SessionEntry>>,
}

impl SessionBuffer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<SessionEntry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn push(&self, entry: SessionEntry, max_size: usize) {
        let mut buf = self.lock();
        buf.push_back(entry);
        while buf.len() > max_size.max(1) {
            buf.pop_front();
        }
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn latest_for_edit(
        &self,
        now: Instant,
        current_app: Option<&AppContext>,
        idle_timeout_secs: u64,
        strategy: VoiceEditReplaceStrategy,
    ) -> Option<SessionEntry> {
        if matches!(strategy, VoiceEditReplaceStrategy::Off) {
            return None;
        }
        let buf = self.lock();
        let entry = buf.back()?.clone();
        drop(buf);

        if idle_timeout_secs > 0
            && now.duration_since(entry.at).as_secs() > idle_timeout_secs
        {
            return None;
        }
        if let Some(ctx) = current_app {
            if !ctx.is_empty() && !entry.app.is_empty() && ctx.bundle_id != entry.app.bundle_id {
                return None;
            }
        }
        if matches!(strategy, VoiceEditReplaceStrategy::SelectAndPaste)
            && !entry.is_replaceable()
        {
            return None;
        }
        Some(entry)
    }

    /// Last N entries for LLM context packaging (newest last).
    pub fn tail(&self, n: usize) -> Vec<SessionEntry> {
        let buf = self.lock();
        let len = buf.len();
        let start = len.saturating_sub(n);
        buf.iter().skip(start).cloned().collect()
    }
}

impl Default for SessionBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Count the UTF-16 code units in a string — what the OS sees for Shift+Left steps
/// on macOS/Windows keyboard input paths.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
