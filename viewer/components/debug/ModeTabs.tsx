"use client";

export type DebugMode = "artifacts" | "captions" | "sections" | "raw";

interface Props {
  mode: DebugMode;
  onChange: (mode: DebugMode) => void;
  artifactCount: number;
  captionCount: number;
  sectionCount: number;
  rawCallCount: number;
}

interface TabSpec {
  key: DebugMode;
  label: string;
  count: number;
}

export default function ModeTabs({
  mode,
  onChange,
  artifactCount,
  captionCount,
  sectionCount,
  rawCallCount,
}: Props) {
  const tabs: TabSpec[] = [
    { key: "artifacts", label: "Artifacts", count: artifactCount },
    { key: "captions", label: "Captions", count: captionCount },
    { key: "sections", label: "Sections", count: sectionCount },
    { key: "raw", label: "Raw Calls", count: rawCallCount },
  ];

  return (
    <div
      className="flex shrink-0"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--muted)" }}
    >
      {tabs.map((tab) => {
        const active = tab.key === mode;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className="px-4 py-2 text-xs font-semibold uppercase tracking-wide"
            style={{
              background: active ? "var(--card)" : "transparent",
              color: active ? "var(--foreground)" : "var(--muted-fg)",
              borderBottom: active ? "2px solid #3b82f6" : "2px solid transparent",
            }}
          >
            {tab.label}{" "}
            <span className="font-mono" style={{ color: "var(--muted-fg)" }}>
              ({tab.count})
            </span>
          </button>
        );
      })}
    </div>
  );
}
