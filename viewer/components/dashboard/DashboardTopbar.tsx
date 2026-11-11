import Link from "next/link";
import Logo from "@/components/Logo";

export default function DashboardTopbar() {
  return (
    <header
      className="sticky top-0 z-30"
      style={{
        background: "color-mix(in srgb, var(--paper) 90%, transparent)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-3.5 flex items-center gap-2.5">
        <Link href="/" aria-label="Chalkboard home" className="flex items-center">
          <Logo size="sm" />
        </Link>
        <span className="font-normal" style={{ color: "var(--muted-fg)" }} aria-hidden="true">›</span>
        <span
          className="text-[13px] font-medium"
          style={{ color: "var(--ink-2)" }}
          aria-current="page"
        >
          Dashboard
        </span>
      </div>
    </header>
  );
}
