use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, Local, Utc};
use log::{debug, error, info};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

/// Database migrations for transcription history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS transcription_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            saved BOOLEAN NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            transcription_text TEXT NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0;"),
    M::up(
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
            transcription_text,
            post_processed_text,
            content='transcription_history',
            content_rowid='id'
        );
        INSERT INTO history_fts(rowid, transcription_text, post_processed_text)
            SELECT id, transcription_text, COALESCE(post_processed_text, '') FROM transcription_history;
        CREATE TRIGGER IF NOT EXISTS history_fts_insert AFTER INSERT ON transcription_history BEGIN
            INSERT INTO history_fts(rowid, transcription_text, post_processed_text)
            VALUES (new.id, new.transcription_text, COALESCE(new.post_processed_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS history_fts_delete AFTER DELETE ON transcription_history BEGIN
            INSERT INTO history_fts(history_fts, rowid, transcription_text, post_processed_text)
            VALUES ('delete', old.id, old.transcription_text, COALESCE(old.post_processed_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS history_fts_update AFTER UPDATE ON transcription_history BEGIN
            INSERT INTO history_fts(history_fts, rowid, transcription_text, post_processed_text)
            VALUES ('delete', old.id, old.transcription_text, COALESCE(old.post_processed_text, ''));
            INSERT INTO history_fts(rowid, transcription_text, post_processed_text)
            VALUES (new.id, new.transcription_text, COALESCE(new.post_processed_text, ''));
        END;",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS word_corrections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wrong TEXT NOT NULL UNIQUE,
            correct TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN user_title TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN audio_duration_ms INTEGER;"),
    // Word count is denormalised so `compute_stats` can rely on SQL aggregates
    // (SUM/MAX) instead of loading every `transcription_text` into memory on
    // each refresh. Populated at save time and backfilled lazily for legacy
    // rows; see `backfill_word_counts`.
    M::up("ALTER TABLE transcription_history ADD COLUMN word_count INTEGER;"),
    M::up(
        "CREATE TABLE IF NOT EXISTS history_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            auto BOOLEAN NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(entry_id) REFERENCES transcription_history(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_history_tags_entry_name
            ON history_tags(entry_id, LOWER(name));
        CREATE INDEX IF NOT EXISTS idx_history_tags_name ON history_tags(LOWER(name));",
    ),
    // Human-readable source app (e.g. "Messages", "Slack") captured at recording
    // start. Shown in the Notes list as a neutral context chip.
    M::up("ALTER TABLE transcription_history ADD COLUMN source_app TEXT;"),
    // Persist badge unlock timestamps so the UI can display when each badge
    // was earned and highlight recently-unlocked achievements.
    M::up(
        "CREATE TABLE IF NOT EXISTS badge_unlocks (
            badge_id TEXT PRIMARY KEY,
            unlocked_at INTEGER NOT NULL
        );",
    ),
    // Per-tag rules that shape how tags are applied — e.g. `strict` means
    // the AI may only attach the tag when the word literally appears in
    // the note, regardless of semantic fit. Name is stored lowercase so
    // the row is the single authoritative rule for the tag regardless of
    // the casing under which entries stored it.
    M::up(
        "CREATE TABLE IF NOT EXISTS tag_rules (
            name TEXT PRIMARY KEY,
            strict BOOLEAN NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );",
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct PaginatedHistory {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "action")]
pub enum HistoryUpdatePayload {
    #[serde(rename = "added")]
    Added { entry: HistoryEntry },
    #[serde(rename = "updated")]
    Updated { entry: HistoryEntry },
    #[serde(rename = "deleted")]
    Deleted { id: i64 },
    #[serde(rename = "toggled")]
    Toggled { id: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryTag {
    pub name: String,
    pub auto: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub id: i64,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub user_title: Option<String>,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    #[serde(default)]
    pub source_app: Option<String>,
    #[serde(default)]
    pub tags: Vec<HistoryTag>,
}

/// Authoritative list of achievement badge identifiers. Serialised as
/// snake_case strings so the wire format stays stable across refactors and
/// is human-readable in logs; specta exports this as a TypeScript
/// string-literal union, letting both sides share a single source of truth
/// and giving the compiler an early warning if the two catalogs ever drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BadgeId {
    FirstWords,
    GettingStarted,
    Regular,
    Devoted,
    Paragraph,
    Marathon,
    OneHourClub,
    TenHourClub,
    PostProcessor,
    Collector,
    Lexicographer,
    EarlyBird,
    NightOwl,
    LunchBreak,
    EveryDayOfTheWeek,
    Sprint,
    Questioner,
    Exclaimer,
}

/// A badge the user has earned, together with the unix timestamp (seconds)
/// at which it was first recorded. The unlock time is persisted in the
/// `badge_unlocks` table so the UI can display dates and "new" indicators.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct EarnedBadge {
    pub id: BadgeId,
    pub unlocked_at: i64,
}

/// Aggregate usage statistics derived from the transcription history table.
/// All fields are lifetime totals across non-empty entries. Rows missing an
/// `audio_duration_ms` value (migrated from before the column existed) are
/// counted toward word/count totals but contribute zero to duration.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TranscriptionStats {
    pub total_words: u64,
    pub total_duration_ms: u64,
    pub transcription_count: u64,
    pub longest_transcription_words: u64,
    pub first_transcription_timestamp: Option<i64>,
    pub latest_transcription_timestamp: Option<i64>,
    pub earned_badges: Vec<EarnedBadge>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct WordCorrection {
    pub id: i64,
    pub wrong: String,
    pub correct: String,
    pub enabled: bool,
    pub created_at: i64,
}

pub struct HistoryManager {
    app_handle: AppHandle,
    recordings_dir: PathBuf,
    db_path: PathBuf,
}

impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // Create recordings directory in app data dir
        let app_data_dir = crate::portable::app_data_dir(app_handle)?;
        let recordings_dir = app_data_dir.join("recordings");
        let db_path = app_data_dir.join("history.db");

        // Ensure recordings directory exists
        if !recordings_dir.exists() {
            fs::create_dir_all(&recordings_dir)?;
            debug!("Created recordings directory: {:?}", recordings_dir);
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            recordings_dir,
            db_path,
        };

        // Initialize database and run migrations synchronously
        manager.init_database()?;

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        info!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid migrations");

        // Get current version before migration
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        debug!("Database version before migration: {}", version_before);

        // Apply any pending migrations
        migrations.to_latest(&mut conn)?;

        // Lazily backfill word_count for rows that pre-date the column. Runs
        // at most once per install; subsequent opens short-circuit via the
        // `word_count IS NULL` filter. Errors here are non-fatal — the stats
        // query tolerates NULLs and the user can always reopen the app.
        if let Err(e) = backfill_word_counts(&conn) {
            log::warn!("word_count backfill skipped: {}", e);
        }

        // Get version after migration
        let version_after: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if version_after > version_before {
            info!(
                "Database migrated from version {} to {}",
                version_before, version_after
            );
        } else {
            debug!("Database already at latest version {}", version_after);
        }

        Ok(())
    }

    /// Migrate from tauri-plugin-sql's migration tracking to rusqlite_migration's.
    /// tauri-plugin-sql used a _sqlx_migrations table, while rusqlite_migration uses
    /// SQLite's user_version pragma. This function checks if the old system was in use
    /// and sets the user_version accordingly so migrations don't re-run.
    fn migrate_from_tauri_plugin_sql(&self, conn: &Connection) -> Result<()> {
        // Check if the old _sqlx_migrations table exists
        let has_sqlx_migrations: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_sqlx_migrations {
            return Ok(());
        }

        // Check current user_version
        let current_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if current_version > 0 {
            // Already migrated to rusqlite_migration system
            return Ok(());
        }

        // Get the highest version from the old migrations table
        let old_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if old_version > 0 {
            info!(
                "Migrating from tauri-plugin-sql (version {}) to rusqlite_migration",
                old_version
            );

            // Set user_version to match the old migration state
            conn.pragma_update(None, "user_version", old_version)?;

            // Optionally drop the old migrations table (keeping it doesn't hurt)
            // conn.execute("DROP TABLE IF EXISTS _sqlx_migrations", [])?;

            info!(
                "Migration tracking converted: user_version set to {}",
                old_version
            );
        }

        Ok(())
    }

    fn get_connection(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        Ok(conn)
    }

    fn map_history_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: row.get("id")?,
            file_name: row.get("file_name")?,
            timestamp: row.get("timestamp")?,
            saved: row.get("saved")?,
            title: row.get("title")?,
            user_title: row.get("user_title").ok(),
            transcription_text: row.get("transcription_text")?,
            post_processed_text: row.get("post_processed_text")?,
            post_process_prompt: row.get("post_process_prompt")?,
            post_process_requested: row.get("post_process_requested")?,
            source_app: row.get("source_app").ok(),
            tags: Vec::new(),
        })
    }

    /// Populate `tags` for each entry in one batched query. Safe to call with
    /// an empty slice. Errors are logged and fall through to empty tag lists
    /// so a tags-table issue doesn't break the history view.
    fn attach_tags(conn: &Connection, entries: &mut [HistoryEntry]) {
        if entries.is_empty() {
            return;
        }
        let ids: Vec<String> = entries.iter().map(|e| e.id.to_string()).collect();
        let placeholders = ids.join(",");
        let sql = format!(
            "SELECT entry_id, name, auto FROM history_tags
             WHERE entry_id IN ({})
             ORDER BY entry_id, LOWER(name)",
            placeholders
        );
        let mut by_id: std::collections::HashMap<i64, Vec<HistoryTag>> =
            std::collections::HashMap::new();
        match conn.prepare(&sql).and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>("entry_id")?,
                    HistoryTag {
                        name: row.get::<_, String>("name")?,
                        auto: row.get::<_, bool>("auto")?,
                    },
                ))
            })?;
            for row in rows {
                let (entry_id, tag) = row?;
                by_id.entry(entry_id).or_default().push(tag);
            }
            Ok(())
        }) {
            Ok(()) => {
                for entry in entries {
                    if let Some(tags) = by_id.remove(&entry.id) {
                        entry.tags = tags;
                    }
                }
            }
            Err(e) => error!("Failed to load history tags: {}", e),
        }
    }

    fn attach_tags_single(conn: &Connection, entry: &mut HistoryEntry) {
        Self::attach_tags(conn, std::slice::from_mut(entry));
    }

    pub fn recordings_dir(&self) -> &std::path::Path {
        &self.recordings_dir
    }

    /// Save a new history entry to the database.
    /// The WAV file should already have been written to the recordings directory.
    pub fn save_entry(
        &self,
        file_name: String,
        transcription_text: String,
        post_process_requested: bool,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        source_app: Option<String>,
    ) -> Result<HistoryEntry> {
        let timestamp = Utc::now().timestamp();
        let title = self.format_timestamp_title(timestamp);
        let audio_duration_ms = self.read_wav_duration_ms(&file_name);
        let word_count = count_words(&transcription_text) as i64;

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                audio_duration_ms,
                word_count,
                source_app
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &file_name,
                timestamp,
                false,
                &title,
                &transcription_text,
                &post_processed_text,
                &post_process_prompt,
                post_process_requested,
                audio_duration_ms,
                word_count,
                &source_app,
            ],
        )?;

        let entry = HistoryEntry {
            id: conn.last_insert_rowid(),
            file_name,
            timestamp,
            saved: false,
            title,
            user_title: None,
            transcription_text,
            post_processed_text,
            post_process_prompt,
            post_process_requested,
            source_app,
            tags: Vec::new(),
        };

        debug!("Saved history entry with id {}", entry.id);

        self.cleanup_old_entries()?;

        // Emit typed event for real-time frontend updates
        if let Err(e) = (HistoryUpdatePayload::Added {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        // Auto-generate title and tags when AI is configured. Runs off the save
        // path so we never block transcription; no-ops when no provider/model
        // is set (ai_metadata::generate returns None) or the transcription is
        // too short to be worth summarizing. Subsequent title/tag mutations
        // emit their own Updated events so the UI refreshes.
        if word_count >= 5 {
            let app_handle = self.app_handle.clone();
            let entry_id = entry.id;
            let transcription_for_ai = entry.transcription_text.clone();
            let post_processed_for_ai = entry.post_processed_text.clone();
            tauri::async_runtime::spawn(async move {
                run_auto_metadata(
                    app_handle,
                    entry_id,
                    transcription_for_ai,
                    post_processed_for_ai,
                )
                .await;
            });
        }

        Ok(entry)
    }

    /// Update an existing history entry with new transcription results (used by retry).
    pub fn update_transcription(
        &self,
        id: i64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
    ) -> Result<HistoryEntry> {
        let word_count = count_words(&transcription_text) as i64;
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE transcription_history
             SET transcription_text = ?1,
                 post_processed_text = ?2,
                 post_process_prompt = ?3,
                 word_count = ?4
             WHERE id = ?5",
            params![
                transcription_text,
                post_processed_text,
                post_process_prompt,
                word_count,
                id
            ],
        )?;

        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }

        let mut entry = conn
            .query_row(
                "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
                 FROM transcription_history WHERE id = ?1",
                params![id],
                Self::map_history_entry,
            )?;
        Self::attach_tags_single(&conn, &mut entry);

        debug!("Updated transcription for history entry {}", id);

        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    pub fn cleanup_old_entries(&self) -> Result<()> {
        let retention_period = crate::settings::get_recording_retention_period(&self.app_handle);

        match retention_period {
            crate::settings::RecordingRetentionPeriod::Never => {
                // Don't delete anything
                return Ok(());
            }
            crate::settings::RecordingRetentionPeriod::PreserveLimit => {
                // Use the old count-based logic with history_limit
                let limit = crate::settings::get_history_limit(&self.app_handle);
                return self.cleanup_by_count(limit);
            }
            _ => {
                // Use time-based logic
                return self.cleanup_by_time(retention_period);
            }
        }
    }

    /// Deletes WAV files for the given entries but leaves the `transcription_history`
    /// rows intact so the text stays searchable. Retention settings prune audio only;
    /// the DB row is only removed via explicit user delete.
    fn delete_audio_files(&self, entries: &[(i64, String)]) -> Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        let mut deleted_count = 0;

        for (_id, file_name) in entries {
            let file_path = self.recordings_dir.join(file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete WAV file {}: {}", file_name, e);
                } else {
                    debug!("Deleted old WAV file: {}", file_name);
                    deleted_count += 1;
                }
            }
        }

        Ok(deleted_count)
    }

    fn cleanup_by_count(&self, limit: usize) -> Result<()> {
        let conn = self.get_connection()?;

        // Get all entries that are not saved, ordered by timestamp desc
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 ORDER BY timestamp DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        if entries.len() > limit {
            let entries_to_delete = &entries[limit..];
            let deleted_count = self.delete_audio_files(entries_to_delete)?;

            if deleted_count > 0 {
                debug!("Cleaned up {} old audio recordings by count", deleted_count);
            }
        }

        Ok(())
    }

    fn cleanup_by_time(
        &self,
        retention_period: crate::settings::RecordingRetentionPeriod,
    ) -> Result<()> {
        let conn = self.get_connection()?;

        // Calculate cutoff timestamp (current time minus retention period)
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            crate::settings::RecordingRetentionPeriod::Days3 => now - (3 * 24 * 60 * 60), // 3 days in seconds
            crate::settings::RecordingRetentionPeriod::Weeks2 => now - (2 * 7 * 24 * 60 * 60), // 2 weeks in seconds
            crate::settings::RecordingRetentionPeriod::Months3 => now - (3 * 30 * 24 * 60 * 60), // 3 months in seconds (approximate)
            _ => unreachable!("Should not reach here"),
        };

        // Get all unsaved entries older than the cutoff timestamp
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 AND timestamp < ?1",
        )?;

        let rows = stmt.query_map(params![cutoff_timestamp], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries_to_delete: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries_to_delete.push(row?);
        }

        let deleted_count = self.delete_audio_files(&entries_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old audio recordings based on retention period",
                deleted_count
            );
        }

        Ok(())
    }

    pub async fn get_history_entries(
        &self,
        cursor: Option<i64>,
        limit: Option<usize>,
    ) -> Result<PaginatedHistory> {
        let conn = self.get_connection()?;
        let limit = limit.map(|l| l.min(100));

        let mut entries: Vec<HistoryEntry> = match (cursor, limit) {
            (Some(cursor_id), Some(lim)) => {
                let fetch_count = (lim + 1) as i64;
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
                     FROM transcription_history
                     WHERE id < ?1
                     ORDER BY id DESC
                     LIMIT ?2",
                )?;
                let result = stmt
                    .query_map(params![cursor_id, fetch_count], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
            (None, Some(lim)) => {
                let fetch_count = (lim + 1) as i64;
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
                     FROM transcription_history
                     ORDER BY id DESC
                     LIMIT ?1",
                )?;
                let result = stmt
                    .query_map(params![fetch_count], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
            (_, None) => {
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
                     FROM transcription_history
                     ORDER BY id DESC",
                )?;
                let result = stmt
                    .query_map([], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
        };

        let has_more = limit.is_some_and(|lim| entries.len() > lim);
        if has_more {
            entries.pop();
        }

        Self::attach_tags(&conn, &mut entries);
        Ok(PaginatedHistory { entries, has_more })
    }

    /// Search history using FTS5 full-text search.
    /// Returns up to `limit` entries matching the query, newest first.
    pub async fn search_history_entries(
        &self,
        query: String,
        limit: Option<usize>,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
    ) -> Result<Vec<HistoryEntry>> {
        let conn = self.get_connection()?;
        let limit = limit.unwrap_or(50).min(200) as i64;

        let mut where_clauses = vec!["history_fts MATCH ?".to_string()];
        let mut params_vec: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(query)];

        if let Some(ts) = start_ts {
            where_clauses.push("h.timestamp >= ?".to_string());
            params_vec.push(rusqlite::types::Value::Integer(ts));
        }
        if let Some(ts) = end_ts {
            where_clauses.push("h.timestamp < ?".to_string());
            params_vec.push(rusqlite::types::Value::Integer(ts));
        }

        params_vec.push(rusqlite::types::Value::Integer(limit));

        let sql = format!(
            "SELECT h.id, h.file_name, h.timestamp, h.saved, h.title,
                    h.transcription_text, h.post_processed_text,
                    h.post_process_prompt, h.post_process_requested, h.source_app
             FROM transcription_history h
             JOIN history_fts ON history_fts.rowid = h.id
             WHERE {}
             ORDER BY h.id DESC
             LIMIT ?",
            where_clauses.join(" AND ")
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut entries = stmt
            .query_map(
                rusqlite::params_from_iter(params_vec.iter()),
                Self::map_history_entry,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Self::attach_tags(&conn, &mut entries);
        Ok(entries)
    }

    /// Return entries matching any combination of text query, tag names, and
    /// date range. All filters are optional and additive. Newest first.
    pub async fn filter_history_entries(
        &self,
        query: Option<String>,
        tag_names: Vec<String>,
        limit: Option<usize>,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
    ) -> Result<Vec<HistoryEntry>> {
        let conn = self.get_connection()?;
        let limit = limit.unwrap_or(100).min(500) as i64;
        let text_query = query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let has_tags = !tag_names.is_empty();
        let has_dates = start_ts.is_some() || end_ts.is_some();

        if !has_tags && !has_dates {
            return match text_query {
                Some(q) => {
                    self.search_history_entries(q, Some(limit as usize), None, None)
                        .await
                }
                None => Ok(self
                    .get_history_entries(None, Some(limit as usize))
                    .await?
                    .entries),
            };
        }

        let mut joins = Vec::new();
        let mut where_clauses = Vec::new();
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if has_tags {
            let tag_placeholders = tag_names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            joins.push("JOIN history_tags t ON t.entry_id = h.id".to_string());
            where_clauses.push(format!("LOWER(t.name) IN ({})", tag_placeholders));
            for name in &tag_names {
                params_vec.push(rusqlite::types::Value::Text(name.to_lowercase()));
            }
        }

        if let Some(q) = text_query {
            joins.push("JOIN history_fts ON history_fts.rowid = h.id".to_string());
            where_clauses.push("history_fts MATCH ?".to_string());
            params_vec.push(rusqlite::types::Value::Text(q));
        }

        if let Some(ts) = start_ts {
            where_clauses.push("h.timestamp >= ?".to_string());
            params_vec.push(rusqlite::types::Value::Integer(ts));
        }
        if let Some(ts) = end_ts {
            where_clauses.push("h.timestamp < ?".to_string());
            params_vec.push(rusqlite::types::Value::Integer(ts));
        }

        params_vec.push(rusqlite::types::Value::Integer(limit));

        let distinct = if has_tags { "DISTINCT " } else { "" };
        let where_clause = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!(
            "SELECT {distinct}h.id, h.file_name, h.timestamp, h.saved, h.title, h.user_title,
                    h.transcription_text, h.post_processed_text,
                    h.post_process_prompt, h.post_process_requested, h.source_app
             FROM transcription_history h
             {}
             {}
             ORDER BY h.id DESC
             LIMIT ?",
            joins.join(" "),
            where_clause
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut entries = stmt
            .query_map(
                rusqlite::params_from_iter(params_vec.iter()),
                Self::map_history_entry,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Self::attach_tags(&conn, &mut entries);
        Ok(entries)
    }

    /// Return all distinct tag names across history, sorted alphabetically.
    pub fn list_all_tags(&self) -> Result<Vec<String>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT name FROM history_tags
             GROUP BY LOWER(name)
             ORDER BY LOWER(name)",
        )?;
        let tags = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    /// Add a tag to an entry. `auto = false` for manual tags, `true` for
    /// AI-applied tags. Case-insensitive uniqueness — adding "Meeting" when
    /// "meeting" is already present is a no-op that returns the existing tag.
    pub fn add_tag(&self, entry_id: i64, name: String, auto: bool) -> Result<HistoryTag> {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err(anyhow!("Tag name cannot be empty"));
        }
        if trimmed.len() > 64 {
            return Err(anyhow!("Tag name is too long (max 64 chars)"));
        }
        let conn = self.get_connection()?;
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT OR IGNORE INTO history_tags (entry_id, name, auto, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![entry_id, trimmed, auto, now],
        )?;

        // Emit update for the entry so the UI refreshes its tag chips.
        self.emit_entry_updated(&conn, entry_id);

        Ok(HistoryTag {
            name: trimmed,
            auto,
        })
    }

    pub fn remove_tag(&self, entry_id: i64, name: String) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "DELETE FROM history_tags WHERE entry_id = ?1 AND LOWER(name) = LOWER(?2)",
            params![entry_id, name],
        )?;
        self.emit_entry_updated(&conn, entry_id);
        Ok(())
    }

    /// Remove a tag from every entry in history and drop any rule associated
    /// with it. Used from the filter bar to wipe a tag out of the vocabulary
    /// entirely. Emits an `updated` event for each affected entry so the UI
    /// refreshes tag chips in place.
    pub fn delete_tag_globally(&self, name: String) -> Result<u64> {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err(anyhow!("Tag name cannot be empty"));
        }
        let conn = self.get_connection()?;

        let affected_ids: Vec<i64> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT entry_id FROM history_tags WHERE LOWER(name) = LOWER(?1)",
            )?;
            let rows = stmt
                .query_map(params![&trimmed], |row| row.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };

        let deleted = conn.execute(
            "DELETE FROM history_tags WHERE LOWER(name) = LOWER(?1)",
            params![&trimmed],
        )? as u64;

        // Remove the rule too so a future re-add starts from defaults.
        conn.execute(
            "DELETE FROM tag_rules WHERE name = LOWER(?1)",
            params![&trimmed],
        )?;

        for entry_id in affected_ids {
            self.emit_entry_updated(&conn, entry_id);
        }

        Ok(deleted)
    }


    fn emit_entry_updated(&self, conn: &Connection, entry_id: i64) {
        let entry = conn
            .query_row(
                "SELECT id, file_name, timestamp, saved, title, user_title,
                        transcription_text, post_processed_text,
                        post_process_prompt, post_process_requested, source_app
                 FROM transcription_history WHERE id = ?1",
                params![entry_id],
                Self::map_history_entry,
            )
            .ok();
        if let Some(mut entry) = entry {
            Self::attach_tags_single(conn, &mut entry);
            if let Err(e) = (HistoryUpdatePayload::Updated { entry }).emit(&self.app_handle) {
                error!("Failed to emit history-updated event: {}", e);
            }
        }
    }

    #[cfg(test)]
    fn get_latest_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                user_title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                source_app
             FROM transcription_history
             ORDER BY timestamp DESC
             LIMIT 1",
        )?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    /// Get the latest entry with non-empty transcription text.
    pub fn get_latest_completed_entry(&self) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        Self::get_latest_completed_entry_with_conn(&conn)
    }

    fn get_latest_completed_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                user_title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                source_app
             FROM transcription_history
             WHERE transcription_text != ''
             ORDER BY timestamp DESC
             LIMIT 1",
        )?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    pub async fn update_user_title(
        &self,
        id: i64,
        user_title: Option<String>,
    ) -> Result<HistoryEntry> {
        let conn = self.get_connection()?;
        let trimmed = user_title
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let updated = conn.execute(
            "UPDATE transcription_history SET user_title = ?1 WHERE id = ?2",
            params![trimmed, id],
        )?;

        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }

        let mut entry = conn.query_row(
            "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
             FROM transcription_history WHERE id = ?1",
            params![id],
            Self::map_history_entry,
        )?;
        Self::attach_tags_single(&conn, &mut entry);

        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    pub async fn toggle_saved_status(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get current saved status
        let current_saved: bool = conn.query_row(
            "SELECT saved FROM transcription_history WHERE id = ?1",
            params![id],
            |row| row.get("saved"),
        )?;

        let new_saved = !current_saved;

        conn.execute(
            "UPDATE transcription_history SET saved = ?1 WHERE id = ?2",
            params![new_saved, id],
        )?;

        debug!("Toggled saved status for entry {}: {}", id, new_saved);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Toggled { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn get_entry_by_id(&self, id: i64) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                user_title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                source_app
             FROM transcription_history
             WHERE id = ?1",
        )?;

        let entry = stmt.query_row([id], Self::map_history_entry).optional()?;
        let entry = match entry {
            Some(mut e) => {
                Self::attach_tags_single(&conn, &mut e);
                Some(e)
            }
            None => None,
        };

        Ok(entry)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get the entry to find the file name
        if let Some(entry) = self.get_entry_by_id(id).await? {
            // Delete the audio file first
            let file_path = self.get_audio_file_path(&entry.file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete audio file {}: {}", entry.file_name, e);
                    // Continue with database deletion even if file deletion fails
                }
            }
        }

        // foreign_keys pragma is ON, so ON DELETE CASCADE handles history_tags.
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )?;

        debug!("Deleted history entry with id: {}", id);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Deleted { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    /// Delete many history rows in a single transaction over one SQLite
    /// connection. Replaces the previous pattern of firing N parallel
    /// `delete_entry` calls, which opened N connections and occasionally lost
    /// writes under contention (pragma races and fd pressure).
    pub fn bulk_delete_entries(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;

        // Collect file names first so we can remove WAVs after the DB commit.
        let mut file_names: Vec<String> = Vec::with_capacity(ids.len());
        {
            let mut select_stmt =
                tx.prepare("SELECT file_name FROM transcription_history WHERE id = ?1")?;
            let mut delete_stmt = tx.prepare("DELETE FROM transcription_history WHERE id = ?1")?;
            for &id in ids {
                if let Some(name) = select_stmt
                    .query_row(params![id], |row| row.get::<_, String>(0))
                    .optional()?
                {
                    file_names.push(name);
                }
                // ON DELETE CASCADE cleans up history_tags.
                delete_stmt.execute(params![id])?;
            }
        }

        tx.commit()?;

        // File removal is best-effort; a failure here leaves an orphan WAV but
        // the DB row is already gone, so the UI won't surface it.
        for file_name in &file_names {
            let file_path = self.get_audio_file_path(file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete audio file {}: {}", file_name, e);
                }
            }
        }

        debug!("Bulk deleted {} history entries", ids.len());

        for &id in ids {
            if let Err(e) = (HistoryUpdatePayload::Deleted { id }).emit(&self.app_handle) {
                error!("Failed to emit history-updated event: {}", e);
            }
        }

        Ok(())
    }

    pub fn get_word_corrections(&self) -> Result<Vec<WordCorrection>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, wrong, correct, enabled, created_at FROM word_corrections ORDER BY created_at DESC",
        )?;
        let corrections = stmt
            .query_map([], |row| {
                Ok(WordCorrection {
                    id: row.get("id")?,
                    wrong: row.get("wrong")?,
                    correct: row.get("correct")?,
                    enabled: row.get("enabled")?,
                    created_at: row.get("created_at")?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(corrections)
    }

    pub fn upsert_word_correction(&self, wrong: String, correct: String) -> Result<WordCorrection> {
        let conn = self.get_connection()?;
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO word_corrections (wrong, correct, enabled, created_at)
             VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(wrong) DO UPDATE SET correct = excluded.correct, enabled = 1",
            params![wrong, correct, now],
        )?;
        let id = conn.last_insert_rowid();
        // If ON CONFLICT path triggered, last_insert_rowid may be 0; fetch by wrong
        let correction = conn.query_row(
            "SELECT id, wrong, correct, enabled, created_at FROM word_corrections WHERE wrong = ?1",
            params![wrong],
            |row| {
                Ok(WordCorrection {
                    id: row.get("id")?,
                    wrong: row.get("wrong")?,
                    correct: row.get("correct")?,
                    enabled: row.get("enabled")?,
                    created_at: row.get("created_at")?,
                })
            },
        )?;
        let _ = id;
        Ok(correction)
    }

    pub fn toggle_word_correction(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE word_corrections SET enabled = NOT enabled WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn delete_word_correction(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute("DELETE FROM word_corrections WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Apply all enabled word corrections to the given text.
    /// Each correction is applied as a case-insensitive word-boundary replacement.
    pub fn apply_word_corrections(&self, text: &str) -> String {
        let corrections = match self.get_word_corrections() {
            Ok(c) => c,
            Err(_) => return text.to_string(),
        };

        let mut result = text.to_string();
        for correction in corrections.iter().filter(|c| c.enabled) {
            let escaped = regex::escape(&correction.wrong);
            // Match at word boundaries: preceded/followed by non-alphanumeric or start/end
            let pattern = format!(r"(?i)(?<![a-zA-Z0-9]){}(?![a-zA-Z0-9])", escaped);
            if let Ok(re) = Regex::new(&pattern) {
                result = re
                    .replace_all(&result, correction.correct.as_str())
                    .to_string();
            }
        }
        result
    }

    pub async fn get_all_history_for_export(&self) -> Result<Vec<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, user_title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, source_app
             FROM transcription_history
             ORDER BY id DESC",
        )?;
        let mut entries = stmt
            .query_map([], Self::map_history_entry)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Self::attach_tags(&conn, &mut entries);
        Ok(entries)
    }

    /// Read the duration of a WAV file in the recordings directory without
    /// decoding samples. Returns `None` if the file is missing or unreadable,
    /// which is expected when the caller saves an empty/failed entry before a
    /// WAV was written.
    fn read_wav_duration_ms(&self, file_name: &str) -> Option<i64> {
        let path = self.recordings_dir.join(file_name);
        let reader = hound::WavReader::open(&path).ok()?;
        let spec = reader.spec();
        let sample_rate = spec.sample_rate as u64;
        if sample_rate == 0 {
            return None;
        }
        let frames = reader.duration() as u64;
        Some(((frames * 1000) / sample_rate) as i64)
    }

    /// Compute lifetime transcription statistics, persist any newly-earned
    /// badges with the current timestamp, and return the full set of earned
    /// badges with their unlock dates. Delegates to [`compute_stats`] for the
    /// derivation logic and [`persist_badge_unlocks`] for storage.
    /// Achievements view. Merges DB-derived per-row badge signals (temporal
    /// clusters, content predicates, post-process/save counts) with the
    /// monotonic counters from `UsageManager` so top-level numbers and the
    /// count/duration/longest-based badges survive note deletion and app
    /// reinstall. Pass the caller's current
    /// [`crate::managers::usage::LifetimeAchievementCounters`] snapshot.
    pub fn get_stats(
        &self,
        counters: crate::managers::usage::LifetimeAchievementCounters,
    ) -> Result<TranscriptionStats> {
        let conn = self.get_connection()?;
        let mut stats = compute_stats(&conn)?;
        // Keychain counters are authoritative for the cumulative display
        // values and for badge thresholds that only depend on those totals.
        // DB-derived numbers remain the fallback when keychain values are
        // smaller (e.g. brand-new install that hasn't recorded anything yet
        // but has migrated history entries — the startup backfill should
        // have seeded the keychain from the DB, so this `max` is belt-and-
        // suspenders).
        stats.total_words = stats.total_words.max(counters.total_words);
        stats.total_duration_ms = stats
            .total_duration_ms
            .max(counters.total_seconds.saturating_mul(1000));
        stats.transcription_count = stats.transcription_count.max(counters.transcription_count);
        stats.longest_transcription_words = stats
            .longest_transcription_words
            .max(counters.longest_transcription_words);
        augment_badges_from_counters(
            &mut stats.earned_badges,
            stats.transcription_count,
            stats.total_duration_ms,
            stats.longest_transcription_words,
        );
        let earned_badges = persist_badge_unlocks(&conn, &stats.earned_badges)?;
        stats.earned_badges = earned_badges;
        Ok(stats)
    }

    /// Current row-count and max-word-count in the history DB. Used once at
    /// startup to seed the v3 achievements counters in the keychain
    /// [`crate::managers::usage::UsageManager`] for users upgrading from a
    /// build that tracked those stats only in the DB.
    pub fn achievements_backfill_seed(&self) -> Result<(u64, u64)> {
        let conn = self.get_connection()?;
        let (count, longest): (u64, u64) = conn.query_row(
            "SELECT
                COUNT(*) AS cnt,
                COALESCE(MAX(word_count), 0) AS longest
             FROM transcription_history
             WHERE transcription_text != ''",
            [],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )?;
        Ok((count, longest))
    }

    fn format_timestamp_title(&self, timestamp: i64) -> String {
        if let Some(utc_datetime) = DateTime::from_timestamp(timestamp, 0) {
            // Convert UTC to local timezone
            let local_datetime = utc_datetime.with_timezone(&Local);
            local_datetime.format("%B %e, %Y - %l:%M%p").to_string()
        } else {
            format!("Recording {}", timestamp)
        }
    }
}

/// Count words using Unicode Standard Annex #29 word boundaries. Unlike
/// `split_whitespace`, `unicode_words()` segments scripts that do not delimit
/// words with spaces (Chinese, Japanese, Thai, etc.), so CJK transcriptions
/// are counted in line with their actual content rather than as a single
/// token. It also strips punctuation, giving identical results to
/// whitespace splitting for punctuated English text.
fn count_words(text: &str) -> u64 {
    use unicode_segmentation::UnicodeSegmentation;
    text.unicode_words().count() as u64
}

/// Background task that generates an AI title and tags for a freshly-saved
/// history entry. Silently no-ops when the user hasn't configured an AI
/// provider/model — errors are logged at warn level, never surfaced, since
/// this is an opportunistic enhancement on top of the save.
async fn run_auto_metadata(
    app_handle: AppHandle,
    entry_id: i64,
    transcription: String,
    post_processed: Option<String>,
) {
    let source_text = post_processed
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(transcription.as_str());
    if source_text.trim().is_empty() {
        return;
    }

    let settings = crate::settings::get_settings(&app_handle);
    let hm = app_handle.state::<Arc<HistoryManager>>();
    let existing_tags = match hm.list_all_tags() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("Auto-metadata: failed to list tags: {}", e);
            return;
        }
    };

    let generated = match crate::ai_metadata::generate(&settings, source_text, &existing_tags).await
    {
        Some(g) => g,
        None => return,
    };

    if let Err(e) = hm.update_user_title(entry_id, Some(generated.title)).await {
        log::warn!("Auto-metadata: failed to set title: {}", e);
    }
    for tag in generated.tags {
        if let Err(e) = hm.add_tag(entry_id, tag, true) {
            log::warn!("Auto-metadata: failed to add tag: {}", e);
        }
    }
}

/// Core derivation routine behind [`HistoryManager::get_stats`]. Takes a bare
/// rusqlite `Connection` so the logic can be unit-tested against an in-memory
/// database without dragging in Tauri app state.
///
/// The implementation favours SQL aggregates (SUM/MAX/COUNT) for everything
/// that can be reduced in the database, and only streams the minimal set of
/// per-row signals (timestamp + two boolean predicates) needed for badges
/// that depend on temporal clustering. This keeps the query cost proportional
/// to *the size of the ids table index*, not to the size of
/// `transcription_text` — important for users with large histories.
pub(crate) fn compute_stats(conn: &Connection) -> Result<TranscriptionStats> {
    use chrono::Timelike;

    // Aggregates computed entirely in SQLite. The `word_count` column is
    // populated at save time and backfilled at startup (`backfill_word_counts`)
    // so `SUM(word_count)` is exact for all rows created after the migration.
    let (
        count,
        total_words,
        longest_words,
        total_duration_ms,
        post_processed_count,
        saved_count,
        first_ts,
        latest_ts,
    ): (u64, u64, u64, u64, u64, u64, Option<i64>, Option<i64>) = conn.query_row(
        "SELECT
            COUNT(*) AS cnt,
            COALESCE(SUM(word_count), 0) AS total_words,
            COALESCE(MAX(word_count), 0) AS longest,
            COALESCE(SUM(audio_duration_ms), 0) AS total_dur,
            COALESCE(SUM(CASE WHEN post_process_requested THEN 1 ELSE 0 END), 0) AS pp_cnt,
            COALESCE(SUM(CASE WHEN saved THEN 1 ELSE 0 END), 0) AS saved_cnt,
            MIN(timestamp) AS first_ts,
            MAX(timestamp) AS latest_ts
         FROM transcription_history
         WHERE transcription_text != ''",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)? as u64,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        },
    )?;

    // Per-row signals for temporal badges. Note that the suffix predicates
    // are evaluated in SQL — only `timestamp` and two booleans cross the
    // rusqlite boundary, regardless of how long the transcription is.
    let mut stmt = conn.prepare(
        "SELECT
            timestamp,
            CASE WHEN rtrim(transcription_text) LIKE '%?' THEN 1 ELSE 0 END AS ends_q,
            CASE WHEN instr(transcription_text, '!') > 0 THEN 1 ELSE 0 END AS has_ex
         FROM transcription_history
         WHERE transcription_text != ''
         ORDER BY timestamp ASC",
    )?;

    let mut ends_with_question: u64 = 0;
    let mut contains_exclamation: u64 = 0;
    let mut hours_seen: u32 = 0; // bitmask of local hours observed
    let mut weekdays_seen: u8 = 0; // bitmask of weekdays observed (Mon=bit 0 … Sun=bit 6)
    let mut sorted_timestamps: Vec<i64> = Vec::new();

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)? != 0,
            row.get::<_, i64>(2)? != 0,
        ))
    })?;
    for row in rows {
        let (ts, ends_q, has_ex) = row?;
        if ends_q {
            ends_with_question += 1;
        }
        if has_ex {
            contains_exclamation += 1;
        }
        // Time-of-day and weekday use the viewer's current local timezone.
        // A user who travels after recording may see retroactive changes;
        // this matches the intuitive "what hour is this entry?" reading a
        // user expects when inspecting history while abroad.
        if let Some(dt) = DateTime::from_timestamp(ts, 0) {
            let local = dt.with_timezone(&Local);
            hours_seen |= 1u32 << local.hour();
            weekdays_seen |= 1u8 << local.weekday().num_days_from_monday();
        }
        sorted_timestamps.push(ts);
    }

    // Timestamps already arrive sorted thanks to the ORDER BY clause.
    let sprint = has_window(&sorted_timestamps, 60 * 60, 10);

    let word_correction_count: u64 = conn
        .query_row("SELECT COUNT(*) FROM word_corrections", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        .max(0) as u64;

    let mut badge_ids: Vec<BadgeId> = Vec::new();
    if count >= 1 {
        badge_ids.push(BadgeId::FirstWords);
    }
    if count >= 10 {
        badge_ids.push(BadgeId::GettingStarted);
    }
    if count >= 100 {
        badge_ids.push(BadgeId::Regular);
    }
    if count >= 1_000 {
        badge_ids.push(BadgeId::Devoted);
    }
    if longest_words >= 250 {
        badge_ids.push(BadgeId::Paragraph);
    }
    if longest_words >= 2_000 {
        badge_ids.push(BadgeId::Marathon);
    }
    if total_duration_ms >= 60 * 60 * 1_000 {
        badge_ids.push(BadgeId::OneHourClub);
    }
    if total_duration_ms >= 10 * 60 * 60 * 1_000 {
        badge_ids.push(BadgeId::TenHourClub);
    }
    if post_processed_count >= 10 {
        badge_ids.push(BadgeId::PostProcessor);
    }
    if saved_count >= 10 {
        badge_ids.push(BadgeId::Collector);
    }
    if word_correction_count >= 5 {
        badge_ids.push(BadgeId::Lexicographer);
    }
    let any_hour_in =
        |range: std::ops::Range<u32>| range.into_iter().any(|h| (hours_seen >> h) & 1 == 1);
    if any_hour_in(5..7) {
        badge_ids.push(BadgeId::EarlyBird);
    }
    if any_hour_in(22..24) || any_hour_in(0..4) {
        badge_ids.push(BadgeId::NightOwl);
    }
    if any_hour_in(12..13) {
        badge_ids.push(BadgeId::LunchBreak);
    }
    if weekdays_seen == 0b0111_1111 {
        badge_ids.push(BadgeId::EveryDayOfTheWeek);
    }
    if sprint {
        badge_ids.push(BadgeId::Sprint);
    }
    if ends_with_question >= 50 {
        badge_ids.push(BadgeId::Questioner);
    }
    if contains_exclamation >= 50 {
        badge_ids.push(BadgeId::Exclaimer);
    }

    // Build EarnedBadge list with placeholder timestamps (0). The real
    // unlock timestamps are filled in by `persist_badge_unlocks` when
    // called from `get_stats`.
    let earned_badges = badge_ids
        .into_iter()
        .map(|id| EarnedBadge { id, unlocked_at: 0 })
        .collect();

    Ok(TranscriptionStats {
        total_words,
        total_duration_ms,
        transcription_count: count,
        longest_transcription_words: longest_words,
        first_transcription_timestamp: first_ts,
        latest_transcription_timestamp: latest_ts,
        earned_badges,
    })
}

/// Append any badges whose thresholds are cleared by the top-level
/// monotonic counters (transcription count, total duration, longest
/// transcription) without removing badges already in `badges`. This keeps
/// count/duration/longest-based unlocks coherent with the keychain-backed
/// counters even when the underlying DB rows have been deleted.
fn augment_badges_from_counters(
    badges: &mut Vec<EarnedBadge>,
    transcription_count: u64,
    total_duration_ms: u64,
    longest_transcription_words: u64,
) {
    let mut add = |id: BadgeId| {
        if !badges.iter().any(|b| b.id == id) {
            badges.push(EarnedBadge { id, unlocked_at: 0 });
        }
    };
    if transcription_count >= 1 {
        add(BadgeId::FirstWords);
    }
    if transcription_count >= 10 {
        add(BadgeId::GettingStarted);
    }
    if transcription_count >= 100 {
        add(BadgeId::Regular);
    }
    if transcription_count >= 1_000 {
        add(BadgeId::Devoted);
    }
    if longest_transcription_words >= 250 {
        add(BadgeId::Paragraph);
    }
    if longest_transcription_words >= 2_000 {
        add(BadgeId::Marathon);
    }
    if total_duration_ms >= 60 * 60 * 1_000 {
        add(BadgeId::OneHourClub);
    }
    if total_duration_ms >= 10 * 60 * 60 * 1_000 {
        add(BadgeId::TenHourClub);
    }
}

/// Persist newly-earned badges into the `badge_unlocks` table with the current
/// timestamp, then return the full set of stored unlocks. Once a badge has
/// been recorded, it stays earned even if the underlying DB state later
/// regresses (notes deleted, word corrections removed, etc.). Existing rows
/// are never overwritten (INSERT OR IGNORE), so the first-ever unlock time
/// is preserved.
fn persist_badge_unlocks(conn: &Connection, computed: &[EarnedBadge]) -> Result<Vec<EarnedBadge>> {
    let now = Utc::now().timestamp();
    let mut insert_stmt = conn
        .prepare("INSERT OR IGNORE INTO badge_unlocks (badge_id, unlocked_at) VALUES (?1, ?2)")?;
    for badge in computed {
        let id_str = badge_id_to_key(&badge.id);
        insert_stmt.execute(params![id_str, now])?;
    }

    // Read back every stored unlock and deserialize the key back into a
    // BadgeId. Unknown keys (e.g. rows left over from an older build that
    // shipped a badge we've since removed) are skipped silently.
    let mut read_stmt = conn.prepare("SELECT badge_id, unlocked_at FROM badge_unlocks")?;
    let rows = read_stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut result: Vec<EarnedBadge> = Vec::new();
    for row in rows {
        let (id_str, unlocked_at) = row?;
        if let Some(id) = key_to_badge_id(&id_str) {
            result.push(EarnedBadge { id, unlocked_at });
        }
    }
    Ok(result)
}

fn badge_id_to_key(id: &BadgeId) -> String {
    serde_json::to_string(id)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

fn key_to_badge_id(key: &str) -> Option<BadgeId> {
    serde_json::from_str::<BadgeId>(&format!("\"{}\"", key)).ok()
}

/// One-time backfill of the `word_count` column for rows that pre-date its
/// introduction. Idempotent: only touches rows where `word_count IS NULL`, so
/// subsequent calls are essentially free once the backfill has completed.
///
/// Runs inside a single transaction so a mid-flight crash leaves the table in
/// a consistent state — either every row is populated or the work rolls back.
pub(crate) fn backfill_word_counts(conn: &Connection) -> Result<()> {
    let pending: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, transcription_text FROM transcription_history WHERE word_count IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    if pending.is_empty() {
        return Ok(());
    }

    log::info!(
        "Backfilling word_count for {} legacy history rows",
        pending.len()
    );

    conn.execute("BEGIN", [])?;
    let result: Result<()> = (|| {
        let mut stmt =
            conn.prepare("UPDATE transcription_history SET word_count = ?1 WHERE id = ?2")?;
        for (id, text) in &pending {
            stmt.execute(params![count_words(text) as i64, id])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute("COMMIT", [])?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Returns true if `sorted_ts` contains at least `min_count` entries falling
/// within any sliding window of `window_secs` seconds. Expects the slice to be
/// sorted in ascending order.
fn has_window(sorted_ts: &[i64], window_secs: i64, min_count: usize) -> bool {
    if sorted_ts.len() < min_count || min_count == 0 {
        return false;
    }
    let mut left = 0usize;
    for right in 0..sorted_ts.len() {
        while sorted_ts[right] - sorted_ts[left] > window_secs {
            left += 1;
        }
        if right - left + 1 >= min_count {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE transcription_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                saved BOOLEAN NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                user_title TEXT,
                transcription_text TEXT NOT NULL,
                post_processed_text TEXT,
                post_process_prompt TEXT,
                post_process_requested BOOLEAN NOT NULL DEFAULT 0,
                audio_duration_ms INTEGER,
                word_count INTEGER,
                source_app TEXT
            );
            CREATE TABLE word_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wrong TEXT NOT NULL UNIQUE,
                correct TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE badge_unlocks (
                badge_id TEXT PRIMARY KEY,
                unlocked_at INTEGER NOT NULL
            );",
        )
        .expect("create test tables");
        conn
    }

    fn insert_entry(conn: &Connection, timestamp: i64, text: &str, post_processed: Option<&str>) {
        insert_full_entry(conn, timestamp, text, post_processed, None, false, false);
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_full_entry(
        conn: &Connection,
        timestamp: i64,
        text: &str,
        post_processed: Option<&str>,
        audio_duration_ms: Option<i64>,
        post_process_requested: bool,
        saved: bool,
    ) {
        // Mirror the production path: populate `word_count` at insert so
        // the SQL aggregates in `compute_stats` exercise the happy path.
        let word_count = count_words(text) as i64;
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                audio_duration_ms,
                word_count
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                format!("ghostly-{}.wav", timestamp),
                timestamp,
                saved,
                format!("Recording {}", timestamp),
                text,
                post_processed,
                Option::<String>::None,
                post_process_requested,
                audio_duration_ms,
                word_count,
            ],
        )
        .expect("insert history entry");
    }

    /// Insert a row with `word_count` deliberately left NULL, matching
    /// pre-migration rows. Used by backfill tests.
    fn insert_legacy_entry(conn: &Connection, timestamp: i64, text: &str) {
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_process_requested
            ) VALUES (?1, ?2, 0, ?3, ?4, 0)",
            params![
                format!("ghostly-{}.wav", timestamp),
                timestamp,
                format!("Recording {}", timestamp),
                text,
            ],
        )
        .expect("insert legacy history entry");
    }

    #[test]
    fn get_latest_entry_returns_none_when_empty() {
        let conn = setup_conn();
        let entry = HistoryManager::get_latest_entry_with_conn(&conn).expect("fetch latest entry");
        assert!(entry.is_none());
    }

    #[test]
    fn get_latest_entry_returns_newest_entry() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "first", None);
        insert_entry(&conn, 200, "second", Some("processed"));

        let entry = HistoryManager::get_latest_entry_with_conn(&conn)
            .expect("fetch latest entry")
            .expect("entry exists");

        assert_eq!(entry.timestamp, 200);
        assert_eq!(entry.transcription_text, "second");
        assert_eq!(entry.post_processed_text.as_deref(), Some("processed"));
    }

    #[test]
    fn get_latest_completed_entry_skips_empty_entries() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "completed", None);
        insert_entry(&conn, 200, "", None);

        let entry = HistoryManager::get_latest_completed_entry_with_conn(&conn)
            .expect("fetch latest completed entry")
            .expect("completed entry exists");

        assert_eq!(entry.timestamp, 100);
        assert_eq!(entry.transcription_text, "completed");
    }

    // ----------------------------------------------------------------------
    // Stats derivation
    // ----------------------------------------------------------------------

    #[test]
    fn count_words_handles_edge_cases() {
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   \t\n "), 0);
        assert_eq!(count_words("hello"), 1);
        assert_eq!(count_words("  hello  world  "), 2);
        assert_eq!(count_words("one two three four"), 4);
        assert_eq!(count_words("hello, world!"), 2);
        assert_eq!(count_words("uno\u{00A0}dos\u{00A0}tres"), 3);
        // Contractions are a single word under UAX #29 word segmentation.
        assert_eq!(count_words("don't stop"), 2);
        // Numbers and alphanumerics count as words.
        assert_eq!(count_words("room 42 is open"), 4);
    }

    #[test]
    fn count_words_counts_cjk_transcriptions_as_nonzero() {
        // UAX #29 segmentation produces at least one word for any non-empty
        // CJK string — the precise count depends on script-specific rules we
        // deliberately don't pin here, since the important property for the
        // achievements surface is simply "doesn't under-count to zero."
        assert!(count_words("你好世界") >= 2);
        assert!(count_words("今日はいい天気ですね") >= 2);
        // Mixed Latin + Han: contributes at least the English word count.
        assert!(count_words("hello 你好 world 世界") >= 3);
    }

    #[test]
    fn has_window_rejects_too_few_entries() {
        assert!(!has_window(&[], 60, 1));
        assert!(!has_window(&[1, 2, 3], 60, 4));
        // min_count == 0 is treated as a degenerate query: never matches.
        assert!(!has_window(&[1, 2, 3], 60, 0));
    }

    #[test]
    fn has_window_detects_cluster_inside_window() {
        // 10 entries within 50 minutes → qualifies for a 60-minute Sprint.
        let ts: Vec<i64> = (0..10).map(|i| i * 5 * 60).collect();
        assert!(has_window(&ts, 60 * 60, 10));
    }

    #[test]
    fn has_window_rejects_spread_entries() {
        // 10 entries spaced 10 minutes apart span 90 minutes total →
        // no 60-minute window contains all 10.
        let ts: Vec<i64> = (0..10).map(|i| i * 10 * 60).collect();
        assert!(!has_window(&ts, 60 * 60, 10));
    }

    #[test]
    fn has_window_slides_to_find_cluster() {
        // A cold-start burst (9 isolated entries) followed by a dense cluster
        // of 10 entries should still match; we must slide past the early ones.
        let mut ts: Vec<i64> = (0..9).map(|i| i * 86_400).collect(); // 9 days apart
        let base = 100 * 86_400;
        ts.extend((0..10).map(|i| base + i * 30)); // 10 entries in 5 minutes
        ts.sort_unstable();
        assert!(has_window(&ts, 60 * 60, 10));
    }

    // Build a stable epoch timestamp for `day` (0-based, Monday = 0) at
    // `hour:minute` UTC. Using UTC-only fixtures keeps the test independent of
    // whatever timezone the host machine happens to be in when CI runs.
    fn utc_ts(day: u32, hour: u32, minute: u32) -> i64 {
        use chrono::{NaiveDate, NaiveDateTime, TimeZone};
        // 2026-04-06 is a Monday in the Gregorian calendar, giving us a fixed
        // anchor so the weekday-bit assertions below don't drift.
        let anchor = NaiveDate::from_ymd_opt(2026, 4, 6).unwrap();
        let date = anchor + chrono::Duration::days(day as i64);
        let dt = NaiveDateTime::new(
            date,
            chrono::NaiveTime::from_hms_opt(hour, minute, 0).unwrap(),
        );
        chrono::Utc.from_utc_datetime(&dt).timestamp()
    }

    #[test]
    fn compute_stats_is_empty_for_empty_db() {
        let conn = setup_conn();
        let stats = compute_stats(&conn).expect("compute_stats succeeds on empty db");
        assert_eq!(stats.total_words, 0);
        assert_eq!(stats.total_duration_ms, 0);
        assert_eq!(stats.transcription_count, 0);
        assert_eq!(stats.longest_transcription_words, 0);
        assert_eq!(stats.first_transcription_timestamp, None);
        assert_eq!(stats.latest_transcription_timestamp, None);
        assert!(stats.earned_badges.is_empty());
    }

    #[test]
    fn compute_stats_skips_empty_transcriptions() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "", None);
        insert_entry(&conn, 200, "hello world", None);
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert_eq!(stats.transcription_count, 1);
        assert_eq!(stats.total_words, 2);
    }

    #[test]
    fn compute_stats_aggregates_counts_and_duration() {
        let conn = setup_conn();
        insert_full_entry(&conn, 100, "one two three", None, Some(1_500), false, false);
        insert_full_entry(&conn, 200, "four five", None, Some(2_500), false, false);
        insert_full_entry(&conn, 300, "six", None, None, false, false);

        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert_eq!(stats.transcription_count, 3);
        assert_eq!(stats.total_words, 6);
        assert_eq!(stats.longest_transcription_words, 3);
        // Rows with NULL duration contribute 0, not an error.
        assert_eq!(stats.total_duration_ms, 4_000);
        assert_eq!(stats.first_transcription_timestamp, Some(100));
        assert_eq!(stats.latest_transcription_timestamp, Some(300));
    }

    #[test]
    fn compute_stats_awards_first_words_and_getting_started() {
        let conn = setup_conn();
        for i in 0..10 {
            insert_entry(&conn, 100 + i, "hello", None);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::FirstWords));
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::GettingStarted));
        assert!(!stats.earned_badges.iter().any(|b| b.id == BadgeId::Regular));
    }

    #[test]
    fn compute_stats_awards_marathon_on_single_long_transcription() {
        let conn = setup_conn();
        let long: String = std::iter::repeat("word")
            .take(2_100)
            .collect::<Vec<_>>()
            .join(" ");
        insert_entry(&conn, 100, &long, None);
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Paragraph));
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Marathon));
    }

    #[test]
    fn compute_stats_awards_one_hour_club_only_after_threshold() {
        let conn = setup_conn();
        // 30 minutes of audio: below the one-hour threshold.
        insert_full_entry(
            &conn,
            100,
            "hello",
            None,
            Some(30 * 60 * 1_000),
            false,
            false,
        );
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(!stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::OneHourClub));

        // Push to exactly one hour: threshold is inclusive.
        insert_full_entry(
            &conn,
            200,
            "hello",
            None,
            Some(30 * 60 * 1_000),
            false,
            false,
        );
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::OneHourClub));
        assert!(!stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::TenHourClub));
    }

    #[test]
    fn compute_stats_awards_post_processor_and_collector() {
        let conn = setup_conn();
        for i in 0..10 {
            insert_full_entry(&conn, 100 + i, "hello", None, None, true, false);
        }
        for i in 0..10 {
            insert_full_entry(&conn, 500 + i, "hello", None, None, false, true);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::PostProcessor));
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Collector));
    }

    #[test]
    fn compute_stats_awards_lexicographer_from_word_corrections() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "hello", None);
        for (i, (wrong, correct)) in [
            ("teh", "the"),
            ("recieve", "receive"),
            ("seperate", "separate"),
            ("occured", "occurred"),
            ("definately", "definitely"),
        ]
        .iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO word_corrections (wrong, correct, enabled, created_at) VALUES (?1, ?2, 1, ?3)",
                params![wrong, correct, 1000 + i as i64],
            )
            .expect("insert word correction");
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Lexicographer));
    }

    #[test]
    fn compute_stats_awards_sprint_on_dense_cluster() {
        let conn = setup_conn();
        // 10 entries within 5 minutes (base timestamp picked so we also
        // incidentally exercise the weekday bitmask path).
        let base = utc_ts(0, 14, 0);
        for i in 0..10 {
            insert_entry(&conn, base + i * 30, "hello", None);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats.earned_badges.iter().any(|b| b.id == BadgeId::Sprint));
    }

    #[test]
    fn compute_stats_does_not_award_sprint_when_spaced_out() {
        let conn = setup_conn();
        // 10 entries, each 10 minutes apart — spans 90 minutes, exceeds
        // the 60-minute window, so no Sprint badge.
        let base = utc_ts(0, 14, 0);
        for i in 0..10 {
            insert_entry(&conn, base + i * 10 * 60, "hello", None);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(!stats.earned_badges.iter().any(|b| b.id == BadgeId::Sprint));
    }

    #[test]
    fn compute_stats_awards_every_day_only_when_all_seven_seen() {
        let conn = setup_conn();
        // Six days: should not earn the badge yet.
        for day in 0..6 {
            insert_entry(&conn, utc_ts(day, 12, 0), "hello", None);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(!stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::EveryDayOfTheWeek));

        // Adding the seventh distinct weekday should unlock it.
        insert_entry(&conn, utc_ts(6, 12, 0), "hello", None);
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::EveryDayOfTheWeek));
    }

    #[test]
    fn compute_stats_awards_question_and_exclamation_badges_at_threshold() {
        let conn = setup_conn();
        // 50 question-ending entries → Questioner.
        for i in 0..50 {
            insert_entry(&conn, 1_000 + i, "are we there yet?", None);
        }
        // 50 exclamation entries → Exclaimer.
        for i in 0..50 {
            insert_entry(&conn, 2_000 + i, "wow amazing work!", None);
        }
        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Questioner));
        assert!(stats
            .earned_badges
            .iter()
            .any(|b| b.id == BadgeId::Exclaimer));
    }

    #[test]
    fn backfill_populates_null_word_counts_and_is_idempotent() {
        let conn = setup_conn();
        insert_legacy_entry(&conn, 100, "hello world");
        insert_legacy_entry(&conn, 200, "one two three four");
        insert_full_entry(&conn, 300, "existing", None, None, false, false);

        // Before backfill, legacy rows have NULL word_count.
        let null_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transcription_history WHERE word_count IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(null_count, 2);

        backfill_word_counts(&conn).expect("backfill succeeds");

        let null_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transcription_history WHERE word_count IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(null_count, 0);

        let stats = compute_stats(&conn).expect("compute_stats succeeds");
        assert_eq!(stats.total_words, 2 + 4 + 1);
        assert_eq!(stats.longest_transcription_words, 4);

        // Second invocation is a no-op but must not error.
        backfill_word_counts(&conn).expect("idempotent backfill");
    }

    /// A static guard against badge-catalog drift: if a new variant is added
    /// to [`BadgeId`], this test fails until the corresponding snake_case
    /// identifier is added to the assertion list, forcing the reviewer to
    /// also update the frontend `BADGES` list that renders labels and icons.
    #[test]
    fn badge_id_wire_format_is_stable() {
        // Every variant → expected snake_case serialization.
        let cases = [
            (BadgeId::FirstWords, "first_words"),
            (BadgeId::GettingStarted, "getting_started"),
            (BadgeId::Regular, "regular"),
            (BadgeId::Devoted, "devoted"),
            (BadgeId::Paragraph, "paragraph"),
            (BadgeId::Marathon, "marathon"),
            (BadgeId::OneHourClub, "one_hour_club"),
            (BadgeId::TenHourClub, "ten_hour_club"),
            (BadgeId::PostProcessor, "post_processor"),
            (BadgeId::Collector, "collector"),
            (BadgeId::Lexicographer, "lexicographer"),
            (BadgeId::EarlyBird, "early_bird"),
            (BadgeId::NightOwl, "night_owl"),
            (BadgeId::LunchBreak, "lunch_break"),
            (BadgeId::EveryDayOfTheWeek, "every_day_of_the_week"),
            (BadgeId::Sprint, "sprint"),
            (BadgeId::Questioner, "questioner"),
            (BadgeId::Exclaimer, "exclaimer"),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).expect("serde");
            assert_eq!(json, format!("\"{}\"", expected));
        }
    }
}
