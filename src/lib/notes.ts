/**
 * Note-taking helpers shared by the meeting panel and the meeting library.
 *
 * Both surfaces edit the same two documents, so the behaviours a person expects
 * from a notepad have to be identical in each. Anything both need lives here.
 */

/** How long typing has to stop before notes are written to disk. */
export const NOTES_SAVE_DEBOUNCE_MS = 600;

/**
 * Continues a bullet list on Enter, the way every notes app does.
 *
 * Returns the new value and caret position, or `null` when the keystroke should
 * do its normal thing. Taking notes during a call means typing without looking,
 * and re-typing "- " on every line is exactly the kind of friction that makes
 * people give up and stop taking notes.
 */
export function continueBullet(
  value: string,
  caret: number,
): { value: string; caret: number } | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const line = value.slice(lineStart, caret);
  const match = /^(\s*)([-*•]\s+)(.*)$/.exec(line);
  if (!match) return null;

  const [, indent, , rest] = match;
  // An empty bullet means "I'm done with the list" — the second Enter ends it
  // rather than laying down another dash nobody asked for.
  if (rest.trim() === "") {
    return {
      value: value.slice(0, lineStart) + value.slice(caret),
      caret: lineStart,
    };
  }
  const insertion = `\n${indent}- `;
  return {
    value: value.slice(0, caret) + insertion + value.slice(caret),
    caret: caret + insertion.length,
  };
}
