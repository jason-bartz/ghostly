//! System notification internationalization.
//!
//! Generated at compile time by build.rs from the frontend locale files
//! (`src/i18n/locales/*/translation.json`), exactly like [`crate::tray_i18n`].
//! The English `"notification"` section defines the struct fields.
//!
//! Notifications are composed in Rust rather than the frontend because they
//! fire while the settings window is closed, so `react-i18next` isn't
//! available to render them.
//!
//! To add a string:
//! 1. Add a flat key to the `"notification"` section of en/translation.json
//! 2. Use the snake_case field here (e.g. `strings.milestone_body`)
//!
//! Other locales backfill separately; a locale missing the key falls back to
//! English via [`get_notification_translations`].

use once_cell::sync::Lazy;
use std::collections::HashMap;

// Include the auto-generated NotificationStrings struct and TRANSLATIONS static
include!(concat!(env!("OUT_DIR"), "/notification_translations.rs"));

/// Get localized notification strings based on the system locale.
///
/// Lookup order: full locale (e.g. "zh-TW") → language code ("zh") → English.
pub fn get_notification_translations(locale: Option<String>) -> NotificationStrings {
    let locale_str = locale.as_deref().unwrap_or("en");
    let lang_code = locale_str.split(['-', '_']).next().unwrap_or("en");

    TRANSLATIONS
        .get(locale_str)
        .or_else(|| TRANSLATIONS.get(lang_code))
        .or_else(|| TRANSLATIONS.get("en"))
        .cloned()
        .expect("English translations must exist")
}
