"use client";

import { SummaryCard } from "./badges";
import { formatTime, type SectionAnalysis } from "@/lib/debug-utils";
import type { VisualContent } from "@/lib/types";
import type { AlignmentMeta } from "@/lib/alignment-meta";

interface Props {
  duration: number;
  segmentCount: number;
  visualContent: VisualContent[];
  analysis: SectionAnalysis[];
  alignmentMeta: AlignmentMeta | null;
}

export default function StatStrip({
  duration,
  segmentCount,
  visualContent,
  analysis,
  alignmentMeta,
}: Props) {
  const totalCoverage = alignmentMeta?.ref_coverage ?? null;
  const refTotal = alignmentMeta?.total_ref_words ?? 0;
  const refMatched = alignmentMeta
    ? alignmentMeta.total_ref_words - alignmentMeta.unmatched_ref_words.length
    : 0;

  const criticalCount = analysis.filter((a) => a.severity === "critical").length;
  const warningCount = analysis.filter((a) => a.severity === "warning").length;
  const lowConfCount = visualContent.filter((v) => v.confidence < 0.85).length;
  const equationCount = visualContent.filter((v) => v.contentType === "equation").length;

  return (
    <div className="grid grid-cols-5 gap-3">
      <SummaryCard
        label="Word Coverage"
        value={totalCoverage !== null ? `${Math.round(totalCoverage * 100)}%` : "—"}
        detail={
          alignmentMeta
            ? `${refMatched.toLocaleString()} / ${refTotal.toLocaleString()} words`
            : "no alignment data"
        }
        alert={totalCoverage !== null && totalCoverage < 0.8}
      />
      <SummaryCard
        label="Segments"
        value={String(segmentCount)}
        detail={formatTime(duration)}
      />
      <SummaryCard
        label="Visual Content"
        value={String(visualContent.length)}
        detail={`${equationCount} eq`}
      />
      <SummaryCard
        label="Critical"
        value={String(criticalCount)}
        detail={`${warningCount} warn`}
        alert={criticalCount > 0}
      />
      <SummaryCard
        label="Low Confidence"
        value={String(lowConfCount)}
        detail="< 0.85"
        alert={lowConfCount > 0}
      />
    </div>
  );
}
