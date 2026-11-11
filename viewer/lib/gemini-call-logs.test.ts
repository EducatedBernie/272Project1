import assert from "node:assert/strict";
import test from "node:test";

import {
  callsForSection,
  formatBytes,
  isGeminiCallLogsManifest,
  selectGeminiCallLogs,
  type GeminiCallLogsManifest,
} from "./gemini-call-logs";

test("validates and selects Gemini call manifests", () => {
  const manifest: GeminiCallLogsManifest = {
    version: 1,
    storage: "r2",
    capture_status: "complete",
    calls: [
      { call_id: "a", kind: "topic_map", section_index: null, attempt: 1, status: "success", started_at: "", ended_at: "", duration_ms: 1, model_requested: "m", model_version: null, prompt_version: null, schema: null },
      { call_id: "b", kind: "visual_content", section_index: 2, attempt: 1, status: "success", started_at: "", ended_at: "", duration_ms: 1, model_requested: "m", model_version: null, prompt_version: null, schema: null },
    ],
  };

  assert.equal(isGeminiCallLogsManifest(manifest), true);
  assert.equal(selectGeminiCallLogs(manifest)?.capture_status, "complete");
  assert.equal(callsForSection(manifest, 2).length, 1);
  assert.equal(callsForSection(manifest, 1).length, 0);
});

test("rejects non-manifest values", () => {
  assert.equal(isGeminiCallLogsManifest(null), false);
  assert.equal(isGeminiCallLogsManifest({ version: 1, capture_status: "complete" }), false);
  assert.equal(selectGeminiCallLogs({}), null);
});

test("formats byte counts", () => {
  assert.equal(formatBytes(null), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(12_345), "12.3 KB");
  assert.equal(formatBytes(1_234_567), "1.2 MB");
});
