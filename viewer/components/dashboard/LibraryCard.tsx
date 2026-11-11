import Link from "next/link";

export interface VideoSummary {
  id: string;
  title: string;
  youtube_url: string | null;
  duration: number;
  status: string;
  created_at: string;
  segment_count: number;
  equation_count: number;
  run_count: number;
  latest_run_status: string | null;
  latest_run_id: string | null;
  latest_run_error: string | null;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function relativeTime(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function youtubeIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function thumbUrl(video: VideoSummary): string | null {
  const yt = youtubeIdFromUrl(video.youtube_url);
  if (yt) return `https://img.youtube.com/vi/${yt}/mqdefault.jpg`;
  return `/api/thumbnail?video_id=${video.id}`;
}

type RunBadge = { tone: "failed" | "processing"; label: string } | null;

function runBadge(video: VideoSummary): RunBadge {
  // Only flag the badge while the video has a "live" run that doesn't match
  // the steady "complete" state. We treat anything that isn't queued/failed as
  // an in-flight stage (captions/topic_map/sections/alignment/saving).
  const s = video.latest_run_status;
  if (!s || s === "complete") return null;
  if (s === "failed") return { tone: "failed", label: "failed" };
  if (s === "queued") return { tone: "processing", label: "queued" };
  return { tone: "processing", label: "processing" };
}

export default function LibraryCard({ video }: { video: VideoSummary }) {
  const thumb = thumbUrl(video);
  const badge = runBadge(video);
  return (
    <Link
      href={video.latest_run_status === "complete" ? `/video/${video.id}/notes` : `/video/${video.id}`}
      className="flex flex-col rounded-xl overflow-hidden transition-transform duration-150 hover:-translate-y-0.5"
      style={{
        background: "#fff",
        border: badge?.tone === "failed"
          ? "1px solid color-mix(in srgb, var(--err) 40%, var(--rule))"
          : "1px solid var(--rule)",
      }}
    >
      <div
        className="relative aspect-video"
        style={{ background: "#0f0f0f" }}
      >
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        {badge && (
          <span
            className="absolute top-1.5 left-1.5 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full"
            style={{
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              background: badge.tone === "failed" ? "var(--err-soft)" : "var(--blue-soft)",
              color: badge.tone === "failed" ? "var(--err)" : "var(--blue)",
            }}
            title={
              badge.tone === "failed" && video.latest_run_error
                ? video.latest_run_error
                : undefined
            }
          >
            {badge.label}
          </span>
        )}
        <span
          className="absolute bottom-1.5 right-1.5 text-[10.5px] px-1.5 py-0.5 rounded"
          style={{
            fontFamily: "var(--font-mono)",
            background: "#000c",
            color: "#fff",
          }}
        >
          {formatDuration(video.duration)}
        </span>
      </div>
      <div className="px-3.5 py-3 flex flex-col gap-1.5">
        <div
          className="text-[14px] font-semibold leading-tight"
          style={{
            color: "var(--ink)",
            letterSpacing: "-0.005em",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            minHeight: 34,
          }}
        >
          {video.title || "Untitled lecture"}
        </div>
        <div
          className="flex gap-2.5 text-[10.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--muted-fg)" }}
        >
          <span>
            <span
              aria-hidden="true"
              className="inline-block mr-1 align-middle"
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: "var(--accent-2)",
              }}
            />
            {video.equation_count}
          </span>
          <span style={{ marginLeft: "auto" }}>{relativeTime(video.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}
