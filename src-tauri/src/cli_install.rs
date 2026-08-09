//! Installs the `ghostly` command onto the user's PATH.
//!
//! The app binary already accepts CLI flags, but it lives inside the bundle at
//! `/Applications/Ghostly.app/Contents/MacOS/ghostly`, which nobody is going
//! to type. This symlinks it somewhere on PATH — the same trick as VS Code's
//! "Install 'code' command in PATH".
//!
//! `/usr/local/bin` is preferred: it is on the default PATH for every shell on
//! macOS, so the command works immediately. It usually needs an admin prompt,
//! so if the user declines we fall back to `~/.local/bin` and tell the caller
//! whether that still needs adding to PATH.

use log::{info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Command;

const COMMAND_NAME: &str = "ghostly";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CliInstallResult {
    /// Absolute path of the installed symlink.
    pub path: String,
    /// Whether the containing directory is already on PATH.
    pub on_path: bool,
    /// Line to add to a shell profile when `on_path` is false.
    pub path_hint: Option<String>,
}

fn system_bin() -> PathBuf {
    PathBuf::from("/usr/local/bin")
}

fn user_bin() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin"))
}

/// Where the command is installed already, if anywhere.
pub fn installed_path() -> Option<PathBuf> {
    let candidates = [Some(system_bin()), user_bin()];
    candidates
        .into_iter()
        .flatten()
        .map(|dir| dir.join(COMMAND_NAME))
        // symlink_metadata so a dangling symlink still counts as "installed"
        // and gets refreshed rather than silently ignored.
        .find(|p| p.symlink_metadata().is_ok())
}

fn dir_on_path(dir: &Path) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|p| p == dir)
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn applescript_escape(s: &str) -> String {
    s.replace('\\', r"\\").replace('"', "\\\"")
}

/// Replace any existing link, creating the parent directory if needed.
fn force_symlink(exe: &Path, dest: &Path) -> std::io::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if dest.symlink_metadata().is_ok() {
        std::fs::remove_file(dest)?;
    }
    std::os::unix::fs::symlink(exe, dest)
}

/// Same thing via an admin prompt, for directories the user cannot write.
fn force_symlink_as_admin(exe: &Path, dest: &Path) -> Result<(), String> {
    let dir = dest.parent().ok_or("Invalid destination path")?;
    let command = format!(
        "mkdir -p {} && ln -sf {} {}",
        shell_single_quote(&dir.to_string_lossy()),
        shell_single_quote(&exe.to_string_lossy()),
        shell_single_quote(&dest.to_string_lossy()),
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        applescript_escape(&command)
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Could not run osascript: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    // -128 is the AppleScript "user cancelled" code.
    if stderr.contains("-128") || stderr.contains("User canceled") {
        Err("cancelled".to_string())
    } else {
        Err(stderr.trim().to_string())
    }
}

pub fn install() -> Result<CliInstallResult, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not locate the Ghostly executable: {}", e))?;

    let system_dest = system_bin().join(COMMAND_NAME);

    // Fast path: /usr/local/bin already exists and is writable (common when
    // Homebrew is installed), so no admin prompt is needed at all.
    match force_symlink(&exe, &system_dest) {
        Ok(()) => {
            info!("Installed CLI at {}", system_dest.display());
            return Ok(CliInstallResult {
                path: system_dest.to_string_lossy().to_string(),
                on_path: true,
                path_hint: None,
            });
        }
        Err(e) => {
            info!("Direct symlink to /usr/local/bin failed ({e}); trying with admin rights");
        }
    }

    match force_symlink_as_admin(&exe, &system_dest) {
        Ok(()) => {
            info!("Installed CLI at {} (admin)", system_dest.display());
            return Ok(CliInstallResult {
                path: system_dest.to_string_lossy().to_string(),
                on_path: true,
                path_hint: None,
            });
        }
        Err(e) if e == "cancelled" => {
            info!("Admin install declined; falling back to ~/.local/bin");
        }
        Err(e) => {
            warn!("Admin install failed: {e}; falling back to ~/.local/bin");
        }
    }

    let fallback_dir = user_bin().ok_or("Could not determine your home directory")?;
    let fallback_dest = fallback_dir.join(COMMAND_NAME);
    force_symlink(&exe, &fallback_dest)
        .map_err(|e| format!("Could not write to {}: {}", fallback_dir.display(), e))?;

    let on_path = dir_on_path(&fallback_dir);
    info!(
        "Installed CLI at {} (on_path={on_path})",
        fallback_dest.display()
    );

    Ok(CliInstallResult {
        path: fallback_dest.to_string_lossy().to_string(),
        on_path,
        path_hint: if on_path {
            None
        } else {
            Some(format!("export PATH=\"{}:$PATH\"", fallback_dir.display()))
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_survives_apostrophes() {
        assert_eq!(shell_single_quote("/tmp/plain"), "'/tmp/plain'");
        assert_eq!(
            shell_single_quote("/Users/o'brien/Ghostly.app"),
            r"'/Users/o'\''brien/Ghostly.app'"
        );
    }

    #[test]
    fn applescript_escaping_handles_quotes_and_backslashes() {
        assert_eq!(applescript_escape(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(applescript_escape(r"back\slash"), r"back\\slash");
    }

    #[test]
    fn symlink_replaces_an_existing_link() {
        let dir = tempfile::tempdir().unwrap();
        let target_a = dir.path().join("a");
        let target_b = dir.path().join("b");
        std::fs::write(&target_a, b"a").unwrap();
        std::fs::write(&target_b, b"b").unwrap();
        let link = dir.path().join("bin/ghostly");

        force_symlink(&target_a, &link).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), target_a);

        force_symlink(&target_b, &link).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), target_b);
    }
}
