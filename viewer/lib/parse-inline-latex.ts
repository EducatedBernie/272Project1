// U+0001 (Start Of Heading) — used as a sentinel that cannot appear in
// real input. We replace `\$` (escaped literal dollar) with this sentinel
// before scanning for `$...$` math delimiters, so an escaped dollar is never
// mistaken for a delimiter. After splitting into text vs math parts:
//   - In text parts, the sentinel becomes a plain `$` (the user's intent).
//   - In math parts, it becomes `\$` so KaTeX renders a literal $ in math mode.
const ESCAPED_DOLLAR_SENTINEL = String.fromCharCode(1);

export type InlineLatexPart = { type: "text" | "latex"; content: string };

export function parseInlineLatex(text: string): InlineLatexPart[] {
  const encoded = text.replace(/\\\$/g, ESCAPED_DOLLAR_SENTINEL);
  const parts: InlineLatexPart[] = [];
  const regex = /\$([^$]+)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(encoded)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: encoded
          .slice(lastIndex, match.index)
          .replaceAll(ESCAPED_DOLLAR_SENTINEL, "$"),
      });
    }
    parts.push({
      type: "latex",
      content: match[1].replaceAll(ESCAPED_DOLLAR_SENTINEL, "\\$"),
    });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < encoded.length) {
    parts.push({
      type: "text",
      content: encoded
        .slice(lastIndex)
        .replaceAll(ESCAPED_DOLLAR_SENTINEL, "$"),
    });
  }

  return parts;
}
