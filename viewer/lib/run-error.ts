/**
 * Parse a `pipeline_runs.error` value for display.
 *
 * The column holds either a short message ("Cancelled by user", "Worker
 * received SIGTERM (deploy/restart)", a validation message) or a full
 * Python traceback. Older rows may have trailing whitespace/newlines, so
 * `error.split("\n").pop()` returned an empty string and the UI fell back
 * to "Unknown error" — even when there was useful data.
 */

// Both patterns are intent strings under our control:
//  - "Cancelled by user" is what the worker writes after a clean cancel
//    chain (poll_once's except CancelledError).
//  - "Cancel requested before stage transition" is what the
//    `_update_run_progress` checkpoint raises before the cancel chain
//    finishes — it ends up in the column when the chain trips on a real
//    failure path (the historical d660283c shape).
// We deliberately do NOT match the bare class name "CancelledError",
// which could be present in unrelated wrapped exceptions or stack frames.
const CANCEL_PATTERNS = [
  "Cancelled by user",
  "Cancel requested before stage transition",
];

export interface ParsedRunError {
  /** True when the error indicates user cancellation (vs. a real failure). */
  cancelled: boolean;
  /** Short, human-readable summary suitable for chips and inline alerts. */
  summary: string;
}

export function parseRunError(error: string | null | undefined): ParsedRunError {
  if (!error || !error.trim()) {
    return { cancelled: false, summary: "no error message recorded" };
  }

  if (CANCEL_PATTERNS.some((p) => error.includes(p))) {
    return { cancelled: true, summary: "Cancelled by user" };
  }

  // Last non-empty line of the error/traceback. For Python tracebacks this
  // is the exception type + message line, which is what an operator wants
  // to see. For short errors it's just the message.
  const lines = error
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];

  return { cancelled: false, summary: last || "no error message recorded" };
}

export function sanitizeRunError(error: string | null | undefined): string | null {
  if (!error || !error.trim()) return null;
  return parseRunError(error).summary;
}
