"use client";

import { useRef, useState } from "react";
import { DisplayLatex, InlineLatex } from "@/lib/inline-latex";
import { chipMeta, type Variant } from "@/lib/chip-meta";

type Tab = "equations" | "diagrams" | "code" | "text" | "chart" | "table";

interface TabDef {
  id: Tab;
  label: string;
  variant: Variant;
}

const TABS: TabDef[] = [
  { id: "equations", label: "Equations", variant: "eq"    },
  { id: "diagrams",  label: "Diagrams",  variant: "dia"   },
  { id: "code",      label: "Code",      variant: "code"  },
  { id: "text",      label: "Text",      variant: "text"  },
  { id: "chart",     label: "Charts",    variant: "chart" },
  { id: "table",     label: "Tables",    variant: "table" },
];

const PSEUDOCODE = `pred (V, x = <c, i>)
  if x > V.max: return V.max
  else if V.cluster[c].min < x:
      return pred(V.cluster[c], i)
  else:
      c' = pred(V.summary, c)
      return V.cluster[c'].max`;

export default function TabbedProof() {
  const [active, setActive] = useState<Tab>("equations");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    equations: null,
    diagrams: null,
    code: null,
    text: null,
    chart: null,
    table: null,
  });

  const activeIndex = TABS.findIndex((t) => t.id === active);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    let nextIndex = activeIndex;
    if (e.key === "ArrowRight") nextIndex = (activeIndex + 1) % TABS.length;
    else if (e.key === "ArrowLeft") nextIndex = (activeIndex - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = TABS.length - 1;
    else return;
    e.preventDefault();
    const nextTab = TABS[nextIndex].id;
    setActive(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  return (
    <section id="outputs" className="px-6 md:px-10 pt-6 pb-14 md:pt-8 md:pb-16" style={{ background: "var(--paper)" }}>
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:[grid-template-columns:1fr_auto] items-end gap-3 mb-6">
          <div>
            <div
              className="text-[11px] uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.14em",
                color: "var(--muted-fg)",
              }}
            >
              01 · What lands on the page
            </div>
            <h2
              className="mt-2 mb-0"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 400,
                fontSize: "clamp(28px, 3.6vw, 44px)",
                lineHeight: 1.04,
                letterSpacing: "-0.02em",
                textWrap: "balance",
                maxWidth: "22ch",
                color: "var(--ink)",
              }}
            >
              One lecture,{" "}
              <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>
                six kinds of notes —
              </em>{" "}
              rendered live.
            </h2>
          </div>
          <span
            className="text-[11px] uppercase md:justify-self-end"
            style={{
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.14em",
              color: "var(--muted-fg)",
            }}
          >
            click any · it&apos;s interactive
          </span>
        </div>

        <div
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5 p-1.5 rounded-xl"
          style={{ background: "var(--paper-2)", border: "1px solid var(--rule)" }}
          role="tablist"
          aria-label="Chalkboard output types"
        >
          {TABS.map((t) => {
            const on = active === t.id;
            const meta = chipMeta(t.variant);
            return (
              <button
                key={t.id}
                id={`proof-tab-${t.id}`}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                role="tab"
                aria-selected={on}
                aria-controls={`proof-panel-${t.id}`}
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(t.id)}
                onKeyDown={handleKeyDown}
                className="flex items-center justify-start lg:justify-center gap-2 px-3 py-2 rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  background: on ? "#fff" : "transparent",
                  boxShadow: on ? "0 1px 0 #0000000a, 0 8px 18px -10px #0000002e" : "none",
                  fontFamily: "var(--font-sans)",
                  color: "var(--ink)",
                  outlineColor: "var(--accent)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="inline-grid place-items-center rounded-md shrink-0"
                  style={{
                    width: 26,
                    height: 26,
                    background: meta.bg,
                    color: "#fff",
                  }}
                >
                  {typeof meta.glyph === "string" ? (
                    <span
                      style={{
                        fontFamily: meta.font,
                        fontStyle: meta.italic ? "italic" : "normal",
                        fontWeight: meta.weight,
                        fontSize: meta.size + 3,
                        lineHeight: 1,
                      }}
                    >
                      {meta.glyph}
                    </span>
                  ) : (
                    meta.glyph
                  )}
                </span>
                <span className="text-sm font-semibold">{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          {TABS.map((t) => (
            <div
              key={t.id}
              id={`proof-panel-${t.id}`}
              role="tabpanel"
              aria-labelledby={`proof-tab-${t.id}`}
              hidden={active !== t.id}
            >
              {t.id === "equations" && <EquationsPanel />}
              {t.id === "diagrams"  && <DiagramsPanel />}
              {t.id === "code"      && <CodePanel />}
              {t.id === "text"      && <TextPanel />}
              {t.id === "chart"     && <ChartPanel />}
              {t.id === "table"     && <TablePanel />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type KindClass = "eq" | "dia" | "code" | "text" | "chart" | "table";

function PanelShell({
  boardImage,
  boardAlt,
  badge,
  quote,
  children,
}: {
  boardImage?: string;
  boardAlt: string;
  badge: string;
  quote: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid gap-5 md:gap-7 grid-cols-1 md:[grid-template-columns:1.1fr_1fr]"
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: "#0a0a0a",
          border: "1px solid var(--rule)",
          boxShadow: "0 30px 60px -40px #00000055",
        }}
      >
        <div style={{ aspectRatio: "16 / 10", background: "#000" }}>
          {boardImage ? (
            <img
              src={boardImage}
              alt={boardAlt}
              style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.92 }}
            />
          ) : (
            <div
              className="w-full h-full grid place-items-center"
              style={{
                background:
                  "repeating-linear-gradient(135deg, #111 0 14px, #0a0a0a 14px 28px)",
              }}
              aria-label={boardAlt}
            >
              <span
                className="text-[10px] uppercase"
                style={{
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.18em",
                  color: "#5a564b",
                }}
              >
                board shot pending
              </span>
            </div>
          )}
        </div>
        <div
          className="px-3.5 py-3 flex flex-col gap-1.5"
          style={{ background: "#0f0f0f", color: "#d8d4c8", borderTop: "1px solid #ffffff10" }}
        >
          <span
            className="text-[10px] uppercase"
            style={{
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.1em",
              color: "var(--accent)",
            }}
          >
            {badge}
          </span>
          <span
            className="italic text-[15px]"
            style={{ fontFamily: "var(--font-serif)", color: "#e8e3d5" }}
          >
            {quote}
          </span>
        </div>
      </div>

      <div
        className="rounded-xl grid gap-3.5 p-5"
        style={{
          background: "#fff",
          border: "1px solid var(--rule)",
          minHeight: 280,
          gridTemplateRows: "auto 1fr auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const KIND_STYLE: Record<KindClass, { bg: string; fg: string }> = {
  eq:    { bg: "color-mix(in srgb, var(--accent) 8%, #fff)", fg: "var(--accent-2)" },
  dia:   { bg: "#e6efe8", fg: "#2a7038" }, // 5.15:1 on bg (WCAG AA); #2f7d3e was 4.33:1
  code:  { bg: "#eae4f2", fg: "#5b3f94" },
  text:  { bg: "#ece2cc", fg: "#3a2f1a" },
  chart: { bg: "#d3e0ef", fg: "#2c5e9e" },
  table: { bg: "#e8e0c8", fg: "#5a4a1c" },
};

function OutHeader({
  kind,
  meta,
  kindClass,
}: {
  kind: string;
  meta: string;
  kindClass: KindClass;
}) {
  const { bg, fg } = KIND_STYLE[kindClass];
  return (
    <div className="flex items-center justify-between">
      <span
        className="text-[10px] font-bold px-2 py-1 rounded"
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.14em",
          background: bg,
          color: fg,
        }}
      >
        {kind}
      </span>
      <span
        className="text-[11px]"
        style={{ fontFamily: "var(--font-mono)", color: "var(--muted-fg)" }}
      >
        {meta}
      </span>
    </div>
  );
}

function OutBody({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "center" | "top";
}) {
  return (
    <div
      className={`min-h-0 flex flex-col ${
        align === "center" ? "justify-center" : "justify-start"
      } gap-3`}
    >
      {children}
    </div>
  );
}

function OutFooter({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="pt-3 text-[12px] italic"
      style={{ borderTop: "1px dashed var(--rule)", color: "var(--muted-fg)" }}
    >
      {children}
    </div>
  );
}

function EquationsPanel() {
  return (
    <PanelShell
      boardImage="/landing/equation-demo.png"
      boardAlt="Feynman at Cornell, 1964"
      badge="Feynman · Cornell '64"
      quote={<>&ldquo;…the component of force at right angles…&rdquo;</>}
    >
      <OutHeader kind="EQUATION" meta="rendered from audio + chalk" kindClass="eq" />
      <OutBody>
        <div className="grid place-items-center text-[20px]">
          <DisplayLatex latex="\ddot{A} = \dot{\vec{r}} \times \dot{\vec{r}} + \vec{r} \times \frac{\vec{F}}{m} = 0" />
        </div>
      </OutBody>
      <OutFooter>
        Never written fully on the board · never spoken verbatim · inferred from context.
      </OutFooter>
    </PanelShell>
  );
}

function DiagramsPanel() {
  return (
    <PanelShell
      boardImage="/landing/diagram-demo.png"
      boardAlt="van Emde Boas tree sketch"
      badge="MIT 6.851 · vEB tree"
      quote={<>Hand-drawn triangles, <span style={{ fontFamily: "var(--font-mono)" }}>VEB_u = VEB_√u</span> recursion</>}
    >
      <OutHeader kind="DIAGRAM" meta="described as alt-text + MathML" kindClass="dia" />
      <OutBody>
        <p className="m-0 text-[15px] leading-[1.6]" style={{ color: "#2a2a2a", textWrap: "pretty" }}>
          A diagram illustrating the recursive structure of a van&nbsp;Emde&nbsp;Boas tree.
          A standalone triangle labeled <InlineLatex latex="VEB_u" /> is shown equivalent
          to a larger composite: a top triangle labeled <InlineLatex latex="VEB_{\sqrt{u}}" />{" "}
          and a horizontal array of smaller triangles at the base, each also{" "}
          <InlineLatex latex="VEB_{\sqrt{u}}" />. A brace under the bottom array indicates
          there are <InlineLatex latex="\sqrt{u}" /> such clusters.
        </p>
      </OutBody>
      <OutFooter>
        Screen readers get the full description. Sighted students get a <i>searchable</i> diagram caption.
      </OutFooter>
    </PanelShell>
  );
}

function CodePanel() {
  return (
    <PanelShell
      boardImage="/landing/code-demo.png"
      boardAlt="pred(V,x) pseudocode on the board"
      badge="MIT 6.851 · pred(V, x)"
      quote={<>Handwritten predecessor query</>}
    >
      <OutHeader kind="CODE" meta="extracted · copyable · typed" kindClass="code" />
      <OutBody>
        <pre
          className="m-0 px-4 py-3.5 rounded-lg overflow-x-auto text-[13px] leading-[1.55]"
          style={{
            background: "var(--chalk-bg)",
            color: "var(--chalk-fg)",
            fontFamily: "var(--font-mono)",
            border: "1px solid #ffffff10",
            whiteSpace: "pre",
          }}
        >
          {PSEUDOCODE}
        </pre>
      </OutBody>
      <OutFooter>
        Indented, copy-pasteable, language-tagged, cross-referenced to its timestamp.
      </OutFooter>
    </PanelShell>
  );
}

function TextPanel() {
  return (
    <PanelShell
      boardImage="/landing/text-demo.png"
      boardAlt="Warm-Up title, question, and bullet list on a whiteboard"
      badge="UC Berkeley CS 70 · Lec 1"
      quote={<>Warm-up title, question, and three bullets — transcribed verbatim.</>}
    >
      <OutHeader kind="TEXT" meta="headings · paragraphs · bullets" kindClass="text" />
      <OutBody>
        <div className="flex flex-col gap-2">
          <h4
            className="m-0 text-[20px]"
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontStyle: "italic",
              color: "var(--ink)",
            }}
          >
            Warm-Up
          </h4>
          <p
            className="m-0 text-[15px] leading-[1.55]"
            style={{ color: "#2a2a2a" }}
          >
            How would you know if any of these are true?
          </p>
          <ul className="m-0 pl-5 flex flex-col gap-1 text-[14.5px] leading-[1.6]" style={{ color: "#2a2a2a" }}>
            <li>There are infinitely many primes.</li>
            <li>
              Every even <InlineLatex latex="\#>2" /> is the sum of two primes.
            </li>
            <li>Your code never gets stuck in an infinite loop.</li>
          </ul>
        </div>
      </OutBody>
      <OutFooter>
        Structured <span style={{ fontFamily: "var(--font-mono)" }}>{"{heading, paragraph, bullet}"}</span> blocks — with nesting depth preserved and inline math rendered.
      </OutFooter>
    </PanelShell>
  );
}

function ChartPanel() {
  return (
    <PanelShell
      boardImage="/landing/chart-demo.png"
      boardAlt="Bar chart with seven categories"
      badge="Bar chart · sample"
      quote={<>Seven categories, one dominant peak — axes, values, and distribution captured in plain language.</>}
    >
      <OutHeader kind="CHART" meta="axes · ranges · regions" kindClass="chart" />
      <OutBody>
        <p className="m-0 text-[15px] leading-[1.6]" style={{ color: "#2a2a2a", textWrap: "pretty" }}>
          A line plot showing pressure versus temperature.{" "}
          <b>X-axis:</b> temperature <InlineLatex latex="T" /> in Kelvin, range{" "}
          <InlineLatex latex="0" /> to <InlineLatex latex="500" />.{" "}
          <b>Y-axis:</b> pressure <InlineLatex latex="P" /> in atm, range not labeled.{" "}
          <b>Data:</b> monotonically increasing curve consistent with{" "}
          <InlineLatex latex="P \propto T" />, with no phase transition visible.
        </p>
      </OutBody>
      <OutFooter>
        Every chart — bar, line, pie, Venn, phase diagram — reads as structured prose for screen readers.
      </OutFooter>
    </PanelShell>
  );
}

function TablePanel() {
  return (
    <PanelShell
      boardImage="/landing/table-demo.png"
      boardAlt="Scenario / Rabbits / Berries worked table"
      badge="Khan · scenarios table"
      quote={<>Hand-written columns — headers, row labels, and cells preserved as data.</>}
    >
      <OutHeader kind="TABLE" meta="headers · rows · cells" kindClass="table" />
      <OutBody align="top">
        <div
          className="rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--rule)" }}
        >
          <table className="w-full text-[13px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--paper-2)" }}>
                {["Scenario", "Rabbits", "Berries"].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-semibold"
                    style={{ color: "var(--ink)", borderBottom: "1px solid var(--rule)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["A", "5", "0"],
                ["B", "4", "100"],
                ["C", "3", "180"],
                ["D", "2", "240"],
                ["E", "1", "280"],
                ["F", "0", "300"],
              ].map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="px-3 py-2"
                      style={{
                        borderTop: i === 0 ? "none" : "1px solid var(--rule)",
                        color: j === 0 ? "var(--ink)" : "#2a2a2a",
                      }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="m-0 text-[12px] italic" style={{ color: "var(--muted-fg)" }}>
          Caption: six scenarios mapping rabbit count to available berries.
        </p>
      </OutBody>
      <OutFooter>
        Cells land as real data — sortable, searchable, copyable into a spreadsheet.
      </OutFooter>
    </PanelShell>
  );
}
