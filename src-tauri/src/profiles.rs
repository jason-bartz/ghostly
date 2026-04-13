use crate::frontmost::AppContext;
use crate::settings::AppSettings;
use serde::{Deserialize, Serialize};
use specta::Type;

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
        }
    }
}

pub fn resolve<'a>(settings: &'a AppSettings, ctx: Option<&AppContext>) -> Option<&'a Profile> {
    if !settings.profiles_enabled {
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

/// Returns built-in profiles for common app categories.
/// These ship with the app and auto-activate when `builtin_profiles_enabled` is true.
pub fn get_builtin_profiles() -> Vec<Profile> {
    vec![
        // ── Developer tools ────────────────────────────────────────────────
        Profile {
            id: "builtin_vscode".to_string(),
            name: "VS Code".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.microsoft.VSCode".to_string()),
                MatchRule::BundleId("com.microsoft.VSCodeInsiders".to_string()),
                MatchRule::ProcessName("Code".to_string()),
                MatchRule::ProcessName("Code.exe".to_string()),
            ],
            prompt_id: Some("builtin_developer".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_cursor".to_string(),
            name: "Cursor".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.todesktop.230313mzl4w4u92".to_string()),
                MatchRule::ProcessName("Cursor".to_string()),
                MatchRule::ProcessName("Cursor.exe".to_string()),
            ],
            prompt_id: Some("builtin_developer".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_zed".to_string(),
            name: "Zed".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("dev.zed.Zed".to_string()),
                MatchRule::ProcessName("zed".to_string()),
            ],
            prompt_id: Some("builtin_developer".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_xcode".to_string(),
            name: "Xcode".to_string(),
            enabled: true,
            match_rules: vec![MatchRule::BundleId("com.apple.dt.Xcode".to_string())],
            prompt_id: Some("builtin_developer".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_terminal".to_string(),
            name: "Terminal".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.apple.Terminal".to_string()),
                MatchRule::BundleId("com.googlecode.iterm2".to_string()),
                MatchRule::BundleId("com.github.wez.wezterm".to_string()),
                MatchRule::ProcessName("Terminal".to_string()),
                MatchRule::ProcessName("iTerm2".to_string()),
                MatchRule::ProcessName("wezterm".to_string()),
                MatchRule::ProcessName("alacritty".to_string()),
                MatchRule::ProcessName("kitty".to_string()),
                MatchRule::ProcessName("WindowsTerminal.exe".to_string()),
                MatchRule::ProcessName("cmd.exe".to_string()),
            ],
            prompt_id: Some("builtin_developer".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        // ── Casual messaging ───────────────────────────────────────────────
        Profile {
            id: "builtin_slack".to_string(),
            name: "Slack".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.tinyspeck.slackmacgap".to_string()),
                MatchRule::ProcessName("slack".to_string()),
                MatchRule::ProcessName("Slack.exe".to_string()),
            ],
            prompt_id: Some("builtin_casual".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_discord".to_string(),
            name: "Discord".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.hnc.Discord".to_string()),
                MatchRule::ProcessName("Discord".to_string()),
                MatchRule::ProcessName("Discord.exe".to_string()),
            ],
            prompt_id: Some("builtin_casual".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_imessage".to_string(),
            name: "Messages".to_string(),
            enabled: true,
            match_rules: vec![MatchRule::BundleId("com.apple.MobileSMS".to_string())],
            prompt_id: Some("builtin_casual".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_whatsapp".to_string(),
            name: "WhatsApp".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("net.whatsapp.WhatsApp".to_string()),
                MatchRule::ProcessName("WhatsApp".to_string()),
            ],
            prompt_id: Some("builtin_casual".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        // ── Email ──────────────────────────────────────────────────────────
        Profile {
            id: "builtin_gmail".to_string(),
            name: "Gmail".to_string(),
            enabled: true,
            match_rules: vec![MatchRule::WindowTitleContains("Gmail".to_string())],
            prompt_id: Some("builtin_email".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_apple_mail".to_string(),
            name: "Apple Mail".to_string(),
            enabled: true,
            match_rules: vec![MatchRule::BundleId("com.apple.mail".to_string())],
            prompt_id: Some("builtin_email".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_outlook".to_string(),
            name: "Outlook".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.microsoft.Outlook".to_string()),
                MatchRule::ProcessName("Outlook".to_string()),
                MatchRule::ProcessName("OUTLOOK.EXE".to_string()),
            ],
            prompt_id: Some("builtin_email".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        // ── Structured writing / notes ─────────────────────────────────────
        Profile {
            id: "builtin_notion".to_string(),
            name: "Notion".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("notion.id".to_string()),
                MatchRule::ProcessName("Notion".to_string()),
                MatchRule::WindowTitleContains("Notion".to_string()),
            ],
            prompt_id: Some("builtin_structured".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_obsidian".to_string(),
            name: "Obsidian".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("md.obsidian".to_string()),
                MatchRule::ProcessName("Obsidian".to_string()),
            ],
            prompt_id: Some("builtin_structured".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
        Profile {
            id: "builtin_linear".to_string(),
            name: "Linear".to_string(),
            enabled: true,
            match_rules: vec![
                MatchRule::BundleId("com.linear".to_string()),
                MatchRule::WindowTitleContains("Linear".to_string()),
            ],
            prompt_id: Some("builtin_structured".to_string()),
            post_process_override: Some(true),
            custom_vocab: vec![],
            append_trailing_space: None,
            provider_override: None,
        },
    ]
}

/// Resolve overrides, checking user profiles first, then built-in profiles.
/// User profiles always take priority over built-in profiles.
pub fn resolve_with_builtins(
    settings: &AppSettings,
    ctx: Option<&AppContext>,
) -> ResolvedOverrides {
    // 1. User profiles take priority
    if let Some(profile) = resolve(settings, ctx) {
        return ResolvedOverrides::from_profile(profile);
    }

    // 2. Fall back to built-in profiles if enabled
    if settings.builtin_profiles_enabled {
        if let Some(ctx) = ctx {
            if !ctx.is_empty() {
                for bp in get_builtin_profiles() {
                    if bp.enabled && bp.match_rules.iter().any(|r| r.matches(ctx)) {
                        return ResolvedOverrides::from_profile(&bp);
                    }
                }
            }
        }
    }

    ResolvedOverrides::default()
}

pub fn merged_custom_words(settings: &AppSettings, overrides: &ResolvedOverrides) -> Vec<String> {
    if overrides.extra_vocab.is_empty() {
        return settings.custom_words.clone();
    }
    let mut seen: std::collections::HashSet<String> = settings
        .custom_words
        .iter()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let mut out = settings.custom_words.clone();
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
