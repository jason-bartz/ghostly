use anyhow::{anyhow, Result};
use log::debug;
use std::io::Cursor;
use xcap::Monitor;

/// Capture the primary monitor as PNG bytes.
pub fn capture_primary_png() -> Result<Vec<u8>> {
    let monitors = Monitor::all().map_err(|e| anyhow!("Failed to enumerate monitors: {}", e))?;
    if monitors.is_empty() {
        return Err(anyhow!("No monitors detected"));
    }

    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(&monitors[0]);

    let image = monitor
        .capture_image()
        .map_err(|e| anyhow!("Failed to capture screen: {}", e))?;

    let mut buf = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut buf), xcap::image::ImageFormat::Png)
        .map_err(|e| anyhow!("Failed to encode PNG: {}", e))?;

    debug!(
        "Captured primary monitor ({}x{}), {} bytes PNG",
        image.width(),
        image.height(),
        buf.len()
    );

    Ok(buf)
}
