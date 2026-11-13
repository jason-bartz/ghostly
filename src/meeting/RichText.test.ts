import { describe, expect, it } from "vitest";
import { stripCitations } from "./RichText";

/**
 * Copying an Ask answer strips its `[12:04]` citations: they are links into
 * a transcript that is not where the text is going. What must survive is the
 * sentence around them — no orphaned spaces before punctuation, no doubled
 * spaces where a citation used to sit.
 */
describe("stripCitations", () => {
  it("removes single citations and the space before them", () => {
    expect(
      stripCitations("Send the revised deck by Friday [12:04]. Confirm seats."),
    ).toBe("Send the revised deck by Friday. Confirm seats.");
  });

  it("removes hour-long timestamps and runs of citations", () => {
    expect(stripCitations("Agreed on pricing [1:02:05, 1:04:10].")).toBe(
      "Agreed on pricing.",
    );
    expect(stripCitations("Raised twice [9:41–12:04] by legal")).toBe(
      "Raised twice by legal",
    );
  });

  it("keeps bracketed text that is not a timestamp", () => {
    expect(stripCitations("Hi [Name], thanks for the call.")).toBe(
      "Hi [Name], thanks for the call.",
    );
  });

  it("keeps line structure", () => {
    expect(
      stripCitations("- **You** — send deck [12:04]\n- Dana — seats"),
    ).toBe("- **You** — send deck\n- Dana — seats");
  });
});
