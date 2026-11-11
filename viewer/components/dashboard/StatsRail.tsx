"use client";

import { useEffect, useState } from "react";

interface MonthlyStats {
  lectures_processed: number;
  total_runtime_seconds: number;
  equations_count: number;
  avg_run_seconds: number;
}

function formatRuntime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

interface StatsRailProps {
  onClose?: () => void;
}

// Stats roll over slowly — runs finish on the order of minutes, not seconds.
// Poll every 30s in the background, and also refetch when the tab becomes
// visible again (covers the "left it open overnight" case without burning
// requests while the user isn't looking).
const STATS_POLL_MS = 30_000;

export default function StatsRail({ onClose }: StatsRailProps) {
  const [stats, setStats] = useState<MonthlyStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = () => {
      fetch("/api/stats/monthly", { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setStats(d);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") console.warn("[StatsRail] fetch failed", err);
        });
    };
    load();
    const interval = setInterval(load, STATS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <aside
      id="stats-rail"
      className="flex flex-col sticky"
      style={{ top: 80, gap: 18 }}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="self-end text-[11px] inline-flex items-center gap-1.5 cursor-pointer rounded-md px-2 py-1 transition-colors"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--muted-fg)",
            background: "transparent",
            border: "1px solid var(--rule)",
          }}
          aria-label="Hide stats panel"
        >
          <span aria-hidden="true">→</span>
          <span>Hide</span>
        </button>
      )}
      <div
        className="p-4.5 rounded-2xl"
        style={{ background: "#fff", border: "1px solid var(--rule)", padding: 18 }}
      >
        <h4
          className="m-0 mb-3 text-[18px]"
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 400,
            letterSpacing: "-0.01em",
          }}
        >
          Last 30 days
        </h4>
        <KV label="Lectures processed" value={stats ? String(stats.lectures_processed) : "—"} />
        <KV label="Total runtime" value={stats ? formatRuntime(stats.total_runtime_seconds) : "—"} />
        <KV label="Equations typeset" value={stats ? String(stats.equations_count) : "—"} />
        <KV label="Avg. run time" value={stats ? formatDuration(stats.avg_run_seconds) : "—"} last />
      </div>

      <div
        className="rounded-2xl"
        style={{
          background: "var(--chalk-bg)",
          color: "#e6e0cf",
          padding: 18,
        }}
      >
        <div
          className="text-[10.5px] uppercase"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.16em",
            color: "var(--accent)",
          }}
        >
          Did you know
        </div>
        <h4
          className="m-0 mt-1.5 mb-2 text-[22px]"
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 400,
            color: "#f1ead6",
            letterSpacing: "-0.01em",
          }}
        >
          Every lecture is fully re-runnable
        </h4>
        <p className="m-0 text-[13px] leading-[1.55]" style={{ color: "#cac3ae" }}>
          Got a model or prompt change? Hit <CodeSpan>Reprocess</CodeSpan> on any video and the full pipeline re-runs in minutes — the old run stays as a reference.
        </p>
      </div>
    </aside>
  );
}

function KV({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className="grid [grid-template-columns:1fr_auto] gap-x-3 gap-y-1.5 py-1.5 text-[11.5px]"
      style={{
        fontFamily: "var(--font-mono)",
        color: "var(--muted-fg)",
        borderBottom: last ? "none" : "1px dashed var(--rule)",
      }}
    >
      <span>{label}</span>
      <b style={{ color: "var(--ink)", fontWeight: 600 }}>{value}</b>
    </div>
  );
}

function CodeSpan({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        background: "#00000033",
        padding: "1px 6px",
        borderRadius: 4,
        color: "var(--accent-soft)",
      }}
    >
      {children}
    </code>
  );
}
