import type { Segment, VisualContent, AnchoredSegment } from "./types";

export function anchorVisualsToSegments(
  segments: Segment[],
  visuals: VisualContent[]
): AnchoredSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const anchored: AnchoredSegment[] = sorted.map((s) => ({ ...s, visuals: [] }));

  for (const v of visuals) {
    let idx = anchored.findIndex(
      (s) => s.start <= v.start && v.start <= s.end
    );
    if (idx === -1) idx = anchored.findIndex((s) => s.start >= v.start);
    if (idx === -1) idx = anchored.length - 1;
    if (idx === -1) continue;
    anchored[idx].visuals.push(v);
  }

  for (const s of anchored) s.visuals.sort((a, b) => a.start - b.start);
  return anchored;
}
