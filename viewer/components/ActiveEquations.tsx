"use client";

import { useEffect, useRef } from "react";
import katex from "@/lib/katex";
import { parseInlineLatex } from "@/lib/parse-inline-latex";
import type { Equation, VisualContent } from "@/lib/types";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const TYPE_LABELS: Record<string, string> = {
  equation: "Equation",
  text: "Text",
  slide: "Text",
  diagram_description: "Diagram",
  chart_description: "Chart",
  table: "Table",
  code: "Code",
};

function RenderedEquation({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (ref.current) {
      try {
        katex.render(latex, ref.current, {
          throwOnError: false,
          displayMode: true,
          output: "htmlAndMathml",
        });
      } catch {
        if (ref.current) {
          ref.current.textContent = latex;
        }
      }
    }
  }, [latex]);

  return <span ref={ref} className="block flex-1 min-w-0" role="math" />;
}

function RenderedCode({ code, language }: { code: string; language?: string }) {
  return (
    <div className="flex-1 min-w-0">
      {language && (
        <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
          {language}
        </span>
      )}
      <pre className="mt-1 text-sm font-mono overflow-x-auto whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function RenderedTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="flex-1 min-w-0 overflow-x-auto">
      <table className="text-sm w-full" style={{ borderCollapse: "collapse" }}>
        {headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="px-2 py-1 text-left text-xs font-semibold" style={{ borderBottom: "1px solid var(--border)", color: "var(--foreground)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1 text-xs" style={{ borderBottom: "1px solid var(--border)", color: "var(--muted-fg)" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}



function InlineLatex({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      try {
        katex.render(latex, ref.current, { throwOnError: false, displayMode: false, output: "htmlAndMathml" });
      } catch {
        if (ref.current) ref.current.textContent = `$${latex}$`;
      }
    }
  }, [latex]);
  return <span ref={ref} className="mx-0.5" role="math" />;
}

function RichText({ text }: { text: string }) {
  const parts = parseInlineLatex(text);
  return (
    <span>
      {parts.map((part, i) =>
        part.type === "latex" ? <InlineLatex key={i} latex={part.content} /> : <span key={i}>{part.content}</span>
      )}
    </span>
  );
}

function RenderedDescription({ description, typeLabel }: { description: string; typeLabel: string }) {
  return (
    <div className="flex-1 min-w-0">
      <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
        {typeLabel}
      </span>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
        <RichText text={description} />
      </p>
    </div>
  );
}

function RenderedContentItem({
  item,
  isActive,
  onSeek,
}: {
  item: VisualContent;
  isActive: boolean;
  onSeek: (time: number) => void;
}) {
  const typeLabel = TYPE_LABELS[item.contentType] || item.contentType;

  return (
    <div
      onClick={() => onSeek(item.start)}
      className="rounded-lg p-3 cursor-pointer transition-all duration-300"
      style={
        isActive
          ? { background: "var(--active)", border: "1px solid var(--active-border)", opacity: 1 }
          : { background: "var(--muted)", border: "1px solid transparent", opacity: 0.5 }
      }
      role="button"
      tabIndex={0}
      aria-label={`${typeLabel}: ${item.description} at ${formatTime(item.start)}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSeek(item.start);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        {item.contentType === "equation" && item.latex ? (
          <RenderedEquation latex={item.latex} />
        ) : item.contentType === "code" && item.code ? (
          <RenderedCode code={item.code} language={item.language} />
        ) : item.contentType === "table" && item.headers && item.rows ? (
          <RenderedTable headers={item.headers} rows={item.rows} />
        ) : (
          <RenderedDescription description={item.description} typeLabel={typeLabel} />
        )}
        <span className="text-xs font-mono shrink-0 pt-1" style={{ color: "var(--muted-fg)" }}>
          {formatTime(item.start)}
        </span>
      </div>
      {item.contentType === "equation" && (
        <p className="text-xs mt-1 truncate" style={{ color: "var(--muted-fg)" }}>
          {item.description}
        </p>
      )}
    </div>
  );
}

function buildSummary(items: VisualContent[]): string {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const label = TYPE_LABELS[item.contentType] || item.contentType;
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => `${count} ${label}${count > 1 ? "s" : ""}`)
    .join(", ");
}

// Support both legacy Equation[] and new VisualContent[] props
interface ActiveEquationsProps {
  equations?: Equation[];
  visualContent?: VisualContent[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export default function ActiveEquations({
  equations,
  visualContent,
  currentTime,
  onSeek,
}: ActiveEquationsProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Use visualContent if available, otherwise convert equations
  const items: VisualContent[] = visualContent || (equations || []).map((eq) => ({
    id: eq.id,
    contentType: "equation",
    description: eq.description,
    confidence: eq.confidence,
    start: eq.start,
    end: eq.end,
    latex: eq.latex,
  }));

  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current;
      const el = activeRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;

      if (elTop < viewTop || elBottom > viewBottom) {
        container.scrollTo({ top: elTop - 20, behavior: "smooth" });
      }
    }
  }, [currentTime]);

  const summary = buildSummary(items);

  return (
    <div className="flex flex-col h-full">
      <div
        className="px-4 py-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-center"
        style={{ color: "var(--active-border)", borderBottom: "1px solid var(--border)" }}
      >
        Visual Content ({summary})
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {items.map((item) => {
          const isActive = currentTime >= item.start && currentTime <= item.end;
          return (
            <div key={item.id} ref={isActive ? activeRef : null}>
              <RenderedContentItem
                item={item}
                isActive={isActive}
                onSeek={onSeek}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
