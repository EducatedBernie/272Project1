/**
 * Persistent vertical timeline pinned to the left edge of the /debug page.
 *
 *   • Tick labels every 5 minutes (right-aligned).
 *   • Section bars on the right edge, color-coded by section.severity.
 *   • One dot per visual content item. Items needing attention render
 *     in their flag color (red for skipped, amber for low-conf); clean
 *     items render in grey-blue. Click a dot to select that item and
 *     seek to it.
 *   • Orange playhead line at currentTime, smoothly transitioned.
 *   • Click anywhere off-dot to seek without selecting.
 */

"use client";

import {
  type SectionAnalysis,
  formatTime,
  TYPE_COLORS,
} from "@/lib/debug-utils";
import { needsAttention, LOWCONF_THRESHOLD } from "@/lib/issues";
import type { VisualContent } from "@/lib/types";

interface Props {
  duration: number;
  currentTime: number;
  items: VisualContent[];
  sections: SectionAnalysis[];
  selectedItemId: string | null;
  onSeek: (time: number) => void;
  onSelectItem: (id: string) => void;
}

const COLUMN_WIDTH = 80;
const TICK_INTERVAL_SECONDS = 300;

function dotColorFor(item: VisualContent): string {
  if (item.repairStatus === "skipped") return "#ef4444";
  if (item.confidence < LOWCONF_THRESHOLD) return "#eab308";
  return TYPE_COLORS[item.contentType] || "#6b7280";
}

export default function VerticalTimeline({
  duration,
  currentTime,
  items,
  sections,
  selectedItemId,
  onSeek,
  onSelectItem,
}: Props) {
  if (duration <= 0) {
    return (
      <div
        className="shrink-0"
        style={{
          width: COLUMN_WIDTH,
          borderRight: "1px solid var(--border)",
          background: "var(--card)",
        }}
      />
    );
  }

  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += TICK_INTERVAL_SECONDS) ticks.push(t);
  if (ticks[ticks.length - 1] < duration - 30) ticks.push(duration);

  const handleColumnClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientY - rect.top) / rect.height;
    const time = Math.max(0, Math.min(pct * duration, duration));
    onSeek(time);
  };

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{
        width: COLUMN_WIDTH,
        borderRight: "1px solid var(--border)",
        background: "var(--card)",
      }}
    >
      <div
        className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide shrink-0"
        style={{
          color: "var(--muted-fg)",
          borderBottom: "1px solid var(--border)",
          background: "var(--muted)",
        }}
      >
        Timeline
      </div>
      <div
        className="relative flex-1 overflow-hidden"
        style={{ cursor: "crosshair" }}
        onClick={handleColumnClick}
      >
        {ticks.map((t) => (
          <div
            key={`tick-${t}`}
            className="absolute left-0 right-0 flex items-center pointer-events-none"
            style={{ top: `${(t / duration) * 100}%`, transform: "translateY(-50%)" }}
          >
            <div className="flex-1 h-px" style={{ background: "var(--border)", opacity: 0.5 }} />
            <span
              className="text-[10px] font-mono pr-1"
              style={{ color: "var(--muted-fg)" }}
            >
              {formatTime(t)}
            </span>
          </div>
        ))}

        {sections.map((sec, i) => {
          const top = (sec.startTime / duration) * 100;
          const height = ((sec.endTime - sec.startTime) / duration) * 100;
          const color =
            sec.severity === "critical" ? "#ef4444" : sec.severity === "warning" ? "#eab308" : "#22c55e";
          return (
            <div
              key={`sec-${i}`}
              className="absolute pointer-events-none"
              title={`${sec.title} (${formatTime(sec.startTime)}-${formatTime(sec.endTime)})`}
              style={{
                top: `${top}%`,
                height: `${Math.max(height, 0.2)}%`,
                right: 0,
                width: 4,
                background: color,
                opacity: 0.6,
              }}
            />
          );
        })}

        {items.map((item) => {
          const top = (item.start / duration) * 100;
          const isSelected = item.id === selectedItemId;
          const color = dotColorFor(item);
          const flagged = needsAttention(item);
          return (
            <button
              key={item.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectItem(item.id);
                onSeek(item.start);
              }}
              title={`${formatTime(item.start)} · ${item.contentType} · conf ${item.confidence.toFixed(2)}`}
              className="absolute rounded-full"
              style={{
                top: `${top}%`,
                left: 12,
                transform: "translateY(-50%)",
                width: isSelected ? 12 : flagged ? 8 : 6,
                height: isSelected ? 12 : flagged ? 8 : 6,
                background: color,
                border: isSelected ? "2px solid var(--foreground)" : `1px solid ${color}`,
                boxShadow: isSelected ? "0 0 0 2px var(--background)" : "none",
                cursor: "pointer",
                padding: 0,
                opacity: flagged || isSelected ? 1 : 0.7,
              }}
            />
          );
        })}

        <div
          className="absolute left-0 right-0 pointer-events-none"
          style={{
            top: `${(currentTime / duration) * 100}%`,
            height: 2,
            background: "#f97316",
            transform: "translateY(-50%)",
            transition: "top 80ms linear",
          }}
        />
        <div
          className="absolute pointer-events-none"
          style={{
            top: `${(currentTime / duration) * 100}%`,
            left: 0,
            transform: "translateY(-50%)",
            width: 0,
            height: 0,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            borderLeft: "6px solid #f97316",
            transition: "top 80ms linear",
          }}
        />
      </div>
    </div>
  );
}
