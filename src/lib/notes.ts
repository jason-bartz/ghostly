/**
 * Note-taking helpers shared by the meeting panel and the meeting library.
 *
 * Both surfaces edit the same two documents, so the behaviours a person expects
 * from a notepad have to be identical in each. Anything both need lives here.
 *
 * The notepad is a plain `<textarea>` holding Markdown — the same text that gets
 * exported, enhanced and re-imported — so "make a bullet" cannot mean "insert a
 * rich-text list node". It means: put the marker there for the user, keep it
 * going while they type, and stop when they say so. That is what every notes app
 * does with `- `, `* ` and `1. `, and doing less makes people give up on taking
 * notes during a call, which is the whole feature.
 */

/** How long typing has to stop before notes are written to disk. */
export const NOTES_SAVE_DEBOUNCE_MS = 600;

/** What one Tab adds to a list item's indent. */
const INDENT = "  ";

// Both markers require whitespace after them, so `-5 degrees` and `2.5x` are
// prose, not lists. The digit cap keeps a pasted phone number from parsing as a
// list item with a nine-digit counter.
const UNORDERED = /^([ \t]*)([-*+•])([ \t]+)(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;

/** A list item, taken apart so its marker can be rewritten. */
export interface ListItem {
  /** Leading whitespace. Depth is measured in characters of this. */
  indent: string;
  /** `-`, `*`, `+` or `•`. Empty for an ordered item. */
  bullet: string;
  ordered: boolean;
  /** Ordered only. */
  number: number;
  /** `.` or `)` for an ordered item, empty otherwise. */
  delimiter: string;
  /** The whitespace between the marker and the text, preserved verbatim. */
  spacing: string;
  /** Everything after the marker. */
  content: string;
  /** Indent plus marker plus spacing — everything before `content`. */
  prefix: string;
}

/** The result of a keystroke the notepad handled itself. */
export interface Edit {
  value: string;
  caret: number;
}

export function parseListItem(line: string): ListItem | null {
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const [, indent, digits, delimiter, spacing, content] = ordered;
    return {
      indent,
      bullet: "",
      ordered: true,
      number: Number(digits),
      delimiter,
      spacing,
      content,
      prefix: `${indent}${digits}${delimiter}${spacing}`,
    };
  }

  const unordered = UNORDERED.exec(line);
  if (unordered) {
    const [, indent, bullet, spacing, content] = unordered;
    return {
      indent,
      bullet,
      ordered: false,
      number: 0,
      delimiter: "",
      spacing,
      content,
      prefix: `${indent}${bullet}${spacing}`,
    };
  }

  return null;
}

/** The marker `item` would have at `indent`, numbered `number`. */
function markerFor(item: ListItem, indent: string, number: number): string {
  return item.ordered
    ? `${indent}${number}${item.delimiter}${item.spacing}`
    : `${indent}${item.bullet}${item.spacing}`;
}

function lineBounds(
  value: string,
  caret: number,
): { start: number; end: number } {
  const start = value.lastIndexOf("\n", caret - 1) + 1;
  const next = value.indexOf("\n", caret);
  return { start, end: next === -1 ? value.length : next };
}

/** One level shallower, tolerating an indent that isn't a whole number of them. */
function outdentOnce(indent: string): string {
  if (indent.startsWith(INDENT)) return indent.slice(INDENT.length);
  return indent.slice(0, Math.max(0, indent.length - 1));
}

/**
 * What an item inserted at `indent` should be numbered.
 *
 * Walks back over the lines above it for the nearest sibling — skipping items
 * nested under one, since a sub-list does not interrupt its parent's count —
 * and starts a fresh list at 1 when there is no sibling to follow. A blank line
 * is a boundary: it is how a person ends one list and starts another.
 */
function precedingNumber(
  value: string,
  lineStart: number,
  indent: string,
): number {
  let offset = lineStart;
  while (offset > 0) {
    const end = offset - 1;
    const start = value.lastIndexOf("\n", end - 1) + 1;
    const line = value.slice(start, end);
    if (line.trim() === "") return 1;

    const item = parseListItem(line);
    if (!item) return 1;
    if (item.indent.length > indent.length) {
      offset = start;
      continue;
    }
    if (item.indent.length < indent.length) return 1;
    return item.ordered ? item.number + 1 : 1;
  }
  return 1;
}

/**
 * Renumbers the ordered items that follow `from` at `indent`, so a list stays
 * 1, 2, 3 after something is inserted into or lifted out of the middle of it.
 *
 * Only ever rewrites text *after* the caret, which is what makes it safe to run
 * on a keystroke: the caret cannot land inside a number that just changed
 * length.
 */
function renumberFrom(
  value: string,
  from: number,
  indent: string,
  next: number,
): string {
  let result = value;
  let offset = from;
  let counter = next;

  while (offset < result.length) {
    const end = result.indexOf("\n", offset);
    const lineEnd = end === -1 ? result.length : end;
    const line = result.slice(offset, lineEnd);

    // A blank line ends the list — the same rule that lets a second Enter get
    // you out of one.
    if (line.trim() === "") break;
    const item = parseListItem(line);
    if (!item) break;

    if (item.indent.length > indent.length) {
      // Nested under this item. Its own numbering is its own business.
      offset = lineEnd + 1;
      continue;
    }
    if (item.indent.length < indent.length) break;
    // A bulleted item at this level is a different list.
    if (!item.ordered) break;

    const prefix = markerFor(item, item.indent, counter);
    counter += 1;
    result =
      result.slice(0, offset) + prefix + item.content + result.slice(lineEnd);
    offset = offset + prefix.length + item.content.length + 1;
  }

  return result;
}

/** The start of the line after the one containing `caret`, or -1 if it is last. */
function nextLineStart(value: string, caret: number): number {
  const newline = value.indexOf("\n", caret);
  return newline === -1 ? -1 : newline + 1;
}

/**
 * Continues a list on Enter, the way every notes app does.
 *
 * Returns the new value and caret position, or `null` when the keystroke should
 * do its normal thing. Taking notes during a call means typing without looking,
 * and re-typing "- " on every line is exactly the kind of friction that makes
 * people give up and stop taking notes.
 */
export function continueList(value: string, caret: number): Edit | null {
  const { start, end } = lineBounds(value, caret);
  const item = parseListItem(value.slice(start, end));
  if (!item) return null;

  // Enter from inside the marker itself is not a continuation — it pushes the
  // item down and leaves a blank line above it, like Enter anywhere else would.
  if (caret < start + item.prefix.length) return null;

  // An item with nothing in it means "I'm done with the list". A nested one
  // steps out a level first, because that is how you get from a sub-point back
  // to the main list without reaching for the mouse; a top-level one loses its
  // marker and leaves you on an empty line.
  if (item.content.trim() === "") {
    if (item.indent === "") {
      return {
        value: value.slice(0, start) + value.slice(end),
        caret: start,
      };
    }

    const indent = outdentOnce(item.indent);
    const prefix = markerFor(
      item,
      indent,
      precedingNumber(value, start, indent),
    );
    let next = value.slice(0, start) + prefix + value.slice(end);
    const after = nextLineStart(next, start);
    if (item.ordered && after !== -1) {
      next = renumberFrom(
        next,
        after,
        indent,
        precedingNumber(next, start, indent) + 1,
      );
    }
    return { value: next, caret: start + prefix.length };
  }

  const number = item.number + 1;
  const insertion = `\n${markerFor(item, item.indent, number)}`;
  let next = value.slice(0, caret) + insertion + value.slice(caret);
  const nextCaret = caret + insertion.length;

  if (item.ordered) {
    const after = nextLineStart(next, nextCaret);
    if (after !== -1) next = renumberFrom(next, after, item.indent, number + 1);
  }

  return { value: next, caret: nextCaret };
}

/**
 * Turns `* ` and `+ ` at the start of a line into a real bullet as you type it.
 *
 * Markdown accepts all three markers, so the asterisk was never broken so much
 * as invisible: you typed the thing that starts a list everywhere else and got
 * back a literal asterisk with no sign anything had happened. Normalising to
 * `- ` is the acknowledgement — one canonical bullet in the document, and the
 * continuation below has something to follow.
 */
export function startBullet(value: string, caret: number): Edit | null {
  const { start } = lineBounds(value, caret);
  const typed = value.slice(start, caret);
  const match = /^([ \t]*)([*+])$/.exec(typed);
  if (!match) return null;

  const prefix = `${match[1]}- `;
  return {
    value: value.slice(0, start) + prefix + value.slice(caret),
    caret: start + prefix.length,
  };
}

/**
 * Tab and Shift-Tab move a list item in and out a level.
 *
 * Only inside a list item: a textarea's Tab is how you get out of the field by
 * keyboard, and taking that away everywhere to serve the occasional sub-bullet
 * is a bad trade.
 */
export function indentListItem(
  value: string,
  caret: number,
  outdent: boolean,
): Edit | null {
  const { start, end } = lineBounds(value, caret);
  const item = parseListItem(value.slice(start, end));
  if (!item) return null;

  const indent = outdent ? outdentOnce(item.indent) : item.indent + INDENT;
  if (indent === item.indent) return null; // Already at the left margin.

  const prefix = markerFor(
    item,
    indent,
    item.ordered ? precedingNumber(value, start, indent) : 0,
  );
  let next = value.slice(0, start) + prefix + item.content + value.slice(end);

  // Both levels are now wrong: the one the item joined has an extra member and
  // the one it left has a gap. Run them in this order — the deeper pass stops
  // at the first item shallower than itself, so it cannot walk into the other
  // list's territory, and `start` is before every edit either makes.
  const after = nextLineStart(next, start);
  if (after !== -1) {
    const deeper = outdent ? item.indent : indent;
    const shallower = outdent ? indent : item.indent;
    next = renumberFrom(
      next,
      after,
      deeper,
      precedingNumber(next, after, deeper),
    );
    next = renumberFrom(
      next,
      after,
      shallower,
      precedingNumber(next, after, shallower),
    );
  }

  return {
    value: next,
    caret: Math.max(
      start + prefix.length,
      caret + (prefix.length - item.prefix.length),
    ),
  };
}

/**
 * Backspace with the caret just after a marker takes the marker off, rather
 * than eating the space and leaving `-text` behind.
 *
 * Same escape as the empty-item Enter, reached the other way: a nested item
 * steps out a level, a top-level one becomes a plain line.
 */
export function removeMarkerBackward(
  value: string,
  caret: number,
): Edit | null {
  const { start, end } = lineBounds(value, caret);
  const item = parseListItem(value.slice(start, end));
  if (!item) return null;
  if (caret !== start + item.prefix.length) return null;

  if (item.indent === "") {
    return {
      value: value.slice(0, start) + item.content + value.slice(end),
      caret: start,
    };
  }

  const indent = outdentOnce(item.indent);
  const prefix = markerFor(item, indent, precedingNumber(value, start, indent));
  return {
    value: value.slice(0, start) + prefix + item.content + value.slice(end),
    caret: start + prefix.length,
  };
}

/** The shape of a keyboard event this module needs. */
interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** The shape of the text field this module needs. */
interface FieldLike {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/**
 * Whether the next Tab should move focus instead of indenting.
 *
 * Taking Tab over inside a list would otherwise trap a keyboard-only user in
 * the notepad: from a bullet, neither Tab nor Shift-Tab would ever reach the
 * next control. Escape-then-Tab is the way every editor that claims the key
 * gives it back, and it is armed here rather than in the components so both
 * notepads are guaranteed to have it.
 *
 * Module-level because only one text field can have focus at a time, and any
 * other keystroke re-arms indentation.
 */
let tabReleased = false;

/**
 * The whole of the notepad's list behaviour, as one call.
 *
 * Both editors route their `keydown` through this so the two can't drift: a
 * bullet that continues in the panel and not in the library is worse than
 * neither doing it.
 *
 * Returns the edit to apply — the caller preventDefault()s and sets state — or
 * `null` to let the keystroke through untouched.
 */
export function noteKeyEdit(event: KeyLike, field: FieldLike): Edit | null {
  if (event.key === "Escape") {
    tabReleased = true;
    return null;
  }
  if (event.key !== "Tab") tabReleased = false;

  const caret = field.selectionStart;
  // A selection means the keystroke is a replacement. Continuing a list through
  // one would eat the selected text.
  if (caret === null || caret !== field.selectionEnd) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  switch (event.key) {
    case "Enter":
      // Shift-Enter is the deliberate "no, just a line break".
      return event.shiftKey ? null : continueList(field.value, caret);
    case "Tab": {
      if (tabReleased) {
        tabReleased = false;
        return null;
      }
      return indentListItem(field.value, caret, event.shiftKey);
    }
    case " ":
      return startBullet(field.value, caret);
    case "Backspace":
      return removeMarkerBackward(field.value, caret);
    default:
      return null;
  }
}
