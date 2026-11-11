import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getPool } from "@/lib/db";
import { isGeminiCallLogsManifest } from "@/lib/gemini-call-logs";

function getR2Client(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string; callId: string }> },
) {
  const { runId, callId } = await params;
  let result;
  try {
    result = await getPool().query(
      "SELECT gemini_call_logs FROM pipeline_runs WHERE id = $1",
      [runId],
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "42703"
    ) {
      return NextResponse.json({ error: "Gemini call logs unavailable" }, { status: 404 });
    }
    throw error;
  }

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const manifest = result.rows[0].gemini_call_logs;
  if (!isGeminiCallLogsManifest(manifest)) {
    return NextResponse.json({ error: "Gemini call logs unavailable" }, { status: 404 });
  }

  const entry = manifest.calls.find((c) => c.call_id === callId);
  if (!entry) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }
  if (!entry.r2_key) {
    return NextResponse.json(
      { error: "Raw blob was not captured", entry },
      { status: 404 },
    );
  }

  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!client || !bucket) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  const object = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: entry.r2_key,
  }));
  const text = await object.Body?.transformToString();
  if (!text) {
    return NextResponse.json({ error: "Empty raw blob" }, { status: 502 });
  }

  return new NextResponse(text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
