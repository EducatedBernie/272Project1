import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * GET /api/stats/monthly
 *
 * Derivable "This month" stats for the dashboard right rail. 30-day rolling
 * window. Gated by middleware like the rest of /api/*.
 */
export async function GET() {
  const pool = getPool();
  const [videosRes, runsRes, eqRes] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS lectures_processed,
             COALESCE(SUM(duration), 0)::int AS total_runtime_seconds
      FROM videos
      WHERE created_at > NOW() - INTERVAL '30 days'
    `),
    pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (heartbeat_at - started_at)))::int AS avg_run_seconds
      FROM pipeline_runs
      WHERE status = 'complete'
        AND COALESCE(run_type, 'process') != 'generate_notes'
        AND started_at IS NOT NULL
        AND heartbeat_at IS NOT NULL
        AND created_at > NOW() - INTERVAL '30 days'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS equations_count
      FROM equations e
      JOIN videos v ON v.id = e.video_id
      WHERE v.created_at > NOW() - INTERVAL '30 days'
    `),
  ]);
  return NextResponse.json({
    lectures_processed: videosRes.rows[0]?.lectures_processed ?? 0,
    total_runtime_seconds: videosRes.rows[0]?.total_runtime_seconds ?? 0,
    equations_count: eqRes.rows[0]?.equations_count ?? 0,
    avg_run_seconds: runsRes.rows[0]?.avg_run_seconds ?? 0,
  });
}
