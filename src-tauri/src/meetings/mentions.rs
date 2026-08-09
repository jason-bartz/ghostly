//! Direct-address detection.
//!
//! The single highest-value alert in a meeting: someone said your name, and you
//! were not listening. Runs only on the far-side lane — the user saying their
//! own name is not someone calling on them.
//!
//! Deliberately conservative. A false alarm trains the user to ignore the
//! feature, so a bare mention buried mid-sentence does not fire; the name has
//! to appear where an address actually occurs.

/// Returns the sentence containing the address, or `None`.
pub fn detect(text: &str, user_name: &str) -> Option<String> {
    let name = user_name.trim();
    if name.is_empty() {
        return None;
    }
    // Match on the first token so "Jason Bartz" still fires on "Jason".
    let first = name.split_whitespace().next()?.to_lowercase();
    if first.len() < 2 {
        return None;
    }

    for sentence in split_sentences(text) {
        if sentence_addresses(sentence, &first) {
            return Some(sentence.trim().to_string());
        }
    }
    None
}

fn split_sentences(text: &str) -> Vec<&str> {
    text.split_inclusive(['.', '?', '!'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// True when the name is used as an address rather than merely mentioned.
///
/// Three shapes cover essentially all real usage:
///   * leading vocative — "Jason, what do you think?"
///   * trailing vocative — "what do you think, Jason?"
///   * question directed at them — "does Jason have a view?"
fn sentence_addresses(sentence: &str, first_name: &str) -> bool {
    let words: Vec<String> = sentence
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return false;
    }

    let position = words.iter().position(|w| w == first_name);
    let Some(position) = position else {
        return false;
    };

    // Leading vocative: name in the first two words.
    if position <= 1 {
        return true;
    }
    // Trailing vocative: name in the last two words.
    if position + 2 >= words.len() {
        return true;
    }
    // Otherwise only count it when the sentence is a question — "what does
    // Jason think?" is an address; "Jason sent the deck yesterday" is not.
    sentence.trim_end().ends_with('?')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_leading_vocative() {
        assert_eq!(
            detect("Jason, what do you think about the timeline?", "Jason").as_deref(),
            Some("Jason, what do you think about the timeline?")
        );
    }

    #[test]
    fn detects_trailing_vocative() {
        assert!(detect("So what would you do here, Jason?", "Jason").is_some());
    }

    #[test]
    fn detects_question_about_the_user() {
        assert!(detect("Does Jason have a view on this one?", "Jason").is_some());
    }

    #[test]
    fn ignores_a_passing_mention() {
        assert!(
            detect("I think Jason sent the deck over yesterday.", "Jason").is_none(),
            "a statement mentioning the user is not an address"
        );
    }

    #[test]
    fn matches_first_name_from_a_full_name() {
        assert!(detect("Jason, can you take this one?", "Jason Bartz").is_some());
    }

    #[test]
    fn is_case_insensitive() {
        assert!(detect("JASON, are you there?", "jason").is_some());
    }

    #[test]
    fn empty_name_never_fires() {
        assert!(detect("Jason, hello", "").is_none());
        assert!(detect("Jason, hello", "   ").is_none());
    }

    #[test]
    fn returns_only_the_addressing_sentence() {
        let text = "We reviewed the numbers. Jason, does that match your read? Anyway.";
        assert_eq!(
            detect(text, "Jason").as_deref(),
            Some("Jason, does that match your read?")
        );
    }
}
