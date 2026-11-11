import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function GET() {
  const result = await getPool().query(`
    SELECT
      v.id, v.title, v.youtube_url, v.duration, v.status, v.created_at,
      (SELECT COUNT(*) FROM transcript_segments WHERE video_id = v.id) as segment_count,
      (SELECT COUNT(*) FROM equations WHERE video_id = v.id) as equation_count,
      (SELECT COUNT(*) FROM pipeline_runs WHERE video_id = v.id AND COALESCE(run_type, 'process') != 'generate_notes') as run_count,
      (SELECT status FROM pipeline_runs WHERE video_id = v.id AND COALESCE(run_type, 'process') != 'generate_notes' ORDER BY created_at DESC LIMIT 1) as latest_run_status,
      (SELECT id FROM pipeline_runs WHERE video_id = v.id AND COALESCE(run_type, 'process') != 'generate_notes' ORDER BY created_at DESC LIMIT 1) as latest_run_id,
      (SELECT error FROM pipeline_runs WHERE video_id = v.id AND COALESCE(run_type, 'process') != 'generate_notes' ORDER BY created_at DESC LIMIT 1) as latest_run_error
    FROM videos v
    ORDER BY v.created_at DESC
  `);
  return NextResponse.json(result.rows);
}
