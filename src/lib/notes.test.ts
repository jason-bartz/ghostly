import { describe, expect, it } from "vitest";
import {
  continueList,
  indentListItem,
  noteKeyEdit,
  parseListItem,
  removeMarkerBackward,
  startBullet,
} from "./notes";

/**
 * These are the keystrokes a person makes without looking, mid-call, while
 * listening to someone else talk. Every case here is one somebody would notice
 * immediately if it broke — a marker that doesn't appear, a number that repeats,
 * a bullet you can't get out of.
 *
 * `|` marks the caret in the fixtures, which is far easier to read than a pair
 * of string offsets.
 */

/** Splits `"- one|"` into the value and the caret offset. */
function at(text: string): { value: string; caret: number } {
  const caret = text.indexOf("|");
  if (caret === -1) throw new Error(`fixture has no caret: ${text}`);
  return { value: text.slice(0, caret) + text.slice(caret + 1), caret };
}

/** Renders an edit back into the `|` notation, for one-line assertions. */
function show(edit: { value: string; caret: number } | null): string | null {
  if (!edit) return null;
  return edit.value.slice(0, edit.caret) + "|" + edit.value.slice(edit.caret);
}

function enter(text: string): string | null {
  const { value, caret } = at(text);
  return show(continueList(value, caret));
}

function space(text: string): string | null {
  const { value, caret } = at(text);
  return show(startBullet(value, caret));
}

function tab(text: string, outdent = false): string | null {
  const { value, caret } = at(text);
  return show(indentListItem(value, caret, outdent));
}

function backspace(text: string): string | null {
  const { value, caret } = at(text);
  return show(removeMarkerBackward(value, caret));
}

describe("parseListItem", () => {
  it("reads every marker Markdown accepts", () => {
    expect(parseListItem("- a")?.bullet).toBe("-");
    expect(parseListItem("* a")?.bullet).toBe("*");
    expect(parseListItem("+ a")?.bullet).toBe("+");
    expect(parseListItem("• a")?.bullet).toBe("•");
    expect(parseListItem("1. a")?.number).toBe(1);
    expect(parseListItem("12) a")?.delimiter).toBe(")");
  });

  it("leaves prose alone", () => {
    // The marker has to be followed by whitespace, or arithmetic and prices
    // would turn into lists.
    expect(parseListItem("-5 degrees")).toBeNull();
    expect(parseListItem("2.5x faster")).toBeNull();
    expect(parseListItem("not a list")).toBeNull();
    expect(parseListItem("")).toBeNull();
  });

  it("keeps the indent and the spacing it was given", () => {
    const item = parseListItem("    -   spaced out");
    expect(item?.indent).toBe("    ");
    expect(item?.spacing).toBe("   ");
    expect(item?.content).toBe("spaced out");
  });
});

describe("startBullet", () => {
  it("turns an asterisk into a bullet", () => {
    expect(space("*|")).toBe("- |");
  });

  it("does the same for a plus, and leaves a dash alone", () => {
    expect(space("+|")).toBe("- |");
    expect(space("-|")).toBeNull();
  });

  it("keeps the indent it was typed at", () => {
    expect(space("  *|")).toBe("  - |");
  });

  it("stays out of the way mid-line", () => {
    // Emphasis, not a list.
    expect(space("some *|")).toBeNull();
    expect(space("- one *|")).toBeNull();
  });
});

describe("continueList", () => {
  it("carries a bullet onto the next line", () => {
    expect(enter("- one|")).toBe("- one\n- |");
  });

  it("continues the marker that is actually there", () => {
    // Enhanced notes come back from the model using whatever marker it likes;
    // continuing with a different one would leave the document in two styles.
    expect(enter("* one|")).toBe("* one\n* |");
    expect(enter("• one|")).toBe("• one\n• |");
  });

  it("counts, and keeps the delimiter", () => {
    expect(enter("1. one|")).toBe("1. one\n2. |");
    expect(enter("3) three|")).toBe("3) three\n4) |");
  });

  it("renumbers what follows when you insert in the middle", () => {
    expect(enter("1. one|\n2. two\n3. three")).toBe(
      "1. one\n2. |\n3. two\n4. three",
    );
  });

  it("stops renumbering at a blank line", () => {
    // The blank line is how someone starts a second, unrelated list.
    expect(enter("1. one|\n2. two\n\n1. other")).toBe(
      "1. one\n2. |\n3. two\n\n1. other",
    );
  });

  it("splits an item at the caret", () => {
    expect(enter("- one| two")).toBe("- one\n- | two");
  });

  it("ends the list on the second Enter", () => {
    expect(enter("- one\n- |")).toBe("- one\n|");
    expect(enter("1. one\n2. |")).toBe("1. one\n|");
  });

  it("steps out a level before ending a nested list", () => {
    expect(enter("- one\n  - |")).toBe("- one\n- |");
  });

  it("numbers a nested item from its own siblings", () => {
    expect(enter("1. one\n  1. a\n  2. b|")).toBe(
      "1. one\n  1. a\n  2. b\n  3. |",
    );
  });

  it("ignores an empty item's own text when deciding it is empty", () => {
    // The caret sits just after the marker on a line that does have text: this
    // is a split, not the end of the list.
    expect(enter("- |one")).toBe("- \n- |one");
  });

  it("leaves non-list lines to the browser", () => {
    expect(enter("just typing|")).toBeNull();
    expect(enter("|")).toBeNull();
  });

  it("does not continue from inside the marker", () => {
    expect(enter("|- one")).toBeNull();
    expect(enter("-| one")).toBeNull();
  });
});

describe("indentListItem", () => {
  it("indents and outdents by one level", () => {
    expect(tab("- one\n- two|")).toBe("- one\n  - two|");
    expect(tab("- one\n  - two|", true)).toBe("- one\n- two|");
  });

  it("restarts a nested number and repairs the level it left", () => {
    expect(tab("1. one\n2. two|\n3. three")).toBe(
      "1. one\n  1. two|\n2. three",
    );
  });

  it("continues a nested run rather than restarting it", () => {
    expect(tab("1. one\n  1. a\n2. two|")).toBe("1. one\n  1. a\n  2. two|");
  });

  it("renumbers the destination when an item is lifted into it", () => {
    expect(tab("1. one\n  1. a\n  2. b|\n  3. c", true)).toBe(
      "1. one\n  1. a\n2. b|\n  1. c",
    );
  });

  it("refuses to outdent past the left margin", () => {
    expect(tab("- one|", true)).toBeNull();
  });

  it("leaves plain paragraphs to the browser, so Tab still moves focus", () => {
    expect(tab("just typing|")).toBeNull();
  });
});

describe("removeMarkerBackward", () => {
  it("takes the marker off rather than the space", () => {
    expect(backspace("- |one")).toBe("|one");
    expect(backspace("1. |one")).toBe("|one");
  });

  it("steps out a level first when nested", () => {
    expect(backspace("- one\n  - |two")).toBe("- one\n- |two");
  });

  it("only fires from the front of the content", () => {
    expect(backspace("- on|e")).toBeNull();
    expect(backspace("-| one")).toBeNull();
  });
});

describe("noteKeyEdit", () => {
  const keys = {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  };

  it("routes each key to its behaviour", () => {
    const field = { value: "- one", selectionStart: 5, selectionEnd: 5 };
    expect(noteKeyEdit(keys, field)?.value).toBe("- one\n- ");
    expect(noteKeyEdit({ ...keys, key: "Tab" }, field)?.value).toBe("  - one");
  });

  it("leaves Shift-Enter as a plain line break", () => {
    const field = { value: "- one", selectionStart: 5, selectionEnd: 5 };
    expect(noteKeyEdit({ ...keys, shiftKey: true }, field)).toBeNull();
  });

  it("keeps out of the way of shortcuts", () => {
    // ⌘↵ enhances the notes; it must not also lay down a bullet.
    const field = { value: "- one", selectionStart: 5, selectionEnd: 5 };
    expect(noteKeyEdit({ ...keys, metaKey: true }, field)).toBeNull();
  });

  it("does nothing while text is selected", () => {
    const field = { value: "- one", selectionStart: 2, selectionEnd: 5 };
    expect(noteKeyEdit(keys, field)).toBeNull();
  });

  it("gives Tab back after Escape, so the notepad is not a keyboard trap", () => {
    const field = { value: "- one", selectionStart: 5, selectionEnd: 5 };
    const tab = { ...keys, key: "Tab" };

    expect(noteKeyEdit(tab, field)).not.toBeNull();
    expect(noteKeyEdit({ ...keys, key: "Escape" }, field)).toBeNull();
    // The Tab straight after Escape moves focus instead of indenting.
    expect(noteKeyEdit(tab, field)).toBeNull();
    // And only that one: typing anything puts indentation back.
    expect(noteKeyEdit(tab, field)).not.toBeNull();
  });

  it("re-arms Tab as soon as anything else is typed", () => {
    const field = { value: "- one", selectionStart: 5, selectionEnd: 5 };
    expect(noteKeyEdit({ ...keys, key: "Escape" }, field)).toBeNull();
    noteKeyEdit({ ...keys, key: "a" }, field);
    expect(noteKeyEdit({ ...keys, key: "Tab" }, field)).not.toBeNull();
  });
});
