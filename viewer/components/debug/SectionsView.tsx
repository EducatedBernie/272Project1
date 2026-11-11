/**
 * Sections mode body — dense table of all sections with severity, coverage,
 * WPM, gap, item count. Each row expands into a per-section drilldown
 * (transcript / visual / unmatched) plus a re-extract form.
 *
 * Mostly a re-port of the old DebugView accordion at lines 1192–1264, just
 * isolated as its own component.
 */

"use client";

import { useState } from "react";

import { CoverageBar, SeverityBadge } from "./badges";
import { SectionReprocess } from "./actions";
import SectionDrilldown from "./SectionDrilldown";
import { type SectionAnalysis, type Section, type Segment, formatTime } from "@/lib/debug-utils";
import type { GeminiCallLogsManifest } from "@/lib/gemini-call-logs";

interface Props {
  analysis: SectionAnalysis[];
  sections: Section[];
  segments: Segment[];
  videoId: string;
  runId: string | null;
  geminiCallLogs: GeminiCallLogsManifest | null;
  onSeek: (time: number) => void;
}

export default function SectionsView({
  analysis,
  sections,
  segments,
  videoId,
  runId,
  geminiCallLogs,
  onSeek,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="overflow-y-auto p-6 space-y-2 flex-1">
      {analysis.map((sec, i) => {
        const isOpen = expanded.has(i);
        const borderColor =
          sec.severity === "critical"
            ? "#ef4444"
            : sec.severity === "warning"
            ? "#eab308"
            : "var(--border)";
        return (
          <div key={i}>
            <div
              className="rounded-lg p-4 cursor-pointer"
              style={{ background: "var(--card)", border: `1px solid ${borderColor}` }}
              onClick={() => toggle(i)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
                      {isOpen ? "▼" : "▶"}
                    </span>
                    <SeverityBadge severity={sec.severity} />
                    <span className="font-semibold text-sm">{sec.title}</span>
                    <span
                      className="text-xs font-mono"
                      style={{ color: "var(--muted-fg)" }}
                    >
                      {formatTime(sec.startTime)}-{formatTime(sec.endTime)}
                    </span>
                  </div>
                  {sec.issues.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 ml-5">
                      {sec.issues.map((issue, j) => (
                        <span
                          key={j}
                          className="text-xs px-2 py-0.5 rounded"
                          style={{
                            background: "var(--muted)",
                            color:
                              sec.severity === "critical" ? "#ef4444" : "#eab308",
                          }}
                        >
                          {issue}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-6 shrink-0 text-right">
                  <div>
                    <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
                      Words
                    </div>
                    <div className="w-24 mt-1">
                      <CoverageBar coverage={sec.wordCoverage} />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
                      WPM
                    </div>
                    <div
                      className="text-sm font-mono"
                      style={{
                        color:
                          sec.wpm < 30 && sec.captionWpm > 60 ? "#ef4444" : "var(--foreground)",
                      }}
                    >
                      {Math.round(sec.wpm)}
                      <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
                        /{Math.round(sec.captionWpm)}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
                      Gap
                    </div>
                    <div
                      className="text-sm font-mono"
                      style={{
                        color: sec.longestGap > 60 ? "#eab308" : "var(--foreground)",
                      }}
                    >
                      {sec.longestGap > 5 ? formatTime(sec.longestGap) : "-"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
                      Items
                    </div>
                    <div className="text-sm font-mono">
                      {sec.vcItems}
                      {sec.lowConfCount > 0 && (
                        <span style={{ color: "#eab308" }}> ({sec.lowConfCount}!)</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {isOpen && (
              <div className="mt-2 space-y-2">
                <SectionReprocess
                  videoId={videoId}
                  runId={runId}
                  sectionIndex={i}
                  analysis={sec}
                  sections={sections}
                />
                <SectionDrilldown
                  analysis={sec}
                  videoId={videoId}
                  segments={segments}
                  runId={runId}
                  geminiCallLogs={geminiCallLogs}
                  sectionIndex={i}
                  onSeek={onSeek}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
