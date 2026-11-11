/**
 * Per-content-type renderer for a VisualContent item.
 *
 * Pulled out of viewer/components/viewer/FocusCard.tsx so the /debug
 * page can use the same body-rendering logic. Both the regular viewer
 * (FocusCard.VisualPanel) and the /debug ArtifactDetail compose this
 * inside their own header chrome.
 *
 * Switches on `item.contentType`:
 *   - equation               → DisplayLatex
 *   - code                   → <pre> with chalkboard styling
 *   - text / slide           → <TextBlocks> rendering kind+depth
 *   - table                  → <table> from headers + rows, description footer
 *   - diagram_description /
 *     chart_description /
 *     other / fallback       → description / caption / title with inline LaTeX
 *
 * Stays a pure render — no business logic, no fetches.
 */

"use client";

import TextBlocks from "@/components/TextBlocks";
import { SegmentText, DisplayLatex } from "@/lib/inline-latex";
import type { VisualContent } from "@/lib/types";

interface Props {
  item: VisualContent;
}

export default function VisualContentBody({ item }: Props) {
  if (item.contentType === "equation" && item.latex) {
    return (
      <div className="py-3 grid place-items-center">
        <DisplayLatex latex={item.latex} />
      </div>
    );
  }

  if (item.contentType === "code" && item.code) {
    return (
      <pre
        className="m-0 px-4 py-3 rounded-md overflow-x-auto text-[13px] leading-[1.5]"
        style={{
          background: "var(--chalk-bg)",
          color: "var(--chalk-fg)",
          fontFamily: "var(--font-mono)",
          whiteSpace: "pre",
        }}
      >
        {item.code}
      </pre>
    );
  }

  if (
    (item.contentType === "text" || item.contentType === "slide") &&
    item.textBlocks &&
    item.textBlocks.length > 0
  ) {
    return <TextBlocks blocks={item.textBlocks} />;
  }

  if (item.contentType === "table" && item.headers && item.rows) {
    return (
      <div className="overflow-x-auto">
        <table
          className="text-[13px]"
          style={{ borderCollapse: "collapse", width: "100%" }}
        >
          <thead>
            <tr>
              {item.headers.map((h, i) => (
                <th
                  key={i}
                  className="px-2 py-1 text-left text-[12px] font-semibold"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                >
                  <SegmentText text={h} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {item.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="px-2 py-1 text-[12.5px]"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      color: "var(--muted-fg)",
                    }}
                  >
                    <SegmentText text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {item.description && (
          <p
            className="text-[12px] mt-2 italic"
            style={{ color: "var(--muted-fg)" }}
          >
            <SegmentText text={item.description} />
          </p>
        )}
      </div>
    );
  }

  return (
    <p
      className="m-0 text-[14px] leading-[1.5]"
      style={{ color: "var(--foreground)" }}
    >
      <SegmentText text={item.description || item.caption || item.title || ""} />
    </p>
  );
}
