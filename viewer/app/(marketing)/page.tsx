import TabbedProof from "@/components/landing/TabbedProof";
import DemoViewer from "@/components/landing/DemoViewer";
import HowItWorks from "@/components/landing/HowItWorks";
import Logo from "@/components/Logo";

export default function LandingPage() {
  return (
    <main id="main-content">
      <section
        className="px-6 md:px-10 pt-16 pb-5"
        style={{ background: "var(--paper)" }}
      >
        <div className="max-w-[1200px] mx-auto">
          <h1
            className="mb-5"
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(44px, 6.4vw, 88px)",
              lineHeight: 0.98,
              letterSpacing: "-0.022em",
              textWrap: "balance",
              maxWidth: "18ch",
              color: "var(--ink)",
            }}
          >
            Your lecture,{" "}
            <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>
              turned into study notes.
            </em>
          </h1>

          <p
            className="text-[18px] leading-[1.55]"
            style={{ color: "#2a2a2a", maxWidth: "64ch", textWrap: "pretty" }}
          >
            Learn from comprehensive explanations or switch to a condensed review.
            Keep equations, code, and original lecture diagrams alongside the ideas,
            with citations that take you back to the source.
          </p>

          <div className="mt-7 flex items-center gap-3 flex-wrap">
            <a
              href="/login"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[14px] font-semibold"
              style={{
                background: "var(--accent-2)",
                color: "#fff",
                boxShadow:
                  "0 1px 0 #ffffff7a inset, 0 14px 28px -16px color-mix(in srgb, var(--accent) 70%, #000), 0 0 0 1px color-mix(in srgb, var(--accent) 35%, #fff) inset",
                textShadow: "0 1px 1px #0006",
              }}
            >
              Create study notes <span aria-hidden="true">→</span>
            </a>
            <a
              href="https://calendar.app.google/vEWCoPkyxMN8ZUqp8"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-3 text-[14px] font-medium"
              style={{ color: "var(--ink)" }}
            >
              Book a meeting <span aria-hidden="true">↗</span>
            </a>
          </div>

          <ProofBadges />
        </div>
      </section>

      <TabbedProof />
      <DemoViewer />
      <HowItWorks />
      <section id="room" className="px-6 md:px-10 py-12" style={{ background: "var(--paper)" }}>
        <div className="max-w-[1200px] mx-auto">
          <h2 className="text-3xl mb-6" style={{ fontFamily: "var(--font-serif)" }}>One lecture. Two ways to study.</h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div><h3 className="text-xl mb-2">Comprehensive</h3><p>Follow the definitions, reasoning, and worked examples in a chapter you can study at your own pace.</p></div>
            <div><h3 className="text-xl mb-2">Condensed</h3><p>Revisit key concepts, equations, and takeaways when you need a quick review.</p></div>
          </div>
          <p className="mt-6 text-sm" style={{ color: "var(--muted-fg)" }}>Add a lecture, wait for extraction, then choose Generate notes with citations. AI can make mistakes; citations and original frames help you check the source.</p>
        </div>
      </section>

      <PageFooter />
    </main>
  );
}

// ── Hero proof-badges strip ────────────────────────────────────────────
// Hidden on mobile (eats too much vertical space above the fold).
// Desktop: inline strip, no chrome — the green dots provide enough visual rhythm.

function ProofBadges() {
  return (
    <div className="mt-6 hidden md:flex items-center gap-x-6 gap-y-2 flex-wrap">
      <Badge><b>Comprehensive + condensed</b></Badge>
      <Badge><b>Equations + original diagrams</b></Badge>
      <Badge><b>Source citations</b></Badge>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2.5 text-[11px] uppercase"
      style={{
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.08em",
        color: "var(--ink-2)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block rounded-full shrink-0"
        style={{ width: 6, height: 6, background: "#2f7d3e" }}
      />
      <span style={{ fontWeight: 500 }}>
        {children}
      </span>
    </span>
  );
}

// ── Page footer ────────────────────────────────────────────────────────

function PageFooter() {
  return (
    <footer
      className="px-6 md:px-10 pt-16 pb-8"
      style={{
        background: "var(--paper-2)",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 mb-10">
          <div className="col-span-2 md:col-span-1">
            <div className="mb-3">
              <Logo size="sm" />
            </div>
            <p
              className="m-0 text-[13.5px] leading-[1.55] max-w-[28ch]"
              style={{ color: "var(--muted-fg)", textWrap: "pretty" }}
            >
              Multimodal lecture notes for learning and review, with equations, original diagrams, code examples, and source citations.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={[
              { label: "Create study notes", href: "/login" },
              { label: "Outputs", href: "#outputs" },
              { label: "How it works", href: "#how" },
            ]}
          />
          <FooterCol
            title="Study"
            links={[
              { label: "Two notes layers", href: "#room" },
              { label: "Lecture library", href: "/dashboard" },
            ]}
          />
          <FooterCol
            title="Company"
            links={[
              { label: "hello@chalkboard.video", href: "mailto:hello@chalkboard.video" },
              { label: "Book a meeting", href: "https://calendar.app.google/vEWCoPkyxMN8ZUqp8", external: true },
            ]}
          />
        </div>

        <div
          className="flex items-center justify-between gap-5 flex-wrap pt-5 text-[12px]"
          style={{
            borderTop: "1px solid var(--rule)",
            fontFamily: "var(--font-mono)",
            color: "var(--muted-fg)",
          }}
        >
          <div>
            AI-generated study material. Check important details against the cited lecture sources.
          </div>
          <div>
            <span
              className="px-1.5 py-0.5 rounded"
              style={{ background: "#fff", border: "1px solid var(--rule)", color: "var(--ink-2)" }}
            >
              Study notes
            </span>{" "}
            · learn at your own pace
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}) {
  return (
    <div>
      <h4
        className="m-0 mb-3 text-[10.5px] uppercase"
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.14em",
          color: "var(--muted-fg)",
          fontWeight: 600,
        }}
      >
        {title}
      </h4>
      <ul className="flex flex-col gap-2 m-0 p-0 list-none">
        {links.map((l) => (
          <li key={l.label}>
            <a
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noopener noreferrer" : undefined}
              className="text-[13.5px]"
              style={{ color: "var(--ink-2)" }}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
