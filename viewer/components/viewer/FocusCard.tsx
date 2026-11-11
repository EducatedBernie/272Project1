"use client";

import { forwardRef } from "react";
import VideoPlayer, { type PlayerHandle } from "@/components/VideoPlayer";
import VisualContentBody from "@/components/VisualContentBody";
import { parseTime, formatTime } from "@/lib/time";
import type { VideoSource, VisualContent } from "@/lib/types";

interface Section {
  start_time: string;
  end_time?: string;
  title: string;
  description: string;
}

function findActiveSection(
  sections: Section[] | null,
  currentTime: number
): { section: Section; index: number } | null {
  if (!sections || sections.length === 0) return null;
  let idx = 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (currentTime >= parseTime(sections[i].start_time)) {
      idx = i;
      break;
    }
  }
  return { section: sections[idx], index: idx };
}

function findActiveVisuals(
  visuals: VisualContent[],
  currentTime: number
): VisualContent[] {
  return visuals
    .filter((v) => v.start <= currentTime && currentTime <= v.end)
    .sort((a, b) => b.start - a.start); // most recent first
}

interface VisualsPanelProps {
  visuals: VisualContent[];
  sections: Section[] | null;
  currentTime: number;
}

export function VisualsPanel({ visuals, sections, currentTime }: VisualsPanelProps) {
  const activeSection = findActiveSection(sections, currentTime);
  const active = findActiveVisuals(visuals, currentTime);

  return (
    <div
      className="h-full overflow-y-auto px-6 py-5"
      tabIndex={0}
      aria-label="On-screen visual content"
      style={{ background: "var(--card)" }}
    >
      {activeSection && (
        <div
          className="text-[17px] leading-snug mb-4"
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontWeight: 500,
            color: "var(--foreground)",
          }}
        >
          § {activeSection.index + 1} · {activeSection.section.title}
        </div>
      )}

      <div
        className="flex items-center gap-2 mb-4 text-[11px] uppercase"
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.12em",
          color: "var(--muted-fg)",
        }}
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 6, height: 6, background: "var(--accent)" }}
        />
        <span>On screen</span>
        <span style={{ color: "var(--border)" }}>·</span>
        <span>{formatTime(currentTime)}</span>
        {active.length > 0 && (
          <>
            <span style={{ color: "var(--border)" }}>·</span>
            <span>
              {active.length} active {active.length === 1 ? "element" : "elements"}
            </span>
          </>
        )}
      </div>

      {active.length === 0 ? (
        <p className="text-sm italic" style={{ color: "var(--muted-fg)" }}>
          Nothing on the board right now.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {active.map((item) => (
            <VisualPanel key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

interface FocusCardProps {
  source: VideoSource;
  visuals: VisualContent[];
  sections: Section[] | null;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  startAt?: number;
  title?: string;
}

const FocusCard = forwardRef<PlayerHandle, FocusCardProps>(function FocusCard(
  { source, visuals, sections, currentTime, onTimeUpdate, startAt, title },
  ref
) {
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="bg-black shrink-0">
        <VideoPlayer
          ref={ref}
          source={source}
          onTimeUpdate={onTimeUpdate}
          startAt={startAt}
          title={title}
        />
      </div>

      <div
        className="flex-1 min-h-0"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <VisualsPanel visuals={visuals} sections={sections} currentTime={currentTime} />
      </div>
    </div>
  );
});

function VisualPanel({ item }: { item: VisualContent }) {
  const { label, variant } = kindMeta(item.contentType);
  const headerColors = {
    eq:    { bg: "color-mix(in srgb, var(--accent) 8%, #fff)", fg: "var(--accent-2)" },
    text:  { bg: "#e7e2d4", fg: "#4c3a17" },
    dia:   { bg: "#e6efe8", fg: "#2f7d3e" },
    chart: { bg: "#dfe8f0", fg: "#2f5d8a" },
    table: { bg: "#efe8dc", fg: "#6d5426" },
    code:  { bg: "#eae4f2", fg: "#5b3f94" },
  }[variant];

  return (
    <div
      className="rounded-lg p-4"
      style={{ background: "var(--paper-2)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <span
          className="text-[10px] font-bold px-2 py-1 rounded"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.14em",
            background: headerColors.bg,
            color: headerColors.fg,
          }}
        >
          {label}
        </span>
        <span
          className="text-[10.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--muted-fg)" }}
        >
          {formatTime(item.start)} – {formatTime(item.end)}
        </span>
      </div>

      <VisualContentBody item={item} />
    </div>
  );
}

function kindMeta(contentType: string): {
  label: string;
  variant: "eq" | "dia" | "code" | "text" | "chart" | "table";
} {
  if (contentType === "equation") return { label: "EQUATION", variant: "eq" };
  if (contentType === "code") return { label: "PSEUDOCODE", variant: "code" };
  if (contentType === "diagram_description") return { label: "DIAGRAM", variant: "dia" };
  if (contentType === "chart_description") return { label: "CHART", variant: "chart" };
  if (contentType === "table") return { label: "TABLE", variant: "table" };
  if (contentType === "slide" || contentType === "text") return { label: "TEXT", variant: "text" };
  return { label: contentType.toUpperCase(), variant: "text" };
}

export default FocusCard;
