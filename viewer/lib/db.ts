import { Pool } from "pg";
import type { GeminiCallLogsManifest } from "./gemini-call-logs";
import { sanitizeRunError } from "./run-error";

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL must be set in production");
    }
    return "postgresql://chalkboard:localdev@localhost:5432/chalkboard";
  }
  return url;
}

// Lazy singleton pool — deferred instantiation so importing this module doesn't
// require DATABASE_URL at build time (Vercel's "Collecting page data" step
// imports every API route). Fails loudly at first query if misconfigured, same
// as before. globalThis cache preserves HMR survival in dev.
let _pool: Pool | undefined;

export function getPool(): Pool {
  if (_pool) return _pool;
  const g = globalThis as unknown as { __pgPool?: Pool };
  if (g.__pgPool) {
    _pool = g.__pgPool;
    return _pool;
  }
  _pool = new Pool({ connectionString: getConnectionString() });
  if (process.env.NODE_ENV !== "production") g.__pgPool = _pool;
  return _pool;
}

export interface TranscriptRow {
  segment_id: string;
  text: string;
  segment_start: number;
  segment_end: number;
  latex_string: string | null;
  equation_description: string | null;
  confidence: number | null;
  equation_id: string | null;
}

export interface VideoRow {
  id: string;
  title: string;
  youtube_url: string;
  duration: number;
  source_type: string;
  r2_key: string | null;
  r2_url: string | null;
}

export async function getVideo(id: string): Promise<VideoRow | null> {
  const result = await getPool().query(
    "SELECT id, title, youtube_url, duration, source_type, r2_key, r2_url FROM videos WHERE id = $1",
    [id]
  );
  return result.rows[0] || null;
}

export interface EquationRow {
  id: string;
  latex_string: string;
  description: string;
  confidence: number;
  timestamp_start: number;
  timestamp_end: number;
}

export async function getEquations(videoId: string, runId?: string): Promise<EquationRow[]> {
  if (runId) {
    const result = await getPool().query(
      `SELECT id, latex_string, description, confidence, timestamp_start, timestamp_end
       FROM equations
       WHERE video_id = $1 AND run_id = $2
       ORDER BY timestamp_start`,
      [videoId, runId]
    );
    return result.rows;
  }
  const result = await getPool().query(
    `SELECT id, latex_string, description, confidence, timestamp_start, timestamp_end
     FROM equations
     WHERE video_id = $1
     ORDER BY timestamp_start`,
    [videoId]
  );
  return result.rows;
}

export async function getTranscriptWithEquations(
  videoId: string,
  runId?: string
): Promise<TranscriptRow[]> {
  if (runId) {
    const result = await getPool().query(
      `SELECT
         s.id as segment_id,
         s.text,
         s.timestamp_start as segment_start,
         s.timestamp_end as segment_end,
         e.latex_string,
         e.description as equation_description,
         e.confidence,
         e.id as equation_id
       FROM transcript_segments s
       LEFT JOIN segment_equations se ON se.segment_id = s.id
       LEFT JOIN equations e ON e.id = se.equation_id
       WHERE s.video_id = $1 AND s.run_id = $2
       ORDER BY s.timestamp_start, se.position`,
      [videoId, runId]
    );
    return result.rows;
  }
  const result = await getPool().query(
    `SELECT
       s.id as segment_id,
       s.text,
       s.timestamp_start as segment_start,
       s.timestamp_end as segment_end,
       e.latex_string,
       e.description as equation_description,
       e.confidence,
       e.id as equation_id
     FROM transcript_segments s
     LEFT JOIN segment_equations se ON se.segment_id = s.id
     LEFT JOIN equations e ON e.id = se.equation_id
     WHERE s.video_id = $1
     ORDER BY s.timestamp_start, se.position`,
    [videoId]
  );
  return result.rows;
}

export interface AutoCaption {
  start: number;
  end: number;
  text: string;
}

export interface RunRow {
  id: string;
  run_type?: string | null;
  status: string;
  progress: Record<string, unknown>;
  pipeline_version: string;
  transcript_prompt_version: string | null;
  equations_prompt_version: string | null;
  visual_content_prompt_version: string | null;
  segment_count: number | null;
  equation_count: number | null;
  sections: { start_time: string; end_time?: string; title: string; description: string }[] | null;
  gemini_call_logs: GeminiCallLogsManifest | null;
  auto_captions: AutoCaption[] | null;
  error: string | null;
  created_at: string;
}

export type PublicRunRow = Omit<RunRow, "gemini_call_logs" | "auto_captions">;

function isMissingColumnError(error: unknown, column: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42703" &&
    String((error as { message?: unknown }).message || "").includes(column)
  );
}

export async function getRunsForVideo(videoId: string): Promise<RunRow[]> {
  try {
    const result = await getPool().query(
      `SELECT id, run_type, status, progress, pipeline_version,
              transcript_prompt_version, equations_prompt_version,
              visual_content_prompt_version,
              segment_count, equation_count, sections, gemini_call_logs,
              auto_captions, error, created_at
       FROM pipeline_runs
       WHERE video_id = $1
         AND COALESCE(run_type, 'process') NOT IN ('qa_adjudication', 'generate_notes')
       ORDER BY created_at DESC`,
      [videoId]
    );
    return result.rows;
  } catch (error) {
    if (!isMissingColumnError(error, "gemini_call_logs")) throw error;
    const result = await getPool().query(
      `SELECT id, run_type, status, progress, pipeline_version,
              transcript_prompt_version, equations_prompt_version,
              visual_content_prompt_version,
              segment_count, equation_count, sections,
              auto_captions, error, created_at
       FROM pipeline_runs
       WHERE video_id = $1
         AND COALESCE(run_type, 'process') NOT IN ('qa_adjudication', 'generate_notes')
       ORDER BY created_at DESC`,
      [videoId]
    );
    return result.rows.map((row) => ({ ...row, gemini_call_logs: null }));
  }
}

export async function getPublicRunsForVideo(videoId: string): Promise<PublicRunRow[]> {
  const result = await getPool().query(
    `SELECT id, run_type, status, progress, pipeline_version,
            transcript_prompt_version, equations_prompt_version,
            visual_content_prompt_version,
            segment_count, equation_count, sections, error, created_at
     FROM pipeline_runs
     WHERE video_id = $1
       AND COALESCE(run_type, 'process') NOT IN ('qa_adjudication', 'generate_notes')
     ORDER BY created_at DESC`,
    [videoId]
  );
  return result.rows.map((row) => ({
    ...row,
    error: sanitizeRunError(row.error),
  }));
}

/**
 * Fetch YouTube/Chirp auto-captions for a video. Looks up the most recent
 * complete `process` run with a non-null auto_captions field — scoped
 * re-extraction runs leave that field null by design, so we always trace
 * back to the parent run that originally downloaded the SRT.
 *
 * Used by the debug page's SyncedTranscripts panel. Returns [] if no
 * complete process run has captions yet (legacy pre-PR3 runs).
 */
export async function getAutoCaptions(videoId: string): Promise<AutoCaption[]> {
  const result = await getPool().query(
    `SELECT auto_captions FROM pipeline_runs
     WHERE video_id = $1
       AND status = 'complete'
       AND run_type = 'process'
       AND auto_captions IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [videoId]
  );
  return result.rows[0]?.auto_captions || [];
}

export interface VisualContentRow {
  id: string;
  content_type: string;
  latex_string: string;
  description: string;
  confidence: number;
  timestamp_start: number;
  timestamp_end: number;
  content_metadata: Record<string, unknown> | null;
}

export async function getVisualContent(videoId: string, runId?: string): Promise<VisualContentRow[]> {
  if (runId) {
    const result = await getPool().query(
      `SELECT id, content_type, latex_string, description, confidence,
              timestamp_start, timestamp_end, content_metadata
       FROM equations
       WHERE video_id = $1 AND run_id = $2
       ORDER BY timestamp_start`,
      [videoId, runId]
    );
    return result.rows;
  }
  const result = await getPool().query(
    `SELECT id, content_type, latex_string, description, confidence,
            timestamp_start, timestamp_end, content_metadata
     FROM equations
     WHERE video_id = $1
     ORDER BY timestamp_start`,
    [videoId]
  );
  return result.rows;
}

export async function getLatestRunId(videoId: string): Promise<string | null> {
  const result = await getPool().query(
    `SELECT id FROM pipeline_runs
     WHERE video_id = $1
       AND status = 'complete'
       AND COALESCE(run_type, 'process') NOT IN ('qa_adjudication', 'generate_notes')
     ORDER BY created_at DESC LIMIT 1`,
    [videoId]
  );
  return result.rows[0]?.id || null;
}
