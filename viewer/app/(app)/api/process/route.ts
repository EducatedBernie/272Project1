import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { canonicalizeYouTubeUrl } from "@/lib/youtube-url";

export async function POST(req: NextRequest) {
  const { youtube_url, title } = await req.json();

  if (!youtube_url) {
    return NextResponse.json({ error: "youtube_url is required" }, { status: 400 });
  }

  const rawSource = String(youtube_url).trim();
  if (!rawSource) {
    return NextResponse.json({ error: "youtube_url is required" }, { status: 400 });
  }
  const canonicalSource = canonicalizeYouTubeUrl(rawSource) ?? rawSource;

  // Initial videos.title falls back to URL so the library card shows
  // *something* between enqueue and worker completion. The worker overwrites
  // this with the real YouTube title (probed via yt-dlp) once known. See
  // pipeline/scripts/process_video_v2.py:get_video_metadata.
  const videoTitle = title || canonicalSource;

  // Atomic find-or-create — UNIQUE constraint on youtube_url prevents duplicates
  const videoResult = await getPool().query(
    `INSERT INTO videos (id, title, youtube_url, duration, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, 0, 'queued', NOW())
     ON CONFLICT (youtube_url) DO UPDATE SET youtube_url = EXCLUDED.youtube_url
     RETURNING id`,
    [videoTitle, canonicalSource]
  );
  const video_id = videoResult.rows[0].id;

  // params.title stays null when the user didn't supply one — that signals
  // to the pipeline that it should probe yt-dlp for the real title, instead
  // of inheriting the URL fallback we used for videos.title above.
  const runResult = await getPool().query(
    `INSERT INTO pipeline_runs (id, video_id, status, run_type, params, pipeline_version, progress, created_at)
     VALUES (gen_random_uuid(), $1, 'queued', 'process',
             $2::jsonb, 'v2', '{}', NOW())
     RETURNING id`,
    [
      video_id,
      JSON.stringify({
        source: canonicalSource,
        title: title || null,
        ...(rawSource !== canonicalSource ? { raw_source: rawSource } : {}),
      }),
    ]
  );

  const run_id = runResult.rows[0].id;
  return NextResponse.json({ queued: true, run_id, video_id });
}
