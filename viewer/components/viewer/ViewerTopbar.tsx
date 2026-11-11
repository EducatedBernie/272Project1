"use client";

import Link from "next/link";
import Logo from "@/components/Logo";
import type { VisualContent } from "@/lib/types";

function countByType(visuals: VisualContent[]) {
  let eq = 0,
    dia = 0,
    code = 0,
    other = 0;
  for (const v of visuals) {
    if (v.contentType === "equation") eq++;
    else if (v.contentType === "diagram_description" || v.contentType === "chart_description") dia++;
    else if (v.contentType === "code") code++;
    else other++;
  }
  return { eq, dia, code, other };
}

function formatDuration(totalSeconds: number): string {
  const m = Math.round(totalSeconds / 60);
  return `${m} min`;
}

export interface ViewerTopbarProps {
  title: string;
  visuals: VisualContent[];
  durationSeconds: number;
  backHref?: string;
  backLabel?: string;
  backActionLabel?: string;
  primaryActionLabel?: string;
  notesHref?: string | null;
  children?: React.ReactNode;
}

export default function ViewerTopbar({
  title,
  visuals,
  durationSeconds,
  backHref = "/dashboard",
  backLabel = "Back to dashboard",
  backActionLabel = "Dashboard",
  primaryActionLabel = "Process new video",
  notesHref,
  children,
}: ViewerTopbarProps) {
  const counts = countByType(visuals);
  return (
    <header
      className="shrink-0"
      style={{
        background: "var(--card)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="px-4 md:px-5 py-2.5 flex items-center gap-3 min-w-0">
        <Link href={backHref} aria-label={backLabel} className="shrink-0 inline-flex">
          <Logo size="sm" showText={false} />
        </Link>

        <Link
          href={backHref}
          className="hidden md:inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap"
          style={{
            color: "var(--foreground)",
            background: "transparent",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {backActionLabel}
        </Link>

        <span className="hidden md:inline h-5 w-px shrink-0" style={{ background: "var(--border)" }} />

        <h1
          className="text-[14px] truncate min-w-0 flex-1"
          style={{ fontFamily: "var(--font-sans)", color: "var(--foreground)" }}
        >
          {title}
        </h1>

        {notesHref && (
          <Link
            href={notesHref}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: "var(--accent-2)", color: "#fff", outlineColor: "var(--accent-2)" }}
          >
            Notes view
          </Link>
        )}

        <Link
          href={backHref}
          aria-label={primaryActionLabel}
          className="hidden sm:inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold whitespace-nowrap"
          style={{
            color: "var(--paper)",
            background: "var(--ink)",
            border: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              fontSize: 19,
              lineHeight: 1,
              fontWeight: 300,
            }}
          >
            +
          </span>
          {primaryActionLabel}
        </Link>
      </div>

      <div
        className="hidden md:flex items-center justify-between gap-4 px-4 md:px-5 py-2"
        style={{
          background: "color-mix(in srgb, var(--paper-2) 55%, var(--card))",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatPill>{formatDuration(durationSeconds)}</StatPill>
          <StatPill>{counts.eq} eq</StatPill>
          <StatPill>{counts.dia} dia</StatPill>
          <StatPill>{counts.code} code</StatPill>
        </div>

        <div className="flex items-center gap-2 shrink-0">{children}</div>
      </div>
    </header>
  );
}

function StatPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-md px-3 py-1 text-[11px] whitespace-nowrap"
      style={{
        fontFamily: "var(--font-mono)",
        color: "var(--muted-fg)",
        background: "var(--paper-2)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </span>
  );
}
