"use client";

interface Run {
  id: string;
  status: string;
  pipeline_version: string;
  transcript_prompt_version: string | null;
  equations_prompt_version: string | null;
  visual_content_prompt_version: string | null;
  segment_count: number | null;
  equation_count: number | null;
  created_at: string;
}

interface RunSelectorProps {
  runs: Run[];
  activeRunId: string | null;
  onRunChange: (runId: string) => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function RunSelector({ runs, activeRunId, onRunChange }: RunSelectorProps) {
  // Show selector if there are multiple runs (any status) or any completed runs
  const relevantRuns = runs.filter((r) => ["complete", "failed"].includes(r.status));

  if (relevantRuns.length <= 1) return null;

  return (
    <select
      value={activeRunId || ""}
      onChange={(e) => onRunChange(e.target.value)}
      className="text-xs rounded-md px-2 py-1.5 cursor-pointer"
      style={{
        background: "var(--muted)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
      }}
    >
      {relevantRuns.map((run, i) => {
        const isFailed = run.status === "failed";
        return (
          <option key={run.id} value={run.id} disabled={isFailed}>
            Run {relevantRuns.length - i} — {formatDate(run.created_at)}
            {isFailed ? " (FAILED)" : ""}
            {run.segment_count != null ? ` (${run.segment_count} seg, ${run.equation_count} items)` : ""}
            {/* Show the visual content prompt version — that's the prompt
                we're actively iterating. Falls back to the equations
                version label for older runs that pre-date the
                visual_content_prompt_version column. */}
            {run.visual_content_prompt_version
              ? ` — vc ${run.visual_content_prompt_version}`
              : run.equations_prompt_version
              ? ` — eq ${run.equations_prompt_version}`
              : ""}
          </option>
        );
      })}
    </select>
  );
}
