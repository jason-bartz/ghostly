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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const PANEL_LABEL: &str = "meeting_panel";

/// Points. Matches `rounded-[14px]` in `MeetingPanel.tsx`.
const CORNER_RADIUS: f64 = 14.0;

/// The minimised panel: a pill just wide enough for a waveform and a clock.
///
/// Minimising a floating panel to the Dock is the one thing it must not do —
/// the panel exists to be visible *during* a call, and a meeting that is still
/// recording with nothing on screen saying so is the worst state this feature
/// can be in. So the yellow button shrinks the window instead of hiding it.
const MINI_WIDTH: f64 = 176.0;
const MINI_HEIGHT: f64 = 40.0;

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

/// The panel is shrunk to the mini player right now.
static MINIMIZED: AtomicBool = AtomicBool::new(false);
/// The size to grow back to when the mini player is clicked.
static RESTORE_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);
/// The frame the green button zoomed away from, so a second click undoes it.
static ZOOM_RESTORE: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

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
    // Where the user parks the mini player is not where they want a 400×660
    // panel to open. Restoring re-clamps the panel onto the screen and moves it
    // itself, and that move is what gets recorded.
    if MINIMIZED.load(Ordering::SeqCst) {
        return;
    }
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
            round_corners(app);
            debug!("Meeting panel created (hidden)");
        }
        Err(e) => log::error!("Failed to create meeting panel: {e}"),
    }
}

/// Rounds the *window*, not just what is painted inside it.
///
/// The panel is undecorated and transparent, and the webview drew its own
/// `border-radius` — which looks right until you notice the corners are still
/// square. Two things gave it away. The webview's layer is opaque where the CSS
/// rounding cut a corner away, so the pixels behind the arc were the window's
/// own background rather than the desktop. And `has_shadow` traces the
/// *window's* rectangle, so a square shadow was drawn behind four rounded
/// corners, outlining exactly the shape that was supposed to be gone.
///
/// Rounding the content view's layer clips the webview to the arc, which fixes
/// the fill, and `invalidateShadow` makes AppKit re-derive the shadow from the
/// now-transparent corners rather than reusing the square one it cached at
/// creation.
///
/// Must stay in sync with the `rounded-[14px]` on the panel's root element:
/// both are drawn, and a mismatch shows as a hairline of the wrong curve.
fn round_corners(app: &AppHandle) {
    set_corner_radius(app, CORNER_RADIUS);
}

/// The window's own rounding. See [`round_corners`] for why this is not left to
/// CSS; the mini player uses it to become a pill rather than a small rectangle.
#[cfg(target_os = "macos")]
fn set_corner_radius(app: &AppHandle, radius: f64) {
    use cocoa::base::{id, NO};
    use objc::{msg_send, sel, sel_impl};

    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let Ok(ns_window) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = ns_window as id;
        let content_view: id = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }

        let _: () = msg_send![content_view, setWantsLayer: true];
        let layer: id = msg_send![content_view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];

        // The window itself must not paint an opaque rectangle underneath, or
        // the clipped corners are filled back in.
        let _: () = msg_send![ns_window, setOpaque: NO];

        // Recompute the shadow from the alpha channel. Without this AppKit
        // keeps the square shadow it derived when the window was created.
        let _: () = msg_send![ns_window, invalidateShadow];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_corner_radius(_app: &AppHandle, _radius: f64) {}

/// Re-derives the drop shadow from the window's current shape.
///
/// Called on resize: AppKit traces the shadow of a transparent window once and
/// caches it, so growing the panel leaves the previous outline hanging off the
/// new corners. Cheap enough to run per resize event.
pub fn refresh_shadow(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use objc::{msg_send, sel, sel_impl};

        let Some(window) = app.get_webview_window(PANEL_LABEL) else {
            return;
        };
        let Ok(ns_window) = window.ns_window() else {
            return;
        };
        unsafe {
            let _: () = msg_send![ns_window as id, invalidateShadow];
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create(_app: &AppHandle) {}

/// The usable area of the display the panel is on — menu bar and Dock excluded
/// — in logical points.
fn work_area(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    Some((origin.x, origin.y, size.width, size.height))
}

/// The panel's frame right now, in logical points.
fn frame(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    Some((position.x, position.y, size.width, size.height))
}

/// Keeps a window that just grew from touching the screen edge it grew past.
///
/// Restoring happens at the mini player's corner, and the mini player is small
/// enough to park anywhere — including the bottom-right, where a 400×660 panel
/// would open almost entirely off-screen.
fn clamp_onto_work_area(window: &tauri::WebviewWindow, width: f64, height: f64) {
    let Some((area_x, area_y, area_width, area_height)) = work_area(window) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(position) = window.outer_position() else {
        return;
    };
    let position = position.to_logical::<f64>(scale);

    let x = position
        .x
        .min(area_x + area_width - width - PANEL_MARGIN)
        .max(area_x + PANEL_MARGIN);
    let y = position
        .y
        .min(area_y + area_height - height - PANEL_MARGIN)
        .max(area_y + PANEL_MARGIN);

    if (x - position.x).abs() > 1.0 || (y - position.y).abs() > 1.0 {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
}

/// Shrinks the panel to the mini player, or grows it back.
///
/// The window is the same one either way. A second window would mean a second
/// webview booting, a second copy of the live-transcript subscriptions and two
/// places for the meeting's state to disagree — for something whose whole job is
/// to be a smaller view of what is already on screen.
pub fn set_minimized(app: &AppHandle, minimized: bool) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || apply_minimized(&app_handle, minimized));
}

/// The body of [`set_minimized`], for callers already on the main thread.
fn apply_minimized(app: &AppHandle, minimized: bool) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    if MINIMIZED.load(Ordering::SeqCst) == minimized {
        return;
    }

    let (width, height) = if minimized {
        // Recorded before the flag goes up, so the restore has something to aim
        // at even if the user never resized the panel this session.
        if let Some((_, _, current_width, current_height)) = frame(&window) {
            if current_width >= MIN_PANEL_WIDTH && current_height >= MIN_PANEL_HEIGHT {
                if let Ok(mut guard) = RESTORE_SIZE.lock() {
                    *guard = Some((current_width, current_height));
                }
            }
        }
        (MINI_WIDTH, MINI_HEIGHT)
    } else {
        RESTORE_SIZE
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .unwrap_or_else(|| panel_size(app))
    };

    MINIMIZED.store(minimized, Ordering::SeqCst);
    // The waveform is the only thing that wants audio levels several times a
    // second, so the stream follows the pill rather than the meeting. Set here
    // rather than in the command so a panel restored by [`hide`] turns it off
    // too.
    super::session::set_level_stream(minimized);

    // A pill the size of a bookmark has no useful resize handles, and dragging
    // one out of a 40pt-tall window is an accident rather than an intention.
    let _ = window.set_resizable(!minimized);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
    set_corner_radius(
        app,
        if minimized {
            MINI_HEIGHT / 2.0
        } else {
            CORNER_RADIUS
        },
    );
    if !minimized {
        clamp_onto_work_area(&window, width, height);
    }
    refresh_shadow(app);

    // The panel restores itself on hide, so the webview cannot be the only
    // record of which shape it is in.
    let _ = app.emit("meeting-panel-minimized", minimized);
}

/// The green button: fill the screen, or go back to the frame before it.
///
/// This is macOS zoom, not full screen. A panel that took over a Space would
/// take the call with it, and the point of the thing is to sit beside a call.
pub fn toggle_zoom(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = app_handle.get_webview_window(PANEL_LABEL) else {
            return;
        };
        // Zooming a 176pt pill is not a thing anyone means to do.
        if MINIMIZED.load(Ordering::SeqCst) {
            return;
        }
        let Some((x, y, width, height)) = frame(&window) else {
            return;
        };
        let Some((area_x, area_y, area_width, area_height)) = work_area(&window) else {
            return;
        };

        // Already zoomed if the frame is the work area, however it got there —
        // dragging the panel to fill the screen and then pressing zoom should
        // give the window back, not do nothing.
        let zoomed = (width - area_width).abs() < 2.0 && (height - area_height).abs() < 2.0;

        let (next_x, next_y, next_width, next_height) = if zoomed {
            ZOOM_RESTORE
                .lock()
                .ok()
                .and_then(|guard| *guard)
                .unwrap_or_else(|| {
                    let (default_width, default_height) = panel_size(&app_handle);
                    (
                        area_x + area_width - default_width - PANEL_MARGIN,
                        area_y + PANEL_MARGIN,
                        default_width,
                        default_height,
                    )
                })
        } else {
            if let Ok(mut guard) = ZOOM_RESTORE.lock() {
                *guard = Some((x, y, width, height));
            }
            (area_x, area_y, area_width, area_height)
        };

        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: next_width,
            height: next_height,
        }));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: next_x,
            y: next_y,
        }));
        refresh_shadow(&app_handle);
    });
}

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
        // A hidden panel is never minimised. Reopening it — from the tray, the
        // shortcut, or the next meeting starting — has to give back the panel,
        // not the pill the user left behind three calls ago.
        apply_minimized(&app_handle, false);

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
