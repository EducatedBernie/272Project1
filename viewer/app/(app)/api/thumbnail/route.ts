import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Resolve thumbnail: given the video path, look for thumbnail.jpg in the same directory
  const thumbPath = path.join(path.dirname(filePath), "thumbnail.jpg");

  // Only allow files under pipeline/uploads
  const pipelineDir = path.resolve(process.cwd(), "..", "pipeline");
  const resolved = path.resolve(thumbPath);
  if (!resolved.startsWith(path.join(pipelineDir, "uploads"))) {
    return NextResponse.json({ error: "access denied" }, { status: 403 });
  }

  try {
    await stat(resolved);
    const bytes = await readFile(resolved);
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
