import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function getR2Client(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) return null;
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key : "";
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  // Key must match the format our presign endpoint issues.
  // Prevents confirming arbitrary objects under other prefixes.
  if (!/^uploads\/[a-f0-9]{12}\/[\w.-]+$/.test(key)) {
    return NextResponse.json({ error: "invalid key format" }, { status: 400 });
  }
  if (!uploadId || !key.startsWith(`uploads/${uploadId}/`)) {
    return NextResponse.json({ error: "uploadId does not match key" }, { status: 400 });
  }

  const r2Client = getR2Client();
  const r2Bucket = process.env.R2_BUCKET_NAME;
  const r2PublicUrl = process.env.R2_PUBLIC_URL;

  if (!r2Client || !r2Bucket || !r2PublicUrl) {
    return NextResponse.json(
      { error: "R2 not configured on server — use direct /api/upload instead" },
      { status: 501 }
    );
  }

  // Verify object exists in R2 and is within size limits.
  let contentLength = 0;
  try {
    const head = await r2Client.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    contentLength = head.ContentLength ?? 0;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey") {
      return NextResponse.json(
        { error: "uploaded file not found in R2 — upload may have failed" },
        { status: 404 }
      );
    }
    throw err;
  }

  if (contentLength <= 0 || contentLength > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `uploaded file size ${contentLength} is out of range (1..${MAX_FILE_SIZE})` },
      { status: 413 }
    );
  }

  const r2Url = `${r2PublicUrl.replace(/\/+$/, "")}/${key}`;

  // Create video record + queued run. Mirrors the CTE pattern used by /api/upload.
  const result = await getPool().query(
    `WITH video AS (
       INSERT INTO videos (id, title, youtube_url, duration, status, created_at, source_type, r2_key, r2_url)
       VALUES (gen_random_uuid(), $1, $2, 0, 'queued', NOW(), 'upload', $3, $4)
       RETURNING id
     )
     INSERT INTO pipeline_runs (id, video_id, status, run_type, params, pipeline_version, progress, created_at)
     VALUES (gen_random_uuid(), (SELECT id FROM video), 'queued', 'process',
             $5::jsonb, 'v2', '{}', NOW())
     RETURNING id, video_id`,
    [
      title,
      r2Url,
      key,
      r2Url,
      JSON.stringify({ source: key, title, video_url: r2Url }),
    ]
  );

  const { id: run_id, video_id } = result.rows[0];
  return NextResponse.json({ queued: true, run_id, video_id, uploadId });
}
