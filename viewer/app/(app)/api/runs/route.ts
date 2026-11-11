import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * GET /api/runs?status=active
 *
 * Returns recent non-terminal runs and recent failures (last 24h), joined
 * with the video title. Used by QueueStrip on /dashboard for cross-video
 * queue visibility.
 *
 * Auth: gated by middleware (the public /api/runs/<id> carve-out only
 * matches the single-id GET pattern; this listing endpoint requires auth).
 *
 * 24h cap so the strip doesn't slowly accumulate ancient failures. LEFT
 * JOIN because reprocess runs may briefly reference a video being deleted.
 */
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");

  // Currently only "active" is supported — any other value returns empty.
  // Keeps the surface tight; we can extend later if needed.
  if (status !== "active") {
    return NextResponse.json([]);
  }

  const result = await getPool().query(`
    SELECT
      pr.id,
      pr.run_type,
      pr.params->>'source_run_id' AS source_run_id,
      pr.status,
      pr.progress,
      pr.created_at,
      pr.error,
      pr.cancel_requested,
      pr.video_id,
      v.title,
      v.youtube_url
    FROM pipeline_runs pr
    LEFT JOIN videos v ON v.id = pr.video_id
    WHERE pr.status != 'complete'
      AND pr.created_at > NOW() - INTERVAL '24 hours'
    ORDER BY pr.created_at DESC
    LIMIT 50
  `);

  return NextResponse.json(result.rows);
}
