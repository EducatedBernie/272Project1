/**
 * /debug page top-level layout — Workflow Rail (Mode A).
 *
 * Design principle: this page is a developer tool. It surfaces
 * EVERYTHING — every visual content item, every caption, every section.
 * Items needing attention are flagged inline; nothing is hidden. Filters
 * are opt-in narrowing. Devs decide what to investigate; we don't curate.
 *
 * Single-mount player: <MiniViewer> stays at one stable JSX position; mode
 * tab clicks vary state but not the component tree, so the YouTube iframe
 * doesn't re-init.
 *
 * Timestamp deeplink: when entered with `?t=<seconds>`, the player seeks
 * there and the worklist auto-selects the artifact active at that time
 * (or closest by start time if nothing is active). Lets the dev jump
 * from the regular viewer's current playhead straight into the matching
 * /debug context.
 */

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type PlayerHandle } from "./VideoPlayer";
import DebugHeader from "./debug/DebugHeader";
import VerticalTimeline from "./debug/VerticalTimeline";
import StatStrip from "./debug/StatStrip";
import ModeTabs, { type DebugMode } from "./debug/ModeTabs";
import { PerTypeHealthStrip } from "./debug/badges";
import FilterChips from "./debug/FilterChips";
import ArtifactWorklist from "./debug/IssueWorklist";
import ArtifactDetail from "./debug/ArtifactDetail";
import MiniViewer, {
  type MiniRect,
  MIN_WIDTH as MINI_MIN_WIDTH,
  MIN_HEIGHT as MINI_MIN_HEIGHT,
} from "./debug/MiniViewer";
import SyncedTranscripts from "./debug/SyncedTranscripts";
import SectionsView from "./debug/SectionsView";
import RawCallsView from "./debug/RawCallsView";

import {
  type AutoCaption,
  type Section,
  type Segment,
  analyzeSections,
} from "@/lib/debug-utils";
import { type AlignmentMeta } from "@/lib/alignment-meta";
import { type UsageSummary } from "@/lib/usage";
import { type GeminiCallLogsManifest } from "@/lib/gemini-call-logs";
import {
  type ArtifactFilter,
  filterArtifacts,
  findArtifactAt,
  findNextArtifact,
} from "@/lib/issues";
import type { VideoSource, VisualContent } from "@/lib/types";

interface DebugViewProps {
  videoId: string;
  source: VideoSource;
  title: string;
  duration: number;
  segments: Segment[];
  autoCaptions: AutoCaption[];
  visualContent: VisualContent[];
  sections: Section[];
  scopedReextractions: VisualContent[];
  alignmentMeta: AlignmentMeta | null;
  runId: string | null;
  usageSummary: UsageSummary | null;
  geminiCallLogs: GeminiCallLogsManifest | null;
  /** Seconds to start the player at, if any. From `?t=` query param. */
  initialTime?: number;
}

const MODE_KEY = "chalkboard:debug:mode";
const RECT_KEY = "chalkboard:debug:miniRect";
const WORKLIST_WIDTH = 360;
const DEFAULT_RECT_WIDTH = 320;
const DEFAULT_RECT_HEIGHT = 180;
const RECT_MARGIN = 16;
// Keep at least this many px of the player visible after a clamp so the
// drag handle is reachable even if the user resized the window down.
const MIN_VISIBLE = 80;

function defaultRect(): MiniRect {
  if (typeof window === "undefined") {
    return { x: 0, y: 0, width: DEFAULT_RECT_WIDTH, height: DEFAULT_RECT_HEIGHT };
  }
  return {
    width: DEFAULT_RECT_WIDTH,
    height: DEFAULT_RECT_HEIGHT,
    x: Math.max(0, window.innerWidth - DEFAULT_RECT_WIDTH - RECT_MARGIN),
    y: Math.max(0, window.innerHeight - DEFAULT_RECT_HEIGHT - RECT_MARGIN),
  };
}

function clampRect(r: MiniRect, viewportW: number, viewportH: number): MiniRect {
  const width = Math.max(MINI_MIN_WIDTH, Math.min(r.width, viewportW));
  const height = Math.max(MINI_MIN_HEIGHT, Math.min(r.height, viewportH));
  // Allow the player to overhang slightly off the left/top, but always
  // keep MIN_VISIBLE px reachable on each axis so the drag handle isn't
  // stranded.
  const x = Math.max(MIN_VISIBLE - width, Math.min(r.x, viewportW - MIN_VISIBLE));
  const y = Math.max(0, Math.min(r.y, viewportH - MIN_VISIBLE));
  return { x, y, width, height };
}

function isMiniRect(v: unknown): v is MiniRect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

function isMode(v: string | null): v is DebugMode {
  return v === "artifacts" || v === "captions" || v === "sections" || v === "raw";
}

function readModePref(): DebugMode {
  if (typeof window === "undefined") return "artifacts";
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    if (isMode(v)) return v;
  } catch {
    /* localStorage unavailable */
  }
  return "artifacts";
}

function readRectPref(): MiniRect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isMiniRect(parsed)) return null;
    return clampRect(parsed, window.innerWidth, window.innerHeight);
  } catch {
    return null;
  }
}

export default function DebugView({
  videoId,
  source,
  title,
  duration,
  segments,
  autoCaptions,
  visualContent,
  scopedReextractions,
  sections,
  alignmentMeta,
  runId,
  usageSummary,
  geminiCallLogs,
  initialTime = 0,
}: DebugViewProps) {
  const [mode, setMode] = useState<DebugMode>(readModePref);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  // Nullable on the server / pre-hydration. Resolved on mount so the
  // initial position is computed from the real viewport rather than
  // the SSR placeholder where `window` is undefined.
  const [miniRect, setMiniRect] = useState<MiniRect | null>(null);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const playerRef = useRef<PlayerHandle>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMiniRect(readRectPref() ?? defaultRect());
  }, []);

  // Re-clamp the rect on window resize so a saved off-screen position
  // snaps back into view. Only fires when the rect actually changes.
  useEffect(() => {
    const onResize = () => {
      setMiniRect((prev) => {
        if (!prev) return prev;
        const next = clampRect(prev, window.innerWidth, window.innerHeight);
        if (
          next.x === prev.x &&
          next.y === prev.y &&
          next.width === prev.width &&
          next.height === prev.height
        ) {
          return prev;
        }
        try {
          window.localStorage.setItem(RECT_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleRectChange = useCallback((next: MiniRect) => {
    const clamped =
      typeof window === "undefined"
        ? next
        : clampRect(next, window.innerWidth, window.innerHeight);
    setMiniRect(clamped);
    try {
      window.localStorage.setItem(RECT_KEY, JSON.stringify(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const handleResetRect = useCallback(() => {
    const next = defaultRect();
    setMiniRect(next);
    try {
      window.localStorage.removeItem(RECT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Items sorted by start. Keep stable across renders so the worklist
  // and timeline see the same order.
  const sortedItems = useMemo(
    () => [...visualContent].sort((a, b) => a.start - b.start),
    [visualContent],
  );

  // Auto-select artifact at initialTime on first mount. Lazy initial
  // state — runs once, before the first paint, so the right pane already
  // shows the right item before any user action.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() => {
    if (initialTime <= 0) return null;
    const found = findArtifactAt(
      [...visualContent].sort((a, b) => a.start - b.start),
      initialTime,
    );
    return found?.id ?? null;
  });

  const handleModeChange = useCallback((next: DebugMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const handleTimeUpdate = useCallback((time: number) => setCurrentTime(time), []);
  const handleSeek = useCallback((time: number) => {
    playerRef.current?.seekTo(time);
    setCurrentTime(time);
  }, []);

  const analysis = useMemo(
    () => analyzeSections(sections, segments, autoCaptions, visualContent, duration, alignmentMeta),
    [sections, segments, autoCaptions, visualContent, duration, alignmentMeta],
  );
  const filteredItems = useMemo(
    () => filterArtifacts(sortedItems, filter),
    [sortedItems, filter],
  );

  // Effective selection is derived: if the user-selected id is filtered
  // out (or never set), fall back to the closest item by current time,
  // else the first one. No useEffect → no cascading renders.
  const effectiveSelectedId = useMemo(() => {
    if (filteredItems.length === 0) return null;
    if (selectedItemId && filteredItems.find((i) => i.id === selectedItemId)) {
      return selectedItemId;
    }
    const found = findArtifactAt(filteredItems, currentTime);
    return found?.id ?? filteredItems[0].id;
  }, [filteredItems, selectedItemId, currentTime]);

  const selectedItem =
    filteredItems.find((i) => i.id === effectiveSelectedId) ?? null;

  const handleSkip = useCallback(() => {
    const nextId = findNextArtifact(filteredItems, effectiveSelectedId);
    if (nextId) {
      setSelectedItemId(nextId);
      const next = filteredItems.find((i) => i.id === nextId);
      if (next) handleSeek(next.start);
    }
  }, [filteredItems, effectiveSelectedId, handleSeek]);

  const handleSelectItem = useCallback(
    (id: string) => {
      setSelectedItemId(id);
      const item = sortedItems.find((i) => i.id === id);
      if (item) handleSeek(item.start);
    },
    [sortedItems, handleSeek],
  );

  return (
    <div
      className="flex flex-col"
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      <DebugHeader
        videoId={videoId}
        title={title}
        duration={duration}
        currentTime={currentTime}
        runId={runId}
        usageSummary={usageSummary}
        geminiCallLogs={geminiCallLogs}
      />

      <div className="flex flex-1 min-h-0">
        <VerticalTimeline
          duration={duration}
          currentTime={currentTime}
          items={sortedItems}
          sections={analysis}
          selectedItemId={effectiveSelectedId}
          onSeek={handleSeek}
          onSelectItem={handleSelectItem}
        />

        <div className="flex-1 flex flex-col min-w-0 relative">
          <div
            className="px-4 py-3 shrink-0 space-y-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <StatStrip
              duration={duration}
              segmentCount={segments.length}
              visualContent={visualContent}
              analysis={analysis}
              alignmentMeta={alignmentMeta}
            />
            <PerTypeHealthStrip items={visualContent} />
          </div>

          <ModeTabs
            mode={mode}
            onChange={handleModeChange}
            // Tab counts reflect the size of each *mode body*. Artifacts =
            // every visual content item; Captions = whichever transcript
            // stream is present (YT auto-captions, falling back to Gemini
            // segments); Sections = total sections. None of these are
            // issue counts — flags happen inline on the rows.
            artifactCount={visualContent.length}
            captionCount={autoCaptions.length || segments.length}
            sectionCount={analysis.length}
            rawCallCount={geminiCallLogs?.calls.length ?? 0}
          />

          {mode === "artifacts" ? (
            <div className="flex flex-1 min-h-0">
              <div
                className="flex flex-col shrink-0 min-h-0"
                style={{
                  width: WORKLIST_WIDTH,
                  borderRight: "1px solid var(--border)",
                  background: "var(--card)",
                }}
              >
                <FilterChips filter={filter} onChange={setFilter} items={sortedItems} />
                <ArtifactWorklist
                  items={filteredItems}
                  selectedId={effectiveSelectedId}
                  currentTime={currentTime}
                  onSelect={handleSelectItem}
                />
              </div>

              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                {selectedItem ? (
                  <ArtifactDetail
                    item={selectedItem}
                    videoId={videoId}
                    segments={segments}
                    visualContent={visualContent}
                    scopedReextractions={scopedReextractions}
                    sections={sections}
                    hasNext={
                      findNextArtifact(filteredItems, effectiveSelectedId) !== null
                    }
                    onSkip={handleSkip}
                  />
                ) : visualContent.length === 0 ? (
                  <div
                    className="flex-1 flex items-center justify-center text-sm italic p-6 text-center"
                    style={{ color: "var(--muted-fg)" }}
                  >
                    This run produced no visual content.
                  </div>
                ) : (
                  <div
                    className="flex-1 flex flex-col items-center justify-center text-sm italic p-6 gap-2 text-center"
                    style={{ color: "var(--muted-fg)" }}
                  >
                    <p>No items match the &ldquo;needs attention&rdquo; filter.</p>
                    <button
                      type="button"
                      onClick={() => setFilter("all")}
                      className="underline"
                      style={{ color: "var(--foreground)" }}
                    >
                      Show all {visualContent.length}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : mode === "captions" ? (
            <SyncedTranscripts
              segments={segments}
              autoCaptions={autoCaptions}
              alignmentMeta={alignmentMeta}
              currentTime={currentTime}
              onSeek={handleSeek}
            />
          ) : mode === "sections" ? (
            <SectionsView
              analysis={analysis}
              sections={sections}
              segments={segments}
              videoId={videoId}
              runId={runId}
              geminiCallLogs={geminiCallLogs}
              onSeek={handleSeek}
            />
          ) : (
            <RawCallsView
              logs={geminiCallLogs}
              sections={sections}
              runId={runId}
            />
          )}

          {miniRect && (
            <MiniViewer
              ref={playerRef}
              source={source}
              rect={miniRect}
              onRectChange={handleRectChange}
              onReset={handleResetRect}
              onTimeUpdate={handleTimeUpdate}
              currentTime={currentTime}
              startAt={initialTime > 0 ? initialTime : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
