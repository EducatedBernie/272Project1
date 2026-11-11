import type { TranscriptRow, EquationRow, VisualContentRow } from "./db";
import type { Segment, Equation, VisualContent, TextBlock, RepairStatus } from "./types";

/**
 * Transform flat DB rows into deduplicated Segment objects (no equations).
 */
export function rowsToSegments(rows: TranscriptRow[]): Segment[] {
  const segmentMap = new Map<string, Segment>();

  for (const row of rows) {
    if (!segmentMap.has(row.segment_id)) {
      segmentMap.set(row.segment_id, {
        id: row.segment_id,
        text: row.text,
        start: Number(row.segment_start),
        end: Number(row.segment_end),
      });
    }
  }

  return Array.from(segmentMap.values());
}

/**
 * Transform equation DB rows into Equation objects.
 */
export function rowsToEquations(rows: EquationRow[]): Equation[] {
  return rows.map((row) => ({
    id: row.id,
    latex: row.latex_string,
    description: row.description,
    confidence: Number(row.confidence),
    start: Number(row.timestamp_start),
    end: Number(row.timestamp_end),
  }));
}

export function rowsToVisualContent(rows: VisualContentRow[]): VisualContent[] {
  return rows.map((row) => {
    const meta = row.content_metadata || {};
    const rawRepair = meta.repair_status;
    const repairStatus: RepairStatus | undefined =
      rawRepair === "fixed" || rawRepair === "skipped" ? rawRepair : undefined;
    return {
      id: row.id,
      contentType: row.content_type || "equation",
      description: row.description,
      confidence: Number(row.confidence),
      start: Number(row.timestamp_start),
      end: Number(row.timestamp_end),
      latex: row.latex_string || undefined,
      code: (meta.code as string) || undefined,
      language: (meta.language as string) || undefined,
      purpose: (meta.purpose as string) || undefined,
      structure: (meta.structure as string[]) || undefined,
      headers: (meta.headers as string[]) || undefined,
      rows: (meta.rows as string[][]) || undefined,
      title: (meta.title as string) || undefined,
      caption: (meta.caption as string) || undefined,
      // Pipeline writes camelCase; accept snake_case for back-compat with any
      // pre-migration rows that used Python's field name directly.
      textBlocks:
        (meta.textBlocks as TextBlock[]) ||
        (meta.text_blocks as TextBlock[]) ||
        undefined,
      visualObservation:
        (meta.visualObservation as string) ||
        (meta.visual_observation as string) ||
        undefined,
      repairStatus,
    };
  });
}
