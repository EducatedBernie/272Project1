import { NextRequest, NextResponse } from "next/server";
import { enqueueNotes, NotesRequestError, parseNotesRequest } from "@/lib/notes";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => { throw new NotesRequestError("Invalid JSON request", 400); });
    const { video_id, source_run_id } = parseNotesRequest(body);
    const job = await enqueueNotes(video_id, source_run_id);
    return NextResponse.json(job, { status: job.status === "complete" ? 200 : 202 });
  } catch (error) {
    if (error instanceof NotesRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Could not queue study notes", error);
    return NextResponse.json({ error: "Could not queue notes. Please try again." }, { status: 500 });
  }
}
