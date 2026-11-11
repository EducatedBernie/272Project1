/**
 * Re-extract action forms — kick the /api/reprocess-section endpoint.
 *
 * Two flavors:
 *   - SectionReprocess: re-run a whole section.
 *   - ItemReextract: re-run a single visual content item with rich context
 *     (transcript ±60s, neighbors before/after) and a verification prompt.
 *
 * Both extracted from DebugView.tsx unchanged in behavior. The forms are
 * tightly coupled to the API call — that's fine; the /debug page is the
 * only consumer.
 */

"use client";

import { useState } from "react";

import { formatTime, type Section, type SectionAnalysis, type Segment } from "@/lib/debug-utils";
import { GEMINI_MODEL_OPTIONS } from "@/lib/model-config";
import type { VisualContent } from "@/lib/types";

export const MODELS = GEMINI_MODEL_OPTIONS;

export const FPS_OPTIONS = [
  { value: "0.5", label: "0.5 fps" },
  { value: "1", label: "1 fps" },
  { value: "2", label: "2 fps" },
  { value: "5", label: "5 fps" },
  { value: "10", label: "10 fps" },
];

export type ActionStatus = "idle" | "running" | "done" | "error";

export function SectionReprocess({
  videoId,
  runId,
  sectionIndex,
  analysis,
  sections,
}: {
  videoId: string;
  runId: string | null;
  sectionIndex: number;
  analysis: SectionAnalysis;
  sections: Section[];
}) {
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<ActionStatus>("idle");

  const handleReprocess = async () => {
    setStatus("running");

    const sec = sections[sectionIndex];
    const prevTitle = sectionIndex > 0 ? sections[sectionIndex - 1].title : "Start of lecture";
    const nextTitle =
      sectionIndex + 1 < sections.length ? sections[sectionIndex + 1].title : "End of lecture";
    const context = `Current section: "${sec?.title || analysis.title}"\nPrevious section: "${prevTitle}"\nNext section: "${nextTitle}"`;

    try {
      const res = await fetch("/api/reprocess-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: videoId,
          run_id: runId,
          section_index: sectionIndex,
          start_time: analysis.startTime,
          end_time: analysis.endTime,
          section_title: analysis.title,
          context,
          model,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div
      className="px-3 py-2 flex items-center gap-3 rounded-lg flex-wrap"
      style={{ background: "var(--muted)", border: "1px solid var(--border)" }}
    >
      <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
        Reprocess:
      </span>
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="text-xs rounded px-2 py-1"
        style={{
          background: "var(--card)",
          color: "var(--foreground)",
          border: "1px solid var(--border)",
        }}
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        onClick={handleReprocess}
        disabled={status === "running"}
        className="text-xs font-medium px-3 py-1 rounded disabled:opacity-50"
        style={{ background: "var(--foreground)", color: "var(--background)" }}
      >
        {status === "running" ? "Running..." : status === "done" ? "Started" : "Run"}
      </button>
      {status === "done" && (
        <span className="text-xs" style={{ color: "#22c55e" }}>
          Reprocess started — refresh debug page when done
        </span>
      )}
      {status === "error" && (
        <span className="text-xs" style={{ color: "#ef4444" }}>
          Failed to start
        </span>
      )}
    </div>
  );
}

interface ItemReextractProps {
  item: VisualContent;
  videoId: string;
  segments: Segment[];
  visualContent: VisualContent[];
  defaultModel?: string;
}

export function ItemReextract({
  item,
  videoId,
  segments,
  visualContent,
  defaultModel = "gemini-2.5-pro-preview-06-05",
}: ItemReextractProps) {
  const [model, setModel] = useState(defaultModel);
  const [fps, setFps] = useState("1");
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [extraFootage, setExtraFootage] = useState(30);
  const [status, setStatus] = useState<ActionStatus>("idle");

  const handleReextract = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStatus("running");

    const contextParts: string[] = [];
    contextParts.push(
      `VERIFICATION TASK: Re-examine this ${item.contentType} and determine if the original extraction is correct.`,
    );
    contextParts.push(`Original extraction: ${item.latex || item.description}`);
    contextParts.push(`Original confidence: ${item.confidence}`);

    if (includeTranscript) {
      const nearby = segments.filter(
        (s) => s.start >= item.start - 60 && s.start <= item.end + 60,
      );
      if (nearby.length > 0) {
        contextParts.push(`\nWhat the professor said (±1 min around this content):`);
        for (const seg of nearby) {
          contextParts.push(`[${formatTime(seg.start)}] ${seg.text}`);
        }
      }
    }

    const sorted = [...visualContent].sort((a, b) => a.start - b.start);
    const idx = sorted.findIndex((v) => v.id === item.id);
    const prev = idx > 0 ? sorted[idx - 1] : null;
    const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
    if (prev || next) {
      contextParts.push(`\nNeighboring visual content:`);
      if (prev) {
        contextParts.push(
          `Before: [${prev.contentType}] ${prev.latex || prev.description?.slice(0, 80)}`,
        );
      }
      if (next) {
        contextParts.push(
          `After: [${next.contentType}] ${next.latex || next.description?.slice(0, 80)}`,
        );
      }
    }

    try {
      const res = await fetch("/api/reprocess-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: videoId,
          section_index: -1,
          start_time: Math.max(0, item.start - extraFootage),
          end_time: item.end + extraFootage,
          section_title: `Re-extract: ${item.contentType} at ${formatTime(item.start)}`,
          context: contextParts.join("\n"),
          model,
          fps: parseFloat(fps),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div
      className="px-3 py-2 space-y-2 rounded-lg"
      style={{ background: "var(--muted)", border: "1px solid var(--border)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold" style={{ color: "var(--muted-fg)" }}>
          Re-extract — verification:
        </span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="text-xs rounded px-2 py-1"
          style={{
            background: "var(--card)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
          }}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={fps}
          onChange={(e) => setFps(e.target.value)}
          className="text-xs rounded px-2 py-1"
          style={{
            background: "var(--card)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
          }}
        >
          {FPS_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={String(extraFootage)}
          onChange={(e) => setExtraFootage(Number(e.target.value))}
          className="text-xs rounded px-2 py-1"
          style={{
            background: "var(--card)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
          }}
        >
          <option value="15">±15s footage</option>
          <option value="30">±30s footage</option>
          <option value="60">±60s footage</option>
        </select>
        <label
          className="flex items-center gap-1 text-xs cursor-pointer"
          style={{ color: "var(--muted-fg)" }}
        >
          <input
            type="checkbox"
            checked={includeTranscript}
            onChange={(e) => setIncludeTranscript(e.target.checked)}
          />
          Include transcript
        </label>
        <button
          onClick={handleReextract}
          disabled={status === "running"}
          className="text-xs font-medium px-3 py-1 rounded disabled:opacity-50"
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          {status === "running" ? "Running..." : status === "done" ? "Started" : "Run"}
        </button>
        {status === "done" && (
          <span className="text-xs" style={{ color: "#22c55e" }}>
            Started — refresh when done
          </span>
        )}
        {status === "error" && (
          <span className="text-xs" style={{ color: "#ef4444" }}>
            Failed to start
          </span>
        )}
      </div>
    </div>
  );
}
