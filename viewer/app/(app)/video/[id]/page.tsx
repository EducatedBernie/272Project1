import { notFound } from "next/navigation";
import {
  getVideo,
  getTranscriptWithEquations,
  getVisualContent,
  getPublicRunsForVideo,
  getLatestRunId,
} from "@/lib/db";
import { rowsToSegments, rowsToVisualContent } from "@/lib/transform";
import { anchorVisualsToSegments } from "@/lib/anchor";
import VideoViewerWithRuns from "@/components/VideoViewerWithRuns";
import { getVideoSource } from "@/lib/video-source";
import { selectPublicRunId } from "@/lib/public-run-selection";
import type { VisualContent } from "@/lib/types";

export default async function VideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run: runIdParam } = await searchParams;

  const video = await getVideo(id);
  if (!video) return notFound();

  const runs = await getPublicRunsForVideo(id);
  const requestedRunIsPublic = runIdParam ? runs.some((run) => run.id === runIdParam) : false;
  const runId = selectPublicRunId(runs, runIdParam, await getLatestRunId(id));
  if (runIdParam && !requestedRunIsPublic && !runId) return notFound();
  const activeRun = runs.find((r) => r.id === runId);
  const sections = activeRun?.sections || null;

  const [transcriptRows, vcRows] = runId
    ? await Promise.all([
        getTranscriptWithEquations(id, runId),
        getVisualContent(id, runId),
      ])
    : [[], []];

  const segments = rowsToSegments(transcriptRows);
  const visualContent: VisualContent[] = rowsToVisualContent(vcRows);
  const anchoredSegments = anchorVisualsToSegments(segments, visualContent);

  const source = getVideoSource(video);
  if (!source) {
    return <div className="p-8 text-red-600">Invalid video source in database</div>;
  }

  return (
    <VideoViewerWithRuns
      videoId={id}
      source={source}
      anchoredSegments={anchoredSegments}
      visualContent={visualContent}
      sections={sections}
      duration={video.duration}
      title={video.title}
      runs={runs}
      activeRunId={runId}
    />
  );
}
