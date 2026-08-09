//! The floating live-transcript panel.
//!
//! A separate window from the recording overlay because it is a different kind
//! of surface: resizable, long-lived, scrollable, and interactive. It is an
//! `NSPanel` so it floats above full-screen conferencing apps without stealing
//! focus when it appears.
//!
//! Unlike the recording overlay this panel **can** become key
//! (`can_become_key_window: true`): naming a speaker needs a text field, and a
//! panel that can never take focus cannot host one. `no_activate` still stops
//! it grabbing focus merely by being shown, so the user's call stays frontmost.

use log::debug;
use tauri::{AppHandle, Manager};

pub const PANEL_LABEL: &str = "meeting_panel";

const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 460.0;
/// Inset from the working area's top-right corner.
const PANEL_MARGIN: f64 = 24.0;

#[cfg(target_os = "macos")]
use tauri::WebviewUrl;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(MeetingLivePanel {
        config: {
            // Required for the speaker-name text field. Paired with
            // `no_activate` below so showing the panel does not pull focus off
            // the meeting.
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

/// Top-right of the primary monitor's working area.
fn panel_position(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())?;

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let position = monitor.position().to_logical::<f64>(scale);

    Some((
        position.x + size.width - PANEL_WIDTH - PANEL_MARGIN,
        position.y + PANEL_MARGIN,
    ))
}

/// Creates the panel, hidden. Safe to call more than once.
#[cfg(target_os = "macos")]
pub fn create(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }
    let (x, y) = panel_position(app).unwrap_or((100.0, 100.0));

    match PanelBuilder::<_, MeetingLivePanel>::new(app, PANEL_LABEL)
        .url(WebviewUrl::App("src/meeting/index.html".into()))
        .title("Meeting")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        // Floating rather than Status: the panel is a companion to the call,
        // not a transient HUD, so it should sit below system alerts.
        .level(PanelLevel::Floating)
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
        }))
        .has_shadow(true)
        .transparent(true)
        .no_activate(true)
        .with_window(|w| w.decorations(false).transparent(true).resizable(true))
        .collection_behavior(
            // Follows the user across Spaces and stays visible over a
            // full-screen call, which is where meetings actually happen.
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => {
            let _ = panel.hide();
            debug!("Meeting panel created (hidden)");
        }
        Err(e) => log::error!("Failed to create meeting panel: {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create(_app: &AppHandle) {}

/// Shows the panel, creating it on first use.
///
/// Every AppKit call here must run on the main thread — `PanelBuilder::build`
/// swizzles the window's class and touches NSWindow directly. Callers include
/// the shortcut dispatch thread, the capture worker and the detector, none of
/// which are the main thread, so the hop is done here rather than at each call
/// site. `run_on_main_thread` posts to the event loop and does not block, so
/// calling it while already on the main thread is safe.
pub fn show(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        create(&app_handle);
        if let Some(window) = app_handle.get_webview_window(PANEL_LABEL) {
            let _ = window.show();
        }
    });
}

pub fn hide(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_webview_window(PANEL_LABEL) {
            let _ = window.hide();
        }
    });
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PANEL_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
