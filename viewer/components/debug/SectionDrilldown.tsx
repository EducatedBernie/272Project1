/**
 * Per-section drilldown — three tabs (Transcript / Visual Content / Unmatched)
 * over a single SectionAnalysis.
 *
 * Extracted from DebugView.tsx with light cleanup. Used inside SectionsView
 * accordion bodies.
 */

"use client";

import { useState } from "react";
import Link from "next/link";

import {
  ConfidenceBadge,
  RenderedLatex,
  RepairStatusBadge,
  TypeBadge,
  VisualObservationExpander,
} from "./badges";
import { ItemReextract } from "./actions";
import { RawCallList } from "./RawCallsView";
import {
  type SectionAnalysis,
  type Segment,
  buildInterleavedTranscript,
  formatTime,
} from "@/lib/debug-utils";
import type { UnmatchedRefWord } from "@/lib/alignment-meta";
import { callsForSection, type GeminiCallLogsManifest } from "@/lib/gemini-call-logs";
import type { VisualContent } from "@/lib/types";

function TranscriptTab({ analysis }: { analysis: SectionAnalysis }) {
  const rows = buildInterleavedTranscript(
    analysis.segments,
    analysis.captions,
    analysis.startTime,
    analysis.endTime,
  );

  if (rows.length === 0) {
    return (
      <p className="text-sm italic p-4" style={{ color: "var(--muted-fg)" }}>
        No transcript data in this section
      </p>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto">
      {rows.map((row, i) => (
        <div
          key={i}
          className="flex gap-2 px-3 py-1.5 text-sm border-b"
          style={{
            background: row.source === "gap" ? "#fecaca20" : "transparent",
            borderColor: "var(--border)",
          }}
        >
          <span
            className="text-xs font-mono w-12 shrink-0 pt-0.5"
            style={{ color: "var(--muted-fg)" }}
          >
            {formatTime(row.time)}
          </span>
          {row.source === "gemini" ? (
            <span
              className="text-xs px-1 py-0.5 rounded shrink-0"
              style={{ background: "#dcfce7", color: "#166534" }}
            >
              G
            </span>
          ) : (
            <span
              className="text-xs px-1 py-0.5 rounded shrink-0"
              style={{ background: "#fecaca", color: "#991b1b" }}
            >
              YT
            </span>
          )}
          <span style={{ color: row.source === "gap" ? "#ef4444" : "var(--foreground)" }}>
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function VisualContentTab({
  items,
  videoId,
  segments,
}: {
  items: VisualContent[];
  videoId: string;
  segments: Segment[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="text-sm italic p-4" style={{ color: "var(--muted-fg)" }}>
        No visual content in this section
      </p>
    );
  }

  const typeCounts: Record<string, number> = {};
  for (const item of items) {
    typeCounts[item.contentType] = (typeCounts[item.contentType] || 0) + 1;
  }
  const summary = Object.entries(typeCounts)
    .map(([t, c]) => `${c} ${t}`)
    .join(", ");

  return (
    <div className="max-h-96 overflow-y-auto">
      <div
        className="px-3 py-2 text-xs"
        style={{ color: "var(--muted-fg)", borderBottom: "1px solid var(--border)" }}
      >
        {summary}
      </div>
      {items.map((item) => {
        const isExpanded = expandedId === item.id;
        return (
          <div
            key={item.id}
            className="border-b cursor-pointer"
            style={{
              borderColor: "var(--border)",
              background: item.confidence < 0.85 ? "#fef9c320" : "transparent",
            }}
            onClick={() => setExpandedId(isExpanded ? null : item.id)}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
                {isExpanded ? "▼" : "▶"}
              </span>
              <ConfidenceBadge confidence={item.confidence} />
              <TypeBadge type={item.contentType} />
              <RepairStatusBadge status={item.repairStatus} />
              <span className="text-xs font-mono" style={{ color: "var(--muted-fg)" }}>
                {formatTime(item.start)}
              </span>
              <span
                className="text-sm truncate flex-1"
                style={{ color: "var(--foreground)" }}
              >
                {item.latex || item.description?.slice(0, 80)}
              </span>
            </div>
            {isExpanded && (
              <div className="px-8 pb-3 space-y-2">
                {item.contentType === "equation" && item.latex && (
                  <div className="py-2">
                    <RenderedLatex latex={item.latex} />
                  </div>
                )}
                <div>
                  <div
                    className="text-xs font-semibold mb-1"
                    style={{ color: "var(--muted-fg)" }}
                  >
                    Description
                  </div>
                  <p className="text-sm" style={{ color: "var(--foreground)" }}>
                    {item.description}
                  </p>
                </div>
                <div className="flex gap-4 text-xs" style={{ color: "var(--muted-fg)" }}>
                  <span>
                    Time: {formatTime(item.start)} - {formatTime(item.end)}
                  </span>
                  <span>Confidence: {item.confidence.toFixed(2)}</span>
                  <Link
                    href={`/video/${videoId}#t=${Math.floor(item.start)}`}
                    className="underline"
                    style={{ color: "#3b82f6" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    Jump to viewer
                  </Link>
                </div>
                {item.code && (
                  <div>
                    <div
                      className="text-xs font-semibold mb-1"
                      style={{ color: "var(--muted-fg)" }}
                    >
                      Code {item.language && `(${item.language})`}
                    </div>
                    <pre
                      className="text-xs font-mono p-2 rounded overflow-x-auto"
                      style={{ background: "var(--muted)" }}
                    >
                      <code>{item.code}</code>
                    </pre>
                  </div>
                )}
                <VisualObservationExpander observation={item.visualObservation} />
                <ItemReextract
                  item={item}
                  videoId={videoId}
                  segments={segments}
                  visualContent={items}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UnmatchedWordsTab({
  unmatchedWords,
  onSeek,
}: {
  unmatchedWords: UnmatchedRefWord[];
  onSeek: (time: number) => void;
}) {
  if (unmatchedWords.length === 0) {
    return (
      <p className="text-sm italic p-4" style={{ color: "var(--muted-fg)" }}>
        All YouTube words accounted for (matched by SequenceMatcher)
      </p>
    );
  }

  const groups: { time: number; words: string[] }[] = [];
  for (const uw of unmatchedWords) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.time - uw.time) < 1) {
      last.words.push(uw.word);
    } else {
      groups.push({ time: uw.time, words: [uw.word] });
    }
  }

  return (
    <div className="max-h-96 overflow-y-auto">
      <div
        className="px-3 py-2 text-xs"
        style={{ color: "var(--muted-fg)", borderBottom: "1px solid var(--border)" }}
      >
        {unmatchedWords.length} YouTube words unmatched by pipeline SequenceMatcher. Should mostly be math-speak that became LaTeX.
      </div>
      {groups.map((group, i) => (
        <div
          key={i}
          className="flex gap-2 px-3 py-1.5 text-sm border-b cursor-pointer hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          onClick={() => onSeek(group.time)}
        >
          <span
            className="text-xs font-mono w-12 shrink-0 pt-0.5"
            style={{ color: "var(--muted-fg)" }}
          >
            {formatTime(group.time)}
          </span>
          <span style={{ color: "#ef4444", fontWeight: 600 }}>{group.words.join(" ")}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  analysis: SectionAnalysis;
  videoId: string;
  segments: Segment[];
  runId: string | null;
  geminiCallLogs: GeminiCallLogsManifest | null;
  sectionIndex: number;
  onSeek: (time: number) => void;
}

export default function SectionDrilldown({
  analysis,
  videoId,
  segments,
  runId,
  geminiCallLogs,
  sectionIndex,
  onSeek,
}: Props) {
  const [tab, setTab] = useState<"transcript" | "visual" | "unmatched" | "raw">("transcript");
  const rawCalls = callsForSection(geminiCallLogs, sectionIndex);

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <div className="flex" style={{ borderBottom: "1px solid var(--border)" }}>
        <button
          className="px-4 py-2 text-xs font-semibold"
          style={{
            background: tab === "transcript" ? "var(--card)" : "var(--muted)",
            color: tab === "transcript" ? "var(--foreground)" : "var(--muted-fg)",
            borderBottom: tab === "transcript" ? "2px solid #3b82f6" : "2px solid transparent",
          }}
          onClick={() => setTab("transcript")}
        >
          Transcript ({analysis.segmentCount} segments)
        </button>
        <button
          className="px-4 py-2 text-xs font-semibold"
          style={{
            background: tab === "visual" ? "var(--card)" : "var(--muted)",
            color: tab === "visual" ? "var(--foreground)" : "var(--muted-fg)",
            borderBottom: tab === "visual" ? "2px solid #3b82f6" : "2px solid transparent",
          }}
          onClick={() => setTab("visual")}
        >
          Visual Content ({analysis.vcItems} items)
        </button>
        <button
          className="px-4 py-2 text-xs font-semibold"
          style={{
            background: tab === "unmatched" ? "var(--card)" : "var(--muted)",
            color: tab === "unmatched" ? "var(--foreground)" : "var(--muted-fg)",
            borderBottom: tab === "unmatched" ? "2px solid #3b82f6" : "2px solid transparent",
          }}
          onClick={() => setTab("unmatched")}
        >
          Unmatched ({analysis.unmatchedWords.length} words)
        </button>
        <button
          className="px-4 py-2 text-xs font-semibold"
          style={{
            background: tab === "raw" ? "var(--card)" : "var(--muted)",
            color: tab === "raw" ? "var(--foreground)" : "var(--muted-fg)",
            borderBottom: tab === "raw" ? "2px solid #3b82f6" : "2px solid transparent",
          }}
          onClick={() => setTab("raw")}
        >
          Raw Calls ({rawCalls.length})
        </button>
      </div>
      {tab === "transcript" ? (
        <TranscriptTab analysis={analysis} />
      ) : tab === "visual" ? (
        <VisualContentTab
          items={analysis.visualContentItems}
          videoId={videoId}
          segments={segments}
        />
      ) : tab === "unmatched" ? (
        <UnmatchedWordsTab unmatchedWords={analysis.unmatchedWords} onSeek={onSeek} />
      ) : (
        <RawCallList calls={rawCalls} runId={runId} />
      )}
    </div>
  );
}
