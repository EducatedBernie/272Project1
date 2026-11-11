import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { modelOverride } from "@/lib/model-config";

export async function POST(req: NextRequest) {
  const { video_id, run_id, section_index, start_time, end_time, section_title, context, model, fps } = await req.json();

  if (!video_id || section_index == null || start_time == null || end_time == null) {
    return NextResponse.json({ error: "video_id, section_index, start_time, end_time required" }, { status: 400 });
  }

  // Get the video's source identifiers. youtube_url holds the YouTube URL for
  // YouTube videos and the R2 public URL for uploads (legacy column overload).
  // r2_key is the authoritative signal that this is an upload — when set, the
  // pipeline re-downloads from R2 and re-presents the bytes to Gemini's Files
  // API on each reprocess (R2 public URLs are not accepted by Gemini FileData).
  const videoResult = await getPool().query(
    "SELECT youtube_url, r2_key FROM videos WHERE id = $1",
    [video_id]
  );
  if (videoResult.rows.length === 0) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
  const { youtube_url, r2_key } = videoResult.rows[0];

  const isVisualOnly = section_index === -1;
  const runType = isVisualOnly ? "reprocess_visual" : "reprocess_section";

  const params: Record<string, unknown> = {
    youtube_url,
    r2_key,
    video_id,
    start_time,
    end_time,
    section_title: section_title || "Section",
    context: context || "",
    ...modelOverride(model),
    fps: fps ?? 0.5,
  };

  if (!isVisualOnly) {
    params.section_index = section_index;
  } else {
    params.scope = "item";
  }

  if (run_id) {
    params.run_id = run_id;
  }

  // Create a queued run — the worker picks it up
  const runResult = await getPool().query(
    `INSERT INTO pipeline_runs (id, video_id, status, run_type, params, pipeline_version, progress, created_at)
     VALUES (gen_random_uuid(), $1, 'queued', $2,
             $3::jsonb, 'v2', '{}', NOW())
     RETURNING id`,
    [video_id, runType, JSON.stringify(params)]
  );

  const newRunId = runResult.rows[0].id;
  return NextResponse.json({ queued: true, run_id: newRunId, video_id, section_index });
}
