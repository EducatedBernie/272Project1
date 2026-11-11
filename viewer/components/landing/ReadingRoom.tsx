"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "q" | "s";

interface FaqEntry {
  roman: string;
  q: string;
  badge?: string;
  title: React.ReactNode;
  body: React.ReactNode;
}

interface SpecEntry {
  navRoman: string;
  navLabel: string;
  roman: string;
  key: string;
  title: React.ReactNode;
  sub: string;
  body: React.ReactNode;
}

// ── FAQ entries (v2 order: accuracy → formats → cost → silent → screen readers → WCAG) ──

const FAQS: FaqEntry[] = [
  {
    roman: "i.",
    q: "How accurate is the extraction?",
    badge: "quality matters",
    title: (
      <>
        It works best when the board is{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>sharp enough to read.</em>
      </>
    ),
    body: (
      <>
        <p>
          Chalkboard is strongest on lectures where the board, tablet, or slides are visible at readable resolution. Sharp HD footage, clean screen recordings, and close board shots give the model enough visual evidence to extract equations and diagrams reliably.
        </p>
        <p>
          If the camera is too far away, the board is blurry, or symbols are small and crowded, extraction becomes less certain. In those cases we output confidence scores and flag the result for human review instead of pretending the model knows.
        </p>
        <p>
          Visual extraction can still beat speech-only captions when a professor writes silently, but it is not magic OCR. The quality of the source video matters.
        </p>
      </>
    ),
  },
  {
    roman: "ii.",
    q: "What lecture formats does it handle?",
    title: (
      <>
        If anything appears on the board,{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>it reads it.</em>
      </>
    ),
    body: (
      <>
        <p>
          Any lecture where anything visual appears on the board — math or otherwise. Chalkboard reads chalkboards, whiteboards, tablets, slide decks, and mixed media equally; it doesn&apos;t care about the subject or the surface.
        </p>
        <FormatChipRow />
        <p>Beyond equations, the same pipeline extracts:</p>
        <InlineSpec
          bits={[
            { lab: "Diagrams", v: "Prose descriptions for the blind" },
            { lab: "Pseudocode", v: "Indented, copyable code" },
            { lab: "Topics", v: "Section headings with timestamps" },
          ]}
        />
        <p>
          It also cross-references: when a professor says &ldquo;this equation&rdquo; and points at the board, Chalkboard links the spoken reference to the specific equation being pointed at.
        </p>
      </>
    ),
  },
  {
    roman: "iii.",
    q: "What does it cost?",
    badge: "$0.25/hr",
    title: (
      <>
        Roughly{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>$0.25</em> per lecture hour.
      </>
    ),
    body: (
      <>
        <p>Fully automated. No human in the loop, no post-processing.</p>
        <InlineSpec
          bits={[
            { lab: "Chalkboard", v: "~$0.25 / hr · minutes to process" },
            { lab: "Human captioning (STEM-grade)", v: "$180–300 / hr · 3–5 days" },
            { lab: "Institutional pricing", v: "Volume rates — contact sales" },
          ]}
        />
        <p>
          For a mid-size university captioning 500 lecture hours per semester, that&apos;s the difference between <b>$125</b> and <b>$90,000</b>. Cost isn&apos;t usually why people adopt this, but it&apos;s what gets procurement to sign.
        </p>
      </>
    ),
  },
  {
    roman: "iv.",
    q: "How does it handle silent writing?",
    title: (
      <>
        It watches the board whether{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>the room is talking or not.</em>
      </>
    ),
    body: (
      <>
        <p>
          This is the hardest case for any captioning tool. Most systems emit <Code>[silence]</Code> or <Code>[writing on board]</Code> — that&apos;s the accessibility gap that <ScChip jumpToSpec={2}>SC 1.2.5</ScChip> exists to close.
        </p>
        <p>
          Chalkboard reads the board every two seconds regardless of audio. A silent derivation becomes a fully timestamped sequence of equations, with the intermediate steps captured, <em>even if they were erased before the professor spoke again.</em>
        </p>
        <p>
          A blind student gets the same &ldquo;walk through this silently&rdquo; experience as a sighted one.
        </p>
      </>
    ),
  },
  {
    roman: "v.",
    q: "How does it work with screen readers?",
    badge: "SC 4.1.2",
    title: (
      <>
        Every equation ships with MathML,{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>not just a picture.</em>
      </>
    ),
    body: (
      <>
        <p>
          KaTeX emits <Code>{"<math>"}</Code> markup alongside the visual rendering. <b>JAWS</b>, <b>NVDA</b>, and <b>VoiceOver</b> parse that markup and read the structure — a fraction reads as &ldquo;numerator over denominator&rdquo;, not &ldquo;sigma slash epsilon zero&rdquo;.
        </p>
        <InlineSpec
          bits={[
            { lab: "NVDA", v: "v2024.4 · MathCAT default" },
            { lab: "JAWS", v: "v2025 · native" },
            { lab: "VoiceOver", v: "macOS 15 · Safari" },
          ]}
        />
        <p>
          No plugins. No separate accessible version. Mapped to <ScChip jumpToSpec={3}>SC 4.1.2</ScChip>.
        </p>
      </>
    ),
  },
  {
    roman: "vi.",
    q: "Which WCAG criteria does it cover?",
    badge: "AA",
    title: (
      <>
        Four success criteria,{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>one render pipeline.</em>
      </>
    ),
    body: (
      <>
        <p>
          Chalkboard meets <b>WCAG 2.1 Level AA</b> for any video content where the lecturer writes, draws, or projects — the exact area where general-purpose captioning vendors fall short, regardless of subject.
        </p>
        <p>Every lecture ships with:</p>
        <div className="flex flex-wrap gap-1.5">
          <ScChip jumpToSpec={0}>SC 1.1.1</ScChip>
          <ScChip jumpToSpec={1}>SC 1.2.2</ScChip>
          <ScChip jumpToSpec={2}>SC 1.2.5</ScChip>
          <ScChip jumpToSpec={3}>SC 4.1.2</ScChip>
        </div>
        <p>Click any criterion above to jump into the spec sheet with that row expanded.</p>
      </>
    ),
  },
];

// ── Spec rows ───────────────────────────────────────────────────────────

const SPECS: SpecEntry[] = [
  {
    navRoman: "i.",
    navLabel: "Text alternatives — visual math & diagrams",
    roman: "SC 1.1.1",
    key: "SC 1.1.1",
    sub: "Spec · 01 of 05 · WCAG 2.1 A",
    title: (
      <>
        Text alternatives —{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>visual math &amp; diagrams.</em>
      </>
    ),
    body: (
      <>
        <p>
          Every equation is rendered with both visual KaTeX and MathML. Every diagram ships with a prose alt-text description generated from the visual + audio context.
        </p>
        <EvCode>
          <Cmt>{"// MathML in rendered output"}</Cmt>
          {"\n"}
          <EvCore>{"<math "}</EvCore>
          <Attr>xmlns</Attr>=<Str>{'"http://www.w3.org/1998/Math/MathML"'}</Str>
          <EvCore>{">"}</EvCore>
          {"\n  <mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup>\n"}
          <EvCore>{"</math>"}</EvCore>
          {"\n\n"}
          <Cmt>{"// diagram alt-text"}</Cmt>
          {"\n"}
          <Attr>alt</Attr>=<Str>{'"A triangle VEB_u equivalent to VEB_√u on top…"'}</Str>
        </EvCode>
      </>
    ),
  },
  {
    navRoman: "ii.",
    navLabel: "Synchronized captions",
    roman: "SC 1.2.2",
    key: "SC 1.2.2",
    sub: "Spec · 02 of 05 · WCAG 2.1 A",
    title: (
      <>
        Synchronized{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>captions.</em>
      </>
    ),
    body: (
      <>
        <p>
          Every transcript segment is anchored to a timestamp with a ±500ms drift tolerance. The active segment highlights live as the video plays.
        </p>
        <EvCode>
          <Cmt>{"// example segment record"}</Cmt>
          {"\n{\n  "}
          <Attr>{'"ts_start"'}</Attr>: <Str>{'"00:28:42.120"'}</Str>,{"\n  "}
          <Attr>{'"ts_end"'}</Attr>:   <Str>{'"00:28:51.480"'}</Str>,{"\n  "}
          <Attr>{'"kind"'}</Attr>:     <Str>{'"equation"'}</Str>,{"\n  "}
          <Attr>{'"latex"'}</Attr>:    <Str>{String.raw`"T(u) = T(\sqrt{u}) + O(1)"`}</Str>,{"\n  "}
          <Attr>{'"source"'}</Attr>:   <Str>{'"audio+chalk"'}</Str>
          {"\n}"}
        </EvCode>
      </>
    ),
  },
  {
    navRoman: "iii.",
    navLabel: "Audio description — visual in silence",
    roman: "SC 1.2.5",
    key: "SC 1.2.5",
    sub: "Spec · 03 of 05 · WCAG 2.1 AA",
    title: (
      <>
        Audio description —{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>visual content in silence.</em>
      </>
    ),
    body: (
      <>
        <p>
          When an instructor writes silently, the diagram/equation is still described in the transcript — the reader doesn&apos;t need to see the board to understand what&apos;s happening.
        </p>
        <EvCode>
          <Cmt>{"// silent-writing example"}</Cmt>
          {"\n[28:42] "}
          <EvCore>{"<silent>"}</EvCore>{" "}
          <Str>instructor redraws the vEB recursion</Str>
          {"\n         as "}
          <Attr>VEB_u = VEB_√u + √u × VEB_√u</Attr>
          {",\n         with a brace marking √u clusters."}
        </EvCode>
      </>
    ),
  },
  {
    navRoman: "iv.",
    navLabel: "Name, role, value — AT-compatible math",
    roman: "SC 4.1.2",
    key: "SC 4.1.2",
    sub: "Spec · 04 of 05 · WCAG 2.1 A",
    title: (
      <>
        Name, role, value —{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>AT-compatible math.</em>
      </>
    ),
    body: (
      <>
        <p>
          MathML is parsed natively by JAWS, NVDA, and VoiceOver. A screen reader hearing <Code>σ/ε₀</Code> identifies it as a fraction with specific numerator and denominator — not just the string &ldquo;sigma over epsilon zero&rdquo;.
        </p>
        <EvCode>
          <Cmt>{"// verified with:"}</Cmt>
          {"\n"}
          <EvCore>NVDA</EvCore>      <Str>v2024.4</Str> · MathCAT reads fractions, roots, sums
          {"\n"}
          <EvCore>JAWS</EvCore>      <Str>v2025</Str>   · MathCAT default
          {"\n"}
          <EvCore>VoiceOver</EvCore> <Str>macOS 15</Str> · Safari native MathML
        </EvCode>
      </>
    ),
  },
  {
    navRoman: "v.",
    navLabel: "ADA Title II · April 2026 rule",
    roman: "28 CFR",
    key: "28 CFR",
    sub: "Spec · 05 of 05 · ADA Title II",
    title: (
      <>
        April 2026{" "}
        <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>digital accessibility rule.</em>
      </>
    ),
    body: (
      <>
        <p>
          Public universities and state/local governments must deliver accessible digital content. Any lecture where a professor writes or draws on a board is a gap — every major captioning vendor falls back to &ldquo;[writing on board]&rdquo; for the visual content, regardless of subject. Chalkboard closes that gap.
        </p>
        <EvCode>
          <Cmt>{"// gap report"}</Cmt>
          {"\nStandard captioning:   "}
          <Attr>{'"[instructor writes]"'}</Attr>
          {"\nChalkboard:            "}
          <Str>{'"T(u) = T(√u) + O(1)"'}</Str>
          {"\n                       + MathML + alt-text + timestamp"}
        </EvCode>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          <ValueCell label="Cost per lecture hour" big="$0.25" sub="$180–300 · human captioning" strike />
          <ValueCell label="Turnaround" big="Minutes" sub="vs 3–5 days for human" />
          <ValueCell label="Manual editing" big="None" sub="Fully automated" />
          <ValueCell label="Missed equations" big="Zero" sub="Across all test videos" />
        </div>
      </>
    ),
  },
];

// ── Main component ──────────────────────────────────────────────────────

export default function ReadingRoom() {
  const [mode, setMode] = useState<Mode>("q");
  const [qIdx, setQIdx] = useState(0);
  const [sIdx, setSIdx] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const qBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const count = mode === "q" ? FAQS.length : SPECS.length;
  const idx = mode === "q" ? qIdx : sIdx;
  const setIdx = mode === "q" ? setQIdx : setSIdx;

  const goTo = useCallback(
    (i: number) => {
      const next = ((i % count) + count) % count;
      setIdx(next);
    },
    [count, setIdx]
  );

  // Arrow-key nav scoped to the component
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        goTo(idx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        goTo(idx - 1);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [idx, goTo]);

  // Cross-link handler: listens for custom events from ScChip
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ specIdx: number }>).detail;
      setMode("s");
      setSIdx(detail.specIdx);
      shellRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("chalkboard-jump-to-spec", handler);
    return () => window.removeEventListener("chalkboard-jump-to-spec", handler);
  }, []);

  // Keep focus on active nav button when arrow-navigating
  useEffect(() => {
    const refs = mode === "q" ? qBtnRefs : sBtnRefs;
    const btn = refs.current[idx];
    if (btn && document.activeElement && shellRef.current?.contains(document.activeElement)) {
      btn.focus();
    }
  }, [idx, mode]);

  const isSpec = mode === "s";
  const current = isSpec ? SPECS[sIdx] : FAQS[qIdx];
  const topline = isSpec
    ? `${(current as SpecEntry).sub}`
    : `Question · ${String(qIdx + 1).padStart(2, "0")} of ${String(FAQS.length).padStart(2, "0")}`;

  return (
    <section id="room" className="px-6 md:px-10 py-20 md:py-24" style={{ background: "var(--paper)" }}>
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:[grid-template-columns:1fr_2fr] gap-4 md:gap-10 mb-10">
          <div>
            <div
              className="text-[11px] uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.14em",
                color: "var(--muted-fg)",
              }}
            >
              04 · Read the fine print
            </div>
            <h2
              className="mt-2 mb-0"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 400,
                fontSize: "clamp(32px, 4.2vw, 52px)",
                lineHeight: 1.02,
                letterSpacing: "-0.02em",
                textWrap: "balance",
                maxWidth: "18ch",
                color: "var(--ink)",
              }}
            >
              Questions, then the{" "}
              <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>spec sheet.</em>
            </h2>
          </div>
          <div>
            <p
              className="m-0 mb-4 text-[16.5px] leading-[1.55] max-w-[60ch]"
              style={{ color: "var(--ink-2)", textWrap: "pretty" }}
            >
              Click through on the left, read on the right. Toggle to spec-sheet mode for the row-by-row WCAG evidence — same widget, same content, darker paper.
            </p>
            <div
              className="inline-flex gap-1 p-1 rounded-xl"
              role="tablist"
              aria-label="Reading mode"
              style={{ background: "var(--paper-2)", border: "1px solid var(--rule)" }}
            >
              <ModeBtn on={mode === "q"} onClick={() => setMode("q")}>
                Questions · {FAQS.length}
              </ModeBtn>
              <ModeBtn on={mode === "s"} onClick={() => setMode("s")}>
                Spec sheet · {SPECS.length}
              </ModeBtn>
            </div>
          </div>
        </div>

        <div
          ref={shellRef}
          className="grid grid-cols-1 md:[grid-template-columns:320px_1fr] gap-0 rounded-2xl overflow-hidden transition-colors"
          style={{
            border: "1px solid var(--rule)",
            background: isSpec ? "var(--paper-2)" : "#fff",
            boxShadow: "0 30px 60px -50px #0000001f",
            minHeight: 520,
          }}
        >
          <nav
            className="flex flex-col gap-1.5 p-5 md:py-7 md:pl-7 md:pr-2"
            style={{
              background: isSpec ? "#ece7db" : "var(--paper-2)",
              borderRight: "1px solid var(--rule)",
            }}
            aria-label={isSpec ? "Spec topics" : "FAQ topics"}
          >
            <div
              className="text-[10.5px] uppercase mb-2.5"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.14em",
                color: "var(--muted-fg)",
              }}
            >
              {isSpec ? `Spec rows · ${SPECS.length}` : `Topics · ${FAQS.length}`}
            </div>
            {isSpec
              ? SPECS.map((s, i) => (
                  <NavBtn
                    key={s.key}
                    ref={(el) => {
                      sBtnRefs.current[i] = el;
                    }}
                    on={i === sIdx}
                    onClick={() => setSIdx(i)}
                    roman={s.navRoman}
                    label={s.navLabel}
                    badge={s.key}
                  />
                ))
              : FAQS.map((f, i) => (
                  <NavBtn
                    key={f.roman}
                    ref={(el) => {
                      qBtnRefs.current[i] = el;
                    }}
                    on={i === qIdx}
                    onClick={() => setQIdx(i)}
                    roman={f.roman}
                    label={f.q}
                    badge={f.badge}
                  />
                ))}
          </nav>

          <article
            id="reader"
            className="flex flex-col gap-4 p-6 md:p-12 min-w-0"
            aria-live="polite"
          >
            <div
              className="flex items-center gap-2.5 text-[11px] uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.14em",
                color: "var(--muted-fg)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontSize: 16,
                  color: "var(--accent-2)",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                {current.roman}
              </span>
              <span>{topline}</span>
            </div>

            <h3
              className="m-0"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 400,
                fontSize: "clamp(26px, 3vw, 38px)",
                lineHeight: 1.12,
                letterSpacing: "-0.015em",
                textWrap: "balance",
                color: "var(--ink)",
              }}
            >
              {current.title}
            </h3>

            <div
              className="answer text-[16.5px] leading-[1.65] max-w-[65ch] flex flex-col gap-3"
              style={{ color: "var(--ink-2)", textWrap: "pretty" }}
            >
              {current.body}
            </div>

            <footer
              className="mt-auto pt-5 flex justify-between items-center gap-5 flex-wrap text-[12px]"
              style={{
                borderTop: "1px dashed var(--rule)",
                fontFamily: "var(--font-mono)",
                color: "var(--muted-fg)",
              }}
            >
              <div>
                Still stuck?{" "}
                <a
                  href="mailto:hello@chalkboard.video"
                  style={{ color: "var(--ink)", borderBottom: "1px solid var(--accent)" }}
                >
                  Email a real human →
                </a>
              </div>
              <div className="flex gap-1.5 items-center">
                <PagerBtn onClick={() => goTo(idx - 1)} label="← prev" aria="Previous" />
                <PagerBtn onClick={() => goTo(idx + 1)} label="next →" aria="Next" />
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </div>
            </footer>
          </article>
        </div>
      </div>
    </section>
  );
}

// ── Small building-block components ─────────────────────────────────────

function ModeBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className="rounded-lg px-3.5 py-1.5 text-[12.5px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        background: on ? "#fff" : "transparent",
        border: "1px solid transparent",
        borderColor: on ? "var(--rule)" : "transparent",
        fontFamily: "var(--font-mono)",
        color: on ? "var(--ink)" : "var(--muted-fg)",
        fontWeight: on ? 600 : 500,
        letterSpacing: "-0.005em",
        boxShadow: on ? "0 1px 0 #0000000a, 0 6px 14px -10px #00000025" : "none",
        outlineColor: "var(--accent)",
      }}
    >
      {children}
    </button>
  );
}

const NavBtn = ({
  ref,
  on,
  onClick,
  roman,
  label,
  badge,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  on: boolean;
  onClick: () => void;
  roman: string;
  label: React.ReactNode;
  badge?: string;
}) => (
  <button
    ref={ref}
    type="button"
    onClick={onClick}
    aria-current={on ? "true" : undefined}
    className="text-left rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-colors"
    style={{
      background: on ? "#fff" : "transparent",
      padding: "12px 14px",
      fontFamily: "var(--font-sans)",
      color: on ? "var(--ink)" : "var(--ink-2)",
      fontSize: 14,
      fontWeight: on ? 500 : 400,
      letterSpacing: "-0.005em",
      boxShadow: on ? "0 1px 0 #0000000a, 0 6px 14px -10px #00000025" : "none",
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 10,
      alignItems: "baseline",
      outlineColor: "var(--accent)",
    }}
  >
    <span
      style={{
        fontFamily: "var(--font-serif)",
        fontStyle: "italic",
        color: on ? "var(--accent-2)" : "var(--muted-fg)",
        fontSize: 14,
      }}
    >
      {roman}
    </span>
    <span className="leading-[1.4]">{label}</span>
    {badge ? (
      <span
        className="text-[10px] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded"
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.08em",
          background: "color-mix(in srgb, var(--accent) 12%, #fff)",
          color: "var(--accent-2)",
          border: "1px solid color-mix(in srgb, var(--accent) 25%, var(--rule))",
        }}
      >
        {badge}
      </span>
    ) : (
      <span />
    )}
  </button>
);

function PagerBtn({
  onClick,
  label,
  aria,
}: {
  onClick: () => void;
  label: string;
  aria: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      className="rounded-md cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        background: "#fff",
        border: "1px solid var(--rule)",
        padding: "5px 10px",
        fontFamily: "inherit",
        fontSize: 11.5,
        color: "var(--ink-2)",
        outlineColor: "var(--accent)",
      }}
    >
      {label}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded text-[10.5px] px-1.5 py-0.5"
      style={{ background: "var(--paper-2)", color: "var(--muted-fg)" }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

function InlineSpec({ bits }: { bits: { lab: string; v: string }[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
      {bits.map((bit) => (
        <div
          key={bit.lab}
          className="p-3 rounded-lg"
          style={{ background: "var(--paper)", border: "1px solid var(--rule)" }}
        >
          <div
            className="text-[10.5px] uppercase"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--accent-2)",
              letterSpacing: "0.08em",
            }}
          >
            {bit.lab}
          </div>
          <div className="text-[13.5px] leading-[1.4] mt-0.5" style={{ color: "var(--ink-2)" }}>
            {bit.v}
          </div>
        </div>
      ))}
    </div>
  );
}

function FormatChipRow() {
  const FORMATS: { label: string; highlighted?: boolean }[] = [
    { label: "URL",        highlighted: true },
    { label: "Upload",     highlighted: true },
    { label: "YouTube" },
    { label: "Zoom" },
    { label: "Chalkboard" },
    { label: "Whiteboard" },
    { label: "iPad / tablet" },
    { label: "Slides" },
    { label: "Mixed media" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5 my-2">
      {FORMATS.map((f) => (
        <span
          key={f.label}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px]"
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            letterSpacing: "-0.005em",
            background: f.highlighted
              ? "color-mix(in srgb, var(--accent) 12%, #fff)"
              : "var(--paper)",
            border: `1px solid ${
              f.highlighted
                ? "color-mix(in srgb, var(--accent) 35%, var(--rule))"
                : "var(--rule)"
            }`,
            color: f.highlighted ? "var(--accent-2)" : "var(--ink-2)",
          }}
        >
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{
              width: 5,
              height: 5,
              background: f.highlighted ? "var(--accent-2)" : "#2f7d3e",
            }}
          />
          {f.label}
        </span>
      ))}
    </div>
  );
}

function ScChip({
  jumpToSpec,
  children,
}: {
  jumpToSpec: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent("chalkboard-jump-to-spec", { detail: { specIdx: jumpToSpec } })
        );
      }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 align-baseline"
      style={{
        fontFamily: "var(--font-mono)",
        background: "color-mix(in srgb, var(--accent) 12%, #fff)",
        color: "var(--accent-2)",
        border: "1px solid color-mix(in srgb, var(--accent) 35%, var(--rule))",
        letterSpacing: "0.04em",
        fontWeight: 600,
        outlineColor: "var(--accent)",
      }}
    >
      {children} <span aria-hidden="true">↗</span>
    </button>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.88em",
        background: "var(--paper)",
        padding: "2px 6px",
        borderRadius: 4,
        border: "1px solid var(--rule)",
      }}
    >
      {children}
    </code>
  );
}

function EvCode({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="rounded-lg p-4 text-[12.5px] leading-[1.55] overflow-x-auto mt-2"
      style={{
        background: "var(--chalk-bg)",
        color: "var(--chalk-fg)",
        fontFamily: "var(--font-mono)",
        whiteSpace: "pre",
      }}
    >
      {children}
    </pre>
  );
}

function Cmt({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#7fa88f", fontStyle: "italic" }}>{children}</span>;
}

function EvCore({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#e0d8b0" }}>{children}</span>;
}

function Attr({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#d97a3d" }}>{children}</span>;
}

function Str({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#a9c79b" }}>{children}</span>;
}

function ValueCell({
  label,
  big,
  sub,
  strike,
}: {
  label: string;
  big: string;
  sub: string;
  strike?: boolean;
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "var(--paper)", border: "1px solid var(--rule)" }}
    >
      <div
        className="text-[10.5px] uppercase"
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.1em",
          color: "var(--muted-fg)",
        }}
      >
        {label}
      </div>
      <div
        className="mt-1"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 24,
          fontWeight: 400,
          color: "var(--accent-2)",
          lineHeight: 1,
        }}
      >
        {big}
      </div>
      <div
        className="mt-1 text-[11.5px]"
        style={{
          color: "var(--muted-fg)",
          textDecoration: strike ? "line-through" : "none",
        }}
      >
        {sub}
      </div>
    </div>
  );
}
