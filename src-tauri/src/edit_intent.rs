use once_cell::sync::Lazy;
use regex::Regex;

const PREFIX_EDIT_MAX_WORDS: usize = 15;

static EDIT_PREFIX_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)^\s*[\p{P}]*\s*(?:\
fix\s+that\b|\
make\s+(?:that|it)\s+(?:shorter|longer|formal|casual|concise|clearer)\b|\
shorten\s+(?:that|it)\b|\
lengthen\s+(?:that|it)\b|\
rewrite\s+(?:that|it)\s+(?:formally|casually|in\s+\w+)\b|\
rephrase\s+(?:that|it)\b|\
undo\s+(?:that|it|the\s+last)\b|\
redo\s+(?:that|it)\b|\
try\s+again\b|\
combine\s+the\s+last\s+(?:two|2|three|3)\b|\
change\s+\S+\s+to\s+\S+|\
replace\s+\S+\s+with\s+\S+\
)",
    )
    .expect("valid edit-intent regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditTrigger {
    /// User pressed the "edit last" shortcut — the entire transcript is the instruction.
    Shortcut,
    /// A prefix match classified this transcript as an edit command.
    Prefix,
}

pub fn detect_prefix(transcript: &str) -> bool {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.split_whitespace().count() > PREFIX_EDIT_MAX_WORDS {
        return false;
    }
    EDIT_PREFIX_RE.is_match(trimmed)
}

/// Scans `transcription` for any configured correction phrase (e.g. "scratch
/// that"). If one is found, everything up to and including the **last**
/// occurrence is discarded; only the remainder is returned. This lets the user
/// correct themselves mid-speech within a single recording.
///
/// Matching is case-insensitive and requires word boundaries on both sides so
/// "scratched that" or "unscratch" won't accidentally trigger.
///
/// Returns the original string unchanged if no phrase matched.
pub fn apply_correction_phrases(transcription: &str, phrases: &[String]) -> String {
    if phrases.is_empty() || transcription.is_empty() {
        return transcription.to_string();
    }

    let lower = transcription.to_lowercase();
    let mut last_cut: Option<usize> = None;

    for phrase in phrases {
        let phrase_lower = phrase.trim().to_lowercase();
        if phrase_lower.is_empty() {
            continue;
        }
        let mut search_from = 0;
        while search_from < lower.len() {
            match lower[search_from..].find(&phrase_lower) {
                None => break,
                Some(rel_pos) => {
                    let abs_pos = search_from + rel_pos;
                    let end = abs_pos + phrase_lower.len();
                    // Word-boundary guard: the char immediately before and after
                    // must not be alphabetic (prevents partial-word matches).
                    let before_ok = abs_pos == 0
                        || lower[..abs_pos]
                            .chars()
                            .next_back()
                            .map_or(true, |c| !c.is_alphabetic());
                    let after_ok = lower[end..]
                        .chars()
                        .next()
                        .map_or(true, |c| !c.is_alphabetic());
                    if before_ok && after_ok {
                        last_cut = Some(last_cut.map_or(end, |prev| prev.max(end)));
                    }
                    search_from = abs_pos + 1;
                }
            }
        }
    }

    match last_cut {
        Some(end) => {
            // Strip leading whitespace/punctuation from the remainder.
            let remainder = transcription[end..].trim_start_matches(|c: char| {
                c.is_whitespace() || matches!(c, ',' | '.' | '!' | '?' | ';' | ':')
            });
            remainder.trim_end().to_string()
        }
        None => transcription.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_common_edits() {
        assert!(detect_prefix("fix that"));
        assert!(detect_prefix("Fix that."));
        assert!(detect_prefix("make it shorter"));
        assert!(detect_prefix("rephrase that"));
        assert!(detect_prefix("undo that"));
        assert!(detect_prefix("try again"));
        assert!(detect_prefix("combine the last two"));
        assert!(detect_prefix("replace foo with bar"));
    }

    #[test]
    fn rejects_content_that_starts_with_similar_words() {
        // The critical case: normal dictation shouldn't trigger.
        assert!(!detect_prefix("fix that bug on line 12 please"));
        assert!(!detect_prefix(
            "combine the last two rows of the table and then output the result"
        ));
        assert!(!detect_prefix("make sure the test passes"));
    }

    #[test]
    fn rejects_long_utterances() {
        let long = "fix that ".repeat(20);
        assert!(!detect_prefix(&long));
    }

    #[test]
    fn make_more_formal_not_matched_but_make_formal_is() {
        // "make it more formal" intentionally doesn't match — we only claim tight patterns.
        // Users who want robustness can enable LLM classifier later.
        assert!(!detect_prefix("make it more formal"));
        assert!(detect_prefix("make it formal"));
    }
}
