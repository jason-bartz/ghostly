// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use ghostly_app_lib::CliArgs;

fn main() {
    let cli_args = CliArgs::parse();

    // Flags that produce output run as a plain CLI client against the local
    // API and exit — they never boot the GUI. Everything else falls through to
    // the normal launch path, where single-instance hands the args to a
    // running copy if there is one.
    if let Some(code) = ghostly_app_lib::run_cli(&cli_args) {
        std::process::exit(code);
    }

    #[cfg(target_os = "linux")]
    {
        // DMABUF renderer causes crashes on various GPU/display server configurations
        // See: https://github.com/tauri-apps/tauri/issues/9394
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    ghostly_app_lib::run(cli_args)
}
