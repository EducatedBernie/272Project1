import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { sanitizeRunError } from "@/lib/run-error";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  const result = await getPool().query(
    `SELECT id, video_id, status, run_type, progress, pipeline_version,
            transcript_prompt_version, equations_prompt_version,
            visual_content_prompt_version, segment_count, equation_count,
            error, created_at
     FROM pipeline_runs WHERE id = $1`,
    [runId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const row = result.rows[0];
  if (["qa_adjudication", "generate_notes"].includes(row.run_type)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const { run_type: _runType, ...publicRow } = row;
  void _runType;

  return NextResponse.json({ ...publicRow, error: sanitizeRunError(publicRow.error) });
}
