use crate::actions::process_transcription_output;
use crate::ai_metadata;
use crate::managers::{
    history::{
        HistoryEntry, HistoryManager, HistoryTag, PaginatedHistory, TagRule, TranscriptionStats,
        WordCorrection,
    },
    transcription::TranscriptionManager,
    usage::UsageManager,
};
use std::sync::Arc;
use tauri::{AppHandle, State};

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn generate_docx(entries: &[HistoryEntry]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    let buf = Vec::new();
    let cursor = std::io::Cursor::new(buf);
    let mut zip = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default();

    // [Content_Types].xml
    zip.start_file("[Content_Types].xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#,
    ).map_err(|e| e.to_string())?;

    // _rels/.rels
    zip.add_directory("_rels/", opts)
        .map_err(|e| e.to_string())?;
    zip.start_file("_rels/.rels", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
    ).map_err(|e| e.to_string())?;

    // word/_rels/document.xml.rels
    zip.add_directory("word/", opts)
        .map_err(|e| e.to_string())?;
    zip.add_directory("word/_rels/", opts)
        .map_err(|e| e.to_string())?;
    zip.start_file("word/_rels/document.xml.rels", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>"#,
    )
    .map_err(|e| e.to_string())?;

    // word/settings.xml
    zip.start_file("word/settings.xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
</w:settings>"#,
    )
    .map_err(|e| e.to_string())?;

    // word/document.xml - build body content from history entries
    let mut body = String::new();
    body.push_str(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>"#,
    );

    for (i, entry) in entries.iter().enumerate() {
        // Date heading
        let date_str = xml_escape(&entry.title);
        body.push_str(&format!(
            r#"
    <w:p>
      <w:pPr>
        <w:rPr><w:b/><w:sz w:val="24"/></w:rPr>
      </w:pPr>
      <w:r>
        <w:rPr><w:b/><w:sz w:val="24"/></w:rPr>
        <w:t>{date}</w:t>
      </w:r>
    </w:p>"#,
            date = date_str
        ));

        // Transcription text
        let lines: Vec<&str> = entry.transcription_text.split('\n').collect();
        for line in &lines {
            let escaped = xml_escape(line);
            body.push_str(&format!(
                r#"
    <w:p>
      <w:r>
        <w:rPr><w:rStyle w:val="a"/><w:i/></w:rPr>
        <w:t xml:space="preserve">{text}</w:t>
      </w:r>
    </w:p>"#,
                text = escaped
            ));
        }

        // Post-processed text (if present and different)
        if let Some(ref pp) = entry.post_processed_text {
            if !pp.is_empty() && pp != &entry.transcription_text {
                let label = if let Some(ref prompt) = entry.post_process_prompt {
                    xml_escape(prompt)
                } else {
                    "Post-processed".to_string()
                };
                body.push_str(&format!(
                    r#"
    <w:p>
      <w:r>
        <w:rPr><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr>
        <w:t>{label}:</w:t>
      </w:r>
    </w:p>"#,
                    label = label
                ));
                for line in pp.split('\n') {
                    let escaped = xml_escape(line);
                    body.push_str(&format!(
                        r#"
    <w:p>
      <w:r>
        <w:t xml:space="preserve">{text}</w:t>
      </w:r>
    </w:p>"#,
                        text = escaped
                    ));
                }
            }
        }

        // Separator between entries (except last)
        if i < entries.len() - 1 {
            body.push_str(
                r#"
    <w:p>
      <w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr>
    </w:p>"#,
            );
        }
    }

    body.push_str(
        r#"
  </w:body>
</w:document>"#,
    );

    zip.start_file("word/document.xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;

    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

#[tauri::command]
#[specta::specta]
pub async fn export_history(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    path: String,
    format: String,
) -> Result<(), String> {
    let entries = history_manager
        .get_all_history_for_export()
        .await
        .map_err(|e| e.to_string())?;

    match format.as_str() {
        "json" => {
            let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
            std::fs::write(&path, json).map_err(|e| e.to_string())?;
        }
        "docx" => {
            let bytes = generate_docx(&entries)?;
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown export format: {}", format)),
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .get_history_entries(cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_entry_title(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
    title: Option<String>,
) -> Result<HistoryEntry, String> {
    history_manager
        .update_user_title(id, title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_history_entry_saved(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_audio_file_path(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<String, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    path.to_str()
        .ok_or_else(|| "Invalid file path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn bulk_delete_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    ids: Vec<i64>,
) -> Result<(), String> {
    history_manager
        .bulk_delete_entries(&ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_history_entry_transcription(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    id: i64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let audio_path = history_manager.get_audio_file_path(&entry.file_name);
    let samples = crate::audio_toolkit::read_wav_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    if samples.is_empty() {
        return Err("Recording has no audio samples".to_string());
    }

    transcription_manager.initiate_model_load();

    let tm = Arc::clone(&transcription_manager);
    let transcription = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
        .await
        .map_err(|e| format!("Transcription task panicked: {}", e))?
        .map_err(|e| e.to_string())?;

    if transcription.is_empty() {
        return Err("Recording contains no speech".to_string());
    }

    let processed =
        process_transcription_output(&app, &transcription, entry.post_process_requested).await;
    history_manager
        .update_transcription(
            id,
            transcription,
            processed.post_processed_text,
            processed.post_process_prompt,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit: usize,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.history_limit = limit;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn search_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    query: String,
    limit: Option<usize>,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    history_manager
        .search_history_entries(query, limit, start_ts, end_ts)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn paste_history_entry(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let text = entry
        .post_processed_text
        .filter(|t| !t.is_empty())
        .unwrap_or(entry.transcription_text);

    if text.is_empty() {
        return Err("Entry has no text to paste".to_string());
    }

    crate::clipboard::paste(text, app)
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_retention_period(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    period: String,
) -> Result<(), String> {
    use crate::settings::RecordingRetentionPeriod;

    let retention_period = match period.as_str() {
        "never" => RecordingRetentionPeriod::Never,
        "preserve_limit" => RecordingRetentionPeriod::PreserveLimit,
        "days3" => RecordingRetentionPeriod::Days3,
        "weeks2" => RecordingRetentionPeriod::Weeks2,
        "months3" => RecordingRetentionPeriod::Months3,
        _ => return Err(format!("Invalid retention period: {}", period)),
    };

    let mut settings = crate::settings::get_settings(&app);
    settings.recording_retention_period = retention_period;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio_file(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    file_path: String,
) -> Result<HistoryEntry, String> {
    use crate::audio_toolkit::{read_audio_file_samples, save_wav_file};

    let path = std::path::Path::new(&file_path);

    // Decode audio file to 16kHz mono f32
    let samples =
        read_audio_file_samples(path).map_err(|e| format!("Failed to decode audio file: {}", e))?;

    if samples.is_empty() {
        return Err("Audio file contains no audio data".to_string());
    }

    transcription_manager.initiate_model_load();

    // Clone samples for the closure so originals remain for WAV saving
    let samples_for_tx = samples.clone();
    let tm = Arc::clone(&transcription_manager);
    let transcription = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples_for_tx))
        .await
        .map_err(|e| format!("Transcription task panicked: {}", e))?
        .map_err(|e| e.to_string())?;

    if transcription.is_empty() {
        return Err("Audio file contains no recognisable speech".to_string());
    }

    // Save a WAV copy in recordings dir so audio player works
    let timestamp = chrono::Utc::now().timestamp();
    let wav_name = format!("file_{}.wav", timestamp);
    let wav_path = history_manager.recordings_dir().join(&wav_name);
    save_wav_file(&wav_path, &samples).map_err(|e| format!("Failed to save WAV: {}", e))?;

    let processed = process_transcription_output(&app, &transcription, false).await;

    // File-import transcription has no capture context (the user picked a file,
    // not dictated into an app), so source_app stays None.
    history_manager
        .save_entry(
            wav_name,
            transcription,
            false,
            processed.post_processed_text,
            processed.post_process_prompt,
            None,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_word_corrections(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<WordCorrection>, String> {
    history_manager
        .get_word_corrections()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_word_correction(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    wrong: String,
    correct: String,
) -> Result<WordCorrection, String> {
    if wrong.trim().is_empty() || correct.trim().is_empty() {
        return Err("Both wrong and correct must be non-empty".to_string());
    }
    history_manager
        .upsert_word_correction(wrong.trim().to_string(), correct.trim().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_word_correction(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_word_correction(id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_transcription_stats(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    usage_manager: State<'_, Arc<UsageManager>>,
) -> Result<TranscriptionStats, String> {
    let counters = usage_manager.lifetime_achievement_counters();
    history_manager
        .get_stats(counters)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn add_history_tag(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
    name: String,
) -> Result<HistoryTag, String> {
    history_manager
        .add_tag(id, name, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_history_tag(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
    name: String,
) -> Result<(), String> {
    history_manager
        .remove_tag(id, name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_all_history_tags(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<String>, String> {
    history_manager.list_all_tags().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_tag_globally(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    name: String,
) -> Result<u64, String> {
    history_manager
        .delete_tag_globally(name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_history_tag_rule(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    name: String,
    strict: bool,
) -> Result<TagRule, String> {
    history_manager
        .set_tag_rule(name, strict)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_history_tag_rules(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<TagRule>, String> {
    history_manager.list_tag_rules().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn filter_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    query: Option<String>,
    tag_names: Vec<String>,
    limit: Option<usize>,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    history_manager
        .filter_history_entries(query, tag_names, limit, start_ts, end_ts)
        .await
        .map_err(|e| e.to_string())
}

/// Generate a title and tags for an entry using the configured LLM provider,
/// apply them (sets `user_title`, inserts tags as `auto = true`), and return
/// the updated entry. Existing tags are preserved — AI-suggested tags that
/// already exist are deduped by the unique index. User-set title is replaced
/// only when the caller explicitly chose to regenerate.
#[tauri::command]
#[specta::specta]
pub async fn generate_history_metadata(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<HistoryEntry, String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let source_text = entry
        .post_processed_text
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(entry.transcription_text.as_str());

    let settings = crate::settings::get_settings(&app);
    let existing_tags = history_manager.list_all_tags().map_err(|e| e.to_string())?;
    let strict_tags: Vec<String> = history_manager
        .list_tag_rules()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.strict)
        .map(|r| r.name)
        .collect();
    let generated = ai_metadata::generate(&settings, source_text, &existing_tags, &strict_tags)
        .await
        .ok_or_else(|| {
            "Unable to generate metadata. Check that an AI provider, model, and API key are configured."
                .to_string()
        })?;

    // Apply title as user_title (the editable layer).
    let updated = history_manager
        .update_user_title(id, Some(generated.title))
        .await
        .map_err(|e| e.to_string())?;

    for tag in generated.tags {
        if let Err(e) = history_manager.add_tag(id, tag, true) {
            log::warn!("Failed to add AI tag: {}", e);
        }
    }

    // Re-fetch so returned entry reflects both the new title and tags.
    history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} disappeared after update", updated.id))
}

#[tauri::command]
#[specta::specta]
pub async fn delete_word_correction(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_word_correction(id)
        .map_err(|e| e.to_string())
}
