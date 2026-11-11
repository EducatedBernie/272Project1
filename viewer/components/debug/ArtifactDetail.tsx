/**
 * Right pane body for the Artifacts tab — renders one VisualContent
 * item with full debug context: rendered LaTeX (if equation), code,
 * description, the Gemini visual_observation prose, what the prof said
 * around the time window, neighboring items, scoped re-extractions, and
 * the re-extract verification form.
 *
 * Items needing attention (low confidence, perception failures) get a
 * banner; clean items don't get a banner — every item is shown the same
 * way otherwise. The /debug page surfaces everything; flags are
 * advisory, not curatorial.
 */

"use client";

import Link from "next/link";

import {
  ConfidenceBadge,
  RepairStatusBadge,
  RichText,
  TypeBadge,
  VisualObservationExpander,
} from "./badges";
import { ItemReextract } from "./actions";
import VisualContentBody from "@/components/VisualContentBody";
import {
  type Section,
  type Segment,
  formatTime,
  parseTs,
} from "@/lib/debug-utils";
import { summarizeArtifact } from "@/lib/issues";
import type { VisualContent } from "@/lib/types";

interface Props {
  item: VisualContent;
  videoId: string;
  segments: Segment[];
  visualContent: VisualContent[];
  scopedReextractions: VisualContent[];
  sections: Section[];
  hasNext: boolean;
  onSkip: () => void;
}

function findEnclosingSection(item: VisualContent, sections: Section[]): Section | null {
  for (let i = 0; i < sections.length; i++) {
    const start = parseTs(sections[i].start_time);
    const end = sections[i].end_time
      ? parseTs(sections[i].end_time!)
      : i + 1 < sections.length
      ? parseTs(sections[i + 1].start_time)
      : Infinity;
    if (item.start >= start && item.start < end) return sections[i];
  }
  return null;
}

function HeaderStrip({
  item,
  enclosingSection,
}: {
  item: VisualContent;
  enclosingSection: Section | null;
}) {
  return (
    <div
      className="px-4 py-2 shrink-0 flex flex-col gap-1"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--muted)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono" style={{ color: "var(--muted-fg)" }}>
          {formatTime(item.start)}–{formatTime(item.end)}
        </span>
        <TypeBadge type={item.contentType} />
        {item.repairStatus && <RepairStatusBadge status={item.repairStatus} />}
        <ConfidenceBadge confidence={item.confidence} />
      </div>
      {enclosingSection && (
        <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
          Section: <span style={{ color: "var(--foreground)" }}>{enclosingSection.title}</span>
        </div>
      )}
    </div>
  );
}

function SkipBar({ hasNext, onSkip }: { hasNext: boolean; onSkip: () => void }) {
  return (
    <div
      className="flex items-center justify-end px-4 py-2 shrink-0"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <button
        type="button"
        onClick={onSkip}
        disabled={!hasNext}
        className="text-xs font-medium px-3 py-1 rounded disabled:opacity-30"
        style={{
          background: "var(--card)",
          color: "var(--foreground)",
          border: "1px solid var(--border)",
        }}
      >
        Skip → {hasNext ? "next item" : "(end of list)"}
      </button>
    </div>
  );
}

export default function ArtifactDetail({
  item,
  videoId,
  segments,
  visualContent,
  scopedReextractions,
  sections,
  hasNext,
  onSkip,
}: Props) {
  const enclosingSection = findEnclosingSection(item, sections);
  const isSkipped = item.repairStatus === "skipped";
  const isLowConf = item.confidence < 0.85;

  // Transcript context: any segment that *starts* within ±60s of the
  // item's range. Predicate matches the one used by ItemReextract's
  // context builder (actions.tsx) so the dev sees exactly what the model
  // would see on a re-extract.
  const overlapping = segments.filter(
    (s) => s.start >= item.start - 60 && s.start <= item.end + 60,
  );

  // Neighboring items by start time.
  const sorted = [...visualContent].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex((v) => v.id === item.id);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;

  // Scoped re-extracts overlapping this item's time range.
  const overlappingReextracts = scopedReextractions.filter(
    (r) => r.start < item.end + 30 && r.end > item.start - 30,
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <HeaderStrip item={item} enclosingSection={enclosingSection} />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isSkipped && (
          <div
            className="text-sm p-3 rounded"
            style={{ background: "#fed7aa40", border: "1px solid #fb923c", color: "#9a3412" }}
          >
            <strong>Perception failure</strong> — validator flagged this item
            but no heal rule matched. Content is genuinely missing from the
            extraction. Consider re-extracting with a heavier model (2.5 Pro)
            and more footage.
          </div>
        )}

        {isLowConf && !isSkipped && (
          <div
            className="text-sm p-3 rounded"
            style={{ background: "#fef9c340", border: "1px solid #eab308", color: "#854d0e" }}
          >
            <strong>Low confidence</strong> ({item.confidence.toFixed(2)}) —
            Gemini wasn&apos;t sure about this extraction. Doesn&apos;t mean
            it&apos;s wrong; check the rendered output and the visual
            observation below before re-running.
          </div>
        )}

        <div
          className="rounded p-4"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <VisualContentBody item={item} />
        </div>

        <VisualObservationExpander observation={item.visualObservation} />

        <div className="flex gap-4 text-xs" style={{ color: "var(--muted-fg)" }}>
          <span>
            Time: {formatTime(item.start)} – {formatTime(item.end)}
          </span>
          <span>Confidence: {item.confidence.toFixed(2)}</span>
          <Link
            href={`/video/${videoId}#t=${Math.floor(item.start)}`}
            className="underline"
            style={{ color: "#3b82f6" }}
          >
            Jump to viewer
          </Link>
        </div>

        {overlapping.length > 0 && (
          <div>
            <div className="text-xs font-semibold mb-1" style={{ color: "var(--muted-fg)" }}>
              What the prof said (±1 min)
            </div>
            <div className="space-y-1">
              {overlapping.map((seg) => (
                <div
                  key={seg.id}
                  className="text-xs p-2 rounded"
                  style={{ background: "var(--muted)" }}
                >
                  <span className="font-mono mr-2" style={{ color: "var(--muted-fg)" }}>
                    {formatTime(seg.start)}
                  </span>
                  <RichText text={seg.text} />
                </div>
              ))}
            </div>
          </div>
        )}

        {(prev || next) && (
          <div>
            <div className="text-xs font-semibold mb-1" style={{ color: "var(--muted-fg)" }}>
              Neighbors
            </div>
            <div className="space-y-1 text-xs">
              {prev && (
                <div
                  className="p-2 rounded flex gap-2 items-center"
                  style={{ background: "var(--muted)" }}
                >
                  <span style={{ color: "var(--muted-fg)" }}>Before:</span>
                  <TypeBadge type={prev.contentType} />
                  <ConfidenceBadge confidence={prev.confidence} />
                  <span className="truncate">{summarizeArtifact(prev, 60)}</span>
                </div>
              )}
              {next && (
                <div
                  className="p-2 rounded flex gap-2 items-center"
                  style={{ background: "var(--muted)" }}
                >
                  <span style={{ color: "var(--muted-fg)" }}>After:</span>
                  <TypeBadge type={next.contentType} />
                  <ConfidenceBadge confidence={next.confidence} />
                  <span className="truncate">{summarizeArtifact(next, 60)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {overlappingReextracts.length > 0 && (
          <div>
            <div className="text-xs font-semibold mb-1" style={{ color: "var(--muted-fg)" }}>
              Scoped re-extractions overlapping this clip ({overlappingReextracts.length})
            </div>
            <div className="space-y-1">
              {overlappingReextracts.map((r) => (
                <div
                  key={r.id}
                  className="text-xs p-2 rounded flex gap-2 items-center"
                  style={{ background: "var(--card)", border: "1px solid #3b82f6" }}
                >
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded"
                    style={{ background: "#dbeafe", color: "#1d4ed8" }}
                  >
                    RE-EXTRACT
                  </span>
                  <ConfidenceBadge confidence={r.confidence} />
                  <TypeBadge type={r.contentType} />
                  <RepairStatusBadge status={r.repairStatus} />
                  <span className="font-mono" style={{ color: "var(--muted-fg)" }}>
                    {formatTime(r.start)}
                  </span>
                  <span className="truncate">{summarizeArtifact(r)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <ItemReextract
          item={item}
          videoId={videoId}
          segments={segments}
          visualContent={visualContent}
          defaultModel={isSkipped ? "gemini-2.5-pro-preview-06-05" : "gemini-2.5-pro-preview-06-05"}
        />
      </div>

      <SkipBar hasNext={hasNext} onSkip={onSkip} />
    </div>
  );
}
