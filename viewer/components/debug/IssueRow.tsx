"use client";

import { ConfidenceBadge, RepairStatusBadge, TypeBadge } from "./badges";
import { formatTime } from "@/lib/debug-utils";
import { needsAttention, summarizeArtifact } from "@/lib/issues";
import type { VisualContent } from "@/lib/types";

interface Props {
  item: VisualContent;
  selected: boolean;
  active: boolean; // is the playhead currently inside [item.start, item.end]?
  onSelect: (id: string) => void;
}

function flagColor(item: VisualContent): string | null {
  if (item.repairStatus === "skipped") return "#ef4444"; // red — perception failure
  if (item.confidence < 0.85) return "#eab308"; // amber — low confidence
  return null; // clean
}

export default function ArtifactRow({ item, selected, active, onSelect }: Props) {
  const flag = flagColor(item);
  const summary = summarizeArtifact(item, 80);

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className="w-full text-left px-3 py-2 flex flex-col gap-1"
      style={{
        background: selected
          ? "var(--active)"
          : active
          ? "color-mix(in srgb, var(--active) 50%, transparent)"
          : "transparent",
        borderLeft: selected
          ? "3px solid var(--active-border)"
          : active
          ? "3px solid var(--active-border)"
          : flag
          ? `3px solid ${flag}`
          : "3px solid transparent",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {flag ? (
          <span
            className="rounded-full shrink-0"
            style={{ width: 8, height: 8, background: flag }}
            title={
              item.repairStatus === "skipped"
                ? "Perception failure — needs attention"
                : "Low confidence — needs attention"
            }
          />
        ) : (
          <span
            className="rounded-full shrink-0"
            style={{ width: 8, height: 8, background: "transparent", border: "1px solid var(--border)" }}
            title="Clean"
          />
        )}
        <span
          className="text-xs font-mono shrink-0"
          style={{ color: "var(--muted-fg)" }}
        >
          {formatTime(item.start)}
        </span>
        <TypeBadge type={item.contentType} />
        {item.repairStatus && <RepairStatusBadge status={item.repairStatus} />}
        <ConfidenceBadge confidence={item.confidence} />
      </div>
      <div
        className="text-sm pl-3 truncate"
        style={{ color: "var(--foreground)" }}
        title={summary}
      >
        {summary}
      </div>
    </button>
  );
}

export { needsAttention }; // re-export so tests / callers can keep one import
