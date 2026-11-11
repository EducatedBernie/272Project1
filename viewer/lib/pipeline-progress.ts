/**
 * Shared pipeline progress model for RunCard (dashboard) and PipelineProgress (viewer banner).
 *
 * Single source of truth for stage labels, the queued/complete edge cases, and
 * the percentage formula. Both components display the same run, so they should
 * agree on labels and math.
 */

export interface PipelineStage {
  key: string;
  label: string;
}

export const STAGES: PipelineStage[] = [
  { key: "downloading_captions", label: "Captions" },
  { key: "generating_topic_map", label: "Topic Map" },
  { key: "processing_sections", label: "Sections" },
  { key: "word_aligning", label: "Alignment" },
  { key: "saving", label: "Saving" },
];

export function getStageIndex(status: string): number {
  return STAGES.findIndex((s) => s.key === status);
}

export interface PipelineProgressView {
  isComplete: boolean;
  isQueued: boolean;
  /** Clamped to [0, STAGES.length]; equals STAGES.length when complete. */
  safeIdx: number;
  /** Active stage object, or null when queued/complete. */
  currentStage: PipelineStage | null;
  /** [0, 1] when in `processing_sections` and totals known; otherwise null. */
  sectionFrac: number | null;
  /** Overall pipeline percentage [0, 100]. */
  overallPct: number;
  /** Single-line mobile header label, e.g. "Sections · 3/8" or "Queued · waiting". */
  mobileLabel: string;
}

export function computePipelineView({
  status,
  sectionsTotal,
  sectionsComplete,
}: {
  status: string;
  sectionsTotal: number;
  sectionsComplete: number;
}): PipelineProgressView {
  const isComplete = status === "complete";
  const stageIdx = getStageIndex(status);
  const isQueued = !isComplete && stageIdx < 0;
  const safeIdx = isComplete ? STAGES.length : Math.max(0, stageIdx);
  const currentStage = isComplete || isQueued ? null : STAGES[safeIdx] ?? STAGES[0];
  const sectionFrac =
    currentStage?.key === "processing_sections" && sectionsTotal > 0
      ? sectionsComplete / sectionsTotal
      : null;
  const overallPct = isComplete
    ? 100
    : isQueued
    ? 0
    : Math.round(((safeIdx + (sectionFrac ?? 0.55)) / STAGES.length) * 100);
  const mobileLabel = isComplete
    ? "Done"
    : isQueued
    ? "Queued · waiting"
    : sectionFrac !== null
    ? `${currentStage!.label} · ${sectionsComplete}/${sectionsTotal}`
    : `${currentStage!.label}…`;

  return {
    isComplete,
    isQueued,
    safeIdx,
    currentStage,
    sectionFrac,
    overallPct,
    mobileLabel,
  };
}
