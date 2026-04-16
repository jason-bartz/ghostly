//! macOS-only: put PNG image data on the system pasteboard and simulate a
//! paste keystroke so that apps like Claude, ChatGPT, VS Code, Cursor, and
//! Perplexity receive an image attachment.

use crate::input::EnigoState;
use crate::settings::get_settings;
use log::{error, info};
use objc::runtime::{Class, Object, BOOL, YES};
use objc::{msg_send, sel, sel_impl};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Put PNG bytes on the macOS general pasteboard, replacing existing content.
fn set_image_on_pasteboard(png_bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let pasteboard_class = Class::get("NSPasteboard").ok_or("NSPasteboard class not found")?;
        let pasteboard: *mut Object = msg_send![pasteboard_class, generalPasteboard];
        if pasteboard.is_null() {
            return Err("Failed to get general pasteboard".into());
        }

        // Clear existing contents
        let _: i64 = msg_send![pasteboard, clearContents];

        // Create NSData from the PNG bytes
        let nsdata_class = Class::get("NSData").ok_or("NSData class not found")?;
        let data: *mut Object = msg_send![nsdata_class,
            dataWithBytes: png_bytes.as_ptr()
            length: png_bytes.len()
        ];
        if data.is_null() {
            return Err("Failed to create NSData from PNG bytes".into());
        }

        // NSPasteboardTypePNG = "public.png"
        let nsstring_class = Class::get("NSString").ok_or("NSString class not found")?;
        let png_type_str = b"public.png\0";
        let png_type: *mut Object = msg_send![nsstring_class,
            stringWithUTF8String: png_type_str.as_ptr()
        ];

        let ok: BOOL = msg_send![pasteboard, setData: data forType: png_type];
        if ok != YES {
            return Err("NSPasteboard setData:forType: returned NO".into());
        }

        Ok(())
    }
}

/// Place a PNG image on the clipboard and simulate Cmd+V (or Shift+Cmd+V) to
/// paste it into the frontmost application.
///
/// `use_shift` should be `true` for apps like VS Code that require Shift to
/// attach images to a chat input.
pub fn paste_image(
    png_bytes: &[u8],
    app_handle: &AppHandle,
    use_shift: bool,
) -> Result<(), String> {
    // Save current text clipboard so we can restore it after paste
    let clipboard = app_handle.clipboard();
    let saved_text = clipboard.read_text().unwrap_or_default();

    let settings = get_settings(app_handle);
    let paste_delay_ms = settings.paste_delay_ms;

    // Write PNG to pasteboard
    set_image_on_pasteboard(png_bytes)?;

    std::thread::sleep(Duration::from_millis(paste_delay_ms));

    // Simulate paste keystroke
    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or("Enigo state not initialized")?;
    let mut enigo = enigo_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock Enigo: {}", e))?;

    if use_shift {
        info!("Pasting image with Shift+Cmd+V (VS Code mode)");
        crate::input::send_paste_ctrl_shift_v(&mut enigo)?;
    } else {
        info!("Pasting image with Cmd+V");
        crate::input::send_paste_ctrl_v(&mut enigo)?;
    }

    // Drop enigo lock before sleeping
    drop(enigo);

    std::thread::sleep(Duration::from_millis(50));

    // Restore previous text clipboard
    if let Err(e) = clipboard.write_text(&saved_text) {
        error!("Failed to restore clipboard after image paste: {}", e);
    }

    Ok(())
}
