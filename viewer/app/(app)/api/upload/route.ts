import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getPool } from "@/lib/db";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^\w.-]/g, "_") || "upload.mp4";
}

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

function generateThumbnail(videoPath: string, outputDir: string): string | null {
  const thumbPath = path.join(outputDir, "thumbnail.jpg");
  try {
    const durationStr = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath,
    ], { timeout: 10000 }).toString().trim();
    const duration = parseFloat(durationStr) || 30;
    const seekTo = Math.floor(duration * 0.1);

    execFileSync("ffmpeg", [
      "-ss", String(seekTo), "-i", videoPath, "-vframes", "1", "-q:v", "4", "-y", thumbPath,
    ], { timeout: 15000, stdio: "ignore" });
    return thumbPath;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const title = formData.get("title") as string | null;

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required for uploaded files" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Max: ${MAX_FILE_SIZE / 1024 / 1024} MB` },
      { status: 413 }
    );
  }

  // Save to temp directory
  const pipelineDir = path.resolve(process.cwd(), "..", "pipeline");
  const uploadId = randomUUID().slice(0, 12);
  const uploadDir = path.join(pipelineDir, "uploads", uploadId);
  await mkdir(uploadDir, { recursive: true });

  const safeName = sanitizeFilename(file.name);
  const filePath = path.join(uploadDir, safeName);
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  await writeFile(filePath, buffer);

  // Generate thumbnail
  generateThumbnail(filePath, uploadDir);

  // Upload to R2 if configured, otherwise fall back to local path
  const r2Client = getR2Client();
  const r2Bucket = process.env.R2_BUCKET_NAME;
  const r2PublicUrl = process.env.R2_PUBLIC_URL;
  let r2Key: string | null = null;
  let r2Url: string | null = null;
  let source = filePath; // default: local path

  if (r2Client && r2Bucket && r2PublicUrl) {
    r2Key = `uploads/${uploadId}/${safeName}`;
    r2Url = `${r2PublicUrl.replace(/\/+$/, "")}/${r2Key}`;

    await r2Client.send(new PutObjectCommand({
      Bucket: r2Bucket,
      Key: r2Key,
      Body: buffer,
    }));

    source = r2Key; // Worker will detect this as an R2 key and download it

    // Clean up local temp file — it's in R2 now
    await unlink(filePath).catch(() => {});
  }

  // Create video record + queued run
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
      title.trim(),
      r2Url || filePath,  // youtube_url column: R2 public URL or local path
      r2Key,
      r2Url,
      JSON.stringify({ source, title: title.trim(), video_url: r2Url }),
    ]
  );

  const { id: run_id, video_id } = result.rows[0];
  return NextResponse.json({ queued: true, run_id, video_id, uploadId });
}
