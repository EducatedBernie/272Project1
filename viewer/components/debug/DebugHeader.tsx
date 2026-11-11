"use client";

import Link from "next/link";

import { CostChip } from "./badges";
import { formatTime } from "@/lib/debug-utils";
import type { UsageSummary } from "@/lib/usage";
import type { GeminiCallLogsManifest } from "@/lib/gemini-call-logs";

interface Props {
  videoId: string;
  title: string;
  duration: number;
  currentTime: number;
  runId: string | null;
  usageSummary: UsageSummary | null;
  geminiCallLogs: GeminiCallLogsManifest | null;
}

export default function DebugHeader({
  videoId,
  title,
  duration,
  currentTime,
  runId,
  usageSummary,
  geminiCallLogs,
}: Props) {
  const captureStatus = geminiCallLogs?.capture_status ?? "unavailable";
  return (
    <header
      className="px-6 py-3 shrink-0"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={`/video/${videoId}`}
            className="text-sm shrink-0"
            style={{ color: "var(--muted-fg)" }}
          >
            ← Viewer
          </Link>
          <span style={{ color: "var(--border)" }}>/</span>
          <h1 className="text-lg font-semibold truncate">{title}</h1>
          <span
            className="text-xs font-mono px-2 py-0.5 rounded shrink-0"
            style={{ background: "#fecaca", color: "#991b1b" }}
          >
            DEBUG
          </span>
          <span
            className="text-xs font-mono shrink-0"
            style={{ color: "var(--muted-fg)" }}
          >
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          {runId && (
            <span
              className="text-xs font-mono shrink-0 truncate"
              style={{ color: "var(--muted-fg)" }}
              title={runId}
            >
              run {runId.slice(0, 8)}
            </span>
          )}
          <span
            className="text-xs font-mono shrink-0"
            style={{ color: captureStatus === "complete" ? "#16a34a" : "#eab308" }}
          >
            raw {captureStatus}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <CostChip usage={usageSummary} />
          <Link
            href="/dashboard"
            className="text-sm"
            style={{ color: "var(--muted-fg)" }}
          >
            Dashboard
          </Link>
        </div>
      </div>
    </header>
  );
}
