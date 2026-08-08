//! Deterministic, LLM-free transcript cleanup.
//!
//! This is the refinement path for destinations where sending the transcript to
//! a rewriting model is both unnecessary and actively harmful — chiefly AI chat
//! and agent surfaces (Claude, ChatGPT, Cursor, Claude Code). Dictating a
//! *prompt* into one of those apps is the one case where an LLM refinement step
//! reliably misbehaves: asked to "clean" text that is itself an instruction, the
//! model executes the instruction instead of transcribing it.
//!
//! No model runs here, so that failure is structurally impossible. It also
//! removes a full network round-trip (typically 400ms–2s) from the hottest path
//! in the app, works offline, and costs nothing.
//!
//! Scope is deliberately narrow — three transforms that are safe to do without
//! language understanding:
//!
//!   1. Spoken punctuation → symbols ("open paren" → `(`)
//!   2. Whitespace/punctuation spacing normalization
//!   3. Sentence capitalization and standalone "i" → "I"
//!
//! Filler-word removal, stutter collapsing, and custom-vocabulary correction are
//! **not** duplicated here — they already run earlier in the transcription
//! pipeline via `audio_toolkit::filter_transcription_output` and
//! `audio_toolkit::apply_custom_words`.
//!
//! Number-word → digit conversion is intentionally omitted. It cannot be done
//! safely without context ("one of the things" must not become "1 of the
//! things"), and Whisper/Parakeet already emit digits for most numeric speech.

use crate::profiles::AutoCleanupLevel;

/// Spoken-punctuation phrases, longest first so multi-word phrases win over
/// their prefixes ("dot dot dot" before "dot", "exclamation point" before
/// "exclamation"). Each entry maps a lowercase phrase to its replacement.
const SPOKEN_PUNCTUATION: &[(&str, &str)] = &[
    // 3-word phrases
    ("dot dot dot", "…"),
    ("open square bracket", "["),
    ("close square bracket", "]"),
    ("open curly brace", "{"),
    ("close curly brace", "}"),
    // 2-word phrases
    ("full stop", "."),
    ("question mark", "?"),
    ("exclamation mark", "!"),
    ("exclamation point", "!"),
    ("open paren", "("),
    ("close paren", ")"),
    ("open parenthesis", "("),
    ("close parenthesis", ")"),
    ("open bracket", "["),
    ("close bracket", "]"),
    ("open brace", "{"),
    ("close brace", "}"),
    ("open quote", "\""),
    ("close quote", "\""),
    ("em dash", "—"),
    ("en dash", "–"),
    ("new line", "\n"),
    ("newline", "\n"),
    ("new paragraph", "\n\n"),
    ("at sign", "@"),
    ("hash tag", "#"),
    ("percent sign", "%"),
    ("dollar sign", "$"),
    // 1-word
    ("period", "."),
    ("comma", ","),
    ("colon", ":"),
    ("semicolon", ";"),
    ("apostrophe", "'"),
    ("hyphen", "-"),
    ("slash", "/"),
    ("backslash", "\\"),
    ("ellipsis", "…"),
    ("ampersand", "&"),
    ("asterisk", "*"),
    ("hashtag", "#"),
    ("unquote", "\""),
];

/// Words that, immediately before a punctuation phrase, signal the speaker means
/// the *word* rather than the mark — "we debated the Oxford comma", "add a
/// period at the end". Conservative by design: a missed conversion is a minor
/// annoyance, an unwanted one corrupts the text.
const LITERAL_SIGNALS: &[&str] = &[
    "the", "a", "an", "that", "this", "another", "any", "each", "every", "one", "two", "no",
    "oxford", "serial", "trailing", "leading", "missing", "extra", "double", "single", "word",
    "with", "without", "using",
];

/// True when `word` (already lowercased, punctuation-stripped) marks the
/// following token as literal.
fn is_literal_signal(word: &str) -> bool {
    LITERAL_SIGNALS.contains(&word)
}

fn strip_edges(word: &str) -> &str {
    word.trim_matches(|c: char| !c.is_alphanumeric())
}

/// Replace spoken punctuation phrases with their symbols.
///
/// Matches greedily on 3-, then 2-, then 1-word windows. Skips any match whose
/// preceding token is a literal signal (see `LITERAL_SIGNALS`).
fn apply_spoken_punctuation(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out: Vec<String> = Vec::with_capacity(words.len());
    let mut i = 0;

    while i < words.len() {
        let mut matched = false;

        // Longest window first so "dot dot dot" beats a bare "dot".
        for window in (1..=3).rev() {
            if i + window > words.len() {
                continue;
            }
            let phrase = words[i..i + window]
                .iter()
                .map(|w| strip_edges(w).to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            if phrase.is_empty() {
                continue;
            }

            let Some((_, symbol)) = SPOKEN_PUNCTUATION
                .iter()
                .find(|(spoken, _)| *spoken == phrase)
            else {
                continue;
            };

            // "the comma" / "a period" → keep the words literal.
            let preceded_by_signal = out
                .last()
                .map(|prev| is_literal_signal(&strip_edges(prev).to_lowercase()))
                .unwrap_or(false);
            if preceded_by_signal {
                continue;
            }

            out.push((*symbol).to_string());
            i += window;
            matched = true;
            break;
        }

        if !matched {
            out.push(words[i].to_string());
            i += 1;
        }
    }

    out.join(" ")
}

/// Collapse the spaces that `apply_spoken_punctuation` leaves around inserted
/// symbols: no space before closing punctuation, none after openers, and
/// newlines shouldn't carry surrounding spaces.
fn normalize_spacing(text: &str) -> String {
    let mut s = text.to_string();

    // No space before these.
    for p in [".", ",", "?", "!", ":", ";", ")", "]", "}", "…", "'", "%"] {
        s = s.replace(&format!(" {}", p), p);
    }

    // No space after these.
    for p in ["(", "[", "{", "$", "@", "#"] {
        s = s.replace(&format!("{} ", p), p);
    }

    // Newlines: drop adjacent spaces.
    s = s.replace(" \n", "\n").replace("\n ", "\n");

    // Slashes bind tight: "src / main" → "src/main".
    s = s.replace(" / ", "/").replace(" \\ ", "\\");

    // Dashes keep one side tight only for em/en dashes used as separators.
    s = s.replace(" — ", "—").replace(" – ", "–");

    // Collapse any runs the replacements created.
    while s.contains("  ") {
        s = s.replace("  ", " ");
    }

    s
}

/// Capitalize the first alphabetic character of each sentence and fix the
/// standalone pronoun "i".
fn apply_capitalization(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // Start of text counts as a sentence boundary.
    let mut at_sentence_start = true;

    let chars: Vec<char> = text.chars().collect();
    let mut idx = 0;

    while idx < chars.len() {
        let c = chars[idx];

        if at_sentence_start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            at_sentence_start = false;
            idx += 1;
            continue;
        }

        // Standalone "i" → "I" (word-boundary checked on both sides).
        if (c == 'i') && !out.ends_with(|p: char| p.is_alphanumeric()) {
            let next_is_boundary = chars
                .get(idx + 1)
                .map(|n| !n.is_alphanumeric() && *n != '\'')
                .unwrap_or(true);
            if next_is_boundary {
                out.push('I');
                at_sentence_start = false;
                idx += 1;
                continue;
            }
        }

        out.push(c);

        if matches!(c, '.' | '?' | '!' | '\n') {
            at_sentence_start = true;
        } else if !c.is_whitespace() {
            at_sentence_start = false;
        }

        idx += 1;
    }

    out
}

/// Run the deterministic cleanup pipeline.
///
/// `AutoCleanupLevel::None` is a passthrough (trim only) so the user's "no
/// cleanup" preference is honored on this path exactly as it is on the LLM path.
/// The remaining levels all map to the same transforms — depth of rewriting is
/// what distinguishes Light/Medium/High for an LLM, and none of that is safe to
/// approximate deterministically.
pub fn clean(text: &str, level: AutoCleanupLevel) -> String {
    if matches!(level, AutoCleanupLevel::None) {
        return text.trim().to_string();
    }

    let s = apply_spoken_punctuation(text);
    let s = normalize_spacing(&s);
    let s = apply_capitalization(&s);
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn light(s: &str) -> String {
        clean(s, AutoCleanupLevel::Light)
    }

    #[test]
    fn converts_spoken_punctuation() {
        assert_eq!(light("hello world period"), "Hello world.");
        assert_eq!(
            light("are you free comma tomorrow"),
            "Are you free, tomorrow"
        );
        assert_eq!(light("what time is it question mark"), "What time is it?");
    }

    #[test]
    fn converts_brackets_and_parens() {
        // Prose spacing: a space before an opening bracket is correct English.
        // Tightening it (`foo(bar)`) is only right in code, and code vs. prose
        // isn't safely detectable without language understanding — so this path
        // stays prose-correct and leaves code formatting to the Developer
        // prompt on the LLM path.
        assert_eq!(
            light("call foo open paren bar close paren"),
            "Call foo (bar)"
        );
        assert_eq!(
            light("index open bracket zero close bracket"),
            "Index [zero]"
        );
    }

    #[test]
    fn longest_phrase_wins() {
        assert_eq!(light("wait dot dot dot really"), "Wait… really");
    }

    #[test]
    fn preserves_literal_punctuation_words() {
        // "the comma" refers to the word, not the mark.
        assert_eq!(
            light("we debated the Oxford comma"),
            "We debated the Oxford comma"
        );
        assert_eq!(light("add a period at the end"), "Add a period at the end");
    }

    #[test]
    fn handles_newline_commands() {
        assert_eq!(
            light("first line new line second line"),
            "First line\nSecond line"
        );
    }

    #[test]
    fn capitalizes_sentences() {
        assert_eq!(
            light("hello there period how are you question mark"),
            "Hello there. How are you?"
        );
    }

    #[test]
    fn capitalizes_standalone_i() {
        assert_eq!(light("i think i can"), "I think I can");
        // Not inside words.
        assert_eq!(light("it is inside"), "It is inside");
    }

    #[test]
    fn none_level_is_passthrough() {
        let input = "hello world period";
        assert_eq!(clean(input, AutoCleanupLevel::None), input);
    }

    #[test]
    fn leaves_ai_prompt_text_intact() {
        // The exact class of input that made the LLM path misbehave: a
        // command-shaped prompt must survive verbatim.
        let input = "write a function that parses JSON and returns a struct";
        assert_eq!(
            light(input),
            "Write a function that parses JSON and returns a struct"
        );
    }

    #[test]
    fn empty_input_is_safe() {
        assert_eq!(light(""), "");
        assert_eq!(light("   "), "");
    }
}
