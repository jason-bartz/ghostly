import React, { useMemo } from "react";

/**
 * The small subset of Markdown that models and licence documents actually
 * produce: headings, bullets, numbered lists, bold, italic, inline code.
 *
 * Deliberately not a Markdown library. Everything rendered here is either
 * shipped in the app bundle or came back from a model given the user's own
 * text, and the alternative — a parser plus a sanitiser plus a renderer — is
 * three dependencies and an HTML injection surface to earn tables and
 * footnotes nobody is asking for. Anything unrecognised renders as the literal
 * text it was, which is exactly what a plain-text answer should do.
 */
interface MarkdownLiteProps {
  source: string;
  /** Wrapper classes. The default suits body copy in a card. */
  className?: string;
  /**
   * Makes `[1]`-style citation markers clickable. The argument is the
   * one-based number as written; the caller maps it to a source.
   */
  onCitation?: (index: number) => void;
  /**
   * Highest citation number that resolves to something. Markers above it stay
   * plain text rather than becoming buttons that lead nowhere — a model asked
   * for citations will occasionally invent one.
   */
  citationCount?: number;
}

export const MarkdownLite: React.FC<MarkdownLiteProps> = ({
  source,
  className = "text-[13.5px] leading-relaxed text-text space-y-3",
  onCitation,
  citationCount = 0,
}) => {
  const blocks = useMemo(
    () => renderBlocks(source, { onCitation, citationCount }),
    [source, onCitation, citationCount],
  );
  return <div className={className}>{blocks}</div>;
};

interface InlineOptions {
  onCitation?: (index: number) => void;
  citationCount: number;
}

function renderBlocks(src: string, opts: InlineOptions): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(
      <p key={key++} className="text-text/90">
        {renderInline(paragraph.join(" "), opts)}
      </p>,
    );
    paragraph = [];
  };

  const flushBullets = () => {
    if (!bullets.length) return;
    out.push(
      <ul key={key++} className="list-disc pl-5 space-y-1 text-text/90">
        {bullets.map((item, i) => (
          <li key={i}>{renderInline(item, opts)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  const flushNumbers = () => {
    if (!numbers.length) return;
    out.push(
      <ol key={key++} className="list-decimal pl-5 space-y-1 text-text/90">
        {numbers.map((item, i) => (
          <li key={i}>{renderInline(item, opts)}</li>
        ))}
      </ol>,
    );
    numbers = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushBullets();
    flushNumbers();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushAll();
      continue;
    }

    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###+\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    if (h1) {
      flushAll();
      out.push(
        <h2 key={key++} className="text-lg font-semibold text-text mt-2 mb-1">
          {renderInline(h1[1], opts)}
        </h2>,
      );
    } else if (h2) {
      flushAll();
      out.push(
        <h3
          key={key++}
          className="text-base font-semibold text-text mt-4 mb-0.5"
        >
          {renderInline(h2[1], opts)}
        </h3>,
      );
    } else if (h3) {
      flushAll();
      out.push(
        <h4 key={key++} className="text-sm font-semibold text-text mt-3 mb-0.5">
          {renderInline(h3[1], opts)}
        </h4>,
      );
    } else if (bullet) {
      flushParagraph();
      flushNumbers();
      bullets.push(bullet[1]);
    } else if (number) {
      flushParagraph();
      flushBullets();
      numbers.push(number[1]);
    } else if (quote) {
      flushAll();
      out.push(
        <blockquote
          key={key++}
          className="border-s-2 border-hairline-strong ps-3 text-text-muted"
        >
          {renderInline(quote[1], opts)}
        </blockquote>,
      );
    } else {
      flushBullets();
      flushNumbers();
      paragraph.push(line);
    }
  }

  flushAll();
  return out;
}

/**
 * `**bold**`, `*italic*`, `` `code` `` and — when the caller asked for them —
 * `[1]` citation markers, in one pass so the offsets can't disagree.
 */
function renderInline(text: string, opts: InlineOptions): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[(\d{1,3})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2]) parts.push(<em key={k++}>{m[2]}</em>);
    else if (m[3])
      parts.push(
        <code
          key={k++}
          className="font-mono text-[12.5px] bg-fill-2 px-1 py-px rounded"
        >
          {m[3]}
        </code>,
      );
    else if (m[4]) {
      const n = Number(m[4]);
      const clickable =
        opts.onCitation !== undefined && n >= 1 && n <= opts.citationCount;
      parts.push(
        clickable ? (
          <CitationMark key={k++} index={n} onClick={opts.onCitation!} />
        ) : (
          m[0]
        ),
      );
    }
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

interface CitationMarkProps {
  index: number;
  onClick: (index: number) => void;
}

/**
 * A citation the reader can act on.
 *
 * Superscript-sized and tinted rather than underlined: it appears mid-sentence,
 * often several times in a line, and link styling at that density turns the
 * answer into a field of blue.
 */
const CitationMark: React.FC<CitationMarkProps> = ({ index, onClick }) => (
  <button
    type="button"
    onClick={() => onClick(index)}
    className="mx-px inline-flex h-4 min-w-4 items-center justify-center rounded
               bg-accent/15 px-1 align-[0.1em] text-[10px] font-semibold tabular-nums
               text-accent-bright transition-colors hover:bg-accent/30 cursor-pointer"
  >
    {index}
  </button>
);
