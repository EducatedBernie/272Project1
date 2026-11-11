import Logo from "@/components/Logo";
import Link from "next/link";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "var(--background)" }}>
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[60] -translate-y-20 rounded-md px-4 py-2 text-sm font-semibold transition-transform focus:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          background: "var(--ink)",
          color: "var(--paper)",
          outlineColor: "var(--accent)",
        }}
      >
        Skip to main content
      </a>
      <nav
        className="sticky top-0 z-50 px-6 py-3 flex items-center justify-between"
        style={{
          background: "color-mix(in srgb, var(--background) 85%, transparent)",
          borderBottom: "1px solid var(--border)",
          backdropFilter: "blur(10px)",
        }}
      >
        <Link href="/" className="flex items-center gap-2">
          <span className="sm:hidden"><Logo size="sm" showText={false} /></span>
          <span className="hidden sm:block"><Logo size="sm" /></span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-6">
          <a
            href="#room"
            className="text-sm hidden sm:block"
            style={{ color: "var(--muted-fg)" }}
          >
            Study notes
          </a>
          <Link
            href="/login"
            className="text-sm font-semibold px-3.5 py-2 rounded-lg transition-transform hover:-translate-y-0.5"
            style={{
              color: "#fff",
              background: "var(--accent-2)",
              boxShadow:
                "0 1px 0 #ffffff7a inset, 0 10px 22px -12px color-mix(in srgb, var(--accent) 70%, #000), 0 0 0 1px color-mix(in srgb, var(--accent) 35%, #fff) inset",
              textShadow: "0 1px 1px #0006",
            }}
          >
            Create study notes
          </Link>
          <a
            href="https://calendar.app.google/vEWCoPkyxMN8ZUqp8"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold px-3.5 py-2 rounded-lg transition-colors"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            Book a meeting <span aria-hidden="true">→</span>
          </a>
        </div>
      </nav>

      {children}
    </div>
  );
}
