"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  type GeminiCallBlob,
  type GeminiCallLogsManifest,
  type GeminiCallManifestEntry,
  formatBytes,
} from "@/lib/gemini-call-logs";
import { type Section, formatTime, parseTs } from "@/lib/debug-utils";

function statusColor(status: string): string {
  if (status === "success") return "#16a34a";
  if (status === "error") return "#ef4444";
  return "var(--muted-fg)";
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function RawBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="text-xs font-semibold mb-1" style={{ color: "var(--muted-fg)" }}>
        {title}
      </div>
      <pre
        className="text-xs font-mono p-3 rounded overflow-x-auto whitespace-pre-wrap"
        style={{ background: "var(--muted)", maxHeight: 360 }}
      >
        {pretty(value) || "(empty)"}
      </pre>
    </div>
  );
}

function CallBlobPanel({
  runId,
  call,
}: {
  runId: string | null;
  call: GeminiCallManifestEntry;
}) {
  const [blob, setBlob] = useState<GeminiCallBlob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!runId || !call.r2_key) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/gemini-call-logs/${call.call_id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load raw call");
      setBlob(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  if (call.capture_error) {
    return (
      <div className="text-xs p-3 rounded" style={{ background: "#fecaca20", color: "#991b1b" }}>
        Raw blob capture failed: {call.capture_error.type}: {call.capture_error.message}
      </div>
    );
  }

  if (!call.r2_key) {
    return (
      <div className="text-xs p-3 rounded" style={{ background: "var(--muted)", color: "var(--muted-fg)" }}>
        No raw R2 blob was captured for this attempt.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!blob && (
        <button
          type="button"
          onClick={load}
          disabled={loading || !runId}
          className="text-xs font-medium px-3 py-1 rounded disabled:opacity-40"
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          {loading ? "Loading raw blob..." : `Load raw blob (${formatBytes(call.blob_bytes)})`}
        </button>
      )}
      {error && (
        <div className="text-xs p-2 rounded" style={{ background: "#fecaca20", color: "#991b1b" }}>
          {error}
        </div>
      )}
      {blob && (
        <div className="grid gap-3">
          <RawBlock title="System Instruction" value={blob.request?.system_instruction || ""} />
          <RawBlock title="User Prompt" value={blob.request?.user_prompt || blob.request?.contents || ""} />
          <RawBlock title="Raw Response Text" value={blob.response?.text || ""} />
          <RawBlock title="Parsed Response" value={blob.response?.parsed ?? null} />
          {blob.error != null ? <RawBlock title="Error" value={blob.error} /> : null}
        </div>
      )}
    </div>
  );
}

export function RawCallList({
  calls,
  runId,
}: {
  calls: GeminiCallManifestEntry[];
  runId: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (calls.length === 0) {
    return (
      <p className="text-sm italic p-4" style={{ color: "var(--muted-fg)" }}>
        No Gemini raw calls captured here.
      </p>
    );
  }

  return (
    <div className="divide-y" style={{ borderColor: "var(--border)" }}>
      {calls.map((call) => {
        const isOpen = expanded === call.call_id;
        const range = call.video?.start_time != null && call.video?.end_time != null
          ? `${formatTime(call.video.start_time)}-${formatTime(call.video.end_time)}`
          : "global";
        return (
          <div key={call.call_id}>
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : call.call_id)}
              className="w-full text-left px-3 py-2 flex items-center gap-2"
            >
              <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
                {isOpen ? "▼" : "▶"}
              </span>
              <span className="text-xs font-mono" style={{ color: statusColor(call.status) }}>
                {call.status}
              </span>
              <span className="text-xs font-semibold">{call.kind}</span>
              <span className="text-xs font-mono" style={{ color: "var(--muted-fg)" }}>
                attempt {call.attempt}
              </span>
              <span className="text-xs font-mono" style={{ color: "var(--muted-fg)" }}>
                {range}
              </span>
              <span className="text-xs font-mono ml-auto" style={{ color: "var(--muted-fg)" }}>
                {call.item_count ?? "-"} items · {call.duration_ms}ms
              </span>
            </button>
            {isOpen && (
              <div className="px-8 pb-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: "var(--muted-fg)" }}>
                  <div>Model: <span style={{ color: "var(--foreground)" }}>{call.model_version || call.model_requested}</span></div>
                  <div>Prompt: <span style={{ color: "var(--foreground)" }}>{call.prompt_version || "-"}</span></div>
                  <div>Schema: <span style={{ color: "var(--foreground)" }}>{call.schema || "-"}</span></div>
                  <div>Blob: <span style={{ color: "var(--foreground)" }}>{formatBytes(call.blob_bytes)}</span></div>
                </div>
                {call.error && (
                  <div className="text-xs p-2 rounded" style={{ background: "#fecaca20", color: "#991b1b" }}>
                    {call.error.type}: {call.error.message}
                  </div>
                )}
                <CallBlobPanel runId={runId} call={call} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionBlock({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs" style={{ color: "var(--muted-fg)" }}>{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

export default function RawCallsView({
  logs,
  sections,
  runId,
}: {
  logs: GeminiCallLogsManifest | null;
  sections: Section[];
  runId: string | null;
}) {
  const grouped = useMemo(() => {
    const global = logs?.calls.filter((c) => c.section_index == null) ?? [];
    const bySection = sections.map((section, index) => ({
      index,
      section,
      calls: logs?.calls.filter((c) => c.section_index === index) ?? [],
    }));
    return { global, bySection };
  }, [logs, sections]);

  if (!logs) {
    return (
      <div className="overflow-y-auto p-6 flex-1">
        <p className="text-sm italic" style={{ color: "var(--muted-fg)" }}>
          Raw Gemini call logging is unavailable for this run. Older runs were not backfilled.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto p-6 flex-1 space-y-3">
      <div className="text-sm" style={{ color: "var(--muted-fg)" }}>
        Capture status: <span style={{ color: "var(--foreground)" }}>{logs.capture_status}</span>
        {logs.truncated ? " · manifest truncated" : ""} · {logs.calls.length} attempts
      </div>
      <SectionBlock title="Global calls" subtitle="Topic map and other non-section calls">
        <RawCallList calls={grouped.global} runId={runId} />
      </SectionBlock>
      {grouped.bySection.map(({ index, section, calls }) => {
        const start = parseTs(section.start_time);
        const end = section.end_time ? parseTs(section.end_time) : null;
        return (
          <SectionBlock
            key={index}
            title={`${index + 1}. ${section.title}`}
            subtitle={`${formatTime(start)}${end != null ? `-${formatTime(end)}` : ""} · ${calls.length} attempts`}
          >
            <RawCallList calls={calls} runId={runId} />
          </SectionBlock>
        );
      })}
    </div>
  );
}
