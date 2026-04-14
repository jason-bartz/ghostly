//! Built-in IDE / agent preset packs.
//!
//! Detects known IDEs and agent CLIs from the frontmost-app context and
//! supplies a tailored set of voice commands plus an auto-submit hint. Used
//! by the recording overlay (one-time hint chip) and by the paste flow to
//! decide whether to press Enter after a dictation.

use crate::frontmost::AppContext;
use crate::settings::VoiceCommand;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Single voice command exposed by a preset. Separate from `VoiceCommand`
/// because we want a user-readable `description` for the hint chip.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeCommand {
    /// Spoken phrase, lowercase. Additional synonyms live in `aliases`.
    pub phrase: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Keystroke in `voice_commands` format: "enter", "escape", "cmd+enter", ...
    pub keystroke: String,
    /// Short description for the one-time overlay hint.
    pub description: String,
}

/// Preset pack for one IDE / agent UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdePreset {
    pub id: String,
    pub name: String,
    /// When true, a normal dictation into this app is auto-submitted (paste + Enter).
    pub auto_submit: bool,
    pub commands: Vec<IdeCommand>,
}

impl IdePreset {
    /// Flatten to the generic `VoiceCommand` form used by the matcher.
    pub fn to_voice_commands(&self) -> Vec<VoiceCommand> {
        self.commands
            .iter()
            .map(|c| {
                let mut phrases = vec![c.phrase.clone()];
                phrases.extend(c.aliases.iter().cloned());
                VoiceCommand {
                    name: c.description.clone(),
                    phrases,
                    keystroke: c.keystroke.clone(),
                    enabled: true,
                }
            })
            .collect()
    }
}

fn cmd(phrase: &str, aliases: &[&str], keystroke: &str, description: &str) -> IdeCommand {
    IdeCommand {
        phrase: phrase.to_string(),
        aliases: aliases.iter().map(|s| s.to_string()).collect(),
        keystroke: keystroke.to_string(),
        description: description.to_string(),
    }
}

fn cursor_preset() -> IdePreset {
    IdePreset {
        id: "cursor".into(),
        name: "Cursor".into(),
        auto_submit: true,
        commands: vec![
            cmd("approve", &["accept", "yes"], "enter", "Accept suggestion"),
            cmd("reject", &["no", "cancel"], "escape", "Reject suggestion"),
            cmd("accept all", &["apply all"], "cmd+enter", "Apply all edits"),
            cmd("next", &[], "tab", "Next suggestion"),
            cmd("back", &["previous"], "shift+tab", "Previous suggestion"),
        ],
    }
}

fn claude_code_preset() -> IdePreset {
    IdePreset {
        id: "claude_code".into(),
        name: "Claude Code".into(),
        auto_submit: true,
        commands: vec![
            cmd(
                "approve",
                &["accept", "yes", "one"],
                "1",
                "Choose option 1 (yes)",
            ),
            cmd("reject", &["no", "two"], "2", "Choose option 2 (no)"),
            cmd("three", &[], "3", "Choose option 3"),
            cmd("cancel", &["stop"], "escape", "Cancel current prompt"),
            cmd("submit", &["send"], "enter", "Submit"),
        ],
    }
}

fn windsurf_preset() -> IdePreset {
    IdePreset {
        id: "windsurf".into(),
        name: "Windsurf".into(),
        auto_submit: true,
        commands: vec![
            cmd("approve", &["accept", "yes"], "enter", "Accept"),
            cmd("reject", &["no", "cancel"], "escape", "Reject"),
            cmd("accept all", &[], "cmd+enter", "Accept all"),
            cmd("next", &[], "tab", "Next"),
            cmd("back", &["previous"], "shift+tab", "Previous"),
        ],
    }
}

fn vscode_preset() -> IdePreset {
    IdePreset {
        id: "vscode".into(),
        name: "VS Code".into(),
        // Copilot Chat submits with Enter; general VS Code editing does not.
        // Leave auto_submit off so dictation into the editor doesn't insert newlines.
        auto_submit: false,
        commands: vec![
            cmd("approve", &["accept"], "tab", "Accept Copilot suggestion"),
            cmd("reject", &["dismiss"], "escape", "Dismiss suggestion"),
            cmd("send", &["submit"], "enter", "Send (Copilot Chat)"),
            cmd(
                "command palette",
                &[],
                "cmd+shift+p",
                "Open command palette",
            ),
        ],
    }
}

fn replit_preset() -> IdePreset {
    IdePreset {
        id: "replit".into(),
        name: "Replit".into(),
        auto_submit: true,
        commands: vec![
            cmd("approve", &["accept", "yes"], "enter", "Accept"),
            cmd("reject", &["no", "cancel"], "escape", "Reject"),
            cmd("run", &[], "cmd+enter", "Run project"),
        ],
    }
}

pub fn all_presets() -> Vec<IdePreset> {
    vec![
        cursor_preset(),
        claude_code_preset(),
        windsurf_preset(),
        vscode_preset(),
        replit_preset(),
    ]
}

/// Best-effort match from a frontmost-app context to a preset. Returns
/// `None` when the context is empty or doesn't look like one of our known
/// IDEs. Detection is deliberately lossy — false negatives are fine (the
/// user can still invoke voice commands manually), false positives are not.
pub fn detect(ctx: &AppContext) -> Option<IdePreset> {
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
        return Some(cursor_preset());
    }

    // Windsurf — Codeium/Exafunction.
    if bundle.contains("windsurf")
        || bundle.contains("exafunction")
        || proc == "windsurf"
        || exe.contains("/windsurf.app/")
    {
        return Some(windsurf_preset());
    }

    // Replit — desktop app or browser tab titled "Replit".
    if bundle.contains("replit") || title.contains("replit") {
        return Some(replit_preset());
    }

    // VS Code — official and OSS builds. Bundle id is the reliable signal;
    // `proc` is useless here because the main process is "Electron" and the
    // renderer is "Code Helper", neither of which uniquely identifies VS Code.
    if bundle.contains("com.microsoft.vscode")
        || bundle.contains("visualstudio.code")
        || bundle.contains("vscodium")
        || exe.contains("/visual studio code.app/")
        || exe.contains("/vscodium.app/")
    {
        return Some(vscode_preset());
    }

    // Claude Code — CLI that runs inside a terminal emulator. Match only
    // when the window title mentions claude, to avoid clobbering random
    // shell sessions.
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
        return Some(claude_code_preset());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(bundle: &str, proc: &str, title: &str) -> AppContext {
        AppContext {
            bundle_id: Some(bundle.into()),
            process_name: Some(proc.into()),
            window_class: None,
            exe_path: None,
            window_title: Some(title.into()),
        }
    }

    #[test]
    fn detects_cursor_by_bundle_id() {
        let p = detect(&ctx(
            "com.todesktop.230313mzl4w4u92",
            "Cursor",
            "repo — main.rs",
        ));
        assert_eq!(p.unwrap().id, "cursor");
    }

    #[test]
    fn detects_vscode() {
        let p = detect(&ctx("com.microsoft.VSCode", "Code", "file.ts"));
        assert_eq!(p.unwrap().id, "vscode");
    }

    #[test]
    fn detects_windsurf() {
        let p = detect(&ctx("com.exafunction.windsurf", "Windsurf", ""));
        assert_eq!(p.unwrap().id, "windsurf");
    }

    #[test]
    fn detects_replit_by_title() {
        let p = detect(&ctx(
            "com.google.Chrome",
            "Google Chrome",
            "Replit — my-repl",
        ));
        assert_eq!(p.unwrap().id, "replit");
    }

    #[test]
    fn detects_claude_code_in_terminal() {
        let p = detect(&ctx("com.apple.Terminal", "Terminal", "claude — ~/project"));
        assert_eq!(p.unwrap().id, "claude_code");
    }

    #[test]
    fn plain_terminal_is_not_claude_code() {
        assert!(detect(&ctx("com.apple.Terminal", "Terminal", "zsh")).is_none());
    }

    #[test]
    fn empty_context_returns_none() {
        assert!(detect(&AppContext::default()).is_none());
    }

    #[test]
    fn vs_code_preset_does_not_auto_submit() {
        assert!(!vscode_preset().auto_submit);
    }
}
