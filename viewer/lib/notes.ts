import { getPool } from "./db";
import type { NotesJob } from "./notes-types";

const JOB_COLUMNS = "id, status, progress, notes, error, created_at, params->>'source_run_id' AS source_run_id";

export class NotesRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseNotesRequest(body: unknown): { video_id: string; source_run_id: string } {
  if (!body || typeof body !== "object" || !("video_id" in body) || !("source_run_id" in body)
      || !isUuid(body.video_id) || !isUuid(body.source_run_id)) {
    throw new NotesRequestError("video_id and source_run_id must be valid UUIDs", 400);
  }
  return { video_id: body.video_id.toLowerCase(), source_run_id: body.source_run_id.toLowerCase() };
}

function publicJob(row: NotesJob): NotesJob {
  // Provider exceptions may contain request material. Keep diagnostics in the protected run view.
  return { ...row, error: row.status === "failed" ? "Notes could not be generated. Please try again." : null };
}

export async function getNotesJob(id: string): Promise<NotesJob | null> {
  const result = await getPool().query(
    `SELECT ${JOB_COLUMNS} FROM pipeline_runs WHERE id=$1 AND run_type='generate_notes'`, [id],
  );
  return result.rows[0] ? publicJob(result.rows[0]) : null;
}

export async function getNotesForSource(videoId: string, sourceRunId: string): Promise<NotesJob | null> {
  const result = await getPool().query(
    `SELECT ${JOB_COLUMNS} FROM pipeline_runs
     WHERE video_id=$1 AND run_type='generate_notes' AND params->>'source_run_id'=$2
     ORDER BY (status != 'failed') DESC, created_at DESC LIMIT 1`, [videoId, sourceRunId],
  );
  return result.rows[0] ? publicJob(result.rows[0]) : null;
}

export async function getNotesSourceRun(videoId: string, sourceRunId?: string): Promise<{ id: string } | null> {
  const result = await getPool().query(
    `SELECT r.id FROM pipeline_runs r
     WHERE r.video_id=$1 AND r.status='complete'
       AND COALESCE(r.run_type,'process') IN ('process','reprocess')
       AND COALESCE(r.progress->>'scope','') NOT IN ('section','item')
       AND ($2::uuid IS NULL OR r.id=$2)
       AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.run_id=r.id AND s.video_id=r.video_id)
     ORDER BY r.created_at DESC LIMIT 1`, [videoId, sourceRunId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function enqueueNotes(videoId: string, sourceRunId: string): Promise<NotesJob> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize requests for this source so repeated clicks/tabs reuse the same job.
    const source = await client.query(
      `SELECT r.status, r.run_type, r.progress,
         EXISTS (SELECT 1 FROM transcript_segments s WHERE s.run_id=r.id AND s.video_id=r.video_id) AS has_transcript
       FROM pipeline_runs r WHERE r.id=$1 AND r.video_id=$2 FOR UPDATE`, [sourceRunId, videoId],
    );
    const row = source.rows[0];
    if (!row) throw new NotesRequestError("Lecture extraction not found", 404);
    if (row.status !== "complete" || ![null, "process", "reprocess"].includes(row.run_type)
        || ["section", "item"].includes(row.progress?.scope)) {
      throw new NotesRequestError("Choose a completed full lecture extraction to generate notes.", 409);
    }
    if (!row.has_transcript) throw new NotesRequestError("This extraction has no transcript to generate notes from.", 409);

    const existing = await client.query(
      `SELECT ${JOB_COLUMNS} FROM pipeline_runs WHERE video_id=$1
       AND run_type='generate_notes' AND params->>'source_run_id'=$2 AND status != 'failed'
       ORDER BY created_at DESC LIMIT 1`, [videoId, sourceRunId],
    );
    let job = existing.rows[0];
    if (!job) {
      const inserted = await client.query(
        `INSERT INTO pipeline_runs (id,video_id,status,run_type,params,pipeline_version,progress,created_at)
         VALUES (gen_random_uuid(),$1,'queued','generate_notes',$2::jsonb,'notes-v1',
                 '{"stage":"Waiting to generate notes"}'::jsonb,NOW())
         RETURNING ${JOB_COLUMNS}`, [videoId, JSON.stringify({ source_run_id: sourceRunId })],
      );
      job = inserted.rows[0];
    }
    await client.query("COMMIT");
    return publicJob(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
