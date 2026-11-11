export interface Equation {
  id: string;
  latex: string;
  description: string;
  confidence: number;
  start: number;
  end: number;
}

export interface TextBlock {
  kind: "heading" | "paragraph" | "bullet";
  text: string;
  depth: number; // 0 = top-level, 1 = sub-bullet
}

export type RepairStatus = "fixed" | "skipped";

export interface VisualContent {
  id: string;
  contentType: string;
  description: string;
  confidence: number;
  start: number;
  end: number;
  latex?: string;
  code?: string;
  language?: string;
  purpose?: string;
  structure?: string[];
  headers?: string[];
  rows?: string[][];
  title?: string;
  caption?: string;
  textBlocks?: TextBlock[];
  section?: string;
  // Debug signals — populated from content_metadata for the /debug page.
  // visualObservation: Gemini's pre-classification prose from v0.5.0
  // describe-first prompting. Best diagnostic signal when an item's
  // content_type or fields look wrong.
  visualObservation?: string;
  // repairStatus: written by the deterministic healer.
  //   "fixed"   — healer rewrote the item from a known misplacement pattern
  //   "skipped" — validator flagged an error but no heal rule matched
  //               (perception failure — content genuinely missing)
  //   undefined — item was clean off the line (the common case)
  repairStatus?: RepairStatus;
}

export interface Segment {
  id: string;
  text: string;
  start: number;
  end: number;
}

export type YouTubeSource = { type: "youtube"; videoId: string };
export type UploadSource = { type: "upload"; videoUrl: string };
export type VideoSource = YouTubeSource | UploadSource;

export interface AnchoredSegment extends Segment {
  visuals: VisualContent[];
}
