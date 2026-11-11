/**
 * Artifact list helpers for the /debug page.
 *
 * Design principle: /debug is a developer tool. It shows EVERYTHING the
 * pipeline produced. Items needing attention (low confidence, perception
 * failures, healed misplacements) get visual flags inline; nothing is
 * hidden. Filters are opt-in narrowing, not curation — the dev decides
 * what's worth investigating, not us.
 *
 * Sections live in their own tab and stay in the SectionAnalysis shape.
 * Unmatched ref-word groups live in the Captions tab. Both keep their
 * existing helpers (analyzeSections / groupUnmatched). This file is just
 * the worklist filter for the Artifacts tab.
 */

import type { VisualContent } from "./types";
import type { UnmatchedRefWord } from "./alignment-meta";

export type ArtifactFilter = "all" | "attention";

export const LOWCONF_THRESHOLD = 0.85;

/**
 * "Needs attention" = anything a dev probably wants to look at first.
 * Low confidence is the cheapest signal; perception-failure items
 * (`repairStatus === "skipped"`) are the strongest. Both are union'd
 * here. A flag is *not* a verdict — clean items can still be wrong, so
 * they're never hidden, only deprioritized.
 */
export function needsAttention(item: VisualContent): boolean {
  if (item.repairStatus === "skipped") return true;
  if (item.confidence < LOWCONF_THRESHOLD) return true;
  return false;
}

export function filterArtifacts(items: VisualContent[], filter: ArtifactFilter): VisualContent[] {
  if (filter === "attention") return items.filter(needsAttention);
  return items;
}

export function findArtifactAt(items: VisualContent[], time: number): VisualContent | null {
  // Prefer an item whose range contains `time`. Fall back to the closest
  // by start-time if nothing is active. Returns null only when items is
  // empty.
  if (items.length === 0) return null;
  const active = items.find((i) => i.start <= time && i.end >= time);
  if (active) return active;
  let closest = items[0];
  let closestDelta = Math.abs(closest.start - time);
  for (const item of items) {
    const delta = Math.abs(item.start - time);
    if (delta < closestDelta) {
      closest = item;
      closestDelta = delta;
    }
  }
  return closest;
}

/**
 * Build a one-line summary for a VisualContent item, picking the right
 * primary field per content_type. Used in worklist rows, neighbor
 * previews, and the scoped re-extract list.
 *
 * For each type, prefer the primary content field (`latex` for equation,
 * `code` for code, first textBlock for text/slide, an `H×R` shape for
 * table) and fall back through any other text-bearing field before
 * giving up with `(empty)`. Mirrors the per-type rendering in
 * VisualContentBody so the summary matches what a click reveals.
 */
export function summarizeArtifact(item: VisualContent, maxLen = 80): string {
  const truncate = (s: string) =>
    s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;

  switch (item.contentType) {
    case "equation":
      if (item.latex?.trim()) return truncate(item.latex.trim());
      if (item.description?.trim()) return truncate(item.description.trim());
      return "(no equation)";

    case "code": {
      const firstLine = item.code?.split("\n").find((l) => l.trim()) ?? "";
      if (firstLine.trim()) return truncate(firstLine.trim());
      if (item.description?.trim()) return truncate(item.description.trim());
      return "(no code)";
    }

    case "text":
    case "slide": {
      const head = item.textBlocks?.find((b) => b.text?.trim())?.text ?? "";
      if (head.trim()) return truncate(head.trim());
      if (item.description?.trim()) return truncate(item.description.trim());
      if (item.title?.trim()) return truncate(item.title.trim());
      return "(no text)";
    }

    case "table": {
      const cols = item.headers?.length ?? 0;
      const rows = item.rows?.length ?? 0;
      const firstCell = item.headers?.[0] ?? item.rows?.[0]?.[0] ?? "";
      const dim = cols && rows ? `${cols}×${rows} table` : cols || rows ? "table" : "";
      if (firstCell.trim()) {
        return dim ? `${dim} — ${truncate(firstCell.trim())}` : truncate(firstCell.trim());
      }
      if (item.description?.trim()) return truncate(item.description.trim());
      return dim || "(empty table)";
    }

    case "diagram_description":
    case "chart_description":
    case "other":
    default:
      if (item.description?.trim()) return truncate(item.description.trim());
      if (item.caption?.trim()) return truncate(item.caption.trim());
      if (item.title?.trim()) return truncate(item.title.trim());
      if (item.latex?.trim()) return truncate(item.latex.trim());
      return "(empty)";
  }
}

export function findNextArtifact(items: VisualContent[], currentId: string | null): string | null {
  if (items.length === 0) return null;
  if (!currentId) return items[0].id;
  const idx = items.findIndex((i) => i.id === currentId);
  if (idx === -1) return items[0].id;
  if (idx + 1 >= items.length) return null;
  return items[idx + 1].id;
}

// --- Unmatched groups (used by the Captions tab; kept here so SyncedTranscripts'
// import remains stable) ---

export interface UnmatchedGroup {
  time: number;
  words: string[];
}

export function groupUnmatched(words: UnmatchedRefWord[]): UnmatchedGroup[] {
  const groups: UnmatchedGroup[] = [];
  for (const w of words) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.time - w.time) < 1) {
      last.words.push(w.word);
    } else {
      groups.push({ time: w.time, words: [w.word] });
    }
  }
  return groups;
}
