use crate::input::EnigoState;
use crate::settings::VoiceCommand;
use anyhow::{anyhow, Result};
use enigo::{Direction, Key, Keyboard};
use log::{debug, warn};
use tauri::{AppHandle, Manager};

/// Normalize transcription text for matching: lowercase, strip trailing
/// punctuation, collapse whitespace.
fn normalize(text: &str) -> String {
    let trimmed: String = text
        .trim()
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'))
        .to_lowercase();
    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Find a command whose phrase list contains the (normalized) transcription.
/// Matches are exact against normalized text; phrases are matched as whole
/// strings, not substrings, to avoid false positives on longer speech.
pub fn find_match<'a>(
    transcription: &str,
    commands: &'a [VoiceCommand],
) -> Option<&'a VoiceCommand> {
    let normalized = normalize(transcription);
    if normalized.is_empty() {
        return None;
    }
    commands
        .iter()
        .filter(|c| c.enabled)
        .find(|c| c.phrases.iter().any(|p| normalize(p) == normalized))
}

/// Map a keystroke token to an enigo Key. Handles named keys, function keys,
/// and single characters.
fn parse_key(token: &str) -> Result<Key> {
    let lower = token.to_lowercase();
    let key = match lower.as_str() {
        "enter" | "return" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" | "bksp" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" => Key::PageUp,
        "pagedown" | "page_down" => Key::PageDown,
        _ => {
            if let Some(stripped) = lower.strip_prefix('f') {
                if let Ok(n) = stripped.parse::<u32>() {
                    let fkey = match n {
                        1 => Key::F1,
                        2 => Key::F2,
                        3 => Key::F3,
                        4 => Key::F4,
                        5 => Key::F5,
                        6 => Key::F6,
                        7 => Key::F7,
                        8 => Key::F8,
                        9 => Key::F9,
                        10 => Key::F10,
                        11 => Key::F11,
                        12 => Key::F12,
                        _ => return Err(anyhow!("Unsupported F-key: F{}", n)),
                    };
                    return Ok(fkey);
                }
            }
            let chars: Vec<char> = lower.chars().collect();
            if chars.len() == 1 {
                Key::Unicode(chars[0])
            } else {
                return Err(anyhow!("Unknown keystroke token: '{}'", token));
            }
        }
    };
    Ok(key)
}

fn parse_modifier(token: &str) -> Option<Key> {
    match token.to_lowercase().as_str() {
        "ctrl" | "control" => Some(Key::Control),
        "shift" => Some(Key::Shift),
        "alt" | "option" | "opt" => Some(Key::Alt),
        "cmd" | "meta" | "super" | "win" => Some(Key::Meta),
        _ => None,
    }
}

/// Execute a keystroke string like "enter", "shift+tab", "cmd+s", "y".
/// Press modifiers in order, click the key, release modifiers in reverse.
pub fn execute_keystroke(app: &AppHandle, keystroke: &str) -> Result<()> {
    let state = app
        .try_state::<EnigoState>()
        .ok_or_else(|| anyhow!("EnigoState not managed"))?;
    let mut enigo = state
        .0
        .lock()
        .map_err(|e| anyhow!("Enigo mutex poisoned: {}", e))?;

    let tokens: Vec<&str> = keystroke
        .split('+')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err(anyhow!("Empty keystroke"));
    }

    let (main_token, modifier_tokens) = tokens.split_last().unwrap();
    let main_key = parse_key(main_token)?;
    let modifiers: Vec<Key> = modifier_tokens
        .iter()
        .map(|t| parse_modifier(t).ok_or_else(|| anyhow!("Unknown modifier: '{}'", t)))
        .collect::<Result<_>>()?;

    debug!(
        "Executing voice-command keystroke: {} (modifiers: {})",
        keystroke,
        modifiers.len()
    );

    for m in &modifiers {
        enigo
            .key(*m, Direction::Press)
            .map_err(|e| anyhow!("Failed to press modifier: {}", e))?;
    }
    let click_result = enigo.key(main_key, Direction::Click);
    for m in modifiers.iter().rev() {
        if let Err(e) = enigo.key(*m, Direction::Release) {
            warn!("Failed to release modifier on error path: {}", e);
        }
    }
    click_result.map_err(|e| anyhow!("Failed to send main key: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(phrases: &[&str], keystroke: &str) -> VoiceCommand {
        VoiceCommand {
            name: phrases[0].to_string(),
            phrases: phrases.iter().map(|s| s.to_string()).collect(),
            keystroke: keystroke.to_string(),
            enabled: true,
        }
    }

    #[test]
    fn matches_exact_phrase_lowercase() {
        let cmds = vec![cmd(&["approve", "accept"], "enter")];
        assert!(find_match("approve", &cmds).is_some());
        assert!(find_match("Approve.", &cmds).is_some());
        assert!(find_match("ACCEPT", &cmds).is_some());
    }

    #[test]
    fn does_not_match_substring() {
        let cmds = vec![cmd(&["no"], "escape")];
        assert!(find_match("nobody home", &cmds).is_none());
    }

    #[test]
    fn disabled_commands_skipped() {
        let mut c = cmd(&["yes"], "enter");
        c.enabled = false;
        assert!(find_match("yes", &[c]).is_none());
    }
}
