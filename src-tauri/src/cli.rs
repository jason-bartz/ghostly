use clap::Parser;

#[derive(Parser, Debug, Clone, Default)]
#[command(
    name = "ghostly",
    about = "Ghostly - Speech to Text",
    after_help = "\
Flags that return a value (--dictate, --status, --history) talk to Ghostly's
local API, which must be enabled in Settings → Developer → Local API.

Examples:
  ghostly --toggle-transcription        Start or stop recording
  ghostly --dictate                     Record, then print the transcript
  git commit -m \"$(ghostly --dictate)\"   Dictate straight into a command
  ghostly --dictate --stop-after 10     Record for 10 seconds, unattended
  ghostly --history --limit 5           Print your last 5 transcriptions
  ghostly --status --json               Machine-readable state"
)]
pub struct CliArgs {
    /// Start with the main window hidden
    #[arg(long)]
    pub start_hidden: bool,

    /// Disable the system tray icon
    #[arg(long)]
    pub no_tray: bool,

    /// Toggle transcription on/off (sent to running instance)
    #[arg(long)]
    pub toggle_transcription: bool,

    /// Deprecated alias for --toggle-transcription. Kept for backward
    /// compatibility; AI refinement now applies automatically when an LLM
    /// is configured.
    #[arg(long)]
    pub toggle_post_process: bool,

    /// Cancel the current operation (sent to running instance)
    #[arg(long)]
    pub cancel: bool,

    /// Enable debug mode with verbose logging
    #[arg(long)]
    pub debug: bool,

    // --- Flags below need a response, so they go over the local API ---
    /// Record, wait for the transcript, and print it to stdout
    #[arg(long)]
    pub dictate: bool,

    /// Print whether Ghostly is idle or recording
    #[arg(long)]
    pub status: bool,

    /// Print recent transcriptions
    #[arg(long)]
    pub history: bool,

    /// Install the `ghostly` command onto your PATH
    #[arg(long)]
    pub install_cli: bool,

    /// Number of entries for --history (default 10)
    #[arg(long, value_name = "N")]
    pub limit: Option<usize>,

    /// Seconds to wait for a transcript with --dictate (default 120)
    #[arg(long, value_name = "SECONDS")]
    pub timeout: Option<u64>,

    /// Stop recording automatically after this many seconds with --dictate
    #[arg(long, value_name = "SECONDS")]
    pub stop_after: Option<u64>,

    /// Also paste the transcript into the focused app with --dictate
    #[arg(long)]
    pub paste: bool,

    /// Emit JSON instead of plain text
    #[arg(long)]
    pub json: bool,
}
