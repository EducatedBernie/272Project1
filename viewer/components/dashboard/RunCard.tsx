"use client";

import Link from "next/link";
import {
  STAGES,
  getStageIndex,
  computePipelineView,
} from "@/lib/pipeline-progress";
import { parseRunError } from "@/lib/run-error";

export interface QueueRun {
  id: string;
  run_type: string;
  source_run_id?: string | null;
  status: string;
  progress:
    | {
        stage?: string;
        sections_total?: number;
        sections_complete?: number;
      }
    | null;
  created_at: string;
  error: string | null;
  cancel_requested: boolean;
  video_id: string | null;
  title: string | null;
  youtube_url: string | null;
}

function formatAge(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function youtubeIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function thumbUrl(run: QueueRun): string | null {
  if (run.run_type === "upload" && run.video_id) {
    return `/api/thumbnail?video_id=${run.video_id}`;
  }
  const yt = youtubeIdFromUrl(run.youtube_url);
  return yt ? `https://img.youtube.com/vi/${yt}/mqdefault.jpg` : null;
}

type Tone = "processing" | "queued" | "failed";

function classifyStatus(run: QueueRun): Tone {
  if (run.status === "queued") return "queued";
  if (run.status === "failed") return "failed";
  return "processing";
}

export default function RunCard({
  run,
  onCancel,
}: {
  run: QueueRun;
  onCancel?: (runId: string) => void;
}) {
  const tone = classifyStatus(run);
  const isNotes = run.run_type === "generate_notes";
  const currentStageIdx = getStageIndex(run.status);
  const sectionsTotal = run.progress?.sections_total ?? 0;
  const sectionsComplete = run.progress?.sections_complete ?? 0;
  const thumb = thumbUrl(run);
  const isFailed = tone === "failed";
  const isProcessing = tone === "processing";

  const pillStyle = {
    processing: { bg: "var(--blue-soft)", fg: "var(--blue)" },
    queued: { bg: "var(--paper-2)", fg: "var(--muted-fg)" },
    failed: { bg: "var(--err-soft)", fg: "var(--err)" },
  }[tone];

  return (
    <div
      className="grid grid-cols-1 md:[grid-template-columns:152px_1fr] rounded-2xl overflow-hidden mb-3"
      style={{
        background: "#fff",
        border: isFailed
          ? "1px solid color-mix(in srgb, var(--err) 40%, transparent)"
          : "1px solid var(--rule)",
      }}
    >
      <div
        className="relative aspect-video md:aspect-auto"
        style={{ background: "#0f0f0f" }}
      >
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="w-full h-full object-cover"
            style={{ opacity: 0.92 }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <span
          className="absolute top-1.5 left-1.5 text-[9.5px] font-semibold uppercase"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.1em",
            background: "#ffffffd8",
            backdropFilter: "blur(4px)",
            padding: "2px 7px",
            borderRadius: 999,
            color: "var(--ink)",
          }}
        >
          {isNotes ? "Study notes" : run.run_type === "upload" ? "UPLOAD" : `YT · ${youtubeIdFromUrl(run.youtube_url)?.slice(0, 12) || run.run_type}`}
        </span>
      </div>

      <div className="p-4 md:px-5 flex flex-col gap-2.5 min-w-0">
        <div className="flex justify-between items-start gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div
              className="text-[15px] font-semibold leading-tight"
              style={{
                color: "var(--ink)",
                letterSpacing: "-0.005em",
                display: "-webkit-box",
                WebkitLineClamp: 1,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
              title={run.title ?? undefined}
            >
              {run.title ?? (run.youtube_url || "Untitled run")}
            </div>
            <div
              className="flex gap-3 flex-wrap mt-1 text-[11px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--muted-fg)",
                letterSpacing: "0.02em",
              }}
            >
              <span>
                <b style={{ color: "var(--ink-2)", fontWeight: 600 }}>
                  {isProcessing ? "started" : isFailed ? "failed" : "queued"}
                </b>{" "}
                {formatAge(run.created_at)} ago
              </span>
              <span>
                run <b style={{ color: "var(--ink-2)", fontWeight: 600 }}>#{run.id.slice(0, 8)}</b>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
            <span
              className="text-[10.5px] font-semibold uppercase px-2.5 py-0.5 rounded-full"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.08em",
                background: pillStyle.bg,
                color: pillStyle.fg,
              }}
            >
              {tone === "processing" ? "● processing" : tone === "queued" ? "queued" : "failed"}
            </span>
            <div className="flex gap-1.5">
              {run.video_id && (
                <Link
                  href={isNotes ? `/video/${run.video_id}/notes?run=${run.source_run_id}` : `/video/${run.video_id}`}
                  className="rounded-md px-2.5 py-1 text-[11px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "#fff",
                    color: "var(--ink-2)",
                    border: "1px solid var(--rule)",
                  }}
                >
                  Open
                </Link>
              )}
              {isProcessing && onCancel && !run.cancel_requested && (
                <button
                  type="button"
                  onClick={() => onCancel(run.id)}
                  className="rounded-md px-2.5 py-1 text-[11px] cursor-pointer"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "#fff",
                    color: "var(--err)",
                    border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)",
                  }}
                >
                  Cancel
                </button>
              )}
              {isProcessing && run.status !== "complete" && run.cancel_requested && (
                <span
                  className="rounded-md px-2.5 py-1 text-[11px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "var(--paper-2)",
                    color: "var(--muted-fg)",
                    border: "1px solid var(--rule)",
                  }}
                  title="Cancel signaled — worker will exit at next stage transition"
                >
                  Cancelling…
                </span>
              )}
            </div>
          </div>
        </div>

        {!isFailed && isNotes && <p role="status">{run.progress?.stage || "Generating notes"}</p>}
        {!isFailed && !isNotes && (
          <>
            {/* Desktop: 5-stage breakdown */}
            <div className="hidden md:grid grid-cols-5 gap-0">
              {STAGES.map((stage, i) => {
                const isComplete = i < currentStageIdx || (run.status === "complete");
                const isCurrent = i === currentStageIdx && !isComplete;
                const isPending = i > currentStageIdx;
                const barWidth = isComplete
                  ? "100%"
                  : isCurrent && stage.key === "processing_sections" && sectionsTotal > 0
                    ? `${Math.round((sectionsComplete / sectionsTotal) * 100)}%`
                    : isCurrent
                      ? "55%"
                      : "0%";
                return (
                  <div
                    key={stage.key}
                    className="relative pt-2 pb-1.5 px-0.5 flex flex-col gap-1.5"
                    style={{
                      borderTop: isComplete
                        ? "2px solid var(--good)"
                        : isCurrent
                          ? "2px solid var(--accent)"
                          : "2px solid var(--rule)",
                    }}
                  >
                    {isComplete && (
                      <span
                        className="absolute grid place-items-center rounded-full"
                        style={{
                          top: -7,
                          left: 0,
                          width: 12,
                          height: 12,
                          background: "var(--good)",
                          color: "#fff",
                          fontSize: 8,
                        }}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                    )}
                    {isCurrent && (
                      <span
                        className="absolute rounded-full"
                        style={{
                          top: -8,
                          left: 0,
                          width: 14,
                          height: 14,
                          background: "var(--accent)",
                          boxShadow: "0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent)",
                          animation: "chalkboard-pulse 1.6s ease-out infinite",
                        }}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="text-[10.5px] font-medium"
                      style={{
                        fontFamily: "var(--font-mono)",
                        letterSpacing: "0.06em",
                        color: isComplete
                          ? "var(--good)"
                          : isCurrent
                            ? "var(--accent-2)"
                            : "var(--muted-fg)",
                        fontWeight: isCurrent ? 600 : 500,
                      }}
                    >
                      {stage.label}
                      {isCurrent && stage.key === "processing_sections" && sectionsTotal > 0
                        ? ` · ${sectionsComplete}/${sectionsTotal}`
                        : ""}
                    </span>
                    <span
                      className="text-[11px] min-h-[14px]"
                      style={{
                        fontFamily: isPending ? "var(--font-mono)" : undefined,
                        color: isPending ? "var(--ink-2)" : "var(--ink-2)",
                      }}
                    >
                      {isPending ? "—" : isCurrent ? stage.label.toLowerCase() + "…" : ""}
                    </span>
                    <div
                      className="mt-auto h-[3px] rounded overflow-hidden"
                      style={{ background: "var(--paper-2)" }}
                    >
                      <div
                        className="h-full rounded transition-all duration-500"
                        style={{
                          width: barWidth,
                          background: isComplete
                            ? "var(--good)"
                            : "linear-gradient(90deg, var(--accent), var(--accent-soft), var(--accent))",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Mobile: compact single bar + tiny stage-dot strip */}
            <CompactProgress
              stageIdx={currentStageIdx}
              sectionsComplete={sectionsComplete}
              sectionsTotal={sectionsTotal}
              isComplete={run.status === "complete"}
            />
          </>
        )}

        {/* Section-by-section dot bar — desktop only.
            On mobile the section count is folded into the CompactProgress header
            (e.g. "Sections · 3/8"), so a second progress visualization is redundant. */}
        {isProcessing && sectionsTotal > 0 && (
          <div
            className="hidden md:flex items-center gap-2.5 p-2.5 rounded-lg mt-1 text-[11.5px]"
            style={{ background: "var(--paper)", fontFamily: "var(--font-mono)" }}
          >
            <div className="flex-1 flex gap-[3px]">
              {Array.from({ length: sectionsTotal }).map((_, i) => {
                const done = i < sectionsComplete;
                const cur = i === sectionsComplete;
                return (
                  <div
                    key={i}
                    className="flex-1 h-2.5 rounded"
                    style={{
                      background: done
                        ? "var(--good)"
                        : cur
                          ? "var(--accent)"
                          : "var(--paper-3)",
                    }}
                  />
                );
              })}
            </div>
            <span style={{ color: "var(--muted-fg)", letterSpacing: "0.04em" }}>
              <b style={{ color: "var(--ink)" }}>
                {sectionsComplete}/{sectionsTotal}
              </b>{" "}
              sections
            </span>
          </div>
        )}

        {isFailed && (() => {
          const parsed = parseRunError(run.error);
          return (
            <div
              className="flex justify-between items-center gap-3 p-2.5 rounded-lg text-[11.5px] leading-[1.5]"
              style={{
                background: parsed.cancelled ? "var(--paper-2)" : "var(--err-soft)",
                borderLeft: `3px solid ${parsed.cancelled ? "var(--muted-fg)" : "var(--err)"}`,
                color: parsed.cancelled ? "var(--muted-fg)" : "var(--err)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span
                className="truncate"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={run.error ?? ""}
              >
                {parsed.cancelled ? <b>cancelled</b> : <><b>failed</b> · {parsed.summary}</>}
              </span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function CompactProgress({
  stageIdx,
  sectionsComplete,
  sectionsTotal,
  isComplete,
}: {
  stageIdx: number;
  sectionsComplete: number;
  sectionsTotal: number;
  isComplete: boolean;
}) {
  // Reconstruct status from inputs so we can use the shared computation.
  // Caller-derived stageIdx + isComplete already encode the relevant state.
  const status = isComplete
    ? "complete"
    : stageIdx >= 0
    ? STAGES[stageIdx].key
    : "queued";
  const view = computePipelineView({ status, sectionsTotal, sectionsComplete });
  const { isQueued, safeIdx, mobileLabel, overallPct } = view;

  // Strip is purely decorative — text label above already conveys current stage.
  const stripLabel = `Stage ${Math.min(safeIdx + 1, STAGES.length)} of ${STAGES.length}: ${
    view.currentStage?.label ?? (isComplete ? "Done" : "Queued")
  }`;

  return (
    <div className="md:hidden flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="text-[12px] font-semibold"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.06em",
            color: isComplete
              ? "var(--good)"
              : isQueued
              ? "var(--muted-fg)"
              : "var(--accent-2)",
            textTransform: "uppercase",
          }}
        >
          {mobileLabel}
        </span>
        <span
          className="text-[11px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--muted-fg)" }}
        >
          {overallPct}%
        </span>
      </div>
      <div
        className="h-[6px] rounded overflow-hidden"
        style={{ background: "var(--paper-2)" }}
      >
        <div
          className="h-full rounded transition-all duration-500"
          style={{
            width: `${overallPct}%`,
            background: isComplete
              ? "var(--good)"
              : "linear-gradient(90deg, var(--accent), var(--accent-soft), var(--accent))",
          }}
        />
      </div>
      <div role="img" aria-label={stripLabel} className="flex items-center gap-1.5">
        {STAGES.map((s, i) => {
          const done = !isQueued && i < safeIdx;
          const cur = !isQueued && i === safeIdx && !isComplete;
          return (
            <div
              key={s.key}
              className="flex-1 h-[3px] rounded"
              style={{
                background: done
                  ? "var(--good)"
                  : cur
                  ? "var(--accent)"
                  : "var(--paper-2)",
                opacity: cur ? 1 : done ? 0.85 : 1,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
