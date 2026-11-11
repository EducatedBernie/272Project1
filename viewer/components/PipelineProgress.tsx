"use client";

import {
  STAGES,
  getStageIndex,
  computePipelineView,
} from "@/lib/pipeline-progress";

interface Run {
  id: string;
  status: string;
  progress: Record<string, unknown>;
}

export default function PipelineProgress({ run }: { run: Run }) {
  const currentStageIdx = getStageIndex(run.status);
  const progress = run.progress || {};
  const sectionsTotal = (progress.sections_total as number) || 0;
  const sectionsComplete = (progress.sections_complete as number) || 0;
  const view = computePipelineView({
    status: run.status,
    sectionsTotal,
    sectionsComplete,
  });
  const { isComplete, isQueued, safeIdx, mobileLabel, overallPct } = view;
  const stripLabel = `Stage ${Math.min(safeIdx + 1, STAGES.length)} of ${STAGES.length}: ${
    view.currentStage?.label ?? (isComplete ? "Done" : "Queued")
  }`;

  return (
    <div
      className="px-4 md:px-6 py-2.5 md:py-3 shrink-0"
      style={{ background: "var(--muted)", borderBottom: "1px solid var(--border)" }}
    >
      {/* Desktop: stage-by-stage trail */}
      <div className="hidden md:flex items-center gap-1">
        {STAGES.map((stage, i) => {
          const isDone = i < currentStageIdx;
          const isCurrent = i === currentStageIdx;
          const isPending = i > currentStageIdx;

          let detail = "";
          if (isCurrent && stage.key === "processing_sections" && sectionsTotal > 0) {
            detail = ` (${sectionsComplete}/${sectionsTotal})`;
          }

          return (
            <div key={stage.key} className="flex items-center gap-1">
              {i > 0 && (
                <div
                  className="w-6 h-px"
                  style={{ background: isDone ? "var(--foreground)" : "var(--border)" }}
                />
              )}
              <div className="flex items-center gap-1.5">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    background: isDone
                      ? "var(--foreground)"
                      : isCurrent
                      ? "var(--blue)"
                      : "var(--border)",
                    boxShadow: isCurrent
                      ? "0 0 0 3px color-mix(in srgb, var(--blue) 30%, transparent)"
                      : "none",
                  }}
                />
                <span
                  className="text-xs whitespace-nowrap"
                  style={{
                    color: isPending ? "var(--muted-fg)" : "var(--foreground)",
                    fontWeight: isCurrent ? 600 : 400,
                  }}
                >
                  {stage.label}{detail}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile: one-line summary + single bar + tiny stage strip */}
      <div className="md:hidden flex flex-col gap-1.5 pr-16">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className="text-[12px] font-semibold uppercase"
            style={{
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.06em",
              color: isComplete
                ? "var(--good)"
                : isQueued
                ? "var(--muted-fg)"
                : "var(--foreground)",
            }}
          >
            {mobileLabel}
          </span>
          <span
            className="text-[11px] font-mono"
            style={{ color: "var(--muted-fg)" }}
          >
            {overallPct}%
          </span>
        </div>
        <div
          className="h-[5px] rounded overflow-hidden"
          style={{ background: "var(--border)" }}
        >
          <div
            className="h-full rounded transition-all duration-500"
            style={{
              width: `${overallPct}%`,
              background: isComplete ? "var(--good)" : "var(--blue)",
            }}
          />
        </div>
        <div role="img" aria-label={stripLabel} className="flex items-center gap-1">
          {STAGES.map((s, i) => {
            const done = !isQueued && i < safeIdx;
            const cur = !isQueued && i === safeIdx && !isComplete;
            return (
              <div
                key={s.key}
                className="flex-1 h-[2px] rounded"
                style={{
                  background: done
                    ? "var(--foreground)"
                    : cur
                    ? "var(--blue)"
                    : "var(--border)",
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
