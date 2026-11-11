import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const PRESIGN_EXPIRY_SECONDS = 60 * 60; // 1 hour

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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const size = typeof body.size === "number" ? body.size : -1;

  if (!filename.trim()) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (!contentType.startsWith("video/")) {
    return NextResponse.json({ error: "contentType must be video/*" }, { status: 400 });
  }
  if (size <= 0 || size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `size must be between 1 byte and ${MAX_FILE_SIZE} bytes` },
      { status: 400 }
    );
  }

  const r2Client = getR2Client();
  const r2Bucket = process.env.R2_BUCKET_NAME;

  if (!r2Client || !r2Bucket) {
    // R2 not configured (e.g. local dev). Client should fall back to direct POST.
    return NextResponse.json({ mode: "direct" });
  }

  const uploadId = randomUUID().replace(/-/g, "").slice(0, 12);
  const safeName = sanitizeFilename(filename);
  const key = `uploads/${uploadId}/${safeName}`;

  const command = new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(r2Client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });

  // Thumbnail presigned URL — client uploads a JPEG alongside the video
  const thumbKey = `uploads/${uploadId}/thumbnail.jpg`;
  const thumbCommand = new PutObjectCommand({
    Bucket: r2Bucket,
    Key: thumbKey,
    ContentType: "image/jpeg",
  });
  const thumbnailUrl = await getSignedUrl(r2Client, thumbCommand, { expiresIn: PRESIGN_EXPIRY_SECONDS });

  return NextResponse.json({
    mode: "presigned",
    url,
    key,
    uploadId,
    contentType,
    thumbnailUrl,
    thumbnailKey: thumbKey,
  });
}
