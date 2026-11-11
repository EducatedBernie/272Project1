import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunError, sanitizeRunError } from "./run-error";

test("null/undefined/empty → no error message recorded", () => {
  assert.deepEqual(parseRunError(null), { cancelled: false, summary: "no error message recorded" });
  assert.deepEqual(parseRunError(undefined), { cancelled: false, summary: "no error message recorded" });
  assert.deepEqual(parseRunError(""), { cancelled: false, summary: "no error message recorded" });
  assert.deepEqual(parseRunError("\n\n  \n"), { cancelled: false, summary: "no error message recorded" });
});

test("short cancel-by-user message → cancelled", () => {
  assert.deepEqual(parseRunError("Cancelled by user"), { cancelled: true, summary: "Cancelled by user" });
});

test("real-world traceback ending with \\n (regression for d660283c) → cancelled", () => {
  // The exact stored error for run d660283c — split-pop of this returned ""
  // and the UI fell back to "Unknown error".
  const err =
    'Traceback (most recent call last):\n' +
    '  File "/app/scripts/worker.py", line 342, in poll_once\n' +
    '    dispatch(run, session)\n' +
    '  File "/app/scripts/process_video_v2.py", line 334, in _update_run_progress\n' +
    "    raise CancelledError(f\"Cancel requested before stage transition to '{status}'\")\n" +
    "scripts.worker.CancelledError: Cancel requested before stage transition to 'downloading_captions'\n";
  const parsed = parseRunError(err);
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.summary, "Cancelled by user");
});

test("real failure (Gemini error) → not cancelled, returns last line", () => {
  const err =
    'Traceback (most recent call last):\n' +
    '  File "/app/scripts/process_video_v2.py", line 220, in upload_to_gemini\n' +
    "    raise RuntimeError(f\"Gemini file upload failed: {file.state}\")\n" +
    "RuntimeError: Gemini file upload failed: FileState.FAILED\n";
  const parsed = parseRunError(err);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.summary, "RuntimeError: Gemini file upload failed: FileState.FAILED");
  assert.equal(sanitizeRunError(err), "RuntimeError: Gemini file upload failed: FileState.FAILED");
});

test("sanitizeRunError removes traceback frames", () => {
  const err =
    'Traceback (most recent call last):\n' +
    '  File "/app/scripts/process_video_v2.py", line 246, in extract_transcript_chunk\n' +
    "google.genai.errors.ClientError: 400 INVALID_ARGUMENT\n";
  assert.equal(sanitizeRunError(err), "google.genai.errors.ClientError: 400 INVALID_ARGUMENT");
});

test("worker SIGTERM marker → not cancelled (a real shutdown, not a user cancel)", () => {
  const parsed = parseRunError("Worker received SIGTERM (deploy/restart)");
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.summary, "Worker received SIGTERM (deploy/restart)");
});

test("trailing whitespace doesn't swallow the message", () => {
  const parsed = parseRunError("ConnectionError: pool exhausted   \n  \n");
  assert.equal(parsed.summary, "ConnectionError: pool exhausted");
});

test("bare 'CancelledError' substring is NOT enough to classify as cancellation", () => {
  // Reviewer note: matching the class-name token alone is too broad — a
  // wrapped exception or a debug log that mentions the class would
  // misclassify. The genuine cancel intent strings ("Cancelled by user",
  // "Cancel requested before stage transition") are what we look for.
  const wrapped =
    "RuntimeError: workflow aborted while handling CancelledError; " +
    "see prior Slack alert for context";
  const parsed = parseRunError(wrapped);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.summary, wrapped);
});
