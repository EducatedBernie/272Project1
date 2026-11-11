import { NextRequest, NextResponse } from "next/server";
import { stat, open } from "fs/promises";
import path from "path";

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Only allow files under the pipeline/uploads directory
  const pipelineDir = path.resolve(process.cwd(), "..", "pipeline");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.join(pipelineDir, "uploads"))) {
    return NextResponse.json({ error: "access denied" }, { status: 403 });
  }

  try {
    const fileStat = await stat(resolved);
    const fileHandle = await open(resolved, "r");
    const stream = fileHandle.readableWebStream();

    return new Response(stream as ReadableStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileStat.size.toString(),
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
}
