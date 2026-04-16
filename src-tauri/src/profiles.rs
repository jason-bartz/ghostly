use crate::frontmost::AppContext;
use crate::settings::AppSettings;
use serde::{Deserialize, Serialize};
use specta::Type;

// ─────────────────────────────────────────────────────────────────────────────
// Style system (new) — see also `category_apps()` and `build_style_prompt()`.
//
// The user picks a Style (Formal / Casual / Excited / Custom) per Category
// (Personal messages / Work messages / Email / Other). The resolver matches
// the frontmost app to a Category, then applies that category's style.
// Auto-cleanup is an orthogonal global knob.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CategoryId {
    PersonalMessages,
    WorkMessages,
    Email,
    Coding,
    Other,
}

impl CategoryId {
    pub fn all() -> [CategoryId; 5] {
        [
            CategoryId::PersonalMessages,
            CategoryId::WorkMessages,
            CategoryId::Email,
            CategoryId::Coding,
            CategoryId::Other,
        ]
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StyleId {
    Formal,
    Casual,
    Excited,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoCleanupLevel {
    None,
    Light,
    Medium,
    High,
}

impl Default for AutoCleanupLevel {
    fn default() -> Self {
        AutoCleanupLevel::Light
    }
}

/// Per-category user configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CategoryStyle {
    pub category_id: CategoryId,
    #[serde(default = "default_style_id")]
    pub selected_style: StyleId,
    /// Category-level vocabulary merged at transcribe time when this category
    /// matches. Separate from the global Dictionary.
    #[serde(default)]
    pub custom_vocab: Vec<String>,
    /// When `selected_style == Custom`, the user-authored prompt that replaces
    /// the style body. `None` otherwise.
    #[serde(default)]
    pub custom_style_prompt: Option<String>,
    #[serde(default)]
    pub custom_style_name: Option<String>,
}

fn default_style_id() -> StyleId {
    StyleId::Casual
}

/// Bundle IDs (macOS) that belong to each category. Used by the resolver to
/// pick a category when no custom rule matches.
pub fn category_apps(category: CategoryId) -> &'static [&'static str] {
    match category {
        CategoryId::PersonalMessages => &[
            "com.apple.MobileSMS",
            "net.whatsapp.WhatsApp",
            "ru.keepcoder.Telegram",
            "com.hnc.Discord",
            "com.burbn.instagram",
            "com.facebook.Messenger",
            "com.apple.FaceTime",
        ],
        CategoryId::WorkMessages => &[
            "com.tinyspeck.slackmacgap",
            "com.microsoft.teams2",
            "com.microsoft.teams",
            "com.linkedin.LinkedIn",
            "zoom.us",
            "us.zoom.xos",
        ],
        CategoryId::Email => &[
            "com.apple.mail",
            "com.google.Chrome",
            "com.microsoft.Outlook",
            "com.readdle.smartemail-Mac",
            "com.superhuman.electron",
            "com.superhuman.Superhuman",
        ],
        CategoryId::Coding => &[
            // Cursor — distributed via todesktop.
            "com.todesktop.230313mzl4w4u92",
            // Windsurf (Codeium / Exafunction).
            "com.exafunction.windsurf",
            // VS Code + OSS builds.
            "com.microsoft.VSCode",
            "com.microsoft.VSCodeInsiders",
            "com.vscodium",
            "com.visualstudio.code.oss",
            // Other first-class dev apps.
            "dev.zed.Zed",
            "com.apple.dt.Xcode",
            "com.replit.macos",
            // Terminal emulators — Claude Code and other CLIs run here.
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "net.kovidgoyal.kitty",
            "com.github.wez.wezterm",
            "org.alacritty",
            "com.mitchellh.ghostty",
            "dev.warp.Warp-Stable",
            "co.zeit.hyper",
        ],
        CategoryId::Other => &[],
    }
}

/// Category-scoped window-title substrings. Used when the bundle ID alone
/// can't disambiguate (browser tabs for Gmail / LinkedIn / Messenger).
pub fn category_title_hints(category: CategoryId) -> &'static [&'static str] {
    match category {
        CategoryId::Email => &["gmail", "outlook", "superhuman"],
        CategoryId::WorkMessages => &["linkedin"],
        CategoryId::PersonalMessages => &["messenger"],
        // Replit has a native app but most users use the web version.
        CategoryId::Coding => &["replit"],
        CategoryId::Other => &[],
    }
}

pub fn default_category_styles() -> Vec<CategoryStyle> {
    vec![
        CategoryStyle {
            category_id: CategoryId::PersonalMessages,
            selected_style: StyleId::Casual,
            custom_vocab: vec![],
            custom_style_prompt: None,
            custom_style_name: None,
        },
        CategoryStyle {
            category_id: CategoryId::WorkMessages,
            selected_style: StyleId::Casual,
            custom_vocab: vec![],
            custom_style_prompt: None,
            custom_style_name: None,
        },
        CategoryStyle {
            category_id: CategoryId::Email,
            selected_style: StyleId::Formal,
            custom_vocab: vec![],
            custom_style_prompt: None,
            custom_style_name: None,
        },
        CategoryStyle {
            category_id: CategoryId::Coding,
            selected_style: StyleId::Casual,
            custom_vocab: vec![],
            custom_style_prompt: None,
            custom_style_name: None,
        },
        CategoryStyle {
            category_id: CategoryId::Other,
            selected_style: StyleId::Casual,
            custom_vocab: vec![],
            custom_style_prompt: None,
            custom_style_name: None,
        },
    ]
}

/// Pick a Category for the given frontmost-app context. Falls back to `Other`
/// so the user always has a style applied.
pub fn match_category(ctx: &AppContext) -> CategoryId {
    let bundle = ctx.bundle_id.as_deref().unwrap_or("").to_ascii_lowercase();
    let title = ctx
        .window_title
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();

    for cat in CategoryId::all() {
        if cat == CategoryId::Other {
            continue;
        }
        for b in category_apps(cat) {
            if bundle == b.to_ascii_lowercase() {
                return cat;
            }
        }
        for hint in category_title_hints(cat) {
            if title.contains(hint) {
                return cat;
            }
        }
    }
    CategoryId::Other
}

pub fn category_style_for<'a>(
    settings: &'a AppSettings,
    category: CategoryId,
) -> Option<&'a CategoryStyle> {
    settings
        .category_styles
        .iter()
        .find(|cs| cs.category_id == category)
}

/// Build the post-process prompt for a given (cleanup, style, category)
/// combination. Returns a full system prompt ending with a `Transcript:`
/// placeholder that the post-process pipeline fills in.
pub fn build_style_prompt(cleanup: AutoCleanupLevel, style: &CategoryStyle) -> String {
    // If the user chose Custom and supplied a prompt, honor it as-is. The
    // cleanup level still applies as a preamble so Auto Cleanup remains a
    // global knob even for custom styles.
    if style.selected_style == StyleId::Custom {
        if let Some(p) = style.custom_style_prompt.as_ref() {
            let body = p.trim();
            if !body.is_empty() {
                let cleanup_prefix = cleanup_preamble(cleanup);
                return format!(
                    "{}{}\n\nReturn only the cleaned text.\n\nTranscript:\n${{output}}",
                    cleanup_prefix, body
                );
            }
        }
    }

    let cleanup_prefix = cleanup_preamble(cleanup);
    let style_body = style_body(style.selected_style);
    format!(
        "{}{}\n\nReturn only the cleaned text.\n\nTranscript:\n${{output}}",
        cleanup_prefix, style_body
    )
}

fn cleanup_preamble(level: AutoCleanupLevel) -> String {
    match level {
        AutoCleanupLevel::None => String::new(),
        AutoCleanupLevel::Light => "Cleanup level — Light. Fix obvious spelling, capitalization, and punctuation. Remove filler words (um, uh). Preserve wording exactly otherwise.\n\n".into(),
        AutoCleanupLevel::Medium => "Cleanup level — Medium. Fix spelling, capitalization, punctuation, and grammar. Remove filler words and false starts. Make sentences more concise without changing meaning.\n\n".into(),
        AutoCleanupLevel::High => "Cleanup level — High. Rewrite the transcript for brevity and polish while keeping the speaker's meaning exactly. Remove redundancy, tighten phrasing, and produce clean prose. Never add information the speaker didn't say.\n\n".into(),
    }
}

fn style_body(style: StyleId) -> &'static str {
    match style {
        StyleId::Formal => {
            "Style — Formal. Use complete sentences, proper capitalization, and standard punctuation. Choose professional vocabulary. Remove slang. Avoid contractions unless they feel natural. Preserve the speaker's intent exactly."
        }
        StyleId::Casual => {
            "Style — Casual. Keep the tone conversational and natural. Contractions are fine. Keep punctuation light and readable. Don't over-formalize. Preserve the speaker's voice."
        }
        StyleId::Excited => {
            "Style — Excited. Keep the tone upbeat and energetic. Use exclamation points where the speaker sounds enthusiastic. Short, punchy sentences. Do not invent excitement the speaker didn't convey."
        }
        StyleId::Custom => {
            "Clean the transcript. Fix spelling, punctuation, and capitalization. Remove filler words."
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum MatchRule {
    /// macOS bundle identifier, e.g. `com.tinyspeck.slackmacgap`.
    /// active-win-pos-rs exposes this in `app_name` on macOS.
    BundleId(String),
    /// Executable file name, e.g. `Code.exe`, `slack`.
    ProcessName(String),
    /// X11 WM_CLASS (Linux only).
    WindowClass(String),
    /// Substring match against the full executable path.
    ExePathContains(String),
    /// Case-insensitive substring against the window title.
    /// Useful for browser-tab-aware profiles ("Gmail", "GitHub").
    WindowTitleContains(String),
}

impl MatchRule {
    pub fn matches(&self, ctx: &AppContext) -> bool {
        match self {
            MatchRule::BundleId(s) => ctx.bundle_id.as_deref() == Some(s.as_str()),
            MatchRule::ProcessName(s) => ctx
                .process_name
                .as_deref()
                .map(|p| p.eq_ignore_ascii_case(s))
                .unwrap_or(false),
            MatchRule::WindowClass(s) => ctx.window_class.as_deref() == Some(s.as_str()),
            MatchRule::ExePathContains(s) => ctx
                .exe_path
                .as_deref()
                .map(|p| p.to_ascii_lowercase().contains(&s.to_ascii_lowercase()))
                .unwrap_or(false),
            MatchRule::WindowTitleContains(s) => ctx
                .window_title
                .as_deref()
                .map(|t| t.to_ascii_lowercase().contains(&s.to_ascii_lowercase()))
                .unwrap_or(false),
        }
    }
}

/// Spoken phrase → keystroke binding, scoped to an individual `Profile`.
/// Folds the former `IdeCommand` into the profile system so IDE-style voice
/// automation and app-specific style overrides share one data model.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct KeystrokeCommand {
    /// Spoken phrase, lowercase. Additional synonyms live in `aliases`.
    pub phrase: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Keystroke in `voice_commands` format: "enter", "escape", "cmd+enter", ...
    pub keystroke: String,
    /// Short description shown on the overlay hint chip.
    pub description: String,
}

/// Flatten a profile's keystroke commands to the generic `VoiceCommand` form
/// used by the voice-command matcher. The description becomes the command
/// name (what the user sees when matching); aliases become additional phrases.
pub fn keystroke_commands_to_voice_commands(
    commands: &[KeystrokeCommand],
) -> Vec<crate::settings::VoiceCommand> {
    commands
        .iter()
        .map(|c| {
            let mut phrases = vec![c.phrase.clone()];
            phrases.extend(c.aliases.iter().cloned());
            crate::settings::VoiceCommand {
                name: c.description.clone(),
                phrases,
                keystroke: c.keystroke.clone(),
                enabled: true,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// OR'd — any matching rule activates the profile.
    #[serde(default)]
    pub match_rules: Vec<MatchRule>,

    /// Override the selected post-process prompt (by prompt id). `None` = inherit.
    #[serde(default)]
    pub prompt_id: Option<String>,

    /// Tri-state override for post-process enable. `None` = inherit.
    #[serde(default)]
    pub post_process_override: Option<bool>,

    /// Profile-specific vocabulary. Merged with global `custom_words` at transcribe time.
    #[serde(default)]
    pub custom_vocab: Vec<String>,

    /// Override trailing-space setting. `None` = inherit.
    #[serde(default)]
    pub append_trailing_space: Option<bool>,

    /// Override post-process provider id (e.g. switch to Apple Intelligence for Slack).
    /// `None` = inherit.
    #[serde(default)]
    pub provider_override: Option<String>,

    /// Voice phrase → keystroke bindings merged into the global command pool
    /// when this profile is active. Empty for apps that don't need app-local
    /// automation.
    #[serde(default)]
    pub keystroke_commands: Vec<KeystrokeCommand>,

    /// When `Some(true)`, a normal dictation into the matching app is
    /// auto-submitted (paste + Enter). When `Some(false)`, auto-submit is
    /// explicitly suppressed for the app (e.g. VS Code editor).
    /// `None` = inherit global auto-submit behavior.
    #[serde(default)]
    pub auto_submit: Option<bool>,

    /// When true, image paste requires Shift+Cmd+V instead of Cmd+V.
    /// VS Code needs this to attach images to Copilot Chat.
    #[serde(default)]
    pub image_paste_uses_shift: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedOverrides {
    pub prompt_id: Option<String>,
    pub post_process_enabled: Option<bool>,
    pub extra_vocab: Vec<String>,
    pub append_trailing_space: Option<bool>,
    pub provider_id: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    /// Full prompt assembled from the style system (preempts `prompt_id`
    /// lookup when set). This is how the new Style page plumbs its
    /// cleanup+style combination into the existing post-process pipeline.
    pub composed_prompt: Option<String>,
    pub category_id: Option<CategoryId>,
    // Note: keystroke_commands, auto_submit, and image_paste_uses_shift are
    // read directly off `Profile` via `match_builtin_profile()` by their
    // consumers (clipboard.rs, actions.rs). Kept off ResolvedOverrides to
    // avoid dead fields — the keystroke and style paths are distinct.
}

impl ResolvedOverrides {
    pub fn from_profile(p: &Profile) -> Self {
        Self {
            prompt_id: p.prompt_id.clone(),
            post_process_enabled: p.post_process_override,
            extra_vocab: p.custom_vocab.clone(),
            append_trailing_space: p.append_trailing_space,
            provider_id: p.provider_override.clone(),
            profile_id: Some(p.id.clone()),
            profile_name: Some(p.name.clone()),
            composed_prompt: None,
            category_id: None,
        }
    }
}

pub fn resolve<'a>(settings: &'a AppSettings, ctx: Option<&AppContext>) -> Option<&'a Profile> {
    // Advanced rules are gated by the Style system's master switch. The
    // legacy `profiles_enabled` flag is preserved on disk but no longer
    // load-bearing — `style_enabled` now covers both categories and rules.
    if !settings.style_enabled {
        return None;
    }
    let ctx = ctx?;
    if ctx.is_empty() {
        return None;
    }
    settings
        .profiles
        .iter()
        .filter(|p| p.enabled && !p.match_rules.is_empty())
        .find(|p| p.match_rules.iter().any(|r| r.matches(ctx)))
}

fn kcmd(phrase: &str, aliases: &[&str], keystroke: &str, description: &str) -> KeystrokeCommand {
    KeystrokeCommand {
        phrase: phrase.to_string(),
        aliases: aliases.iter().map(|s| s.to_string()).collect(),
        keystroke: keystroke.to_string(),
        description: description.to_string(),
    }
}

fn cursor_profile() -> Profile {
    Profile {
        id: "builtin_cursor".to_string(),
        name: "Cursor".to_string(),
        enabled: true,
        match_rules: vec![
            MatchRule::BundleId("com.todesktop.230313mzl4w4u92".to_string()),
            MatchRule::ProcessName("Cursor".to_string()),
            MatchRule::ExePathContains("/Cursor.app/".to_string()),
        ],
        prompt_id: Some("builtin_developer".to_string()),
        post_process_override: Some(true),
        custom_vocab: vec![],
        append_trailing_space: None,
        provider_override: None,
        keystroke_commands: vec![
            kcmd("approve", &["accept", "yes"], "enter", "Accept suggestion"),
            kcmd("reject", &["no", "cancel"], "escape", "Reject suggestion"),
            kcmd("accept all", &["apply all"], "cmd+enter", "Apply all edits"),
            kcmd("next", &[], "tab", "Next suggestion"),
            kcmd("back", &["previous"], "shift+tab", "Previous suggestion"),
        ],
        auto_submit: Some(true),
        image_paste_uses_shift: false,
    }
}

fn claude_code_profile() -> Profile {
    Profile {
        id: "builtin_claude_code".to_string(),
        name: "Claude Code".to_string(),
        enabled: true,
        // Match rules shown for UI context. Actual resolution uses
        // `match_builtin_profile` which ANDs the terminal check with a
        // title-contains-claude check — MatchRule can't express that
        // directly without a composite variant.
        match_rules: vec![
            MatchRule::BundleId("com.apple.Terminal".to_string()),
            MatchRule::BundleId("com.googlecode.iterm2".to_string()),
            MatchRule::BundleId("net.kovidgoyal.kitty".to_string()),
            MatchRule::BundleId("com.github.wez.wezterm".to_string()),
            MatchRule::BundleId("org.alacritty".to_string()),
            MatchRule::BundleId("com.mitchellh.ghostty".to_string()),
            MatchRule::BundleId("dev.warp.Warp-Stable".to_string()),
            MatchRule::BundleId("co.zeit.hyper".to_string()),
            MatchRule::WindowTitleContains("claude".to_string()),
        ],
        prompt_id: Some("builtin_developer".to_string()),
        post_process_override: Some(true),
        custom_vocab: vec![],
        append_trailing_space: None,
        provider_override: None,
        keystroke_commands: vec![
            kcmd(
                "approve",
                &["accept", "yes", "one"],
                "1",
                "Choose option 1 (yes)",
            ),
            kcmd("reject", &["no", "two"], "2", "Choose option 2 (no)"),
            kcmd("three", &[], "3", "Choose option 3"),
            kcmd("cancel", &["stop"], "escape", "Cancel current prompt"),
            kcmd("submit", &["send"], "enter", "Submit"),
        ],
        auto_submit: Some(true),
        image_paste_uses_shift: false,
    }
}

fn windsurf_profile() -> Profile {
    Profile {
        id: "builtin_windsurf".to_string(),
        name: "Windsurf".to_string(),
        enabled: true,
        match_rules: vec![
            MatchRule::BundleId("com.exafunction.windsurf".to_string()),
            MatchRule::ProcessName("Windsurf".to_string()),
            MatchRule::ExePathContains("/Windsurf.app/".to_string()),
        ],
        prompt_id: Some("builtin_developer".to_string()),
        post_process_override: Some(true),
        custom_vocab: vec![],
        append_trailing_space: None,
        provider_override: None,
        keystroke_commands: vec![
            kcmd("approve", &["accept", "yes"], "enter", "Accept"),
            kcmd("reject", &["no", "cancel"], "escape", "Reject"),
            kcmd("accept all", &[], "cmd+enter", "Accept all"),
            kcmd("next", &[], "tab", "Next"),
            kcmd("back", &["previous"], "shift+tab", "Previous"),
        ],
        auto_submit: Some(true),
        image_paste_uses_shift: false,
    }
}

fn vscode_profile() -> Profile {
    Profile {
        id: "builtin_vscode".to_string(),
        name: "VS Code".to_string(),
        enabled: true,
        match_rules: vec![
            MatchRule::BundleId("com.microsoft.VSCode".to_string()),
            MatchRule::BundleId("com.microsoft.VSCodeInsiders".to_string()),
            MatchRule::BundleId("com.vscodium".to_string()),
            MatchRule::BundleId("com.visualstudio.code.oss".to_string()),
            MatchRule::ExePathContains("/Visual Studio Code.app/".to_string()),
            MatchRule::ExePathContains("/VSCodium.app/".to_string()),
        ],
        prompt_id: Some("builtin_developer".to_string()),
        post_process_override: Some(true),
        custom_vocab: vec![],
        append_trailing_space: None,
        provider_override: None,
        keystroke_commands: vec![
            kcmd("approve", &["accept"], "tab", "Accept Copilot suggestion"),
            kcmd("reject", &["dismiss"], "escape", "Dismiss suggestion"),
            kcmd("send", &["submit"], "enter", "Send (Copilot Chat)"),
            kcmd(
                "command palette",
                &[],
                "cmd+shift+p",
                "Open command palette",
            ),
        ],
        // `None` = inherit global auto-submit. The old IdePreset used
        // `auto_submit: false` with the same meaning: don't force-override
        // when the user's global setting is off, since dictation into the
        // editor shouldn't insert newlines. Copilot Chat auto-submits when
        // the user opts in globally.
        auto_submit: None,
        // Copilot Chat requires Shift+Cmd+V for image paste.
        image_paste_uses_shift: true,
    }
}

fn replit_profile() -> Profile {
    Profile {
        id: "builtin_replit".to_string(),
        name: "Replit".to_string(),
        enabled: true,
        match_rules: vec![
            MatchRule::BundleId("com.replit.macos".to_string()),
            MatchRule::WindowTitleContains("Replit".to_string()),
        ],
        prompt_id: Some("builtin_developer".to_string()),
        post_process_override: Some(true),
        custom_vocab: vec![],
        append_trailing_space: None,
        provider_override: None,
        keystroke_commands: vec![
            kcmd("approve", &["accept", "yes"], "enter", "Accept"),
            kcmd("reject", &["no", "cancel"], "escape", "Reject"),
            kcmd("run", &[], "cmd+enter", "Run project"),
        ],
        auto_submit: Some(true),
        image_paste_uses_shift: false,
    }
}

/// Built-in IDE / agent profiles — folded in from the former `ide_presets` module.
/// Each profile carries its own keystroke bindings, auto-submit hint, and
/// image-paste quirk so app-specific automation flows through the same
/// Profile data model as user-authored rules.
///
/// IDs use the `builtin_*` prefix so the frontend icon lookup
/// (`getAppInfoByProfileId`) resolves them to known app icons.
pub fn get_builtin_profiles() -> Vec<Profile> {
    vec![
        cursor_profile(),
        claude_code_profile(),
        windsurf_profile(),
        vscode_profile(),
        replit_profile(),
    ]
}

/// Match the frontmost app context against the built-in IDE/agent profiles.
/// Kept separate from `resolve()` (which scans user-authored profiles) because
/// Claude Code needs a composite "terminal + title contains 'claude'" check
/// that `MatchRule` can't express without introducing a nested variant.
///
/// Mirrors the old `ide_presets::detect` heuristics exactly so the Phase 4
/// consumer switchover is behavior-preserving.
pub fn match_builtin_profile(ctx: &AppContext) -> Option<Profile> {
    let bundle = ctx.bundle_id.as_deref().unwrap_or("").to_lowercase();
    let proc = ctx.process_name.as_deref().unwrap_or("").to_lowercase();
    let title = ctx.window_title.as_deref().unwrap_or("").to_lowercase();
    let exe = ctx.exe_path.as_deref().unwrap_or("").to_lowercase();

    // Cursor — distributed via todesktop; app name is "Cursor".
    if bundle.contains("cursor")
        || proc == "cursor"
        || bundle.contains("todesktop.230313mzl4w4u92")
        || exe.contains("/cursor.app/")
    {
        return Some(cursor_profile());
    }

    // Windsurf — Codeium/Exafunction.
    if bundle.contains("windsurf")
        || bundle.contains("exafunction")
        || proc == "windsurf"
        || exe.contains("/windsurf.app/")
    {
        return Some(windsurf_profile());
    }

    // Replit — desktop app or browser tab titled "Replit".
    if bundle.contains("replit") || title.contains("replit") {
        return Some(replit_profile());
    }

    // VS Code — official and OSS builds. Bundle id is the reliable signal;
    // `proc` is useless here because the main process is "Electron".
    if bundle.contains("com.microsoft.vscode")
        || bundle.contains("visualstudio.code")
        || bundle.contains("vscodium")
        || exe.contains("/visual studio code.app/")
        || exe.contains("/vscodium.app/")
    {
        return Some(vscode_profile());
    }

    // Claude Code — CLI inside a terminal emulator. Gate on both the
    // terminal bundle AND the window title to avoid clobbering other shell
    // sessions or Claude.app windows.
    let is_terminal = bundle.contains("apple.terminal")
        || bundle.contains("iterm")
        || bundle.contains("alacritty")
        || bundle.contains("warp")
        || bundle.contains("ghostty")
        || bundle.contains("kitty")
        || bundle.contains("wezterm")
        || bundle.contains("hyper")
        || proc.contains("terminal")
        || proc == "iterm2";
    if is_terminal && (title.contains("claude") || title.contains("claude code")) {
        return Some(claude_code_profile());
    }

    None
}

/// Resolve overrides: advanced custom rules first, then category-based style,
/// and finally a sensible default. The style system is always on — `Other`
/// acts as the catch-all when no specific category matches.
pub fn resolve_with_builtins(
    settings: &AppSettings,
    ctx: Option<&AppContext>,
) -> ResolvedOverrides {
    // 1. Advanced custom rules (the "Advanced" section in the Style settings)
    //    take priority over categories — this is the power-user escape hatch.
    if let Some(profile) = resolve(settings, ctx) {
        return ResolvedOverrides::from_profile(profile);
    }

    // 2. Category-based resolution. The Style system is always considered
    //    when `style_enabled` is on — the `Other` category catches apps that
    //    don't match a specific category so the user always gets their
    //    configured cleanup + default style.
    if settings.style_enabled {
        let category = ctx.map(match_category).unwrap_or(CategoryId::Other);
        let style = category_style_for(settings, category);

        let mut out = ResolvedOverrides::default();
        out.category_id = Some(category);

        if let Some(style) = style {
            out.extra_vocab = style.custom_vocab.clone();
            out.composed_prompt = Some(build_style_prompt(settings.auto_cleanup_level, style));
            // Post-process must be on for the style prompt to apply. If the
            // user has globally disabled post-processing we leave this at
            // None so the global setting wins.
            out.post_process_enabled = Some(true);
            out.profile_name = Some(category_display_name(category).into());
        } else if settings.auto_cleanup_level != AutoCleanupLevel::None {
            // No category style configured but cleanup is on — synthesize a
            // minimal style so Auto Cleanup still applies.
            let fallback = CategoryStyle {
                category_id: category,
                selected_style: StyleId::Casual,
                custom_vocab: vec![],
                custom_style_prompt: None,
                custom_style_name: None,
            };
            out.composed_prompt = Some(build_style_prompt(settings.auto_cleanup_level, &fallback));
            out.post_process_enabled = Some(true);
        }
        return out;
    }

    ResolvedOverrides::default()
}

fn category_display_name(cat: CategoryId) -> &'static str {
    match cat {
        CategoryId::PersonalMessages => "Personal messages",
        CategoryId::WorkMessages => "Work messages",
        CategoryId::Email => "Email",
        CategoryId::Coding => "Coding",
        CategoryId::Other => "Other",
    }
}

/// Words tagged for the active category in the user's Dictionary.
/// An empty `categories` list on a word means "applies everywhere" (global).
fn dictionary_words_for_category(settings: &AppSettings, category: CategoryId) -> Vec<String> {
    settings
        .custom_words
        .iter()
        .filter(
            |w| match settings.custom_word_categories.get(&w.to_ascii_lowercase()) {
                None => true,
                Some(tags) if tags.is_empty() => true,
                Some(tags) => tags.contains(&category),
            },
        )
        .cloned()
        .collect()
}

pub fn merged_custom_words(settings: &AppSettings, overrides: &ResolvedOverrides) -> Vec<String> {
    // Base list: global dictionary words that apply to the active category
    // (or all words when no category is resolved).
    let base = match overrides.category_id {
        Some(cat) => dictionary_words_for_category(settings, cat),
        None => settings.custom_words.clone(),
    };

    if overrides.extra_vocab.is_empty() {
        return base;
    }
    let mut seen: std::collections::HashSet<String> =
        base.iter().map(|w| w.to_ascii_lowercase()).collect();
    let mut out = base;
    for w in &overrides.extra_vocab {
        let key = w.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(w.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(bundle: &str, proc: &str) -> AppContext {
        AppContext {
            bundle_id: Some(bundle.into()),
            process_name: Some(proc.into()),
            window_class: None,
            exe_path: None,
            window_title: None,
        }
    }

    #[test]
    fn bundle_id_exact_match() {
        let r = MatchRule::BundleId("com.tinyspeck.slackmacgap".into());
        assert!(r.matches(&ctx("com.tinyspeck.slackmacgap", "Slack")));
        assert!(!r.matches(&ctx("com.apple.Safari", "Safari")));
    }

    #[test]
    fn process_name_is_case_insensitive() {
        let r = MatchRule::ProcessName("code.exe".into());
        assert!(r.matches(&ctx("", "Code.exe")));
    }

    #[test]
    fn exe_path_substring_case_insensitive() {
        let mut c = ctx("", "");
        c.exe_path = Some("/Applications/Visual Studio Code.app/Contents/MacOS/Electron".into());
        assert!(MatchRule::ExePathContains("visual studio code".into()).matches(&c));
    }

    #[test]
    fn window_title_contains() {
        let mut c = ctx("com.google.Chrome", "Chrome");
        c.window_title = Some("Inbox (23) - Gmail — Google Chrome".into());
        assert!(MatchRule::WindowTitleContains("gmail".into()).matches(&c));
    }
}
