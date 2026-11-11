/**
 * Captions mode body — side-by-side YouTube auto-captions and Gemini
 * transcript with playhead sync. Auto-scrolls both columns to keep the
 * active line at ~1/3 height.
 *
 * Also surfaces alignment-meta unmatched ref words: a banner shows the
 * count, and unmatched groups appear inline in the YouTube column with a
 * red highlight + click-to-seek. When YT auto-captions are missing
 * (older runs / videos without subtitles), the YT column is replaced
 * with a notice and the unmatched words still get their own panel.
 */

"use client";

import { useEffect, useRef } from "react";

import { RichText } from "./badges";
import {
  type AutoCaption,
  type Segment,
  formatTime,
} from "@/lib/debug-utils";
import { type UnmatchedGroup, groupUnmatched } from "@/lib/issues";
import type { AlignmentMeta } from "@/lib/alignment-meta";

interface Props {
  segments: Segment[];
  autoCaptions: AutoCaption[];
  alignmentMeta: AlignmentMeta | null;
  currentTime: number;
  onSeek: (time: number) => void;
}

export default function SyncedTranscripts({
  segments,
  autoCaptions,
  alignmentMeta,
  currentTime,
  onSeek,
}: Props) {
  const ytRef = useRef<HTMLDivElement>(null);
  const geminiRef = useRef<HTMLDivElement>(null);
  const ytActiveRef = useRef<HTMLDivElement>(null);
  const geminiActiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    for (const [containerRef, activeRef] of [
      [ytRef, ytActiveRef],
      [geminiRef, geminiActiveRef],
    ] as const) {
      if (activeRef.current && containerRef.current) {
        const container = containerRef.current;
        const el = activeRef.current;
        const elTop = el.offsetTop - container.offsetTop;
        const targetScroll = elTop - container.clientHeight / 3;
        if (Math.abs(container.scrollTop - targetScroll) > 30) {
          container.scrollTo({ top: targetScroll, behavior: "smooth" });
        }
      }
    }
  }, [currentTime]);

  let activeCapIdx = -1;
  for (let i = autoCaptions.length - 1; i >= 0; i--) {
    if (autoCaptions[i].start <= currentTime) {
      activeCapIdx = i;
      break;
    }
  }

  let activeSegIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].start <= currentTime) {
      activeSegIdx = i;
      break;
    }
  }

  const unmatchedGroups: UnmatchedGroup[] = alignmentMeta?.unmatched_ref_words
    ? groupUnmatched(alignmentMeta.unmatched_ref_words)
    : [];
  const totalUnmatched = alignmentMeta?.unmatched_ref_words?.length ?? 0;
  const totalRef = alignmentMeta?.total_ref_words ?? 0;

  const ytEmpty = autoCaptions.length === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Alignment summary banner — only when alignment data is present. */}
      {alignmentMeta && (
        <div
          className="px-4 py-2 text-xs flex items-center gap-3 shrink-0 flex-wrap"
          style={{ background: "var(--muted)", borderBottom: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--muted-fg)" }}>
            Alignment: <strong style={{ color: "var(--foreground)" }}>{Math.round(alignmentMeta.ref_coverage * 100)}%</strong>
            {" "}
            ({totalRef - totalUnmatched} / {totalRef} ref words matched)
          </span>
          {totalUnmatched > 0 && (
            <span style={{ color: "#ef4444" }}>
              {totalUnmatched} unmatched
              {unmatchedGroups.length > 0 && ` · ${unmatchedGroups.length} groups`}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* YouTube auto-captions column. When the run didn't capture YT
            captions (autoCaptions = []), show a notice instead of an
            empty column so the dev knows it's a data gap, not a UI bug. */}
        <div
          className="w-1/2 flex flex-col min-h-0"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <div
            className="px-3 py-1.5 text-xs font-semibold uppercase shrink-0"
            style={{
              color: "var(--muted-fg)",
              borderBottom: "1px solid var(--border)",
              background: "var(--muted)",
            }}
          >
            YouTube Auto-Captions
          </div>
          {ytEmpty ? (
            <div
              className="flex-1 overflow-y-auto p-4 space-y-3"
              style={{ color: "var(--muted-fg)" }}
            >
              <p className="text-sm italic">
                No YouTube auto-captions were stored for this run. The pipeline
                downloads them on first ingest; older runs (or videos without
                public subtitles) won&apos;t have them. Re-run the pipeline if
                you need them.
              </p>
              {unmatchedGroups.length > 0 && (
                <div>
                  <div className="text-xs font-semibold mb-1 uppercase tracking-wide">
                    Unmatched ref words ({unmatchedGroups.length})
                  </div>
                  <p className="text-xs mb-2">
                    Words from the alignment&apos;s reference stream that
                    didn&apos;t match any Gemini segment. Click to seek.
                  </p>
                  <div className="space-y-1">
                    {unmatchedGroups.map((g, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onSeek(g.time)}
                        className="text-xs p-2 rounded w-full text-left hover:opacity-80"
                        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
                      >
                        <span className="font-mono mr-2" style={{ color: "var(--muted-fg)" }}>
                          {formatTime(g.time)}
                        </span>
                        <span style={{ color: "#ef4444", fontWeight: 600 }}>
                          {g.words.join(" ")}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div ref={ytRef} className="flex-1 overflow-y-auto">
              {autoCaptions.map((cap, i) => {
                const isActive = i === activeCapIdx;
                return (
                  <div
                    key={i}
                    ref={isActive ? ytActiveRef : null}
                    className="px-3 py-1 text-sm cursor-pointer"
                    style={{
                      background: isActive ? "var(--active)" : "transparent",
                      borderLeft: isActive
                        ? "3px solid var(--active-border)"
                        : "3px solid transparent",
                    }}
                    onClick={() => onSeek(cap.start)}
                  >
                    <span
                      className="text-xs font-mono mr-2"
                      style={{ color: "var(--muted-fg)" }}
                    >
                      {formatTime(cap.start)}
                    </span>
                    <span
                      style={{ color: "var(--foreground)", opacity: isActive ? 1 : 0.6 }}
                    >
                      {cap.text}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-1/2 flex flex-col min-h-0">
          <div
            className="px-3 py-1.5 text-xs font-semibold uppercase shrink-0"
            style={{
              color: "var(--muted-fg)",
              borderBottom: "1px solid var(--border)",
              background: "var(--muted)",
            }}
          >
            Gemini Transcript
          </div>
          <div ref={geminiRef} className="flex-1 overflow-y-auto">
            {segments.map((seg, i) => {
              const isActive = i === activeSegIdx;
              return (
                <div
                  key={seg.id}
                  ref={isActive ? geminiActiveRef : null}
                  className="px-3 py-1 text-sm cursor-pointer"
                  style={{
                    background: isActive ? "var(--active)" : "transparent",
                    borderLeft: isActive
                      ? "3px solid #3b82f6"
                      : "3px solid transparent",
                  }}
                  onClick={() => onSeek(seg.start)}
                >
                  <span
                    className="text-xs font-mono mr-2"
                    style={{ color: "var(--muted-fg)" }}
                  >
                    {formatTime(seg.start)}
                  </span>
                  <span
                    style={{ color: "var(--foreground)", opacity: isActive ? 1 : 0.6 }}
                  >
                    <RichText text={seg.text} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
