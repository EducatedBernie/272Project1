import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * POST /api/runs/<id>/cancel
 *
 * Sets cancel_requested = true if the run is still cancellable. The worker
 * picks this up at the next stage transition (inside `_update_run_progress`)
 * and exits cleanly with status=failed, error="Cancelled by user".
 *
 * Cancellation is checkpoint-based, not preemptive: a long Gemini call won't
 * be interrupted, but the next stage transition will catch it. Worst case:
 * up to ~90 seconds (one Gemini call per section) before the cancel takes
 * effect.
 *
 * Auth: gated by middleware (the public /api/runs/<id> carve-out is
 * GET-only on the single-id path; this sub-route is always auth-required).
 *
 * Why POST not DELETE: we're flipping a flag, not deleting the run record.
 * The row stays in pipeline_runs with status=failed for history.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  // Also patch progress.stage so the dashboard reflects the cancel intent
  // on its next poll (within ~3s) — without this the run continues to
  // display its in-flight stage until the worker hits the next checkpoint,
  // which can be 90+ seconds during a long Gemini call.
  const result = await getPool().query(
    `UPDATE pipeline_runs
     SET cancel_requested = true,
         progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('stage', 'Cancelling…')
     WHERE id = $1
       AND status NOT IN ('complete', 'failed')
     RETURNING id, status`,
    [runId]
  );

  if (result.rowCount === 1) {
    return NextResponse.json({
      cancelled: true,
      run_id: result.rows[0].id,
      status: result.rows[0].status,
    });
  }

  // Either the row doesn't exist or it's already terminal — distinguish.
  const existing = await getPool().query(
    `SELECT status FROM pipeline_runs WHERE id = $1`,
    [runId]
  );

  if (existing.rows.length === 0) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json(
    { error: "Run already terminal", status: existing.rows[0].status },
    { status: 409 }
  );
}
