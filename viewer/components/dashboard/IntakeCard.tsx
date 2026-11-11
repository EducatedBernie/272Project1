"use client";

import { useCallback, useRef, useState } from "react";

const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;
const THUMB_TIMEOUT_MS = 5000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / 1024 / 1024;

function extractThumbnail(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.src = "";
    };
    const bail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    const timeout = setTimeout(bail, THUMB_TIMEOUT_MS);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(video.duration * 0.1, 5);
    };
    video.onseeked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_WIDTH;
      canvas.height = THUMB_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        cleanup();
        resolve(null);
        return;
      }
      ctx.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      canvas.toBlob(
        (blob) => {
          cleanup();
          resolve(blob);
        },
        "image/jpeg",
        0.85
      );
    };
    video.onerror = bail;
    video.src = objectUrl;
  });
}

type Status = "idle" | "submitting" | "uploading" | "submitted" | "error";

interface IntakeCardProps {
  onSubmitted?: () => void;
}

export default function IntakeCard({ onSubmitted }: IntakeCardProps) {
  // Mobile collapse state — desktop ignores this (boxes always visible at md+)
  const [expanded, setExpanded] = useState(false);

  // YouTube state
  const [url, setUrl] = useState("");
  const [ytStatus, setYtStatus] = useState<Status>("idle");
  const [ytError, setYtError] = useState("");

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upStatus, setUpStatus] = useState<Status>("idle");
  const [upError, setUpError] = useState("");
  const [uploadPercent, setUploadPercent] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const ytBusy = ytStatus === "submitting";
  const upBusy = upStatus === "submitting" || upStatus === "uploading";

  const handleYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || ytBusy) return;
    setYtError("");
    setYtStatus("submitting");
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtube_url: url.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start processing");
      }
      setYtStatus("submitted");
      setUrl("");
      onSubmitted?.();
      setTimeout(() => setYtStatus("idle"), 3000);
    } catch (err) {
      setYtStatus("error");
      setYtError(err instanceof Error ? err.message : "Failed to start processing");
    }
  };

  const pickFile = (f: File | null) => {
    setUpError("");
    if (!f) {
      setFile(null);
      return;
    }
    if (!f.type.startsWith("video/")) {
      setUpError("Please select a video file.");
      setFile(null);
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      setUpError(`File is ${(f.size / 1024 / 1024).toFixed(0)} MB — max is ${MAX_FILE_SIZE_MB} MB.`);
      setFile(null);
      return;
    }
    setFile(f);
    if (upStatus === "submitted") setUpStatus("idle");
  };

  const uploadPresigned = (
    presignedUrl: string,
    body: Blob | File,
    contentType: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", presignedUrl);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPercent(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`R2 upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      xhr.send(body);
    });
  };

  const uploadDirect = (f: File, titleVal: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPercent(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let msg = `Upload failed (${xhr.status})`;
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.error) msg = data.error;
          } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      const fd = new FormData();
      fd.append("file", f);
      fd.append("title", titleVal);
      xhr.send(fd);
    });
  };

  const handleUploadSubmit = async () => {
    if (!file || upBusy) return;
    setUpError("");
    setUploadPercent(0);
    setUpStatus("submitting");
    // Title auto-derived from filename (strip extension)
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || file.name;
    try {
      const presignRes = await fetch("/api/upload/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "video/mp4",
          size: file.size,
        }),
      });
      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => ({}));
        throw new Error(data.error || "Failed to get upload URL");
      }
      const presign = await presignRes.json();
      if (presign.mode === "direct") {
        setUpStatus("uploading");
        await uploadDirect(file, title);
      } else if (presign.mode === "presigned") {
        setUpStatus("uploading");
        const thumbPromise = extractThumbnail(file)
          .then(async (blob) => {
            if (blob && presign.thumbnailUrl) {
              await uploadPresigned(presign.thumbnailUrl, blob, "image/jpeg");
            }
          })
          .catch((e) => console.warn("Thumbnail upload failed:", e));
        await uploadPresigned(presign.url, file, presign.contentType);
        await thumbPromise;
        setUpStatus("submitting");
        const confirmRes = await fetch("/api/upload/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: presign.key,
            uploadId: presign.uploadId,
            title,
          }),
        });
        if (!confirmRes.ok) {
          const data = await confirmRes.json().catch(() => ({}));
          throw new Error(data.error || "Failed to confirm upload");
        }
      } else {
        throw new Error("Unknown presign response");
      }
      setUpStatus("submitted");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onSubmitted?.();
      setTimeout(() => setUpStatus("idle"), 3000);
    } catch (err) {
      setUpStatus("error");
      setUpError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (upBusy) return;
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) pickFile(dropped);
    },
    [upBusy]
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls="intake-boxes"
        className="md:hidden mt-7 w-full rounded-xl px-4 py-3.5 text-[14px] font-semibold flex items-center justify-between cursor-pointer"
        style={{
          background: "var(--ink)",
          color: "var(--paper)",
          border: 0,
        }}
      >
        <span>{expanded ? "Hide" : "Process new video"}</span>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            fontSize: 22,
            lineHeight: 1,
            fontWeight: 300,
            transform: expanded ? "rotate(45deg)" : "rotate(0)",
            transition: "transform 0.18s ease",
          }}
        >
          +
        </span>
      </button>

    <div
      id="intake-boxes"
      className={`mt-3 md:mt-7 rounded-2xl p-1.5 grid grid-cols-1 md:[grid-template-columns:1.2fr_1fr] gap-1.5 ${expanded ? "" : "max-md:hidden"}`}
      style={{
        background: "#fff",
        border: "1px solid var(--rule)",
        boxShadow: "0 18px 40px -32px #0003",
      }}
    >
      {/* YouTube side */}
      <form
        onSubmit={handleYouTubeSubmit}
        className="rounded-xl p-5 flex flex-col gap-2.5"
        style={{ background: "var(--paper)" }}
      >
        <div
          className="flex items-center gap-2 text-[10.5px] uppercase"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.14em",
            color: "var(--muted-fg)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              color: "var(--accent-2)",
              fontSize: 16,
            }}
          >
            ↗
          </span>
          <span>YouTube · fastest path</span>
        </div>
        <h3
          className="m-0"
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 400,
            fontSize: 22,
            lineHeight: 1.1,
            letterSpacing: "-0.01em",
          }}
        >
          Paste a lecture URL
        </h3>
        <div className="flex flex-col sm:flex-row gap-2 items-stretch mt-1">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            disabled={ytBusy}
            className="flex-1 rounded-lg px-3.5 py-3 focus:outline-none focus:ring-2 disabled:opacity-50"
            style={{
              background: "#fff",
              border: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--ink)",
              boxShadow: "none",
            }}
          />
          <button
            type="submit"
            disabled={ytBusy || !url.trim()}
            className="rounded-lg px-4 py-3 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{
              background: "var(--ink)",
              color: "var(--paper)",
              border: 0,
              cursor: ytBusy || !url.trim() ? "not-allowed" : "pointer",
            }}
          >
            {ytStatus === "submitting"
              ? "Starting…"
              : ytStatus === "submitted"
                ? "Queued ✓"
                : "Process →"}
          </button>
        </div>
        <div
          className="flex gap-3.5 flex-wrap mt-0.5 text-[11.5px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--muted-fg)",
            letterSpacing: "0.02em",
          }}
        >
          <span>
            <b style={{ color: "var(--ink)", fontWeight: 600 }}>Avg.</b> 3–5 min for a 60-min lecture
          </span>
          <span>· captions auto-fetched</span>
        </div>
        {ytStatus === "error" && (
          <p className="text-[12px]" style={{ color: "var(--err)" }}>
            {ytError}
          </p>
        )}
      </form>

      {/* Upload side */}
      <div
        className="rounded-xl p-5 flex flex-col gap-2.5"
        style={{
          background: "var(--paper-2)",
          border: "1px dashed var(--rule)",
        }}
      >
        <div
          className="flex items-center gap-2 text-[10.5px] uppercase"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.14em",
            color: "var(--muted-fg)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              color: "var(--accent-2)",
              fontSize: 16,
            }}
          >
            △
          </span>
          <span>or upload a file</span>
        </div>
        <label
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            if (!upBusy) setDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragging(false);
          }}
          className="flex-1 flex flex-col items-center justify-center gap-1 text-center cursor-pointer rounded-lg p-4.5 transition-colors"
          style={{
            background: dragging ? "var(--paper)" : "#fff",
            border: `1.5px dashed ${dragging ? "var(--accent)" : "#1a1a1a33"}`,
            opacity: upBusy ? 0.6 : 1,
            cursor: upBusy ? "not-allowed" : "pointer",
            minHeight: 120,
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            onChange={(e) => pickFile(e.target.files?.[0] || null)}
            disabled={upBusy}
            className="sr-only"
          />
          {file ? (
            <>
              <span className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
                {file.name}
              </span>
              <span
                className="text-[10.5px] mt-1"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted-fg)",
                  letterSpacing: "0.04em",
                }}
              >
                {(file.size / 1024 / 1024).toFixed(1)} MB — click or drop to replace
              </span>
            </>
          ) : (
            <>
              <span className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
                Drop a video, or{" "}
                <u style={{ color: "var(--accent-2)", textDecorationThickness: "1.5px", textUnderlineOffset: 2 }}>
                  click to choose
                </u>
              </span>
              <span
                className="text-[10.5px] mt-1"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted-fg)",
                  letterSpacing: "0.04em",
                }}
              >
                MP4 · MOV · WebM · up to {MAX_FILE_SIZE_MB / 1024} GB
              </span>
            </>
          )}
        </label>
        {file && (
          <button
            type="button"
            onClick={handleUploadSubmit}
            disabled={upBusy}
            className="rounded-lg px-4 py-3 text-[13px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{
              background: "var(--ink)",
              color: "var(--paper)",
              border: 0,
              cursor: upBusy ? "not-allowed" : "pointer",
            }}
          >
            {upStatus === "submitting"
              ? "Preparing…"
              : upStatus === "uploading"
                ? `Uploading ${uploadPercent}%…`
                : upStatus === "submitted"
                  ? "Queued ✓"
                  : "Process →"}
          </button>
        )}
        {upStatus === "uploading" && (
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: "#fff" }}
            role="progressbar"
            aria-valuenow={uploadPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full transition-all duration-150"
              style={{ width: `${uploadPercent}%`, background: "var(--accent)" }}
            />
          </div>
        )}
        {upStatus === "error" && (
          <p className="text-[12px]" style={{ color: "var(--err)" }}>
            {upError}
          </p>
        )}
      </div>
    </div>
    </>
  );
}
