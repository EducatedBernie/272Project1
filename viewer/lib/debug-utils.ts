/**
 * Pure helpers for the /debug page.
 *
 * Extracted from viewer/components/DebugView.tsx (PR 9 era) into a lib so
 * the rebuilt component tree can import them without circular deps. No
 * React, no DOM, no fetch — every function is deterministic and side-effect
 * free, suitable for unit testing.
 */

import type { VisualContent } from "./types";
import type { UnmatchedRefWord, AlignmentMeta } from "./alignment-meta";

export interface Segment {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface AutoCaption {
  start: number;
  end: number;
  text: string;
}

export interface Section {
  start_time: string;
  end_time?: string;
  title: string;
  description: string;
}

export type Severity = "ok" | "warning" | "critical";

export interface SectionAnalysis {
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  transcriptWords: number;
  captionWords: number;
  coverage: number;
  wpm: number;
  captionWpm: number;
  segmentCount: number;
  gapSeconds: number;
  longestGap: number;
  vcItems: number;
  eqCount: number;
  lowConfCount: number;
  avgConfidence: number;
  wordCoverage: number;
  unmatchedWords: UnmatchedRefWord[];
  severity: Severity;
  issues: string[];
  segments: Segment[];
  captions: AutoCaption[];
  visualContentItems: VisualContent[];
}

export const TYPE_COLORS: Record<string, string> = {
  equation: "#3b82f6",
  text: "#8b5cf6",
  slide: "#8b5cf6",
  diagram_description: "#f97316",
  chart_description: "#06b6d4",
  table: "#10b981",
  code: "#ec4899",
};

export function parseTs(ts: string): number {
  const parts = ts.split(":").map((p) => parseInt(p.replace(/[^0-9]/g, "")));
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function stripLatex(text: string): string {
  return text.replace(/\$[^$]+\$/g, "").replace(/\s+/g, " ").trim();
}

interface ComputedUnmatchedWord {
  word: string;
  time: number;
  captionText: string;
}

export interface WordCoverage {
  matched: number;
  total: number;
  unmatchedWords: ComputedUnmatchedWord[];
}

export function computeWordCoverage(
  geminiSegments: Segment[],
  captions: AutoCaption[],
): WordCoverage {
  const geminiWords: Map<string, number> = new Map();
  for (const seg of geminiSegments) {
    const words = stripLatex(seg.text).toLowerCase().split(/\s+/).filter(Boolean);
    for (const w of words) {
      geminiWords.set(w, (geminiWords.get(w) || 0) + 1);
    }
  }

  let latexSubstitutions = 0;
  for (const seg of geminiSegments) {
    const matches = seg.text.match(/\$[^$]+\$/g);
    if (matches) latexSubstitutions += matches.length * 3;
  }

  const filler = new Set([
    "um", "uh", "oh", "ah", "like", "you", "know", "gonna", "gotta", "so",
    "and", "the", "a", "is", "it", "that", "this", "to", "of", "in", "for",
    "on", "with", "be", "have", "do", "we", "they", "he", "she", "was",
    "were", "are", "been", "has", "had", "will", "would", "could", "should",
    "can", "may", "might",
  ]);
  let matched = 0;
  let totalWords = 0;
  const unmatched: ComputedUnmatchedWord[] = [];
  const geminiBag = new Map(geminiWords);

  for (const cap of captions) {
    const words = cap.text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const w of words) {
      totalWords++;
      if (filler.has(w)) {
        matched++;
      } else if (geminiBag.has(w) && geminiBag.get(w)! > 0) {
        geminiBag.set(w, geminiBag.get(w)! - 1);
        matched++;
      } else {
        unmatched.push({ word: w, time: cap.start, captionText: cap.text });
      }
    }
  }

  const effectiveMatched = Math.min(matched + latexSubstitutions, totalWords);
  return { matched: effectiveMatched, total: totalWords, unmatchedWords: unmatched };
}

export function analyzeSections(
  sections: Section[],
  segments: Segment[],
  autoCaptions: AutoCaption[],
  visualContent: VisualContent[],
  duration: number,
  alignmentMeta: AlignmentMeta | null,
): SectionAnalysis[] {
  const parsed = sections.map((sec, idx) => {
    const start = parseTs(sec.start_time);
    const end = sec.end_time
      ? parseTs(sec.end_time)
      : idx + 1 < sections.length
      ? parseTs(sections[idx + 1].start_time)
      : duration;
    return { ...sec, startTime: start, endTime: end };
  });

  return parsed.map((sec) => {
    const dur = sec.endTime - sec.startTime;
    const secSegs = segments.filter((s) => s.start >= sec.startTime && s.start < sec.endTime);
    const secCaps = autoCaptions.filter((c) => c.start >= sec.startTime && c.start < sec.endTime);
    const secVc = visualContent.filter((v) => v.start >= sec.startTime && v.start < sec.endTime);

    const transcriptWords = secSegs.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
    const captionWords = secCaps.reduce((sum, c) => sum + c.text.split(/\s+/).length, 0);
    const coverage = captionWords > 0 ? transcriptWords / captionWords : 1;
    const wpm = dur > 0 ? transcriptWords / (dur / 60) : 0;
    const captionWpm = dur > 0 ? captionWords / (dur / 60) : 0;

    let gapSeconds = 0;
    let longestGap = 0;
    const sorted = [...secSegs].sort((a, b) => a.start - b.start);
    if (sorted.length > 0) {
      const startGap = sorted[0].start - sec.startTime;
      if (startGap > 5) { gapSeconds += startGap; longestGap = Math.max(longestGap, startGap); }
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].start - sorted[i - 1].end;
        if (gap > 5) { gapSeconds += gap; longestGap = Math.max(longestGap, gap); }
      }
      const endGap = sec.endTime - sorted[sorted.length - 1].end;
      if (endGap > 5) { gapSeconds += endGap; longestGap = Math.max(longestGap, endGap); }
    } else {
      gapSeconds = dur;
      longestGap = dur;
    }

    const eqCount = secVc.filter((v) => v.contentType === "equation").length;
    const lowConfCount = secVc.filter((v) => v.confidence < 0.85).length;
    const avgConfidence = secVc.length > 0
      ? secVc.reduce((sum, v) => sum + v.confidence, 0) / secVc.length
      : 1;

    let wordCoverage: number;
    let sectionUnmatched: UnmatchedRefWord[];
    if (alignmentMeta?.unmatched_ref_words) {
      sectionUnmatched = alignmentMeta.unmatched_ref_words.filter(
        (w) => w.time >= sec.startTime && w.time < sec.endTime,
      );
      const sectionRefWords = captionWords;
      wordCoverage =
        sectionRefWords > 0 ? Math.max(0, 1 - sectionUnmatched.length / sectionRefWords) : 1;
    } else {
      const wc = computeWordCoverage(secSegs, secCaps);
      wordCoverage = wc.total > 0 ? wc.matched / wc.total : 1;
      sectionUnmatched = wc.unmatchedWords.map((uw) => ({ time: uw.time, word: uw.word }));
    }

    const issues: string[] = [];
    let sev = 0;
    if (coverage < 0.5) {
      sev = 2;
      issues.push(`${Math.round(coverage * 100)}% coverage (${transcriptWords}/${captionWords})`);
    } else if (coverage < 0.8) {
      sev = Math.max(sev, 1);
      issues.push(`${Math.round(coverage * 100)}% coverage`);
    }
    if (wpm < 30 && captionWpm > 60) {
      sev = 2;
      issues.push(`${Math.round(wpm)} wpm vs ${Math.round(captionWpm)} wpm expected`);
    }
    if (longestGap > 60) {
      sev = Math.max(sev, 1);
      issues.push(`${formatTime(longestGap)} gap`);
    }
    if (lowConfCount > 0) {
      sev = Math.max(sev, 1);
      issues.push(`${lowConfCount} low-conf`);
    }
    const severity: Severity = sev === 2 ? "critical" : sev === 1 ? "warning" : "ok";

    return {
      title: sec.title,
      startTime: sec.startTime,
      endTime: sec.endTime,
      duration: dur,
      transcriptWords,
      captionWords,
      coverage,
      wpm,
      captionWpm,
      segmentCount: secSegs.length,
      gapSeconds,
      longestGap,
      vcItems: secVc.length,
      eqCount,
      lowConfCount,
      avgConfidence,
      wordCoverage,
      unmatchedWords: sectionUnmatched,
      severity,
      issues,
      segments: secSegs,
      captions: secCaps,
      visualContentItems: secVc,
    };
  });
}

export interface InterleavedRow {
  time: number;
  source: "gemini" | "youtube" | "gap";
  text: string;
  gapStart?: number;
  gapEnd?: number;
}

export function buildInterleavedTranscript(
  segments: Segment[],
  captions: AutoCaption[],
  startTime: number,
  endTime: number,
): InterleavedRow[] {
  const rows: InterleavedRow[] = [];
  const geminiRanges = segments.map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);

  let cursor = startTime;
  for (const seg of geminiRanges) {
    if (seg.start > cursor + 3) {
      const gapCaps = captions.filter((c) => c.start >= cursor && c.start < seg.start);
      if (gapCaps.length > 0) {
        for (const cap of gapCaps) {
          rows.push({ time: cap.start, source: "gap", text: cap.text, gapStart: cursor, gapEnd: seg.start });
        }
      } else {
        rows.push({
          time: cursor,
          source: "gap",
          text: "(silence — no YouTube captions either)",
          gapStart: cursor,
          gapEnd: seg.start,
        });
      }
    }
    cursor = Math.max(cursor, seg.end);
  }
  if (cursor < endTime - 3) {
    const gapCaps = captions.filter((c) => c.start >= cursor && c.start < endTime);
    for (const cap of gapCaps) {
      rows.push({ time: cap.start, source: "gap", text: cap.text, gapStart: cursor, gapEnd: endTime });
    }
  }

  for (const seg of segments) {
    rows.push({ time: seg.start, source: "gemini", text: seg.text });
  }

  rows.sort((a, b) => a.time - b.time);
  return rows;
}

export { parseInlineLatex } from "./parse-inline-latex";

export interface PerTypeHealth {
  type: string;
  count: number;
  healed: number;
  unhealable: number;
}

export function aggregatePerType(items: VisualContent[]): PerTypeHealth[] {
  const buckets = new Map<string, PerTypeHealth>();
  for (const item of items) {
    const b = buckets.get(item.contentType) || {
      type: item.contentType,
      count: 0,
      healed: 0,
      unhealable: 0,
    };
    b.count++;
    if (item.repairStatus === "fixed") b.healed++;
    else if (item.repairStatus === "skipped") b.unhealable++;
    buckets.set(item.contentType, b);
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}
