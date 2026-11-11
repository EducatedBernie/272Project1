import type { VisualContent } from "./types";

export interface NoteBlock {
  text: string;
  citations: string[];
  artifacts?: { source_id: string; caption: string }[];
}

export interface NoteSource {
  id: string;
  kind: "transcript" | "visual";
  start: number;
  end: number;
  text: string;
  visual?: VisualContent;
  illustration?: {
    status: "ready" | "full_frame" | "unavailable";
    frame?: {
      id: string;
      url: string;
      key: string;
      sha256: string;
      width: number;
      height: number;
      requested_time: number;
    };
    box_2d?: [number, number, number, number];
    model?: string;
    prompt_version: string;
    issue?: string;
  };
}

export interface NotesLayer {
  title: string;
  overview: NoteBlock[];
  sections: { id: string; title: string; blocks: NoteBlock[] }[];
}

export interface NotesDocument extends NotesLayer {
  version: 1;
  condensed?: NotesLayer;
  sources: NoteSource[];
}

export interface NotesJob {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  notes: NotesDocument | null;
  error: string | null;
  created_at: string;
  source_run_id: string;
}
