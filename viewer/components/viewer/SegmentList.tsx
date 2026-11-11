"use client";

import { useEffect, useRef } from "react";
import { SegmentText, InlineLatex, parseInlineLatex } from "@/lib/inline-latex";
import { parseTime, formatTime } from "@/lib/time";
import { getPreferredScrollBehavior } from "@/lib/motion";
import type { AnchoredSegment, VisualContent } from "@/lib/types";
import { KindChip, type Variant } from "@/lib/chip-meta";

interface Section {
  start_time: string;
  end_time?: string;
  title: string;
  description: string;
}

interface SegmentListProps {
  segments: AnchoredSegment[];
  sections: Section[] | null;
  currentTime: number;
  onSeek: (time: number) => void;
}

export default function SegmentList({
  segments,
  sections,
  currentTime,
  onSeek,
}: SegmentListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  let activeId: string | null = null;
  for (const s of segments) {
    if (s.start <= currentTime) activeId = s.id;
    else break;
  }
  const activeSegment = activeId
    ? segments.find((segment) => segment.id === activeId)
    : null;

  useEffect(() => {
    if (!activeRef.current || !containerRef.current) return;
    const c = containerRef.current;
    const el = activeRef.current;
    const target = el.offsetTop - c.offsetTop - c.clientHeight / 3;
    if (Math.abs(c.scrollTop - target) > 30) {
      c.scrollTo({ top: target, behavior: getPreferredScrollBehavior() });
    }
  }, [activeId]);

  const sectionStarts = (sections ?? []).map((s, idx) => ({
    ...s,
    index: idx,
    startSeconds: parseTime(s.start_time),
  }));

  function sectionForSegment(segStart: number) {
    if (sectionStarts.length === 0) return null;
    let chosen = sectionStarts[0];
    for (const s of sectionStarts) {
      if (s.startSeconds <= segStart) chosen = s;
      else break;
    }
    return chosen;
  }

  const rows: React.ReactNode[] = [];
  let prevSectionIdx: number | null = null;
  for (const s of segments) {
    const sec = sectionForSegment(s.start);
    if (sec && sec.index !== prevSectionIdx) {
      rows.push(
        <div
          key={`sec-${sec.index}`}
          className="px-5 pt-6 pb-3 text-[20px] leading-snug"
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontWeight: 500,
            color: "var(--foreground)",
            borderTop: prevSectionIdx === null ? "none" : "1px solid var(--border)",
          }}
        >
          § {sec.index + 1} · {sec.title}
        </div>
      );
      prevSectionIdx = sec.index;
    }
    const isActive = s.id === activeId;
    const spokenText = toSpokenTranscriptText(s.text);
    rows.push(
      <div
        key={s.id}
        ref={isActive ? activeRef : null}
        className="px-5 py-2.5"
        style={{
          background: isActive ? "var(--paper-2)" : "transparent",
          borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
        }}
        aria-current={isActive ? "true" : undefined}
      >
        <button
          type="button"
          onClick={() => onSeek(s.start)}
          className="w-full text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 rounded-sm"
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            outlineColor: "var(--accent)",
          }}
          aria-label={`Seek to ${formatTime(s.start)}: ${spokenText}`}
        >
          <span
            className="text-[11px] font-mono mr-2 align-top"
            style={{ color: "var(--muted-fg)" }}
          >
            {formatTime(s.start)}
          </span>
          <span
            className="text-[15px] leading-[1.55]"
            style={{
              color: isActive ? "var(--foreground)" : "var(--muted-fg)",
              fontFamily: "var(--font-sans)",
            }}
          >
            <SegmentText text={s.text} />
          </span>
        </button>
        {s.visuals.length > 0 && (
          <div className="mt-2 ml-11 flex flex-col gap-1.5">
            {s.visuals.map((v) => (
              <VisualChip key={v.id} visual={v} onSeek={onSeek} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto" style={{ background: "var(--card)" }}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {activeSegment
          ? `Transcript at ${formatTime(activeSegment.start)}: ${toSpokenTranscriptText(activeSegment.text)}`
          : "No transcript segment active"}
      </div>
      {rows}
    </div>
  );
}

// Floor-level spoken form for the transcript live region and seek labels.
// A live region is linear and non-navigable, so we announce a category word
// rather than a linearized equation — the navigable math lives in the on-screen
// MathML. TODO: replace with a precomputed `spoken` field (Speech Rule Engine,
// generated in the pipeline) once available; that also feeds the TTS roadmap item.
function toSpokenTranscriptText(text: string): string {
  return parseInlineLatex(text)
    .map((part) =>
      part.type === "latex" ? ` ${mathCategoryWord(part.content)} ` : part.content
    )
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

// A relation (=, ≤, ≥, ≠, etc.) reads as "equation"; anything else is a bare
// "expression". Cheap, deterministic stand-in until real speech strings exist.
function mathCategoryWord(latex: string): string {
  return /=|\\le\b|\\ge\b|\\neq\b|\\leq\b|\\geq\b|\\approx\b|\\equiv\b/.test(latex)
    ? "equation"
    : "expression";
}

function VisualChip({
  visual,
  onSeek,
}: {
  visual: VisualContent;
  onSeek: (t: number) => void;
}) {
  const { label, variant } = kindMeta(visual.contentType);

  return (
    <button
      type="button"
      onClick={() => onSeek(visual.start)}
      className="text-left rounded-md px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        background: "color-mix(in srgb, var(--paper-2) 60%, transparent)",
        border: "1px solid var(--border)",
        outlineColor: "var(--accent)",
      }}
    >
      <div className="flex items-center gap-2">
        <KindChip variant={variant} />
        <span
          className="text-[10px] uppercase"
          style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.1em", color: "var(--muted-fg)" }}
        >
          {label}
        </span>
      </div>
      <div className="mt-1 text-[13px]" style={{ color: "var(--foreground)" }}>
        {visual.contentType === "equation" && visual.latex ? (
          <InlineLatex latex={visual.latex} />
        ) : visual.contentType === "code" && visual.code ? (
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {visual.code.split("\n")[0]}
            {visual.code.includes("\n") ? " …" : ""}
          </span>
        ) : visual.contentType === "text" && visual.textBlocks && visual.textBlocks.length > 0 ? (
          <span className="line-clamp-2">
            <SegmentText text={textPreview(visual.textBlocks)} />
          </span>
        ) : visual.contentType === "table" && (visual.title || visual.caption) ? (
          <span className="line-clamp-2">
            <SegmentText text={visual.title || visual.caption || ""} />
          </span>
        ) : (
          <span className="line-clamp-2">
            <SegmentText text={visual.description || visual.caption || visual.title || ""} />
          </span>
        )}
      </div>
    </button>
  );
}

function kindMeta(type: string): { label: string; variant: Variant } {
  if (type === "equation") return { label: "Equation", variant: "eq" };
  if (type === "diagram_description") return { label: "Diagram", variant: "dia" };
  if (type === "chart_description") return { label: "Chart", variant: "chart" };
  if (type === "code") return { label: "Code", variant: "code" };
  if (type === "table") return { label: "Table", variant: "table" };
  return { label: "Text", variant: "text" };
}

function textPreview(blocks: { kind: string; text: string }[]): string {
  const heading = blocks.find((b) => b.kind === "heading" && b.text.trim());
  const primary = heading || blocks.find((b) => b.text.trim());
  if (!primary) return "";
  const extra = blocks.length - 1;
  return extra > 0 ? `${primary.text} · +${extra} more` : primary.text;
}
