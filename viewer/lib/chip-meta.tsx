export type Variant = "eq" | "dia" | "code" | "text" | "chart" | "table";

interface ChipMeta {
  bg: string;
  glyph: string | React.ReactNode;
  font: string;
  italic: boolean;
  weight: number;
  size: number;
}

export function chipMeta(variant: Variant): ChipMeta {
  switch (variant) {
    case "eq":
      return { bg: "var(--accent-2)", glyph: "∫", font: "var(--font-serif)", italic: true, weight: 400, size: 14 };
    case "dia":
      return { bg: "#2f7d3e", glyph: "△", font: "var(--font-sans)", italic: false, weight: 600, size: 12 };
    case "code":
      return { bg: "#5b3f94", glyph: "{ }", font: "var(--font-mono)", italic: false, weight: 500, size: 11 };
    case "text":
      return { bg: "#3a2f1a", glyph: "¶", font: "var(--font-serif)", italic: true, weight: 500, size: 14 };
    case "chart":
      return {
        bg: "#2c5e9e",
        glyph: <BarsIcon />,
        font: "var(--font-sans)",
        italic: false,
        weight: 600,
        size: 12,
      };
    case "table":
      return {
        bg: "#5a4a1c",
        glyph: <GridIcon />,
        font: "var(--font-sans)",
        italic: false,
        weight: 600,
        size: 12,
      };
  }
}

export function KindChip({ variant }: { variant: Variant }) {
  const meta = chipMeta(variant);
  return (
    <span
      className="inline-grid place-items-center shrink-0"
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        background: meta.bg,
        color: "#fff",
      }}
      aria-hidden="true"
    >
      {typeof meta.glyph === "string" ? (
        <span
          style={{
            fontFamily: meta.font,
            fontStyle: meta.italic ? "italic" : "normal",
            fontWeight: meta.weight,
            fontSize: meta.size,
            lineHeight: 1,
          }}
        >
          {meta.glyph}
        </span>
      ) : (
        meta.glyph
      )}
    </span>
  );
}

function BarsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="1"  y="7" width="2.4" height="4" rx="0.6" />
      <rect x="4.8" y="4" width="2.4" height="7" rx="0.6" />
      <rect x="8.6" y="1" width="2.4" height="10" rx="0.6" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="1.2" />
      <line x1="6" y1="1.2" x2="6" y2="10.8" />
      <line x1="1.2" y1="6" x2="10.8" y2="6" />
    </svg>
  );
}
