"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import VideoPlayer, { type PlayerHandle } from "./VideoPlayer";
import FocusCard, { VisualsPanel } from "./viewer/FocusCard";
import SegmentList from "./viewer/SegmentList";
import ViewerTopbar from "./viewer/ViewerTopbar";
import MobileTabBar from "./viewer/MobileTabBar";
import ThemeToggle from "./ThemeToggle";
import RunSelector from "./RunSelector";
import PipelineProgress from "./PipelineProgress";
import { useIsMobile } from "@/lib/use-media-query";
import { parseRunError } from "@/lib/run-error";
import type { AnchoredSegment, VisualContent, VideoSource } from "@/lib/types";

interface Run {
  id: string;
  status: string;
  run_type?: string | null;
  progress: Record<string, unknown>;
  pipeline_version: string;
  transcript_prompt_version: string | null;
  equations_prompt_version: string | null;
  visual_content_prompt_version: string | null;
  segment_count: number | null;
  equation_count: number | null;
  error: string | null;
  created_at: string;
}

interface Section {
  start_time: string;
  end_time?: string;
  title: string;
  description: string;
}

interface VideoViewerWithRunsProps {
  videoId: string;
  source: VideoSource;
  anchoredSegments: AnchoredSegment[];
  visualContent: VisualContent[];
  sections: Section[] | null;
  duration: number;
  title: string;
  runs: Run[];
  activeRunId: string | null;
}

const ACTIVE_RUN_WINDOW_MS = 30 * 60 * 1000;

function isTerminalRun(status: string): boolean {
  return status === "complete" || status === "failed";
}

export default function VideoViewerWithRuns({
  videoId,
  source,
  anchoredSegments,
  visualContent,
  sections,
  duration,
  title,
  runs,
  activeRunId,
}: VideoViewerWithRunsProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeRunProgress, setActiveRunProgress] = useState<Run | null>(null);
  const [mobileTab, setMobileTab] = useState<"outputs" | "transcript">("transcript");
  const [nowMs, setNowMs] = useState<number | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const router = useRouter();
  const isMobile = useIsMobile();
  const isRecentRun = useCallback((run: Run) => {
    if (nowMs === null) return false;
    const createdAtMs = Date.parse(run.created_at);
    return Number.isFinite(createdAtMs) && createdAtMs >= nowMs - ACTIVE_RUN_WINDOW_MS;
  }, [nowMs]);
  const inProgressRun = runs.find((r) => !isTerminalRun(r.status) && isRecentRun(r)) ?? null;
  const recentActiveRunProgress =
    activeRunProgress && (!isTerminalRun(activeRunProgress.status) ? isRecentRun(activeRunProgress) : true)
      ? activeRunProgress
      : null;
  const polledRun = recentActiveRunProgress ?? inProgressRun;

  const handleTimeUpdate = useCallback((t: number) => setCurrentTime(t), []);
  const handleSeek = useCallback((t: number) => {
    playerRef.current?.seekTo(t);
    setCurrentTime(t);
  }, []);

  useEffect(() => {
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const interval = setInterval(updateNow, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!polledRun) return;
    if (isTerminalRun(polledRun.status)) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${polledRun.id}`);
        if (!res.ok) {
          console.warn(`[VideoViewer] run poll ${polledRun.id}: HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setActiveRunProgress(data);
        if (data.status === "complete") {
          router.refresh();
        }
        if (data.status === "failed") {
          setCancelling(false);
        }
      } catch (err) {
        console.warn(`[VideoViewer] run poll ${polledRun.id} network error`, err);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [polledRun, router]);

  const handleReprocess = async () => {
    setReprocessing(true);
    try {
      const res = await fetch("/api/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId }),
      });
      const data = await res.json();
      if (data.run_id) {
        setActiveRunProgress({
          id: data.run_id,
          status: "queued",
          progress: { stage: "Starting..." },
          pipeline_version: "v2",
          transcript_prompt_version: null,
          equations_prompt_version: null,
          visual_content_prompt_version: null,
          segment_count: null,
          equation_count: null,
          error: null,
          created_at: new Date().toISOString(),
        });
        setReprocessing(false);
      } else {
        setReprocessing(false);
      }
    } catch {
      setReprocessing(false);
    }
  };

  const handleCancel = async () => {
    if (!polledRun) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/runs/${polledRun.id}/cancel`, { method: "POST" });
      if (!res.ok) setCancelling(false);
    } catch {
      setCancelling(false);
    }
  };

  const handleRunChange = (runId: string) => {
    router.push(`/video/${videoId}?run=${runId}`);
  };

  const displayedRun =
    recentActiveRunProgress ?? runs.find((r) => r.id === activeRunId) ?? null;
  const runIsActive = Boolean(polledRun && !isTerminalRun(polledRun.status));
  const notesRun = runs.find((run) => run.id === activeRunId && run.status === "complete" &&
    (run.run_type == null || run.run_type === "process" || run.run_type === "reprocess") &&
    !["section", "item"].includes(String(run.progress?.scope)));
  const notesHref = notesRun ? `/video/${videoId}/notes?${new URLSearchParams({ run: notesRun.id })}` : null;
  const debugHref = (() => {
    const params = new URLSearchParams();
    if (activeRunId) params.set("run", activeRunId);
    if (currentTime > 0) params.set("t", String(Math.floor(currentTime)));
    const qs = params.toString();
    return `/video/${videoId}/debug${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="flex flex-col overflow-hidden" style={{ background: "var(--background)", height: "100dvh" }}>
      <ViewerTopbar title={title} visuals={visualContent} durationSeconds={duration} notesHref={notesHref}>
        {runs.length > 0 && (
          <RunSelector runs={runs} activeRunId={activeRunId} onRunChange={handleRunChange} />
        )}
        <button
          onClick={handleReprocess}
          disabled={reprocessing || runIsActive}
          className="px-3 py-1.5 text-xs font-medium rounded-md disabled:opacity-50"
          style={{
            background: "var(--paper-2)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
          }}
        >
          {reprocessing || runIsActive ? "Reprocessing..." : "Reprocess"}
        </button>
        <details className="relative">
          <summary
            className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
            style={{
              background: "var(--paper-2)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
            }}
          >
            More
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 7.5h.01M12 12h.01M12 16.5h.01"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </summary>
          <div
            className="absolute right-0 top-[calc(100%+6px)] z-30 w-44 rounded-md p-1.5 shadow-lg"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              boxShadow: "0 18px 40px -24px #000",
            }}
          >
            <Link
              // Pass the current playhead through so /debug seeks there and
              // auto-selects the matching artifact. Round to int seconds —
              // sub-second precision isn't useful here and bloats the URL.
              href={debugHref}
              className="block rounded px-2.5 py-2 text-xs font-medium"
              style={{ color: "var(--foreground)" }}
            >
              Debug
            </Link>
            <div className="mt-1 flex items-center justify-between rounded px-2.5 py-1.5">
              <span className="text-xs font-medium" style={{ color: "var(--muted-fg)" }}>
                Theme
              </span>
              <ThemeToggle />
            </div>
          </div>
        </details>
      </ViewerTopbar>

      {polledRun && runIsActive && (
        <div className="relative">
          <PipelineProgress run={polledRun} />
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="absolute top-2 right-3 px-2 py-1 text-xs font-medium rounded disabled:opacity-50"
            style={{
              background: "var(--card)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      {displayedRun?.status === "failed" && (() => {
        const parsed = parseRunError(displayedRun.error);
        const params = new URLSearchParams({ run: displayedRun.id });
        return (
          <div
            className="px-6 py-2 text-sm flex items-center justify-between gap-4"
            style={{
              background: "var(--paper-2)",
              color: parsed.cancelled ? "var(--muted-fg)" : "var(--accent-2)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span className="min-w-0 truncate">
              {parsed.cancelled ? "Run cancelled" : `Run failed: ${parsed.summary}`}
            </span>
            <Link
              href={`/video/${videoId}/debug?${params.toString()}`}
              className="shrink-0 underline underline-offset-2"
              style={{ color: "var(--foreground)" }}
            >
              View details
            </Link>
          </div>
        );
      })()}

      {/* Conditional render — only one player iframe is mounted at a time.
          See review feedback round 3 #1: keeping both branches mounted via
          CSS `display:none` resulted in two YouTubePlayer instances each
          firing their own 250ms time-update poll. */}
      {isMobile ? (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="bg-black shrink-0">
            <VideoPlayer
              ref={playerRef}
              source={source}
              onTimeUpdate={handleTimeUpdate}
            />
          </div>

          <div
            className="flex-1 min-h-0 relative"
            style={{ background: "var(--card)", borderTop: "1px solid var(--border)" }}
          >
            <div
              id="mobile-panel-outputs"
              role="tabpanel"
              aria-labelledby="mobile-tab-outputs"
              className="absolute inset-0"
              style={{ display: mobileTab === "outputs" ? "block" : "none" }}
            >
              <VisualsPanel
                visuals={visualContent}
                sections={sections}
                currentTime={currentTime}
              />
            </div>
            <div
              id="mobile-panel-transcript"
              role="tabpanel"
              aria-labelledby="mobile-tab-transcript"
              className="absolute inset-0"
              style={{ display: mobileTab === "transcript" ? "block" : "none" }}
            >
              <SegmentList
                segments={anchoredSegments}
                sections={sections}
                currentTime={currentTime}
                onSeek={handleSeek}
              />
            </div>
          </div>

          <MobileTabBar
            tabs={[
              { key: "transcript", label: "Transcript", count: anchoredSegments.length },
              { key: "outputs", label: "Outputs", count: visualContent.length },
            ]}
            active={mobileTab}
            onChange={setMobileTab}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-row min-h-0 w-full max-w-[1600px] mx-auto">
          <div className="w-[58%] shrink-0 flex flex-col min-h-0">
            <FocusCard
              ref={playerRef}
              source={source}
              visuals={visualContent}
              sections={sections}
              currentTime={currentTime}
              onTimeUpdate={handleTimeUpdate}
            />
          </div>

          <div
            className="flex-1 min-h-0 min-w-0 border-l"
            style={{ background: "var(--card)", borderColor: "var(--border)" }}
          >
            <SegmentList
              segments={anchoredSegments}
              sections={sections}
              currentTime={currentTime}
              onSeek={handleSeek}
            />
          </div>
        </div>
      )}
    </div>
  );
}
