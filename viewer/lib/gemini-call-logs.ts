export type GeminiCaptureStatus = "complete" | "partial" | "failed" | "unavailable";

export interface GeminiCallManifestEntry {
  call_id: string;
  kind: string;
  section_index: number | null;
  attempt: number;
  status: "success" | "error" | string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  model_requested: string;
  model_version: string | null;
  prompt_version: string | null;
  video?: {
    start_time?: number | null;
    end_time?: number | null;
    fps?: number | null;
  };
  schema: string | null;
  usage?: Record<string, unknown> | null;
  item_count?: number | null;
  r2_key?: string | null;
  blob_bytes?: number | null;
  request_bytes?: number | null;
  response_text_bytes?: number | null;
  parsed_bytes?: number | null;
  error?: { type?: string; message?: string; traceback?: string } | null;
  capture_error?: { type?: string; message?: string; at?: string } | null;
}

export interface GeminiCallLogsManifest {
  version: number;
  storage: "r2" | string;
  capture_status: GeminiCaptureStatus;
  truncated?: boolean;
  calls: GeminiCallManifestEntry[];
}

export interface GeminiCallBlob {
  version: number;
  call_id: string;
  kind: string;
  section_index: number | null;
  attempt: number;
  status: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  model_requested: string;
  model_version: string | null;
  prompt_version: string | null;
  video?: Record<string, unknown>;
  request?: {
    schema?: string | null;
    system_instruction?: string | null;
    user_prompt?: string | null;
    contents?: unknown;
    config?: unknown;
  };
  response?: {
    text?: string | null;
    parsed?: unknown;
    usage_metadata?: unknown;
  };
  error?: unknown;
}

export function isGeminiCallLogsManifest(value: unknown): value is GeminiCallLogsManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.calls)) return false;
  return typeof v.version === "number" && typeof v.capture_status === "string";
}

export function selectGeminiCallLogs(value: unknown): GeminiCallLogsManifest | null {
  return isGeminiCallLogsManifest(value) ? value : null;
}

export function callsForSection(
  logs: GeminiCallLogsManifest | null,
  sectionIndex: number,
): GeminiCallManifestEntry[] {
  if (!logs) return [];
  return logs.calls.filter((c) => c.section_index === sectionIndex);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}
