import React from "react";
import { useTranslation } from "react-i18next";
import { Clock3 } from "lucide-react";

/**
 * The small slice of Markdown the meeting AI writes, rendered for a narrow
 * panel.
 *
 * Not a Markdown library, deliberately. The models are asked for exactly this
 * much — paragraphs, `- ` bullets, numbered lists, `**bold**`, `### headings`,
 * quotes — and the two summary prompts write `Heading:` lines on their own,
 * which no Markdown parser would treat as a heading. Handling only that, and
 * building React nodes rather than HTML, means nothing a model writes can ever
 * be markup.
 *
 * Transcript citations are the reason this exists at all. The model cites the
 * moment it relied on as `[12:04]`, and each becomes a chip that scrolls the
 * live transcript to that card — an answer you can check in one click.
 *
 * Rendering is tolerant of half-finished input, because answers are drawn as
 * they stream: an unclosed `**` at the end is shown as the text it is so far,
 * not swallowed.
 */

/** `12:04` or `1:02:05` → milliseconds. */
function parseClock(text: string): number | null {
  const parts = text.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (m > 59 && parts.length === 3) return null;
  if (s > 59) return null;
  return ((h * 60 + m) * 60 + s) * 1000;
}

// `[12:04]`, `[1:02:05]`, and runs like `[12:04, 14:30]` or `[12:04–14:30]`.
const CITATION =
  /\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:,|–|-|—|and)\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]/g;
const CLOCK = /\d{1,2}:\d{2}(?::\d{2})?/g;

interface InlineProps {
  text: string;
  onCite?: (ms: number) => void;
}

/** Bold, italic, code and citations within one line. */
const Inline: React.FC<InlineProps> = ({ text, onCite }) => {
  const { t } = useTranslation();
  const nodes: React.ReactNode[] = [];
  let key = 0;

  // Citations first, since their brackets would otherwise read as text.
  const pieces: Array<{ cite: string[] } | { text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const index = match.index ?? 0;
    if (index > last) pieces.push({ text: text.slice(last, index) });
    pieces.push({ cite: match[1].match(CLOCK) ?? [] });
    last = index + match[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });

  for (const piece of pieces) {
    if ("cite" in piece) {
      for (const clock of piece.cite) {
        const ms = parseClock(clock);
        if (ms === null) continue;
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={() => onCite?.(ms)}
            disabled={!onCite}
            title={t("meeting.ask.jumpTo", { time: clock })}
            className="mx-[1px] inline-flex translate-y-[-1px] items-center gap-[3px] rounded-[6px] bg-accent/12 px-[5px] py-[1px] align-middle text-[10.5px] font-medium tabular-nums text-accent-bright transition-colors duration-150 hover:bg-accent/22 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Clock3 className="h-[9px] w-[9px]" aria-hidden />
            {clock}
          </button>,
        );
      }
      continue;
    }

    // `**bold**`, `*italic*`, `` `code` ``. Underscore emphasis is left alone:
    // it collides with snake_case and file names far more often than a model
    // means it as emphasis.
    const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;
    let cursor = 0;
    for (const match of piece.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) nodes.push(piece.text.slice(cursor, index));
      const token = match[0];
      if (token.startsWith("**")) {
        nodes.push(
          <strong key={key++} className="font-semibold text-text">
            {token.slice(2, -2)}
          </strong>,
        );
      } else if (token.startsWith("`")) {
        nodes.push(
          <code
            key={key++}
            className="rounded bg-fill-3 px-1 py-[1px] font-mono text-[11.5px]"
          >
            {token.slice(1, -1)}
          </code>,
        );
      } else {
        nodes.push(
          <em key={key++} className="italic">
            {token.slice(1, -1)}
          </em>,
        );
      }
      cursor = index + token.length;
    }
    if (cursor < piece.text.length) nodes.push(piece.text.slice(cursor));
  }

  return <>{nodes}</>;
};

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ text: string; depth: number; marker: string }>;
    };

const BULLET = /^(\s*)[-*•+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
// The summary prompts' section labels: short, alone on the line, colon-ended.
const LABEL = /^([A-Z][\w '’/&-]{0,28}):\s*$/;

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = line.trim().match(HEADING);
    const label = line.trim().match(LABEL);
    if (heading || label) {
      flush();
      blocks.push({
        kind: "heading",
        text: (heading?.[1] ?? label?.[1] ?? "").replace(/\*\*/g, ""),
      });
      continue;
    }

    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const indent = (bullet?.[1] ?? numbered?.[1] ?? "").length;
      const item = {
        text: bullet?.[2] ?? numbered?.[3] ?? "",
        depth: Math.min(3, Math.floor(indent / 2)),
        marker: numbered ? `${numbered[2]}.` : "",
      };
      const previous = blocks[blocks.length - 1];
      if (
        previous?.kind === "list" &&
        (previous.ordered === ordered || item.depth > 0)
      ) {
        previous.items.push(item);
      } else {
        blocks.push({ kind: "list", ordered, items: [item] });
      }
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      flush();
      const text = line.trimStart().replace(/^>\s?/, "");
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "quote") previous.text += ` ${text}`;
      else blocks.push({ kind: "quote", text });
      continue;
    }

    // A wrapped continuation of the list item above it.
    const previous = blocks[blocks.length - 1];
    if (!paragraph.length && previous?.kind === "list" && /^\s{2,}/.test(raw)) {
      previous.items[previous.items.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

interface RichTextProps {
  text: string;
  /** Called with milliseconds into the meeting when a citation is clicked. */
  onCite?: (ms: number) => void;
  /** Draws a caret after the last character while the answer streams. */
  streaming?: boolean;
  className?: string;
}

export const RichText: React.FC<RichTextProps> = ({
  text,
  onCite,
  streaming = false,
  className = "",
}) => {
  const blocks = parse(text);
  const caret = streaming ? (
    <span className="stream-caret" aria-hidden />
  ) : null;

  return (
    <div
      className={`space-y-2 text-[13px] leading-[1.6] text-text-muted ${className}`}
    >
      {blocks.map((block, index) => {
        const lastBlock = index === blocks.length - 1;
        switch (block.kind) {
          case "heading":
            return (
              <p
                key={index}
                className="pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-subtle first:pt-0"
              >
                {block.text}
                {lastBlock && caret}
              </p>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="border-l-2 border-accent/40 pl-2.5 text-text-subtle italic"
              >
                <Inline text={block.text} onCite={onCite} />
                {lastBlock && caret}
              </blockquote>
            );
          case "list":
            return (
              <ul key={index} className="space-y-1">
                {block.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex gap-2"
                    style={{ paddingLeft: item.depth * 14 }}
                  >
                    {block.ordered && item.depth === 0 ? (
                      <span className="w-4 shrink-0 text-right text-[12px] font-medium tabular-nums text-text-subtle">
                        {item.marker}
                      </span>
                    ) : (
                      <span
                        className={`mt-[9px] h-[4px] w-[4px] shrink-0 rounded-full ${
                          item.depth === 0 ? "bg-accent/70" : "bg-text-faint"
                        }`}
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 break-words">
                      <Inline text={item.text} onCite={onCite} />
                      {lastBlock && i === block.items.length - 1 && caret}
                    </span>
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={index} className="break-words">
                <Inline text={block.text} onCite={onCite} />
                {lastBlock && caret}
              </p>
            );
        }
      })}
      {blocks.length === 0 && caret}
    </div>
  );
};

/** Removes citation brackets, for copying an answer somewhere they mean nothing. */
export function stripCitations(text: string): string {
  return text
    .replace(CITATION, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export default RichText;
