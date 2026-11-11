import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { buildFullReprocessParams } from "@/lib/reprocess-params";

export async function POST(req: NextRequest) {
  const { video_id } = await req.json();

  if (!video_id) {
    return NextResponse.json({ error: "video_id is required" }, { status: 400 });
  }

  // Get the video's source identifiers. `youtube_url` is overloaded for
  // uploads: it stores the public playback URL, while `r2_key` is the worker's
  // authoritative source path.
  const videoResult = await getPool().query(
    "SELECT youtube_url, title, r2_key, r2_url FROM videos WHERE id = $1",
    [video_id]
  );
  if (videoResult.rows.length === 0) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }

  const video = videoResult.rows[0];
  const params = buildFullReprocessParams(video);
  if (!video.r2_key && params.source !== video.youtube_url) {
    await getPool().query(
      "UPDATE videos SET youtube_url = $2 WHERE id = $1",
      [video_id, params.source]
    );
  }

  // Create a queued run — the worker picks it up
  const runResult = await getPool().query(
    `INSERT INTO pipeline_runs (id, video_id, status, run_type, params, pipeline_version, progress, created_at)
     VALUES (gen_random_uuid(), $1, 'queued', 'reprocess',
             $2::jsonb, 'v2', '{}', NOW())
     RETURNING id`,
    [
      video_id,
      JSON.stringify(params),
    ]
  );

  const runId = runResult.rows[0].id;
  return NextResponse.json({ queued: true, run_id: runId });
}
