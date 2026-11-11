"use client";

import { needsAttention, type ArtifactFilter } from "@/lib/issues";
import type { VisualContent } from "@/lib/types";

interface Props {
  filter: ArtifactFilter;
  onChange: (filter: ArtifactFilter) => void;
  items: VisualContent[]; // unfiltered, used for the per-chip counts
}

interface ChipSpec {
  key: ArtifactFilter;
  label: string;
  match: (item: VisualContent) => boolean;
}

const SPECS: ChipSpec[] = [
  { key: "all", label: "All", match: () => true },
  { key: "attention", label: "Needs attention", match: needsAttention },
];

export default function FilterChips({ filter, onChange, items }: Props) {
  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 py-2 shrink-0"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--muted)" }}
    >
      {SPECS.map((spec) => {
        const count = items.filter(spec.match).length;
        const active = spec.key === filter;
        return (
          <button
            key={spec.key}
            type="button"
            onClick={() => onChange(spec.key)}
            className="text-xs px-2.5 py-1 rounded font-mono"
            style={{
              background: active ? "var(--foreground)" : "var(--card)",
              color: active ? "var(--background)" : "var(--muted-fg)",
              border: active ? "1px solid var(--foreground)" : "1px solid var(--border)",
            }}
          >
            {spec.label} <span style={{ opacity: active ? 0.7 : 1 }}>({count})</span>
          </button>
        );
      })}
    </div>
  );
}
