"use client";

import { useEffect, useRef, useState } from "react";
import katex from "@/lib/katex";
import { SegmentText as RichText } from "@/lib/inline-latex";
import TextBlocks from "@/components/TextBlocks";
import type { Equation, VisualContent } from "@/lib/types";

interface Section {
  start_time: string;
  end_time?: string;
  title: string;
  description: string;
  startSeconds?: number;
}

const TYPE_LABELS: Record<string, string> = {
  equation: "Equation",
  text: "Text",
  slide: "Text",
  diagram_description: "Diagram",
  chart_description: "Chart",
  table: "Table",
  code: "Code",
  other: "Other",
};

function RenderedContentItem({
  item,
  isActive,
  onSeek,
}: {
  item: VisualContent;
  isActive: boolean;
  onSeek: (time: number) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const typeLabel = TYPE_LABELS[item.contentType] || item.contentType;
  const isEquation = item.contentType === "equation" && item.latex;

  useEffect(() => {
    if (isEquation && ref.current) {
      try {
        katex.render(item.latex!, ref.current, {
          throwOnError: false,
          displayMode: true,
          output: "htmlAndMathml",
        });
      } catch {
        if (ref.current) {
          ref.current.textContent = item.latex!;
        }
      }
    }
  }, [item.latex, isEquation]);

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
      aria-label={`${typeLabel}: ${item.description}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSeek(item.start);
        }
      }}
    >
      {isEquation ? (
        <>
          <span ref={ref} className="block" role="math" />
          <p className="text-xs mt-1 truncate" style={{ color: "var(--muted-fg)" }}>
            <RichText text={item.description} />
          </p>
        </>
      ) : item.contentType === "code" && item.code ? (
        <div>
          {item.language && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
              {item.language}
            </span>
          )}
          {item.purpose && (
            <p className="text-xs italic mt-1" style={{ color: "var(--muted-fg)" }}>
              <RichText text={item.purpose} />
            </p>
          )}
          <pre className="mt-1 text-sm font-mono overflow-x-auto whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>
            <code>{item.code}</code>
          </pre>
          {item.structure && item.structure.length > 0 ? (
            <details className="mt-1">
              <summary className="text-xs cursor-pointer" style={{ color: "var(--muted-fg)" }}>
                Structure ({item.structure.length} blocks)
              </summary>
              <ol className="list-decimal ml-5 text-xs mt-1" style={{ color: "var(--muted-fg)" }}>
                {item.structure.map((s, i) => (
                  <li key={i}><RichText text={s} /></li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ) : item.contentType === "table" && item.headers && item.rows ? (
        <div className="overflow-x-auto">
          {item.title && (
            <h4 className="text-sm font-semibold mb-1" style={{ color: "var(--foreground)" }}>
              <RichText text={item.title} />
            </h4>
          )}
          <table className="text-sm w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {item.headers.map((h, i) => (
                  <th key={i} className="px-2 py-1 text-left text-xs font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>
                    <RichText text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {item.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 text-xs" style={{ borderBottom: "1px solid var(--border)", color: "var(--muted-fg)" }}>
                      <RichText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs mt-1" style={{ color: "var(--muted-fg)" }}>
            <RichText text={item.caption || item.description} />
          </p>
        </div>
      ) : item.contentType === "text" && item.textBlocks && item.textBlocks.length > 0 ? (
        <div>
          <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
            {typeLabel}
          </span>
          <TextBlocks blocks={item.textBlocks} />
        </div>
      ) : (
        <div>
          <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
            {typeLabel}
          </span>
          <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
            <RichText text={item.description} />
          </p>
        </div>
      )}
    </div>
  );
}

function parseTime(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  return 0;
}

interface GroupedEquationsProps {
  equations?: Equation[];
  visualContent?: VisualContent[];
  sections: Section[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export default function GroupedEquations({
  equations,
  visualContent,
  sections,
  currentTime,
  onSeek,
}: GroupedEquationsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeSectionRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement>(null);

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

  // Parse section start times
  const parsedSections = sections.map((s) => ({
    ...s,
    startSeconds: parseTime(s.start_time),
  }));

  // Find which section is active
  let activeSectionIdx = 0;
  for (let i = parsedSections.length - 1; i >= 0; i--) {
    if (currentTime >= parsedSections[i].startSeconds) {
      activeSectionIdx = i;
      break;
    }
  }

  // Group items by section
  const grouped = parsedSections.map((sec, idx) => {
    const nextStart = idx + 1 < parsedSections.length ? parsedSections[idx + 1].startSeconds : Infinity;
    const sectionItems = items.filter(
      (item) => item.start >= sec.startSeconds && item.start < nextStart
    );
    return { section: sec, items: sectionItems };
  });

  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0]));
  const visibleExpandedSections = new Set(expandedSections);
  visibleExpandedSections.add(activeSectionIdx);

  // Auto-scroll
  useEffect(() => {
    const container = containerRef.current;
    const target = activeItemRef.current;
    if (!container || !target) return;

    const elTop = target.offsetTop - container.offsetTop;
    const targetScroll = elTop - container.clientHeight / 3;

    if (Math.abs(container.scrollTop - targetScroll) > 30) {
      container.scrollTo({ top: targetScroll, behavior: "smooth" });
    }
  }, [currentTime]);

  const toggleSection = (idx: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Build summary
  const eqCount = items.filter((i) => i.contentType === "equation").length;
  const otherCount = items.length - eqCount;
  const summary = otherCount > 0
    ? `${sections.length} topics, ${eqCount} equations, ${otherCount} other`
    : `${sections.length} topics, ${eqCount} equations`;

  return (
    <div className="flex flex-col h-full">
      <div
        className="px-4 py-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-center"
        style={{ color: "var(--active-border)", borderBottom: "1px solid var(--border)" }}
      >
        Lecture Notes ({summary})
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {grouped.map((group, idx) => {
          const isActiveSec = idx === activeSectionIdx;
          const isExpanded = visibleExpandedSections.has(idx);

          return (
            <div key={idx} ref={isActiveSec ? activeSectionRef : null}>
              <div
                onClick={() => toggleSection(idx)}
                className="px-4 py-3 cursor-pointer flex items-start gap-2 transition-colors"
                style={{
                  background: isActiveSec ? "var(--active)" : "var(--card)",
                  borderBottom: "1px solid var(--border)",
                  borderLeft: isActiveSec ? "3px solid var(--active-border)" : "3px solid transparent",
                }}
              >
                <span
                  className="text-xs mt-0.5 shrink-0 transition-transform duration-200"
                  style={{
                    color: "var(--muted-fg)",
                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  ▶
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                    {group.section.title}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--muted-fg)" }}>
                    {(() => {
                      const counts: Record<string, number> = {};
                      for (const item of group.items) {
                        const label = TYPE_LABELS[item.contentType] || item.contentType;
                        counts[label] = (counts[label] || 0) + 1;
                      }
                      return Object.entries(counts)
                        .map(([label, n]) => `${n} ${label}${n > 1 ? "s" : ""}`)
                        .join(", ") || "0 items";
                    })()}
                  </p>
                </div>
              </div>

              {isExpanded && (
                <div className="px-3 py-2 space-y-2" style={{ background: "var(--card)" }}>
                  {group.items.length === 0 ? (
                    <p className="text-xs italic px-2 py-1" style={{ color: "var(--muted-fg)" }}>
                      No visual content in this section
                    </p>
                  ) : (
                    group.items.map((item) => {
                      const isActive = currentTime >= item.start && currentTime <= item.end;
                      return (
                        <div key={item.id} ref={isActive ? activeItemRef : null}>
                          <RenderedContentItem
                            item={item}
                            isActive={isActive}
                            onSeek={onSeek}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
