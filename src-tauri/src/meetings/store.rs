//! SQLite persistence for meetings.
//!
//! Shares `history.db` with [`crate::managers::history`] — the schema lives in
//! that module's `MIGRATIONS` array so there is exactly one migration sequence
//! for the app. Connections are opened per call with the same pragmas
//! `HistoryManager` uses; WAL plus a 5 s busy timeout makes the concurrent
//! reader (the panel) and writer (the capture worker) safe without a shared
//! mutex.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use tauri::AppHandle;

use super::types::{
    DetectionSource, LabelSource, Lane, Meeting, MeetingSegment, MeetingSpeaker, MeetingSummary,
    NewSegment, SpeakerKind, SummaryKind,
};

/// Turns a user's search box into an FTS5 query.
///
/// Everything the user typed is quoted, so `"` `*` `:` `AND` `NEAR(` and the
/// rest of the FTS grammar are data rather than syntax — an unquoted apostrophe
/// or a stray colon would otherwise make the whole query a syntax error and
/// search would appear broken for that keystroke. Each token gets a `*` so
/// results appear while the user is still typing, and tokens are ANDed so
/// adding a word narrows.
fn fts_prefix_query(needle: &str) -> String {
    needle
        .split_whitespace()
        // Inside an FTS5 string literal, `"` is escaped by doubling it.
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::fts_prefix_query;

    #[test]
    fn every_token_is_quoted_and_prefixed() {
        assert_eq!(
            fts_prefix_query("quarterly plan"),
            "\"quarterly\"* AND \"plan\"*"
        );
    }

    /// FTS5 syntax in the search box is data, not grammar.
    ///
    /// Unquoted, each of these is either an operator or a syntax error, and a
    /// syntax error means search returns nothing for that keystroke — which
    /// reads as "search is broken" rather than "no results".
    #[test]
    fn fts_operators_are_treated_as_literal_text() {
        assert_eq!(fts_prefix_query("AND"), "\"AND\"*");
        assert_eq!(fts_prefix_query("NEAR("), "\"NEAR(\"*");
        assert_eq!(fts_prefix_query("foo:bar"), "\"foo:bar\"*");
        assert_eq!(fts_prefix_query("it's"), "\"it's\"*");
        // A double quote is escaped by doubling it inside the literal.
        assert_eq!(
            fts_prefix_query("say \"hi\""),
            "\"say\"* AND \"\"\"hi\"\"\"*"
        );
    }

    #[test]
    fn blank_input_produces_an_empty_query() {
        // Callers short-circuit before this, but an empty MATCH is a syntax
        // error, so it must never be reachable by accident.
        assert_eq!(fts_prefix_query("   "), "");
    }
}

#[derive(Clone)]
pub struct MeetingStore {
    db_path: PathBuf,
}

impl MeetingStore {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let db_path = crate::portable::app_data_dir(app)?.join("history.db");
        Ok(Self { db_path })
    }

    fn conn(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        Ok(conn)
    }

    // ---- Meetings --------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn create_meeting(
        &self,
        id: &str,
        title: Option<&str>,
        started_at: i64,
        app_bundle_id: Option<&str>,
        app_display_name: Option<&str>,
        detection_source: DetectionSource,
        captured_system_audio: bool,
    ) -> Result<()> {
        self.conn()?.execute(
            "INSERT INTO meetings
                (id, title, started_at, app_bundle_id, app_display_name,
                 detection_source, captured_system_audio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                title,
                started_at,
                app_bundle_id,
                app_display_name,
                detection_source.as_str(),
                captured_system_audio
            ],
        )?;
        Ok(())
    }

    pub fn finish_meeting(&self, id: &str, ended_at: i64) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meetings SET ended_at = ?2 WHERE id = ?1",
            params![id, ended_at],
        )?;
        Ok(())
    }

    pub fn set_meeting_title(&self, id: &str, title: &str) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meetings SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        Ok(())
    }

    /// Records that the far-side lane is running. Called after the tap starts,
    /// because the system lane may fail independently of the meeting starting.
    pub fn set_captured_system_audio(&self, id: &str, captured: bool) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meetings SET captured_system_audio = ?2 WHERE id = ?1",
            params![id, captured],
        )?;
        Ok(())
    }

    pub fn get_meeting(&self, id: &str) -> Result<Option<Meeting>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, app_bundle_id, app_display_name,
                    detection_source, captured_system_audio
             FROM meetings WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::map_meeting)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_meetings(&self, limit: i64) -> Result<Vec<Meeting>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, app_bundle_id, app_display_name,
                    detection_source, captured_system_audio
             FROM meetings ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], Self::map_meeting)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_meeting(&self, id: &str) -> Result<()> {
        // Segments, speakers and summaries cascade via foreign keys.
        self.conn()?
            .execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Deletes meetings older than `days`. A `days` of 0 means keep forever.
    ///
    /// Returns the number of meetings removed. Unlike
    /// `HistoryManager::cleanup_by_time` this takes a plain day count rather
    /// than a `RecordingRetentionPeriod`, deliberately: that enum's match ends
    /// in `unreachable!()`, so adding a variant would be a runtime panic.
    pub fn prune_older_than(&self, days: u32, now: i64) -> Result<usize> {
        if days == 0 {
            return Ok(0);
        }
        let cutoff = now - (days as i64 * 24 * 60 * 60);
        // `COALESCE(ended_at, started_at)`: a meeting interrupted by a crash or
        // a force-quit never gets an `ended_at`, and matching on that column
        // alone would keep those transcripts forever — the exact opposite of
        // what someone setting a retention window is asking for.
        let removed = self.conn()?.execute(
            "DELETE FROM meetings WHERE COALESCE(ended_at, started_at) < ?1",
            params![cutoff],
        )?;
        Ok(removed)
    }

    fn map_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
        Ok(Meeting {
            id: row.get("id")?,
            title: row.get("title")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            app_bundle_id: row.get("app_bundle_id")?,
            app_display_name: row.get("app_display_name")?,
            detection_source: DetectionSource::from_str(&row.get::<_, String>("detection_source")?),
            captured_system_audio: row.get("captured_system_audio")?,
        })
    }

    // ---- Speakers --------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_speaker(&self, speaker: &MeetingSpeaker) -> Result<()> {
        self.conn()?.execute(
            "INSERT INTO meeting_speakers
                (id, meeting_id, display_name, kind, lane, cluster_index,
                 voiceprint_id, pinned, color_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                kind = excluded.kind,
                cluster_index = excluded.cluster_index,
                voiceprint_id = excluded.voiceprint_id,
                pinned = excluded.pinned,
                color_index = excluded.color_index",
            params![
                speaker.id,
                speaker.meeting_id,
                speaker.display_name,
                speaker.kind.as_str(),
                speaker.lane.as_str(),
                speaker.cluster_index,
                speaker.voiceprint_id,
                speaker.pinned,
                speaker.color_index
            ],
        )?;
        Ok(())
    }

    pub fn list_speakers(&self, meeting_id: &str) -> Result<Vec<MeetingSpeaker>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, display_name, kind, lane, cluster_index,
                    voiceprint_id, pinned, color_index
             FROM meeting_speakers WHERE meeting_id = ?1
             ORDER BY color_index",
        )?;
        let rows = stmt.query_map(params![meeting_id], Self::map_speaker)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_speaker(&self, id: &str) -> Result<Option<MeetingSpeaker>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, display_name, kind, lane, cluster_index,
                    voiceprint_id, pinned, color_index
             FROM meeting_speakers WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::map_speaker)?;
        Ok(rows.next().transpose()?)
    }

    /// Names a speaker. Naming implies the label is authoritative, so this also
    /// pins the row against the end-of-meeting re-clustering pass.
    pub fn rename_speaker(&self, speaker_id: &str, display_name: &str) -> Result<()> {
        let kind = if display_name.trim().is_empty() {
            SpeakerKind::Unknown
        } else {
            SpeakerKind::Named
        };
        let name: Option<&str> = (!display_name.trim().is_empty()).then_some(display_name);
        self.conn()?.execute(
            "UPDATE meeting_speakers
             SET display_name = ?2, kind = ?3, pinned = 1
             WHERE id = ?1",
            params![speaker_id, name, kind.as_str()],
        )?;
        Ok(())
    }

    /// Folds `source` into `target`, reassigning every segment. Used when
    /// diarization split one person across two clusters.
    pub fn merge_speakers(&self, target_id: &str, source_id: &str) -> Result<usize> {
        if target_id == source_id {
            return Ok(0);
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let moved = tx.execute(
            "UPDATE meeting_segments
             SET speaker_id = ?1, label_source = 'manual'
             WHERE speaker_id = ?2",
            params![target_id, source_id],
        )?;
        tx.execute(
            "DELETE FROM meeting_speakers WHERE id = ?1",
            params![source_id],
        )?;
        tx.commit()?;
        Ok(moved)
    }

    /// Reassigns a single segment, marking it manually labelled.
    pub fn assign_segment_speaker(&self, segment_id: i64, speaker_id: &str) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meeting_segments
             SET speaker_id = ?2, label_source = 'manual'
             WHERE id = ?1",
            params![segment_id, speaker_id],
        )?;
        Ok(())
    }

    /// Reassigns every non-pinned segment currently attributed to `from` — the
    /// "and all other segments from this speaker" affordance.
    pub fn reassign_all_segments(&self, meeting_id: &str, from: &str, to: &str) -> Result<usize> {
        let moved = self.conn()?.execute(
            "UPDATE meeting_segments
             SET speaker_id = ?3, label_source = 'manual'
             WHERE meeting_id = ?1 AND speaker_id = ?2",
            params![meeting_id, from, to],
        )?;
        Ok(moved)
    }

    fn map_speaker(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSpeaker> {
        Ok(MeetingSpeaker {
            id: row.get("id")?,
            meeting_id: row.get("meeting_id")?,
            display_name: row.get("display_name")?,
            kind: SpeakerKind::from_str(&row.get::<_, String>("kind")?),
            lane: Lane::from_str(&row.get::<_, String>("lane")?),
            cluster_index: row.get("cluster_index")?,
            voiceprint_id: row.get("voiceprint_id")?,
            pinned: row.get("pinned")?,
            color_index: row.get("color_index")?,
        })
    }

    // ---- Segments --------------------------------------------------------

    pub fn insert_segment(&self, meeting_id: &str, segment: &NewSegment) -> Result<i64> {
        let conn = self.conn()?;
        let embedding = segment.embedding.as_ref().map(|e| {
            let mut bytes = Vec::with_capacity(e.len() * 4);
            for value in e {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        });
        conn.execute(
            "INSERT INTO meeting_segments
                (meeting_id, speaker_id, lane, start_ms, end_ms, text,
                 label_source, is_crosstalk, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                meeting_id,
                segment.speaker_id,
                segment.lane.as_str(),
                segment.start_ms,
                segment.end_ms,
                segment.text,
                segment.label_source.as_str(),
                segment.is_crosstalk,
                embedding
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Replaces a segment's text, used by live refinement.
    pub fn update_segment_text(&self, segment_id: i64, text: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meeting_segments SET text = ?2 WHERE id = ?1",
            params![segment_id, text],
        )?;
        Ok(())
    }

    pub fn list_segments(&self, meeting_id: &str) -> Result<Vec<MeetingSegment>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, speaker_id, lane, start_ms, end_ms, text,
                    label_source, is_crosstalk
             FROM meeting_segments WHERE meeting_id = ?1
             ORDER BY start_ms",
        )?;
        let rows = stmt.query_map(params![meeting_id], Self::map_segment)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Segments overlapping a time window, used by the summarizer.
    pub fn segments_in_range(
        &self,
        meeting_id: &str,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Vec<MeetingSegment>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, speaker_id, lane, start_ms, end_ms, text,
                    label_source, is_crosstalk
             FROM meeting_segments
             WHERE meeting_id = ?1 AND end_ms >= ?2 AND start_ms <= ?3
             ORDER BY start_ms",
        )?;
        let rows = stmt.query_map(params![meeting_id, from_ms, to_ms], Self::map_segment)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn map_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSegment> {
        Ok(MeetingSegment {
            id: row.get("id")?,
            meeting_id: row.get("meeting_id")?,
            speaker_id: row.get("speaker_id")?,
            lane: Lane::from_str(&row.get::<_, String>("lane")?),
            start_ms: row.get("start_ms")?,
            end_ms: row.get("end_ms")?,
            text: row.get("text")?,
            label_source: LabelSource::from_str(&row.get::<_, String>("label_source")?),
            is_crosstalk: row.get("is_crosstalk")?,
        })
    }

    /// Search across meeting titles, app names, tags and transcript content.
    ///
    /// Transcript matching goes through the `meeting_segments_fts` index rather
    /// than a `LIKE '%needle%'` scan, which no index can serve and which grows
    /// linearly with every minute ever recorded. Titles, app names and tags
    /// stay on LIKE: those tables are one row per meeting, and substring
    /// matching inside a word ("zoo" finding "Zoom") is what people expect from
    /// a title filter but not from transcript search.
    pub fn search_meetings(&self, query: &str, limit: i64) -> Result<Vec<Meeting>> {
        let needle = query.trim();
        if needle.is_empty() {
            return self.list_meetings(limit);
        }
        let pattern = format!("%{}%", needle.replace('%', "\\%").replace('_', "\\_"));
        let fts = fts_prefix_query(needle);
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.title, m.started_at, m.ended_at, m.app_bundle_id,
                    m.app_display_name, m.detection_source, m.captured_system_audio
             FROM meetings m
             WHERE m.title LIKE ?1 ESCAPE '\\'
                OR m.app_display_name LIKE ?1 ESCAPE '\\'
                OR EXISTS (
                     SELECT 1 FROM meeting_tags mt
                     WHERE mt.meeting_id = m.id AND mt.name LIKE ?1 ESCAPE '\\'
                   )
                OR EXISTS (
                     SELECT 1 FROM meeting_segments_fts f
                     JOIN meeting_segments s ON s.id = f.rowid
                     WHERE f.text MATCH ?2 AND s.meeting_id = m.id
                   )
             ORDER BY m.started_at DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![pattern, fts, limit], Self::map_meeting)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Meetings that started within a closed date range, in unix seconds.
    pub fn meetings_in_range(&self, from: i64, to: i64, limit: i64) -> Result<Vec<Meeting>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, app_bundle_id, app_display_name,
                    detection_source, captured_system_audio
             FROM meetings
             WHERE started_at >= ?1 AND started_at <= ?2
             ORDER BY started_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from, to, limit], Self::map_meeting)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Number of segments per meeting, for list rows.
    pub fn segment_count(&self, meeting_id: &str) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM meeting_segments WHERE meeting_id = ?1",
            params![meeting_id],
            |row| row.get(0),
        )?)
    }

    // ---- Tags ------------------------------------------------------------

    pub fn add_tag(&self, meeting_id: &str, name: &str) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Tag name cannot be empty");
        }
        if trimmed.chars().count() > 64 {
            anyhow::bail!("Tag name is too long (max 64 characters)");
        }
        self.conn()?.execute(
            "INSERT OR IGNORE INTO meeting_tags (meeting_id, name, created_at)
             VALUES (?1, ?2, ?3)",
            params![meeting_id, trimmed, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn remove_tag(&self, meeting_id: &str, name: &str) -> Result<()> {
        self.conn()?.execute(
            "DELETE FROM meeting_tags WHERE meeting_id = ?1 AND LOWER(name) = LOWER(?2)",
            params![meeting_id, name],
        )?;
        Ok(())
    }

    pub fn tags_for(&self, meeting_id: &str) -> Result<Vec<String>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare("SELECT name FROM meeting_tags WHERE meeting_id = ?1 ORDER BY LOWER(name)")?;
        let rows = stmt.query_map(params![meeting_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every distinct tag in use, for autocomplete.
    pub fn all_tags(&self) -> Result<Vec<String>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT name, COUNT(*) AS uses FROM meeting_tags
             GROUP BY LOWER(name) ORDER BY uses DESC, LOWER(name)",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- Summaries -------------------------------------------------------

    pub fn insert_summary(
        &self,
        meeting_id: &str,
        created_at: i64,
        covers_from_ms: i64,
        covers_to_ms: i64,
        kind: SummaryKind,
        body: &str,
    ) -> Result<i64> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO meeting_summaries
                (meeting_id, created_at, covers_from_ms, covers_to_ms, kind, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                meeting_id,
                created_at,
                covers_from_ms,
                covers_to_ms,
                kind.as_str(),
                body
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_summaries(&self, meeting_id: &str) -> Result<Vec<MeetingSummary>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, created_at, covers_from_ms, covers_to_ms, kind, body
             FROM meeting_summaries WHERE meeting_id = ?1
             ORDER BY covers_to_ms",
        )?;
        let rows = stmt.query_map(params![meeting_id], Self::map_summary)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Rolling summaries only, which is what "catch me up" folds together.
    pub fn rolling_summaries(&self, meeting_id: &str) -> Result<Vec<MeetingSummary>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, created_at, covers_from_ms, covers_to_ms, kind, body
             FROM meeting_summaries WHERE meeting_id = ?1 AND kind = 'rolling'
             ORDER BY covers_to_ms",
        )?;
        let rows = stmt.query_map(params![meeting_id], Self::map_summary)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// End of the most recent summary of any kind, i.e. "since I last caught
    /// up". Zero when nothing has been summarised yet.
    pub fn last_summarised_ms(&self, meeting_id: &str) -> Result<i64> {
        let conn = self.conn()?;
        let value: Option<i64> = conn.query_row(
            "SELECT MAX(covers_to_ms) FROM meeting_summaries WHERE meeting_id = ?1",
            params![meeting_id],
            |row| row.get(0),
        )?;
        Ok(value.unwrap_or(0))
    }

    fn map_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSummary> {
        Ok(MeetingSummary {
            id: row.get("id")?,
            meeting_id: row.get("meeting_id")?,
            created_at: row.get("created_at")?,
            covers_from_ms: row.get("covers_from_ms")?,
            covers_to_ms: row.get("covers_to_ms")?,
            kind: SummaryKind::from_str(&row.get::<_, String>("kind")?),
            body: row.get("body")?,
        })
    }
}
