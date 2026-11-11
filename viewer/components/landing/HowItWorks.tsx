"use client";

interface Modality {
  id: "ear" | "eye" | "inf";
  title: string;
  description: string;
  glyph: string;
  glyphFont: "serif-italic" | "sans";
  glyphSize: number;
  dotBg: string;
}

const MODALITIES: Modality[] = [
  {
    id: "ear",
    title: "Add a lecture.",
    description: "Import a public YouTube lecture or upload a recording.",
    glyph: "♪",
    glyphFont: "serif-italic",
    glyphSize: 16,
    dotBg: "var(--accent-2)",
  },
  {
    id: "eye",
    title: "Capture the material.",
    description: "Extract the spoken explanation, equations, and visual content.",
    glyph: "◉",
    glyphFont: "sans",
    glyphSize: 15,
    dotBg: "#2f7d3e",
  },
  {
    id: "inf",
    title: "Generate study notes.",
    description: "Create comprehensive and condensed notes with source citations.",
    glyph: "∴",
    glyphFont: "sans",
    glyphSize: 15,
    dotBg: "#5b3f94",
  },
];

export default function HowItWorks() {
  return (
    <section
      id="how"
      className="px-6 md:px-10 py-8 md:py-10"
      style={{ background: "var(--paper)", borderBottom: "1px solid var(--rule)" }}
    >
      <div className="max-w-[1320px] mx-auto">
        <div
          className="text-[10.5px] uppercase mb-3"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.14em",
            color: "var(--muted-fg)",
          }}
        >
          03 · How it works
        </div>
        <div
          className="grid grid-cols-1 md:[grid-template-columns:minmax(180px,1fr)_2.2fr_2.2fr_2.2fr] gap-6 md:gap-10 items-center px-6 py-6 md:px-8 md:py-7 rounded-2xl"
          style={{ background: "#fff", border: "1px solid var(--rule)" }}
        >
          <h2
            className="m-0"
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(22px, 2.3vw, 30px)",
              lineHeight: 1.1,
              letterSpacing: "-0.015em",
              color: "var(--ink)",
              textWrap: "balance",
            }}
          >
            From lecture to{" "}
            <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>
              study chapter.
            </em>
          </h2>

          {MODALITIES.map((m) => (
            <div key={m.id} className="flex items-center gap-3 min-w-0">
              <span
                aria-hidden="true"
                className="inline-grid place-items-center rounded-md shrink-0"
                style={{
                  width: 34,
                  height: 34,
                  background: m.dotBg,
                  color: "#fff",
                  fontFamily:
                    m.glyphFont === "serif-italic"
                      ? "var(--font-serif)"
                      : "var(--font-sans)",
                  fontStyle: m.glyphFont === "serif-italic" ? "italic" : "normal",
                  fontWeight: 600,
                  fontSize: m.glyphSize,
                  lineHeight: 1,
                }}
              >
                {m.glyph}
              </span>
              <div className="min-w-0">
                <div
                  className="text-[13.5px] font-semibold"
                  style={{ color: "var(--ink)", lineHeight: 1.3 }}
                >
                  {m.title}
                </div>
                <div
                  className="text-[12.5px] mt-0.5"
                  style={{ color: "var(--ink-2)", lineHeight: 1.5, textWrap: "pretty" }}
                >
                  {m.description}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
