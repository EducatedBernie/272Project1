import { NextRequest, NextResponse } from "next/server";
import { getNotesJob, isUuid } from "@/lib/notes";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Notes not found" }, { status: 404 });
  const job = await getNotesJob(id);
  if (!job) return NextResponse.json({ error: "Notes not found" }, { status: 404 });
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}
