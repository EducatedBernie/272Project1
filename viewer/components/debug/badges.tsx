/**
 * Leaf UI components shared across the /debug page.
 *
 * Extracted from viewer/components/DebugView.tsx for the v2 layout rebuild.
 * Each component is dumb (props in, JSX out) — no fetches, no business logic.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import katex from "@/lib/katex";
import "katex/dist/katex.min.css";

import type { RepairStatus } from "@/lib/types";
import {
  type Severity,
  TYPE_COLORS,
  parseInlineLatex,
  aggregatePerType,
} from "@/lib/debug-utils";
import type { VisualContent } from "@/lib/types";
import { type UsageSummary, approxCost, formatTokens } from "@/lib/usage";

export function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, { bg: string; color: string; label: string }> = {
    ok: { bg: "#dcfce7", color: "#166534", label: "OK" },
    warning: { bg: "#fef9c3", color: "#854d0e", label: "WARN" },
    critical: { bg: "#fecaca", color: "#991b1b", label: "FAIL" },
  };
  const s = styles[severity];
  return (
    <span
      className="text-xs font-bold px-2 py-0.5 rounded"
      style={{ background: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  );
}

export function CoverageBar({ coverage }: { coverage: number }) {
  const pct = Math.min(Math.round(coverage * 100), 100);
  const color = pct >= 90 ? "#22c55e" : pct >= 70 ? "#eab308" : "#ef4444";
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex-1 h-2 rounded-full overflow-hidden"
        style={{ background: "var(--border)" }}
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-mono w-10 text-right" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

export function RenderedLatex({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      try {
        katex.render(latex, ref.current, {
          throwOnError: false,
          displayMode: true,
          output: "htmlAndMathml",
        });
      } catch {
        if (ref.current) ref.current.textContent = latex;
      }
    }
  }, [latex]);
  return <span ref={ref} role="math" />;
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color = confidence >= 0.9 ? "#22c55e" : confidence >= 0.7 ? "#eab308" : "#ef4444";
  return (
    <span
      className="text-xs font-bold px-1.5 py-0.5 rounded font-mono"
      style={{ background: `${color}20`, color }}
    >
      {confidence.toFixed(2)}
    </span>
  );
}

export function TypeBadge({ type }: { type: string }) {
  const color = TYPE_COLORS[type] || "#6b7280";
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ background: `${color}20`, color }}
    >
      {type}
    </span>
  );
}

export function RepairStatusBadge({ status }: { status: RepairStatus | undefined }) {
  if (!status) return null;
  const styles =
    status === "fixed"
      ? {
          bg: "#dcfce7",
          color: "#166534",
          label: "healed",
          title: "Deterministic healer rewrote a known misplacement pattern",
        }
      : {
          bg: "#fed7aa",
          color: "#9a3412",
          label: "skipped",
          title:
            "Validator flagged an error but no heal rule matched — perception failure (content genuinely missing)",
        };
  return (
    <span
      className="text-xs font-bold px-1.5 py-0.5 rounded font-mono"
      style={{ background: styles.bg, color: styles.color }}
      title={styles.title}
    >
      {styles.label}
    </span>
  );
}

export function VisualObservationExpander({ observation }: { observation: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (!observation) return null;
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs underline"
        style={{ color: "var(--muted-fg)" }}
      >
        {open ? "Hide" : "Show"} visual observation
      </button>
      {open && (
        <p
          className="text-xs mt-1 p-2 rounded italic"
          style={{
            background: "var(--muted)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
          }}
        >
          {observation}
        </p>
      )}
    </div>
  );
}

export function InlineLatex({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      try {
        katex.render(latex, ref.current, {
          throwOnError: false,
          displayMode: false,
          output: "htmlAndMathml",
        });
      } catch {
        if (ref.current) ref.current.textContent = `$${latex}$`;
      }
    }
  }, [latex]);
  return <span ref={ref} className="mx-0.5" role="math" />;
}

export function RichText({ text }: { text: string }) {
  const parts = parseInlineLatex(text);
  return (
    <span>
      {parts.map((part, i) =>
        part.type === "latex" ? (
          <InlineLatex key={i} latex={part.content} />
        ) : (
          <span key={i}>{part.content}</span>
        ),
      )}
    </span>
  );
}

export function CostChip({ usage }: { usage: UsageSummary | null }) {
  if (!usage) return null;
  const { totals } = usage;
  if (totals.calls === 0) return null;
  const cost = approxCost(usage);
  const tip =
    `${totals.calls} calls · ${totals.prompt_tokens.toLocaleString()} prompt · ` +
    `${totals.candidates_tokens.toLocaleString()} output · ` +
    `${totals.cached_tokens.toLocaleString()} cached · ` +
    `${totals.thoughts_tokens.toLocaleString()} thoughts. ` +
    `~$ is approximate (pricing changes).`;
  return (
    <span
      className="text-xs font-mono px-2 py-0.5 rounded"
      style={{
        background: "var(--muted)",
        color: "var(--muted-fg)",
        border: "1px solid var(--border)",
      }}
      title={tip}
    >
      {totals.calls}c · {formatTokens(totals.total_tokens)} · ~${cost.toFixed(2)}
    </span>
  );
}

export function PerTypeHealthStrip({ items }: { items: VisualContent[] }) {
  const buckets = aggregatePerType(items);
  if (buckets.length === 0) return null;
  const totalHealed = buckets.reduce((s, b) => s + b.healed, 0);
  const totalUnhealable = buckets.reduce((s, b) => s + b.unhealable, 0);
  const overallClean = totalHealed === 0 && totalUnhealable === 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2
          className="text-sm font-semibold uppercase tracking-wide"
          style={{ color: "var(--muted-fg)" }}
        >
          Per-type health
        </h2>
        <span
          className="text-xs"
          style={{
            color: overallClean ? "#22c55e" : totalUnhealable > 0 ? "#ef4444" : "#eab308",
          }}
        >
          {overallClean
            ? "all clean"
            : `${totalHealed} healed${totalUnhealable > 0 ? ` · ${totalUnhealable} unhealable` : ""}`}
        </span>
      </div>
      <div
        className="rounded-lg p-3 flex flex-wrap gap-2"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        {buckets.map((b) => {
          const color = TYPE_COLORS[b.type] || "#6b7280";
          const dirty = b.healed + b.unhealable > 0;
          const detail = !dirty
            ? "all clean"
            : [
                b.healed > 0 ? `${b.healed} healed` : null,
                b.unhealable > 0 ? `${b.unhealable} unhealable` : null,
              ]
                .filter(Boolean)
                .join(", ");
          return (
            <div
              key={b.type}
              className="flex items-center gap-2 px-3 py-2 rounded font-mono text-xs"
              style={{
                background: `${color}15`,
                border: `1px solid ${b.unhealable > 0 ? "#ef4444" : b.healed > 0 ? "#eab308" : `${color}40`}`,
              }}
            >
              <span style={{ color }}>{b.type}</span>
              <span className="font-bold" style={{ color: "var(--foreground)" }}>
                {b.count}
              </span>
              <span
                style={{
                  color: b.unhealable > 0 ? "#ef4444" : b.healed > 0 ? "#a16207" : "#16a34a",
                }}
              >
                {dirty ? `(${detail})` : "✓"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SummaryCard({
  label,
  value,
  detail,
  alert,
}: {
  label: string;
  value: string;
  detail: string;
  alert?: boolean;
}) {
  return (
    <div
      className="rounded-lg p-4"
      style={{
        background: "var(--card)",
        border: `1px solid ${alert ? "#ef4444" : "var(--border)"}`,
      }}
    >
      <div className="text-xs" style={{ color: "var(--muted-fg)" }}>
        {label}
      </div>
      <div
        className="text-2xl font-bold mt-1"
        style={{ color: alert ? "#ef4444" : "var(--foreground)" }}
      >
        {value}
      </div>
      <div className="text-xs mt-0.5" style={{ color: "var(--muted-fg)" }}>
        {detail}
      </div>
    </div>
  );
}
