use log::{debug, warn};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fmt;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

pub const APPLE_INTELLIGENCE_PROVIDER_ID: &str = "apple_intelligence";
pub const APPLE_INTELLIGENCE_DEFAULT_MODEL_ID: &str = "Apple Intelligence";

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

// Custom deserializer to handle both old numeric format (1-5) and new string format ("trace", "debug", etc.)
impl<'de> Deserialize<'de> for LogLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LogLevelVisitor;

        impl<'de> Visitor<'de> for LogLevelVisitor {
            type Value = LogLevel;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or integer representing log level")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<LogLevel, E> {
                match value.to_lowercase().as_str() {
                    "trace" => Ok(LogLevel::Trace),
                    "debug" => Ok(LogLevel::Debug),
                    "info" => Ok(LogLevel::Info),
                    "warn" => Ok(LogLevel::Warn),
                    "error" => Ok(LogLevel::Error),
                    _ => Err(E::unknown_variant(
                        value,
                        &["trace", "debug", "info", "warn", "error"],
                    )),
                }
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<LogLevel, E> {
                match value {
                    1 => Ok(LogLevel::Trace),
                    2 => Ok(LogLevel::Debug),
                    3 => Ok(LogLevel::Info),
                    4 => Ok(LogLevel::Warn),
                    5 => Ok(LogLevel::Error),
                    _ => Err(E::invalid_value(de::Unexpected::Unsigned(value), &"1-5")),
                }
            }
        }

        deserializer.deserialize_any(LogLevelVisitor)
    }
}

impl From<LogLevel> for tauri_plugin_log::LogLevel {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Trace => tauri_plugin_log::LogLevel::Trace,
            LogLevel::Debug => tauri_plugin_log::LogLevel::Debug,
            LogLevel::Info => tauri_plugin_log::LogLevel::Info,
            LogLevel::Warn => tauri_plugin_log::LogLevel::Warn,
            LogLevel::Error => tauri_plugin_log::LogLevel::Error,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct ShortcutBinding {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_binding: String,
    pub current_binding: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct VoiceCommand {
    /// Display label for settings UI.
    pub name: String,
    /// Trigger phrases. Matched case-insensitively against the normalized
    /// transcription as whole strings (not substrings).
    pub phrases: Vec<String>,
    /// Keystroke to inject. Format: "enter", "escape", "shift+tab", "cmd+s",
    /// "y". Modifiers: ctrl/shift/alt/option/cmd/meta. Keys: named (enter,
    /// escape, tab, space, backspace, delete, up/down/left/right, home, end,
    /// pageup, pagedown, f1-f12) or a single character.
    pub keystroke: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct LLMPrompt {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// Optional global keyboard shortcut for this prompt (e.g. "ctrl+1").
    /// When set, pressing this shortcut triggers a transcription using this prompt.
    #[serde(default)]
    pub shortcut: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct PostProcessProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub allow_base_url_edit: bool,
    #[serde(default)]
    pub models_endpoint: Option<String>,
    #[serde(default)]
    pub supports_structured_output: bool,
    #[serde(default)]
    pub supports_vision: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPosition {
    None,
    Top,
    Bottom,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ModelUnloadTimeout {
    Never,
    Immediately,
    Min2,
    Min5,
    Min10,
    Min15,
    Hour1,
    Sec15, // Debug mode only
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PasteMethod {
    CtrlV,
    Direct,
    None,
    ShiftInsert,
    CtrlShiftV,
    ExternalScript,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHandling {
    DontModify,
    CopyToClipboard,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum AutoSubmitKey {
    Enter,
    CtrlEnter,
    CmdEnter,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecordingRetentionPeriod {
    Never,
    PreserveLimit,
    Days3,
    Weeks2,
    Months3,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum KeyboardImplementation {
    Tauri,
    HandyKeys,
}

impl Default for KeyboardImplementation {
    fn default() -> Self {
        #[cfg(target_os = "linux")]
        return KeyboardImplementation::Tauri;
        #[cfg(not(target_os = "linux"))]
        return KeyboardImplementation::HandyKeys;
    }
}

impl Default for ModelUnloadTimeout {
    fn default() -> Self {
        ModelUnloadTimeout::Min5
    }
}

impl Default for PasteMethod {
    fn default() -> Self {
        // Default to CtrlV for macOS and Windows, Direct for Linux
        #[cfg(target_os = "linux")]
        return PasteMethod::Direct;
        #[cfg(not(target_os = "linux"))]
        return PasteMethod::CtrlV;
    }
}

impl Default for ClipboardHandling {
    fn default() -> Self {
        ClipboardHandling::DontModify
    }
}

impl Default for AutoSubmitKey {
    fn default() -> Self {
        AutoSubmitKey::Enter
    }
}

impl ModelUnloadTimeout {
    pub fn to_minutes(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Min2 => Some(2),
            ModelUnloadTimeout::Min5 => Some(5),
            ModelUnloadTimeout::Min10 => Some(10),
            ModelUnloadTimeout::Min15 => Some(15),
            ModelUnloadTimeout::Hour1 => Some(60),
            ModelUnloadTimeout::Sec15 => Some(0), // Special case for debug - handled separately
        }
    }

    pub fn to_seconds(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Sec15 => Some(15),
            _ => self.to_minutes().map(|m| m * 60),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum SoundTheme {
    Subtle,
    Marimba,
    Pop,
    Custom,
}

impl SoundTheme {
    fn as_str(&self) -> &'static str {
        match self {
            SoundTheme::Subtle => "subtle",
            SoundTheme::Marimba => "marimba",
            SoundTheme::Pop => "pop",
            SoundTheme::Custom => "custom",
        }
    }

    pub fn to_start_path(&self) -> String {
        format!("resources/{}_start.wav", self.as_str())
    }

    pub fn to_stop_path(&self) -> String {
        format!("resources/{}_stop.wav", self.as_str())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum TypingTool {
    Auto,
    Wtype,
    Kwtype,
    Dotool,
    Ydotool,
    Xdotool,
}

impl Default for TypingTool {
    fn default() -> Self {
        TypingTool::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum WhisperAcceleratorSetting {
    Auto,
    Cpu,
    Gpu,
}

impl Default for WhisperAcceleratorSetting {
    fn default() -> Self {
        WhisperAcceleratorSetting::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum OrtAcceleratorSetting {
    Auto,
    Cpu,
    Cuda,
    #[serde(rename = "directml")]
    DirectMl,
    Rocm,
}

impl Default for OrtAcceleratorSetting {
    fn default() -> Self {
        OrtAcceleratorSetting::Auto
    }
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub(crate) struct SecretMap(HashMap<String, String>);

impl fmt::Debug for SecretMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redacted: HashMap<&String, &str> = self
            .0
            .iter()
            .map(|(k, v)| (k, if v.is_empty() { "" } else { "[REDACTED]" }))
            .collect();
        redacted.fmt(f)
    }
}

impl std::ops::Deref for SecretMap {
    type Target = HashMap<String, String>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for SecretMap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/* still handy for composing the initial JSON in the store ------------- */
#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct AppSettings {
    pub bindings: HashMap<String, ShortcutBinding>,
    pub push_to_talk: bool,
    #[serde(default = "default_audio_feedback")]
    pub audio_feedback: bool,
    #[serde(default = "default_audio_feedback_volume")]
    pub audio_feedback_volume: f32,
    #[serde(default = "default_sound_theme")]
    pub sound_theme: SoundTheme,
    #[serde(default = "default_start_hidden")]
    pub start_hidden: bool,
    #[serde(default = "default_autostart_enabled")]
    pub autostart_enabled: bool,
    #[serde(default = "default_model")]
    pub selected_model: String,
    #[serde(default = "default_always_on_microphone")]
    pub always_on_microphone: bool,
    #[serde(default)]
    pub selected_microphone: Option<String>,
    #[serde(default)]
    pub clamshell_microphone: Option<String>,
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default = "default_translate_to_english")]
    pub translate_to_english: bool,
    #[serde(default = "default_selected_language")]
    pub selected_language: String,
    #[serde(default = "default_overlay_position")]
    pub overlay_position: OverlayPosition,
    #[serde(default = "default_debug_mode")]
    pub debug_mode: bool,
    #[serde(default = "default_log_level")]
    pub log_level: LogLevel,
    #[serde(default)]
    pub custom_words: Vec<String>,
    /// Optional phonetic ("sounds like") hints keyed by the lowercased custom
    /// word. Used as a Soundex override so users can nudge fuzzy-match for
    /// proper nouns whose spelling diverges from pronunciation
    /// (e.g. "Siobhan" -> "shavawn").
    #[serde(default)]
    pub custom_word_phonetics: HashMap<String, String>,
    #[serde(default)]
    pub model_unload_timeout: ModelUnloadTimeout,
    #[serde(default = "default_word_correction_threshold")]
    pub word_correction_threshold: f64,
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    #[serde(default = "default_recording_retention_period")]
    pub recording_retention_period: RecordingRetentionPeriod,
    #[serde(default)]
    pub paste_method: PasteMethod,
    #[serde(default)]
    pub clipboard_handling: ClipboardHandling,
    #[serde(default = "default_auto_submit")]
    pub auto_submit: bool,
    #[serde(default)]
    pub auto_submit_key: AutoSubmitKey,
    #[serde(default = "default_post_process_provider_id")]
    pub post_process_provider_id: String,
    #[serde(default = "default_post_process_providers")]
    pub post_process_providers: Vec<PostProcessProvider>,
    #[serde(default = "default_post_process_api_keys")]
    pub post_process_api_keys: SecretMap,
    #[serde(default = "default_post_process_models")]
    pub post_process_models: HashMap<String, String>,
    #[serde(default = "default_post_process_prompts")]
    pub post_process_prompts: Vec<LLMPrompt>,
    #[serde(default)]
    pub post_process_selected_prompt_id: Option<String>,
    #[serde(default)]
    pub mute_while_recording: bool,
    #[serde(default)]
    pub append_trailing_space: bool,
    #[serde(default = "default_app_language")]
    pub app_language: String,
    #[serde(default)]
    pub experimental_enabled: bool,
    #[serde(default)]
    pub lazy_stream_close: bool,
    /// Enables the hands-free continuous dictation mode. Dev-mode gated in UI.
    /// When true, an additional shortcut arms/disarms a VAD-driven loop that
    /// transcribes each utterance on silence without any key press.
    #[serde(default)]
    pub continuous_dictation_enabled: bool,
    /// Milliseconds of trailing silence that closes a segment.
    #[serde(default = "default_continuous_silence_ms")]
    pub continuous_silence_ms: u32,
    /// Hard ceiling on a single segment before force-flushing.
    #[serde(default = "default_continuous_max_segment_ms")]
    pub continuous_max_segment_ms: u32,
    /// Segments shorter than this are dropped (cough/click suppression).
    #[serde(default = "default_continuous_min_segment_ms")]
    pub continuous_min_segment_ms: u32,
    /// When true, ending a continuous-dictation segment with the configured
    /// submit phrase strips the phrase and sends the submit keystroke after
    /// pasting. Lets the user finish a thought with "...send it" to fire off
    /// a chat message hands-free.
    #[serde(default)]
    pub continuous_submit_phrase_enabled: bool,
    /// Phrase that triggers the submit keystroke when it appears at the end of
    /// a segment. Matched case-insensitively with word boundaries.
    #[serde(default = "default_continuous_submit_phrase")]
    pub continuous_submit_phrase: String,
    /// Which key to send when the submit phrase fires. Reuses `AutoSubmitKey`
    /// but the UI exposes only Enter and Cmd+Enter — Ctrl+Enter is uncommon
    /// for chat submit on macOS.
    #[serde(default)]
    pub continuous_submit_key: AutoSubmitKey,
    #[serde(default)]
    pub keyboard_implementation: KeyboardImplementation,
    #[serde(default = "default_show_tray_icon")]
    pub show_tray_icon: bool,
    #[serde(default = "default_show_dock_icon")]
    pub show_dock_icon: bool,
    #[serde(default = "default_paste_delay_ms")]
    pub paste_delay_ms: u64,
    #[serde(default = "default_typing_tool")]
    pub typing_tool: TypingTool,
    pub external_script_path: Option<String>,
    #[serde(default)]
    pub custom_filler_words: Option<Vec<String>>,
    #[serde(default)]
    pub whisper_accelerator: WhisperAcceleratorSetting,
    #[serde(default)]
    pub ort_accelerator: OrtAcceleratorSetting,
    #[serde(default = "default_whisper_gpu_device")]
    pub whisper_gpu_device: i32,
    #[serde(default)]
    pub extra_recording_buffer_ms: u64,

    // --- Per-app profiles (Feature A) ---
    #[serde(default)]
    pub profiles_enabled: bool,
    #[serde(default)]
    pub profiles: Vec<crate::profiles::Profile>,
    /// When true, built-in app-category profiles auto-activate for common apps.
    #[serde(default = "default_true")]
    pub builtin_profiles_enabled: bool,

    // --- Style system (supersedes the flat profile list for most users) ---
    /// Master switch for the Style system. When on, the resolver picks a
    /// Category for the frontmost app and applies the configured style and
    /// cleanup level. Defaults on.
    #[serde(default = "default_true")]
    pub style_enabled: bool,
    /// Per-category style configuration. Always contains 4 entries (one per
    /// CategoryId) — `ensure_category_style_defaults` keeps this invariant.
    #[serde(default = "crate::profiles::default_category_styles")]
    pub category_styles: Vec<crate::profiles::CategoryStyle>,
    #[serde(default)]
    pub auto_cleanup_level: crate::profiles::AutoCleanupLevel,
    /// Per-word category tags for Dictionary entries, keyed by the
    /// lowercased word. Empty / missing = applies globally. When set,
    /// the word only feeds Whisper's prompt in matching categories.
    #[serde(default)]
    pub custom_word_categories: HashMap<String, Vec<crate::profiles::CategoryId>>,

    // --- Voice editing loop (Feature B) ---
    #[serde(default)]
    pub voice_editing_enabled: bool,
    #[serde(default = "default_session_buffer_size")]
    pub session_buffer_size: usize,
    #[serde(default = "default_session_idle_timeout_secs")]
    pub session_idle_timeout_secs: u64,
    #[serde(default)]
    pub voice_edit_replace_strategy: VoiceEditReplaceStrategy,
    /// Opt-in experimental: regex prefix detection in addition to the shortcut.
    #[serde(default)]
    pub voice_edit_prefix_detection: bool,

    // --- Localhost REST API (Feature C) ---
    #[serde(default)]
    pub rest_api_enabled: bool,
    #[serde(default = "default_rest_api_port")]
    pub rest_api_port: u16,

    // --- Voice commands (agent control) ---
    #[serde(default)]
    pub voice_commands_enabled: bool,
    #[serde(default = "default_voice_commands")]
    pub voice_commands: Vec<VoiceCommand>,

    // --- IDE presets (one-time hint + contextual auto-submit) ---
    /// When true, Ghostly detects supported IDEs/agent CLIs (Cursor, Claude
    /// Code, Windsurf, VS Code, Replit) and surfaces a one-time hint chip in
    /// the overlay plus context-aware voice-command matching.
    #[serde(default = "default_true")]
    pub ide_presets_enabled: bool,
    /// Preset IDs the user has already been shown the hint for. Used to make
    /// the onscreen hint strictly one-time per app.
    #[serde(default)]
    pub seen_ide_hints: Vec<String>,
    /// When true, dictation into a detected IDE with `auto_submit: true`
    /// presses Enter after paste regardless of the global `auto_submit`
    /// setting. This is what makes "auto populate AND auto send" work.
    #[serde(default = "default_true")]
    pub ide_auto_submit: bool,

    // --- Correction phrases (Feature D) ---
    /// When true, speaking a correction phrase deletes the last transcription.
    /// No AI required — pure regex word-boundary replacement.
    #[serde(default = "default_correction_phrases_enabled")]
    pub correction_phrases_enabled: bool,
    /// Phrases that trigger deletion of the last pasted transcription.
    #[serde(default = "default_correction_phrases")]
    pub correction_phrases: Vec<String>,

    /// Version string of the EULA the user has accepted. `None` means the
    /// user has not yet accepted any EULA — app must show the click-through
    /// modal before allowing use. When `CURRENT_EULA_VERSION` bumps, the
    /// stored value will not match and the user re-accepts.
    #[serde(default)]
    pub eula_accepted_version: Option<String>,

    /// True when the user has a valid Pro license. Bypasses the weekly
    /// usage cap. Populated later by the license module; stub default is false.
    #[serde(default)]
    pub is_pro: bool,

    /// Debug-only override that forces the free-tier code path regardless of
    /// `is_pro`. Only settable from the Debug settings pane; not exposed in
    /// the normal UI. Lets us test the paywall flow on a Pro build.
    #[serde(default)]
    pub dev_force_free_tier: bool,
}

/// Bump this string when the EULA text changes in a way that requires users
/// to re-accept. Format: `YYYY-MM-DD` matching the "Last updated" date at the
/// top of `EULA.md`.
pub const CURRENT_EULA_VERSION: &str = "2026-04-14";

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEditReplaceStrategy {
    /// Select prior pasted text (Shift+Left×N) then paste replacement.
    SelectAndPaste,
    /// Just paste the new version; user deletes old version manually.
    RepasteOnly,
    /// Disable voice-edit replacement entirely.
    Off,
}

impl Default for VoiceEditReplaceStrategy {
    fn default() -> Self {
        VoiceEditReplaceStrategy::SelectAndPaste
    }
}

fn default_session_buffer_size() -> usize {
    10
}

fn default_session_idle_timeout_secs() -> u64 {
    120
}

fn default_model() -> String {
    "".to_string()
}

fn default_always_on_microphone() -> bool {
    false
}

fn default_continuous_silence_ms() -> u32 {
    900
}

fn default_continuous_max_segment_ms() -> u32 {
    20_000
}

fn default_continuous_min_segment_ms() -> u32 {
    400
}

fn default_continuous_submit_phrase() -> String {
    "send it".to_string()
}

fn default_translate_to_english() -> bool {
    false
}

fn default_start_hidden() -> bool {
    true
}

fn default_autostart_enabled() -> bool {
    true
}

fn default_selected_language() -> String {
    "auto".to_string()
}

fn default_overlay_position() -> OverlayPosition {
    #[cfg(target_os = "linux")]
    return OverlayPosition::None;
    #[cfg(not(target_os = "linux"))]
    return OverlayPosition::Bottom;
}

fn default_debug_mode() -> bool {
    false
}

fn default_log_level() -> LogLevel {
    LogLevel::Debug
}

fn default_word_correction_threshold() -> f64 {
    0.18
}

fn default_correction_phrases_enabled() -> bool {
    true
}

fn default_paste_delay_ms() -> u64 {
    60
}

fn default_auto_submit() -> bool {
    false
}

fn default_history_limit() -> usize {
    20
}

fn default_recording_retention_period() -> RecordingRetentionPeriod {
    RecordingRetentionPeriod::Days3
}

fn default_audio_feedback() -> bool {
    true
}

fn default_audio_feedback_volume() -> f32 {
    0.6
}

fn default_sound_theme() -> SoundTheme {
    SoundTheme::Subtle
}

fn default_app_language() -> String {
    tauri_plugin_os::locale()
        .map(|l| l.replace('_', "-"))
        .unwrap_or_else(|| "en".to_string())
}

fn default_show_tray_icon() -> bool {
    true
}

fn default_show_dock_icon() -> bool {
    true
}

fn default_post_process_provider_id() -> String {
    "openai".to_string()
}

fn default_post_process_providers() -> Vec<PostProcessProvider> {
    let mut providers = vec![
        PostProcessProvider {
            id: "openai".to_string(),
            label: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: true,
            supports_vision: true,
        },
        PostProcessProvider {
            id: "zai".to_string(),
            label: "Z.AI".to_string(),
            base_url: "https://api.z.ai/api/paas/v4".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: true,
            supports_vision: true,
        },
        PostProcessProvider {
            id: "openrouter".to_string(),
            label: "OpenRouter".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: true,
            supports_vision: true,
        },
        PostProcessProvider {
            id: "anthropic".to_string(),
            label: "Anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: false,
            supports_vision: false,
        },
        PostProcessProvider {
            id: "groq".to_string(),
            label: "Groq".to_string(),
            base_url: "https://api.groq.com/openai/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: false,
            supports_vision: true,
        },
        PostProcessProvider {
            id: "cerebras".to_string(),
            label: "Cerebras".to_string(),
            base_url: "https://api.cerebras.ai/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: Some("/models".to_string()),
            supports_structured_output: true,
            supports_vision: false,
        },
    ];

    // Note: We always include Apple Intelligence on macOS ARM64 without checking availability
    // at startup. The availability check is deferred to when the user actually tries to use it
    // (in actions.rs). This prevents crashes on macOS 26.x beta where accessing
    // SystemLanguageModel.default during early app initialization causes SIGABRT.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        providers.push(PostProcessProvider {
            id: APPLE_INTELLIGENCE_PROVIDER_ID.to_string(),
            label: "Apple Intelligence".to_string(),
            base_url: "apple-intelligence://local".to_string(),
            allow_base_url_edit: false,
            models_endpoint: None,
            supports_structured_output: true,
            supports_vision: false,
        });
    }

    // Custom provider always comes last
    providers.push(PostProcessProvider {
        id: "custom".to_string(),
        label: "Custom".to_string(),
        base_url: "http://localhost:11434/v1".to_string(),
        allow_base_url_edit: true,
        models_endpoint: Some("/models".to_string()),
        supports_structured_output: false,
        supports_vision: false,
    });

    providers
}

fn default_post_process_api_keys() -> SecretMap {
    let mut map = HashMap::new();
    for provider in default_post_process_providers() {
        map.insert(provider.id, String::new());
    }
    SecretMap(map)
}

fn default_model_for_provider(provider_id: &str) -> String {
    if provider_id == APPLE_INTELLIGENCE_PROVIDER_ID {
        return APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string();
    }
    String::new()
}

fn default_post_process_models() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for provider in default_post_process_providers() {
        map.insert(
            provider.id.clone(),
            default_model_for_provider(&provider.id),
        );
    }
    map
}

/// IDs of built-in prompts that are auto-injected into user settings.
/// Used by `ensure_builtin_prompts()` to detect which prompts to add/preserve.
pub const BUILTIN_PROMPT_IDS: &[&str] = &[
    "default_improve_transcriptions",
    "builtin_developer",
    "builtin_ai_prompt",
    "builtin_screenshot_qa",
    "builtin_email",
    "builtin_casual",
    "builtin_structured",
];

fn default_post_process_prompts() -> Vec<LLMPrompt> {
    vec![
        LLMPrompt {
            id: "default_improve_transcriptions".to_string(),
            name: "Improve Transcriptions".to_string(),
            prompt: "Clean this transcript:\n1. Fix spelling, capitalization, and punctuation errors\n2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)\n3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?)\n4. Remove filler words (um, uh, like as filler)\n5. Keep the language in the original version (if it was french, keep it in french for example)\n6. Format lists: if the text contains explicit enumeration (first/second/third, one/two/three, number one/two, bullet point one/two) or a clear sequence of items, format them as a proper bulleted or numbered list using markdown (- item or 1. item)\n\nPreserve exact meaning and word order. Do not paraphrase or reorder content.\n\nReturn only the cleaned transcript.\n\nTranscript:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_developer".to_string(),
            name: "Developer".to_string(),
            prompt: "You are a developer assistant. Clean this voice transcription for a coding context:\n1. Format identifiers: detect spoken camelCase (\"my variable\" → myVariable), snake_case (\"my function\" → my_function), and UPPER_CASE constants\n2. Format CLI syntax: convert spoken commands to code (\"git force push\" → git push --force, \"make directory\" → mkdir, \"pipe to grep\" → | grep)\n3. Convert spoken symbols: \"dot\" → \".\", \"slash\" → \"/\", \"double colon\" → \"::\", \"arrow\" → \"->\", \"fat arrow\" → \"=>\"\n4. Fix punctuation: add semicolons, brackets where spoken (\"open paren\" → \"(\", \"close bracket\" → \"]\")\n5. Preserve technical terms exactly (React, Kubernetes, PostgreSQL, TypeScript, etc.)\n6. Remove filler words only\n\nReturn only the cleaned text.\n\nTranscript:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_ai_prompt".to_string(),
            name: "AI Prompt Rewriter".to_string(),
            prompt: "You rewrite rambly spoken instructions into clean prompts for AI coding assistants (Cursor, Claude Code, Windsurf, v0).\n\nRestructure the input into this shape when the content supports it:\n- **Goal:** one sentence describing what to build, fix, or change\n- **Context:** files, functions, libraries, or constraints the user mentioned\n- **Acceptance:** observable criteria for \"done\" — only if the user stated or clearly implied them\n\nRules:\n- Preserve the user's intent exactly. Do not invent requirements, files, or constraints they didn't mention.\n- Preserve technical terms, identifiers, and code fragments verbatim (camelCase, snake_case, file paths, CLI flags).\n- Remove filler words and false starts. Tighten rambling phrasing.\n- If the input is a short one-liner, return a single clean sentence instead of forcing the structure.\n- Return only the rewritten prompt — no preamble, no explanation.\n\nInput:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_screenshot_qa".to_string(),
            name: "Screenshot Q&A".to_string(),
            prompt: "You are a vision assistant. The user has attached a screenshot and dictated a request.\n\nRules:\n- Look carefully at the screenshot.\n- Answer the dictated request directly and concisely.\n- If the user asks for code, a prompt, a commit message, or any specific output, return ONLY that output — no preamble, no explanation.\n- If the user asks a general question about the screen, answer plainly in one or two sentences unless more is clearly needed.\n- Preserve any identifiers, file paths, CLI flags, and code fragments verbatim.\n\nDictated request:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_email".to_string(),
            name: "Email".to_string(),
            prompt: "Clean this voice transcription for a professional email context:\n1. Fix spelling, capitalization, and grammar\n2. Convert number words to digits where appropriate\n3. Replace spoken punctuation with symbols\n4. Remove filler words (um, uh, like as filler)\n5. Ensure professional tone — fix overly casual phrasing without changing meaning\n6. Add proper sentence structure and paragraph breaks where natural\n\nPreserve meaning exactly. Return only the cleaned text.\n\nTranscript:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_casual".to_string(),
            name: "Casual".to_string(),
            prompt: "Clean this voice transcription for casual messaging:\n1. Fix obvious spelling errors only\n2. Replace spoken punctuation with symbols\n3. Remove filler words (um, uh)\n4. Keep it natural and conversational — don't over-formalize\n5. Lowercase is fine where appropriate\n\nPreserve the casual tone. Return only the cleaned text.\n\nTranscript:\n${output}".to_string(),
            shortcut: None,
        },
        LLMPrompt {
            id: "builtin_structured".to_string(),
            name: "Structured Notes".to_string(),
            prompt: "Clean and structure this voice transcription for note-taking:\n1. Fix spelling, capitalization, and punctuation\n2. Convert number words to digits\n3. Replace spoken punctuation with symbols\n4. Remove filler words\n5. Add bullet points or numbered lists where you detect enumeration (\"first... second... third...\")\n6. Break long sentences into clear, scannable statements\n\nPreserve all meaning. Return only the structured text.\n\nTranscript:\n${output}".to_string(),
            shortcut: None,
        },
    ]
}

/// Ensure all built-in prompts exist in user settings and their text is
/// up-to-date. Called at settings load time so users always have access to
/// built-in prompts and receive prompt-text updates automatically.
/// User-set shortcuts on built-in prompts are preserved.
fn ensure_builtin_prompts(settings: &mut AppSettings) -> bool {
    let builtins = default_post_process_prompts();
    let mut changed = false;
    for builtin in builtins {
        match settings
            .post_process_prompts
            .iter_mut()
            .find(|p| p.id == builtin.id)
        {
            None => {
                debug!("Injecting missing built-in prompt '{}'", builtin.id);
                settings.post_process_prompts.push(builtin);
                changed = true;
            }
            Some(existing) => {
                // Sync name and prompt text so built-in updates reach existing
                // users automatically. The shortcut (user-set) is left alone.
                if existing.name != builtin.name || existing.prompt != builtin.prompt {
                    debug!("Updating built-in prompt '{}'", builtin.id);
                    existing.name = builtin.name;
                    existing.prompt = builtin.prompt;
                    changed = true;
                }
            }
        }
    }
    changed
}

fn default_whisper_gpu_device() -> i32 {
    -1 // auto
}

fn default_true() -> bool {
    true
}

fn default_rest_api_port() -> u16 {
    7543
}

fn default_correction_phrases() -> Vec<String> {
    vec!["scratch that".to_string()]
}

fn default_voice_commands() -> Vec<VoiceCommand> {
    vec![
        VoiceCommand {
            name: "Approve".to_string(),
            phrases: vec![
                "approve".to_string(),
                "accept".to_string(),
                "yes".to_string(),
                "okay".to_string(),
                "confirm".to_string(),
            ],
            keystroke: "enter".to_string(),
            enabled: true,
        },
        VoiceCommand {
            name: "Reject".to_string(),
            phrases: vec![
                "reject".to_string(),
                "decline".to_string(),
                "no".to_string(),
                "cancel".to_string(),
            ],
            keystroke: "escape".to_string(),
            enabled: true,
        },
        VoiceCommand {
            name: "Next".to_string(),
            phrases: vec!["next".to_string()],
            keystroke: "tab".to_string(),
            enabled: true,
        },
        VoiceCommand {
            name: "Back".to_string(),
            phrases: vec!["back".to_string(), "previous".to_string()],
            keystroke: "shift+tab".to_string(),
            enabled: true,
        },
    ]
}

fn default_typing_tool() -> TypingTool {
    TypingTool::Auto
}

fn ensure_post_process_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for provider in default_post_process_providers() {
        // Use match to do a single lookup - either sync existing or add new
        match settings
            .post_process_providers
            .iter_mut()
            .find(|p| p.id == provider.id)
        {
            Some(existing) => {
                // Sync supports_structured_output field for existing providers (migration)
                if existing.supports_structured_output != provider.supports_structured_output {
                    debug!(
                        "Updating supports_structured_output for provider '{}' from {} to {}",
                        provider.id,
                        existing.supports_structured_output,
                        provider.supports_structured_output
                    );
                    existing.supports_structured_output = provider.supports_structured_output;
                    changed = true;
                }
            }
            None => {
                // Provider doesn't exist, add it
                settings.post_process_providers.push(provider.clone());
                changed = true;
            }
        }

        if !settings.post_process_api_keys.contains_key(&provider.id) {
            settings
                .post_process_api_keys
                .insert(provider.id.clone(), String::new());
            changed = true;
        }

        let default_model = default_model_for_provider(&provider.id);
        match settings.post_process_models.get_mut(&provider.id) {
            Some(existing) => {
                if existing.is_empty() && !default_model.is_empty() {
                    *existing = default_model.clone();
                    changed = true;
                }
            }
            None => {
                settings
                    .post_process_models
                    .insert(provider.id.clone(), default_model);
                changed = true;
            }
        }
    }

    changed
}

pub const SETTINGS_STORE_PATH: &str = "settings_store.json";

pub fn get_default_settings() -> AppSettings {
    #[cfg(target_os = "windows")]
    let default_shortcut = "ctrl+space";
    #[cfg(target_os = "macos")]
    let default_shortcut = "option+space";
    #[cfg(target_os = "linux")]
    let default_shortcut = "ctrl+space";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_shortcut = "alt+space";

    let mut bindings = HashMap::new();
    bindings.insert(
        "transcribe".to_string(),
        ShortcutBinding {
            id: "transcribe".to_string(),
            name: "Transcribe".to_string(),
            description: "Converts your speech into text.".to_string(),
            default_binding: default_shortcut.to_string(),
            current_binding: default_shortcut.to_string(),
        },
    );
    // Voice command shortcut — unbound by default; user opts in.
    bindings.insert(
        "voice_command".to_string(),
        ShortcutBinding {
            id: "voice_command".to_string(),
            name: "Voice Command".to_string(),
            description:
                "Records a short phrase and maps it to a keystroke (e.g. \"approve\" → Enter) instead of pasting text. Great for AI agent control in Cursor, Claude Code, and similar tools."
                    .to_string(),
            default_binding: "".to_string(),
            current_binding: "".to_string(),
        },
    );

    // Screenshot + dictate shortcut — unbound by default so users opt in explicitly.
    bindings.insert(
        "transcribe_with_screenshot".to_string(),
        ShortcutBinding {
            id: "transcribe_with_screenshot".to_string(),
            name: "Screenshot + Dictate".to_string(),
            description:
                "Captures the screen and records your question, then stages them. Focus a text field and trigger 'Paste Staged Capture' to drop the screenshot and text into the app."
                    .to_string(),
            default_binding: "".to_string(),
            current_binding: "".to_string(),
        },
    );

    // Confirm-paste shortcut for staged screenshot captures. Unbound by default
    // so the user can pick a combo that doesn't conflict with their target apps.
    bindings.insert(
        "confirm_screenshot_paste".to_string(),
        ShortcutBinding {
            id: "confirm_screenshot_paste".to_string(),
            name: "Paste Staged Capture".to_string(),
            description:
                "Pastes the staged screenshot + transcription into the focused text field. Trigger this after capturing with 'Screenshot + Dictate'."
                    .to_string(),
            default_binding: "".to_string(),
            current_binding: "".to_string(),
        },
    );
    bindings.insert(
        "cancel".to_string(),
        ShortcutBinding {
            id: "cancel".to_string(),
            name: "Cancel".to_string(),
            description: "Cancels the current recording.".to_string(),
            default_binding: "escape".to_string(),
            current_binding: "escape".to_string(),
        },
    );
    // Voice-edit shortcut — unbound by default so users opt in explicitly.
    // Arm/disarm for hands-free continuous dictation. Unbound by default;
    // the feature is dev-mode gated and the user explicitly opts in.
    bindings.insert(
        "toggle_continuous_dictation".to_string(),
        ShortcutBinding {
            id: "toggle_continuous_dictation".to_string(),
            name: "Toggle Continuous Dictation".to_string(),
            description:
                "Arms or disarms hands-free continuous dictation. When armed, the microphone stays hot and Ghostly transcribes each utterance automatically on silence."
                    .to_string(),
            default_binding: "".to_string(),
            current_binding: "".to_string(),
        },
    );

    // Default: fn+ctrl — sits right next to the transcribe key on a MacBook
    // so the edit action feels like a natural sibling of the record action.
    let default_edit_shortcut = "ctrl+fn";
    bindings.insert(
        "edit_last_transcription".to_string(),
        ShortcutBinding {
            id: "edit_last_transcription".to_string(),
            name: "Edit Last Transcription".to_string(),
            description:
                "Records a short instruction and revises the previously pasted transcription via the post-process LLM. Also shows quick-action chips (Shorten, Lengthen, Fix grammar, Rephrase) you can click to edit whatever text is in the focused field."
                    .to_string(),
            default_binding: default_edit_shortcut.to_string(),
            current_binding: default_edit_shortcut.to_string(),
        },
    );

    AppSettings {
        bindings,
        push_to_talk: true,
        audio_feedback: true,
        audio_feedback_volume: default_audio_feedback_volume(),
        sound_theme: default_sound_theme(),
        start_hidden: default_start_hidden(),
        autostart_enabled: default_autostart_enabled(),
        selected_model: "".to_string(),
        always_on_microphone: false,
        selected_microphone: None,
        clamshell_microphone: None,
        selected_output_device: None,
        translate_to_english: false,
        selected_language: "auto".to_string(),
        overlay_position: default_overlay_position(),
        debug_mode: false,
        log_level: default_log_level(),
        custom_words: Vec::new(),
        custom_word_phonetics: HashMap::new(),
        model_unload_timeout: ModelUnloadTimeout::default(),
        word_correction_threshold: default_word_correction_threshold(),
        history_limit: default_history_limit(),
        recording_retention_period: default_recording_retention_period(),
        paste_method: PasteMethod::default(),
        clipboard_handling: ClipboardHandling::default(),
        auto_submit: default_auto_submit(),
        auto_submit_key: AutoSubmitKey::default(),
        post_process_provider_id: default_post_process_provider_id(),
        post_process_providers: default_post_process_providers(),
        post_process_api_keys: default_post_process_api_keys(),
        post_process_models: default_post_process_models(),
        post_process_prompts: default_post_process_prompts(),
        post_process_selected_prompt_id: None,
        mute_while_recording: false,
        append_trailing_space: false,
        app_language: default_app_language(),
        experimental_enabled: false,
        lazy_stream_close: false,
        continuous_dictation_enabled: false,
        continuous_silence_ms: default_continuous_silence_ms(),
        continuous_max_segment_ms: default_continuous_max_segment_ms(),
        continuous_min_segment_ms: default_continuous_min_segment_ms(),
        continuous_submit_phrase_enabled: false,
        continuous_submit_phrase: default_continuous_submit_phrase(),
        continuous_submit_key: AutoSubmitKey::default(),
        keyboard_implementation: KeyboardImplementation::default(),
        show_tray_icon: default_show_tray_icon(),
        show_dock_icon: default_show_dock_icon(),
        paste_delay_ms: default_paste_delay_ms(),
        typing_tool: default_typing_tool(),
        external_script_path: None,
        custom_filler_words: None,
        whisper_accelerator: WhisperAcceleratorSetting::default(),
        ort_accelerator: OrtAcceleratorSetting::default(),
        whisper_gpu_device: default_whisper_gpu_device(),
        extra_recording_buffer_ms: 0,
        profiles_enabled: false,
        profiles: Vec::new(),
        builtin_profiles_enabled: true,
        style_enabled: true,
        category_styles: crate::profiles::default_category_styles(),
        auto_cleanup_level: crate::profiles::AutoCleanupLevel::default(),
        custom_word_categories: HashMap::new(),
        voice_editing_enabled: false,
        session_buffer_size: default_session_buffer_size(),
        session_idle_timeout_secs: default_session_idle_timeout_secs(),
        voice_edit_replace_strategy: VoiceEditReplaceStrategy::default(),
        voice_edit_prefix_detection: false,
        rest_api_enabled: false,
        rest_api_port: default_rest_api_port(),
        voice_commands_enabled: false,
        voice_commands: default_voice_commands(),
        ide_presets_enabled: true,
        seen_ide_hints: Vec::new(),
        ide_auto_submit: true,
        correction_phrases_enabled: true,
        correction_phrases: default_correction_phrases(),
        eula_accepted_version: None,
        is_pro: false,
        dev_force_free_tier: false,
    }
}

impl AppSettings {
    /// Effective Pro status after applying the debug override. Free-tier code
    /// paths (usage cap, paywall) gate on this.
    pub fn effective_is_pro(&self) -> bool {
        self.is_pro && !self.dev_force_free_tier
    }

    pub fn active_post_process_provider(&self) -> Option<&PostProcessProvider> {
        self.post_process_providers
            .iter()
            .find(|provider| provider.id == self.post_process_provider_id)
    }

    pub fn post_process_provider(&self, provider_id: &str) -> Option<&PostProcessProvider> {
        self.post_process_providers
            .iter()
            .find(|provider| provider.id == provider_id)
    }

    pub fn post_process_provider_mut(
        &mut self,
        provider_id: &str,
    ) -> Option<&mut PostProcessProvider> {
        self.post_process_providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
    }

    /// Returns true when the user has a usable LLM configured: a valid
    /// provider + model selected, and either an API key entered or the
    /// provider is Apple Intelligence (native, no key required).
    ///
    /// Used to decide whether the default transcribe shortcut should auto-
    /// apply AI refinement.
    pub fn has_working_llm(&self) -> bool {
        let Some(provider) = self.active_post_process_provider() else {
            return false;
        };
        let model = self
            .post_process_models
            .get(&provider.id)
            .map(|s| s.trim())
            .unwrap_or("");
        if model.is_empty() {
            return false;
        }
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            return true;
        }
        let key = self
            .post_process_api_keys
            .get(&provider.id)
            .map(|s| s.trim())
            .unwrap_or("");
        !key.is_empty()
    }
}

pub fn load_or_create_app_settings(app: &AppHandle) -> AppSettings {
    // Initialize store
    let store = app
        .store(crate::portable::store_path(SETTINGS_STORE_PATH))
        .expect("Failed to initialize store");

    let mut settings = if let Some(settings_value) = store.get("settings") {
        // Parse the entire settings object
        match serde_json::from_value::<AppSettings>(settings_value) {
            Ok(mut settings) => {
                debug!("Found existing settings: {:?}", settings);
                let default_settings = get_default_settings();
                let mut updated = false;

                // Merge default bindings into existing settings
                for (key, value) in default_settings.bindings {
                    if !settings.bindings.contains_key(&key) {
                        debug!("Adding missing binding: {}", key);
                        settings.bindings.insert(key, value);
                        updated = true;
                    }
                }

                // Migration: `transcribe_with_post_process` was removed in
                // favor of auto-refinement on the main transcribe shortcut.
                // Drop any orphan binding carried over from older installs.
                if settings
                    .bindings
                    .remove("transcribe_with_post_process")
                    .is_some()
                {
                    debug!("Removing obsolete `transcribe_with_post_process` binding");
                    updated = true;
                }

                if updated {
                    debug!("Settings updated with new bindings");
                    store.set("settings", serde_json::to_value(&settings).unwrap());
                }

                settings
            }
            Err(e) => {
                warn!("Failed to parse settings: {}", e);
                // Fall back to default settings if parsing fails
                let default_settings = get_default_settings();
                store.set("settings", serde_json::to_value(&default_settings).unwrap());
                default_settings
            }
        }
    } else {
        let default_settings = get_default_settings();
        store.set("settings", serde_json::to_value(&default_settings).unwrap());
        default_settings
    };

    let mut changed = ensure_post_process_defaults(&mut settings);
    changed |= ensure_builtin_prompts(&mut settings);
    changed |= ensure_category_style_defaults(&mut settings);
    changed |= migrate_seen_ide_hint_ids(&mut settings);
    let migrated = hydrate_api_keys_from_keychain(&mut settings);
    if changed || migrated {
        store.set(
            "settings",
            serde_json::to_value(sanitize_for_storage(&settings)).unwrap(),
        );
    }

    settings
}

/// Migrate legacy `seen_ide_hints` entries from the bare preset ids
/// ("cursor", "claude_code", "windsurf", "vscode", "replit") to the
/// `builtin_*` profile ids introduced when IDE presets folded into the
/// profile system. Without this, existing users would see the one-time
/// hint chip again after upgrading.
fn migrate_seen_ide_hint_ids(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for id in settings.seen_ide_hints.iter_mut() {
        let new_id = match id.as_str() {
            "cursor" => Some("builtin_cursor"),
            "claude_code" => Some("builtin_claude_code"),
            "windsurf" => Some("builtin_windsurf"),
            "vscode" => Some("builtin_vscode"),
            "replit" => Some("builtin_replit"),
            _ => None,
        };
        if let Some(next) = new_id {
            *id = next.to_string();
            changed = true;
        }
    }
    changed
}

/// Backfill any missing category_styles entries so the Style system always
/// has a row per CategoryId. Preserves the user's existing selections.
fn ensure_category_style_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for cat in crate::profiles::CategoryId::all() {
        if !settings
            .category_styles
            .iter()
            .any(|cs| cs.category_id == cat)
        {
            let defaults = crate::profiles::default_category_styles();
            if let Some(default) = defaults.into_iter().find(|cs| cs.category_id == cat) {
                settings.category_styles.push(default);
                changed = true;
            }
        }
    }
    changed
}

/// Hydrate API keys from the OS keychain into the in-memory settings.
/// Migrates any plaintext keys still in the JSON up into the keychain.
/// Returns true when plaintext keys were successfully migrated (and thus
/// should be cleared from the JSON store on the next save).
fn hydrate_api_keys_from_keychain(settings: &mut AppSettings) -> bool {
    let providers: Vec<String> = settings
        .post_process_providers
        .iter()
        .map(|p| p.id.clone())
        .collect();
    let mut migrated_plaintext = false;
    for provider_id in providers {
        let current = settings
            .post_process_api_keys
            .get(&provider_id)
            .cloned()
            .unwrap_or_default();
        if current.is_empty() {
            if let Some(stored) = crate::keychain::get_api_key(&provider_id) {
                settings.post_process_api_keys.insert(provider_id, stored);
            }
        } else if crate::keychain::set_api_key(&provider_id, &current) {
            // Plaintext key successfully migrated to keychain.
            migrated_plaintext = true;
        } else {
            // Keychain unavailable — leave plaintext in place so the user
            // doesn't lose their key. We'll try again next load.
            warn!(
                "Keychain write failed for provider '{}'; keeping plaintext in settings.",
                provider_id
            );
        }
    }
    migrated_plaintext
}

/// Produce a copy of settings with API keys cleared for each provider whose
/// key is present in the OS keychain. Keys only get cleared when the keychain
/// confirms it has them, so a keychain outage can't cause data loss.
fn sanitize_for_storage(settings: &AppSettings) -> AppSettings {
    let mut out = settings.clone();
    let providers: Vec<String> = out
        .post_process_providers
        .iter()
        .map(|p| p.id.clone())
        .collect();
    for provider_id in providers {
        // Only clear the JSON copy if the keychain actually holds the key.
        if crate::keychain::get_api_key(&provider_id).is_some() {
            out.post_process_api_keys.insert(provider_id, String::new());
        }
    }
    out
}

pub fn get_settings(app: &AppHandle) -> AppSettings {
    let store = app
        .store(crate::portable::store_path(SETTINGS_STORE_PATH))
        .expect("Failed to initialize store");

    let mut settings = if let Some(settings_value) = store.get("settings") {
        serde_json::from_value::<AppSettings>(settings_value).unwrap_or_else(|_| {
            let default_settings = get_default_settings();
            store.set(
                "settings",
                serde_json::to_value(sanitize_for_storage(&default_settings)).unwrap(),
            );
            default_settings
        })
    } else {
        let default_settings = get_default_settings();
        store.set(
            "settings",
            serde_json::to_value(sanitize_for_storage(&default_settings)).unwrap(),
        );
        default_settings
    };

    let mut changed = ensure_post_process_defaults(&mut settings);
    changed |= ensure_builtin_prompts(&mut settings);
    changed |= ensure_category_style_defaults(&mut settings);
    changed |= migrate_seen_ide_hint_ids(&mut settings);
    let migrated = hydrate_api_keys_from_keychain(&mut settings);
    if changed || migrated {
        store.set(
            "settings",
            serde_json::to_value(sanitize_for_storage(&settings)).unwrap(),
        );
    }

    settings
}

pub fn write_settings(app: &AppHandle, settings: AppSettings) {
    let store = app
        .store(crate::portable::store_path(SETTINGS_STORE_PATH))
        .expect("Failed to initialize store");

    // Persist API keys to the OS keychain; they never hit disk in plaintext.
    for (provider_id, key) in settings.post_process_api_keys.iter() {
        if !key.is_empty() {
            crate::keychain::set_api_key(provider_id, key);
        } else {
            // Empty key means the user cleared it — drop the keychain entry so
            // it stops being returned on the next hydrate.
            crate::keychain::delete_api_key(provider_id);
        }
    }

    store.set(
        "settings",
        serde_json::to_value(sanitize_for_storage(&settings)).unwrap(),
    );
}

pub fn get_bindings(app: &AppHandle) -> HashMap<String, ShortcutBinding> {
    let settings = get_settings(app);

    settings.bindings
}

pub fn get_stored_binding(app: &AppHandle, id: &str) -> ShortcutBinding {
    let bindings = get_bindings(app);

    let binding = bindings.get(id).unwrap().clone();

    binding
}

pub fn get_history_limit(app: &AppHandle) -> usize {
    let settings = get_settings(app);
    settings.history_limit
}

pub fn get_recording_retention_period(app: &AppHandle) -> RecordingRetentionPeriod {
    let settings = get_settings(app);
    settings.recording_retention_period
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_disable_auto_submit() {
        let settings = get_default_settings();
        assert!(!settings.auto_submit);
        assert_eq!(settings.auto_submit_key, AutoSubmitKey::Enter);
    }

    #[test]
    fn debug_output_redacts_api_keys() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("openai".to_string(), "sk-proj-secret-key-12345".to_string());
        settings.post_process_api_keys.insert(
            "anthropic".to_string(),
            "sk-ant-secret-key-67890".to_string(),
        );
        settings
            .post_process_api_keys
            .insert("empty_provider".to_string(), "".to_string());

        let debug_output = format!("{:?}", settings);

        assert!(!debug_output.contains("sk-proj-secret-key-12345"));
        assert!(!debug_output.contains("sk-ant-secret-key-67890"));
        assert!(debug_output.contains("[REDACTED]"));
    }

    #[test]
    fn secret_map_debug_redacts_values() {
        let map = SecretMap(HashMap::from([("key".into(), "secret".into())]));
        let out = format!("{:?}", map);
        assert!(!out.contains("secret"));
        assert!(out.contains("[REDACTED]"));
    }
}
