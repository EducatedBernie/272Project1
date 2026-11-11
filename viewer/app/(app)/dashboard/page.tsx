"use client";

import { useCallback, useEffect, useState } from "react";

const RAIL_STORAGE_KEY = "chalkboard.dashboard.rail-open";
import DashboardTopbar from "@/components/dashboard/DashboardTopbar";
import IntakeCard from "@/components/dashboard/IntakeCard";
import RunCard, { type QueueRun } from "@/components/dashboard/RunCard";
import LibraryCard, { type VideoSummary } from "@/components/dashboard/LibraryCard";
import StatsRail from "@/components/dashboard/StatsRail";

const RUN_POLL_MS = 3000;
const VIDEO_POLL_MS = 6000;

type RunFilter = "all" | "running" | "queued" | "failed";

function runsMatch(run: QueueRun, filter: RunFilter): boolean {
  if (filter === "all") return true;
  if (filter === "queued") return run.status === "queued";
  if (filter === "failed") return run.status === "failed";
  // running = any active stage (captions / topic_map / sections / alignment / saving).
  // The /api/runs?status=active endpoint never returns "complete", so we only need
  // to exclude queued + failed here.
  return run.status !== "queued" && run.status !== "failed";
}

export default function DashboardPage() {
  const [runs, setRuns] = useState<QueueRun[] | null>(null);
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [refreshTick, setRefreshTick] = useState(0);
  // Side rail is collapsed by default; user preference persists in localStorage.
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RAIL_STORAGE_KEY);
      if (stored === "1") setRailOpen(true);
    } catch { /* localStorage unavailable */ }
  }, []);

  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(RAIL_STORAGE_KEY, next ? "1" : "0");
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const kickRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Poll active runs
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/runs?status=active");
        if (!res.ok) return;
        const data: QueueRun[] = await res.json();
        if (!cancelled) setRuns(data);
      } catch {}
    };
    load();
    const interval = setInterval(load, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshTick]);

  // Poll video library (slower)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/videos");
        if (!res.ok) return;
        const data: VideoSummary[] = await res.json();
        if (!cancelled) setVideos(data);
      } catch {}
    };
    load();
    const interval = setInterval(load, VIDEO_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshTick]);

  const handleCancel = useCallback(async (runId: string) => {
    try {
      await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      kickRefresh();
    } catch {}
  }, [kickRefresh]);

  const filteredRuns = (runs ?? []).filter((r) => runsMatch(r, runFilter));

  const summary = runs
    ? (() => {
        const running = runs.filter((r) => runsMatch(r, "running")).length;
        const queued = runs.filter((r) => r.status === "queued").length;
        const failed = runs.filter((r) => r.status === "failed").length;
        return `${running} running · ${queued} queued · ${failed} failed`;
      })()
    : "…";

  return (
    <div className="min-h-screen" style={{ background: "var(--paper)" }}>
      <DashboardTopbar />

      <main
        className="max-w-[1400px] mx-auto px-6 md:px-10 pb-16 pt-9 grid gap-8"
        style={{ gridTemplateColumns: "minmax(0,1fr)" }}
      >
        <div
          className="grid gap-8 items-start"
          style={{
            gridTemplateColumns: railOpen ? "minmax(0, 1fr) 380px" : "minmax(0, 1fr)",
          }}
        >
          <div>
            <div
              className="flex items-center gap-2.5 text-[11px] uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.18em",
                color: "var(--muted-fg)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 24,
                  height: 1,
                  background: "var(--muted-fg)",
                }}
              />
              <span>
                Dashboard · {videos ? `${videos.length} lecture${videos.length === 1 ? "" : "s"} processed` : "loading…"}
              </span>
            </div>
            <h1
              className="mt-3.5 mb-2.5"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 400,
                fontSize: "clamp(40px, 4.8vw, 60px)",
                lineHeight: 1,
                letterSpacing: "-0.025em",
              }}
            >
              What are we{" "}
              <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>rendering</em> today?
            </h1>
            <p
              className="m-0 text-[15px] leading-[1.55] max-w-[60ch]"
              style={{ color: "var(--ink-2)" }}
            >
              Paste a YouTube URL or drop a file — each lecture becomes a synced transcript with typeset equations, described diagrams, and pseudocode you can copy.
            </p>

            <IntakeCard onSubmitted={kickRefresh} />

            <section className="mt-9">
              <div className="flex items-baseline justify-between mb-3.5 flex-wrap gap-3">
                <div>
                  <h2
                    className="m-0 text-[26px]"
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontWeight: 400,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    In progress
                  </h2>
                  <div
                    className="mt-1 text-[11px] uppercase"
                    style={{
                      fontFamily: "var(--font-mono)",
                      letterSpacing: "0.14em",
                      color: "var(--muted-fg)",
                    }}
                  >
                    {summary}
                  </div>
                </div>
                <div className="flex gap-1.5" role="group" aria-label="Filter runs">
                  {(["all", "running", "queued", "failed"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setRunFilter(f)}
                      aria-pressed={runFilter === f}
                      className="px-3 py-1 rounded-full text-[11px] inline-flex items-center gap-1.5 cursor-pointer"
                      style={{
                        fontFamily: "var(--font-mono)",
                        letterSpacing: "0.04em",
                        background: runFilter === f ? "var(--ink)" : "#fff",
                        color: runFilter === f ? "var(--paper)" : "var(--ink-2)",
                        border: runFilter === f ? "1px solid var(--ink)" : "1px solid var(--rule)",
                      }}
                    >
                      {f !== "all" && (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background:
                              f === "running"
                                ? "var(--blue)"
                                : f === "queued"
                                  ? "var(--muted-fg)"
                                  : "var(--err)",
                          }}
                        />
                      )}
                      <span>{f}</span>
                    </button>
                  ))}
                </div>
              </div>

              {runs === null ? (
                <EmptyState message="Loading queue…" />
              ) : filteredRuns.length === 0 ? (
                <EmptyState
                  message={
                    runs.length === 0
                      ? "Nothing in progress. Paste a URL above to start a run."
                      : `No runs match '${runFilter}'.`
                  }
                />
              ) : (
                <div>
                  {filteredRuns.map((run) => (
                    <RunCard key={run.id} run={run} onCancel={handleCancel} />
                  ))}
                </div>
              )}
            </section>

            <section id="library" className="mt-9">
              <div className="flex items-baseline justify-between mb-3.5 flex-wrap gap-3">
                <div>
                  <h2
                    className="m-0 text-[26px]"
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontWeight: 400,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Your library
                  </h2>
                  <div
                    className="mt-1 text-[11px] uppercase"
                    style={{
                      fontFamily: "var(--font-mono)",
                      letterSpacing: "0.14em",
                      color: "var(--muted-fg)",
                    }}
                  >
                    {videos ? `${videos.length} ready · sorted by newest` : "loading…"}
                  </div>
                </div>
              </div>

              {videos === null ? (
                <EmptyState message="Loading library…" />
              ) : videos.length === 0 ? (
                <EmptyState
                  message="Your library is empty — process a lecture above and it'll show up here."
                />
              ) : (
                <div
                  className="grid gap-3.5"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
                >
                  {videos.map((v) => (
                    <LibraryCard key={v.id} video={v} />
                  ))}
                </div>
              )}
            </section>
          </div>

          {railOpen && <StatsRail onClose={toggleRail} />}
        </div>

        {!railOpen && (
          <button
            type="button"
            onClick={toggleRail}
            className="fixed top-[76px] right-5 z-20 rounded-lg px-3 py-2 text-[11px] inline-flex items-center gap-2 cursor-pointer transition-colors"
            style={{
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              background: "#fff",
              color: "var(--ink-2)",
              border: "1px solid var(--rule)",
              boxShadow: "0 8px 20px -12px #00000033",
            }}
            aria-expanded="false"
            aria-controls="stats-rail"
          >
            <span aria-hidden="true">◧</span>
            <span>Stats</span>
          </button>
        )}
      </main>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="rounded-xl px-6 py-10 text-center"
      style={{
        background: "#fff",
        border: "1px dashed var(--rule-2)",
        color: "var(--muted-fg)",
      }}
    >
      {message}
    </div>
  );
}
