//! The floating live-transcript panel.
//!
//! A separate window from the recording overlay because it is a different kind
//! of surface: resizable, long-lived, scrollable, movable and interactive. It is
//! an `NSPanel` so it floats above full-screen conferencing apps without
//! stealing focus when it appears.
//!
//! Unlike the recording overlay this panel **can** become key
//! (`can_become_key_window: true`): naming a speaker and renaming the meeting
//! both need a text field, and a panel that can never take focus cannot host
//! one. Showing it still uses `orderFrontRegardless` rather than
//! `makeKeyAndOrderFront`, so it appears without pulling focus off the call.
//!
//! # Creation is deliberately quiet
//!
//! The panel is built hidden, and built without `PanelBuilder::no_activate`.
//! That option implements "do not steal focus" by flipping the process to
//! `NSApplicationActivationPolicyProhibited` for the duration of the build,
//! which orders *every* window the app owns out of the screen list — so
//! creating the panel made Ghostly itself vanish. Building the window with
//! `visible(false)` achieves the same thing without touching the process-wide
//! policy, and [`show`] then uses `orderFrontRegardless` so the panel appears
//! without pulling focus off the call.
//!
//! It is also created during setup rather than on first use, so showing it is
//! instant instead of waiting on a webview to boot.

use log::debug;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const PANEL_LABEL: &str = "meeting_panel";

const PANEL_WIDTH: f64 = 400.0;
/// Tall enough for two panes. The panel hosts a live transcript *and* a
/// notepad now, and at the old 460 the notepad was three lines — which reads
/// as a comment box rather than as somewhere to take notes.
const PANEL_HEIGHT: f64 = 660.0;
/// Inset from the working area's top-right corner.
const PANEL_MARGIN: f64 = 24.0;

/// Last position and size the user left the panel at, in logical points.
///
/// Written from the window move/resize events, which fire per pixel of a drag —
/// far too often to touch the settings store. Flushed to disk when the panel
/// hides and when the app exits.
static LAST_POSITION: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static LAST_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// Smallest usable panel. A saved size below this is treated as corrupt rather
/// than restored, since a 20pt-tall transcript is indistinguishable from a bug.
const MIN_PANEL_WIDTH: f64 = 240.0;
const MIN_PANEL_HEIGHT: f64 = 200.0;

#[cfg(target_os = "macos")]
use tauri::WebviewUrl;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(MeetingLivePanel {
        config: {
            // Required for the speaker-name and meeting-name text fields.
            // Paired with `no_activate` below so showing the panel does not
            // pull focus off the meeting.
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

/// The size to open at: whatever the user last resized to, else the default.
fn panel_size(app: &AppHandle) -> (f64, f64) {
    let settings = crate::settings::get_settings(app);
    let (width, height) = match (settings.meeting.panel_width, settings.meeting.panel_height) {
        (Some(width), Some(height)) if width >= MIN_PANEL_WIDTH && height >= MIN_PANEL_HEIGHT => {
            (width, height)
        }
        _ => (PANEL_WIDTH, PANEL_HEIGHT),
    };

    // The two-pane default is tall, and a panel taller than the display cannot
    // be resized back — its bottom edge is off-screen, and it is undecorated,
    // so there is no corner left to grab.
    let available = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())
        .map(|monitor| {
            monitor
                .size()
                .to_logical::<f64>(monitor.scale_factor())
                .height
        });
    match available {
        Some(screen) if screen > MIN_PANEL_HEIGHT => {
            (width, height.min(screen - PANEL_MARGIN * 2.0))
        }
        _ => (width, height),
    }
}

/// Where to place the panel: wherever the user last left it, else the top-right
/// of the primary monitor's working area.
fn panel_position(app: &AppHandle, width: f64) -> Option<(f64, f64)> {
    if let Some(saved) = saved_position(app, width) {
        return Some(saved);
    }

    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())?;

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let position = monitor.position().to_logical::<f64>(scale);

    Some((
        position.x + size.width - width - PANEL_MARGIN,
        position.y + PANEL_MARGIN,
    ))
}

/// A stored position, but only if some monitor still contains it.
///
/// Restoring blindly would strand the panel off-screen after the user
/// disconnects the display they last dragged it onto.
fn saved_position(app: &AppHandle, width: f64) -> Option<(f64, f64)> {
    let settings = crate::settings::get_settings(app);
    let (x, y) = (settings.meeting.panel_x?, settings.meeting.panel_y?);

    let monitors = app.available_monitors().ok()?;
    let visible = monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        // The title bar only has to be reachable, not the whole panel.
        x + width > origin.x
            && x < origin.x + size.width
            && y + 40.0 > origin.y
            && y < origin.y + size.height
    });
    visible.then_some((x, y))
}

/// Records a drag. Cheap enough to call on every move event.
pub fn remember_position(x: f64, y: f64) {
    if let Ok(mut guard) = LAST_POSITION.lock() {
        *guard = Some((x, y));
    }
}

/// Records a resize. Cheap enough to call on every resize event.
pub fn remember_size(width: f64, height: f64) {
    if width < MIN_PANEL_WIDTH || height < MIN_PANEL_HEIGHT {
        return;
    }
    if let Ok(mut guard) = LAST_SIZE.lock() {
        *guard = Some((width, height));
    }
}

/// Writes the remembered geometry to the settings store, if it changed.
pub fn persist_geometry(app: &AppHandle) {
    let position = LAST_POSITION.lock().ok().and_then(|guard| *guard);
    let size = LAST_SIZE.lock().ok().and_then(|guard| *guard);
    if position.is_none() && size.is_none() {
        return;
    }

    let mut settings = crate::settings::get_settings(app);
    let mut changed = false;

    if let Some((x, y)) = position {
        if settings.meeting.panel_x != Some(x) || settings.meeting.panel_y != Some(y) {
            settings.meeting.panel_x = Some(x);
            settings.meeting.panel_y = Some(y);
            changed = true;
        }
    }
    if let Some((width, height)) = size {
        if settings.meeting.panel_width != Some(width)
            || settings.meeting.panel_height != Some(height)
        {
            settings.meeting.panel_width = Some(width);
            settings.meeting.panel_height = Some(height);
            changed = true;
        }
    }

    if !changed {
        return;
    }
    crate::settings::write_settings(app, settings);
}

/// Creates the panel, hidden. Safe to call more than once.
///
/// Must run on the main thread — `PanelBuilder::build` swizzles the window's
/// class and touches NSWindow directly.
#[cfg(target_os = "macos")]
pub fn create(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }
    let (width, height) = panel_size(app);
    let (x, y) = panel_position(app, width).unwrap_or((100.0, 100.0));

    match PanelBuilder::<_, MeetingLivePanel>::new(app, PANEL_LABEL)
        .url(WebviewUrl::App("src/meeting/index.html".into()))
        .title("Meeting")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        // Floating rather than Status: the panel is a companion to the call,
        // not a transient HUD, so it should sit below system alerts.
        .level(PanelLevel::Floating)
        .size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
        .has_shadow(true)
        .transparent(true)
        // NSPanel defaults this to true, which would make the transcript
        // vanish the instant the user clicked back into their call — exactly
        // when they need to read it.
        .hides_on_deactivate(false)
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .resizable(true)
                // See the module docs: this is what replaces `no_activate`.
                .visible(false)
        })
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
            panel.hide();
            debug!("Meeting panel created (hidden)");
        }
        Err(e) => log::error!("Failed to create meeting panel: {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create(_app: &AppHandle) {}

/// Shows the panel, creating it on first use.
///
/// Every AppKit call here must run on the main thread. Callers include the
/// shortcut dispatch thread, the capture worker and the detector, none of which
/// are the main thread, so the hop is done here rather than at each call site.
/// `run_on_main_thread` posts to the event loop and does not block, so calling
/// it while already on the main thread is safe.
pub fn show(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        create(&app_handle);

        // `orderFrontRegardless` rather than the Tauri window's `show()`, which
        // maps to `makeKeyAndOrderFront:` and would take focus off the call the
        // moment a meeting started.
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app_handle.get_webview_panel(PANEL_LABEL) {
                panel.show();
                return;
            }
        }

        if let Some(window) = app_handle.get_webview_window(PANEL_LABEL) {
            let _ = window.show();
        }
    });
}

pub fn hide(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app_handle.get_webview_panel(PANEL_LABEL) {
                panel.hide();
                persist_geometry(&app_handle);
                return;
            }
        }

        if let Some(window) = app_handle.get_webview_window(PANEL_LABEL) {
            let _ = window.hide();
        }
        persist_geometry(&app_handle);
    });
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PANEL_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
