import Link from "next/link";
import { notFound } from "next/navigation";
import { getVideo } from "@/lib/db";
import { getNotesForSource, getNotesSourceRun, isUuid } from "@/lib/notes";
import { getVideoSource } from "@/lib/video-source";
import StudyNotes from "@/components/notes/StudyNotes";

export const dynamic = "force-dynamic";

export default async function NotesPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run } = await searchParams;
  if (!isUuid(id) || (run !== undefined && !isUuid(run))) return notFound();
  const video = await getVideo(id);
  if (!video) return notFound();
  const source = getVideoSource(video);
  if (!source) return notFound();
  const sourceRun = await getNotesSourceRun(id, run);
  if (!sourceRun) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-20">
        <Link href={`/video/${id}`} className="underline">Back to lecture</Link>
        <h1 className="text-4xl mt-10 mb-4" style={{ fontFamily: "var(--font-serif)" }}>Study notes</h1>
        <p>Notes need a completed full lecture with a transcript. Open the lecture and select a completed full run.</p>
      </main>
    );
  }
  const job = await getNotesForSource(id, sourceRun.id);
  return <StudyNotes key={sourceRun.id} videoId={id} sourceRunId={sourceRun.id}
    title={video.title} source={source} initialJob={job} />;
}
