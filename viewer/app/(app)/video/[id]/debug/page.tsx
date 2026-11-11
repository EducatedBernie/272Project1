import { notFound } from "next/navigation";
import { getVideo, getVisualContent, getRunsForVideo, getLatestRunId, getAutoCaptions } from "@/lib/db";
import { rowsToVisualContent } from "@/lib/transform";
import DebugView from "@/components/DebugView";
import { getVideoSource, extractYouTubeId } from "@/lib/video-source";
import { getPool } from "@/lib/db";
import { selectAlignmentMeta, type AlignmentMeta } from "@/lib/alignment-meta";
import { selectUsageSummary } from "@/lib/usage";
import { selectGeminiCallLogs } from "@/lib/gemini-call-logs";

interface DemoData {
  segments: { id: string; text: string; start: number; end: number }[];
  autoCaptions: { start: number; end: number; text: string }[];
  sections: { start_time: string; end_time?: string; title: string; description: string }[];
  visualContent?: { id: string; contentType: string; description: string; confidence: number; start: number; end: number; latex?: string }[];
  alignmentMeta?: AlignmentMeta;
  duration: number;
}

async function getDemoJson(videoId: string): Promise<DemoData | null> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const filePath = path.join(process.cwd(), "public", "demo", `${videoId}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export default async function DebugPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string; t?: string }>;
}) {
  const { id } = await params;
  const { run: runIdParam, t: tParam } = await searchParams;
  // `?t=<seconds>` lets the viewer link straight into a debug session at
  // the current playhead. Parse defensively — bad input becomes 0 (no
  // seek) so the page still renders.
  const parsedT = tParam ? Number(tParam) : 0;
  const initialTime = Number.isFinite(parsedT) && parsedT > 0 ? parsedT : 0;

  const video = await getVideo(id);
  if (!video) return notFound();

  const source = getVideoSource(video);
  if (!source) return notFound();

  // Try loading demo JSON (has autoCaptions and sections)
  const youtubeVideoId = extractYouTubeId(video.youtube_url);
  const demoData = youtubeVideoId ? await getDemoJson(youtubeVideoId) : null;

  const runs = await getRunsForVideo(id);
  const runId = runIdParam || (await getLatestRunId(id));
  const activeRun = runs.find((r) => r.id === runId);

  // Get segments from DB
  const segResult = await getPool().query(
    runId
      ? `SELECT id, text, timestamp_start, timestamp_end FROM transcript_segments WHERE video_id = $1 AND run_id = $2 ORDER BY timestamp_start`
      : `SELECT id, text, timestamp_start, timestamp_end FROM transcript_segments WHERE video_id = $1 ORDER BY timestamp_start`,
    runId ? [id, runId] : [id]
  );
  const segments = segResult.rows.map((r: { id: string; text: string; timestamp_start: number; timestamp_end: number }) => ({
    id: r.id,
    text: r.text,
    start: Number(r.timestamp_start),
    end: Number(r.timestamp_end),
  }));

  // Get visual content from DB — include base run + any scoped re-extraction runs
  const vcRows = await getVisualContent(id, runId || undefined);
  const visualContent = rowsToVisualContent(vcRows);

  // Also get visual content from scoped runs (section/item re-extractions)
  const scopedRunsResult = await getPool().query(
    `SELECT r.id, r.progress FROM pipeline_runs r
     WHERE r.video_id = $1 AND r.status = 'complete'
     AND r.id != $2
     AND (r.progress->>'scope' = 'section' OR r.progress->>'scope' = 'item')
     ORDER BY r.created_at DESC`,
    [id, runId || '']
  );

  const scopedVcItems = [];
  for (const scopedRun of scopedRunsResult.rows) {
    const scopedVc = await getVisualContent(id, scopedRun.id);
    const items = rowsToVisualContent(scopedVc);
    for (const item of items) {
      scopedVcItems.push({ ...item, _scopedRunId: scopedRun.id });
    }
  }

  const sections = activeRun?.sections || demoData?.sections || [];
  // Prefer the static demo JSON when present (landing-page demo videos have
  // curated files committed to the repo); otherwise pull from the DB, which
  // is where Railway-processed videos store their SRT-derived captions. The
  // helper traces back to the parent `process` run so scoped re-extraction
  // runs still display captions on the debug page.
  const autoCaptions = demoData?.autoCaptions?.length
    ? demoData.autoCaptions
    : await getAutoCaptions(id);
  const duration = video.duration || demoData?.duration || 0;
  const dbAlignment = (activeRun?.progress as { alignment?: unknown } | undefined)?.alignment;
  const alignmentMeta = selectAlignmentMeta(demoData?.alignmentMeta, dbAlignment);
  const usageSummary = selectUsageSummary(activeRun?.progress);
  const geminiCallLogs = selectGeminiCallLogs(activeRun?.gemini_call_logs);

  return (
    <DebugView
      videoId={id}
      source={source}
      title={video.title}
      duration={duration}
      segments={segments}
      autoCaptions={autoCaptions}
      visualContent={visualContent}
      scopedReextractions={scopedVcItems}
      sections={sections}
      alignmentMeta={alignmentMeta}
      runId={runId}
      usageSummary={usageSummary}
      geminiCallLogs={geminiCallLogs}
      initialTime={initialTime}
    />
  );
}
