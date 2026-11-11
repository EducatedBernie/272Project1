"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import VideoPlayer, { type PlayerHandle } from "@/components/VideoPlayer";
import FocusCard, { VisualsPanel } from "@/components/viewer/FocusCard";
import SegmentList from "@/components/viewer/SegmentList";
import MobileTabBar from "@/components/viewer/MobileTabBar";
import { anchorVisualsToSegments } from "@/lib/anchor";
import { getPreferredScrollBehavior } from "@/lib/motion";
import { useIsMobile } from "@/lib/use-media-query";
import type {
  AnchoredSegment,
  Equation,
  Segment,
  VisualContent,
  VideoSource,
} from "@/lib/types";

interface AutoCaption {
  start: number;
  end: number;
  text: string;
}

interface Section {
  start_time: string;
  title: string;
  description: string;
}

interface DemoData {
  videoId?: string;
  videoUrl?: string;
  title: string;
  segments: Segment[];
  equations: Equation[];
  visualContent?: VisualContent[];
  autoCaptions: AutoCaption[];
  sections?: Section[];
}

const DEMOS: {
  id: string;
  label: string;
  description: React.ReactNode;
  startAt: number;
}[] = [
  {
    id: "qyP1xZCB62E",
    label: "Physics Lecture",
    description:
      "Walter Lewin's MIT physics lecture — dense equations on the chalkboard rendered as fractions, integrals, and Greek symbols in real time.",
    startAt: 686,
  },
  {
    id: "NRbdymYpL9s",
    label: "Silent Board Work",
    description: (
      <>
        I write <strong>without narrating</strong>. Standard captions capture nothing — Chalkboard extracts every step of the quadratic formula derivation.
      </>
    ),
    startAt: 35,
  },
  {
    id: "kd0xTfdt6qw",
    label: "Feynman (1964)",
    description: (
      <>
        The board is <strong>barely legible to a human eye</strong> and Feynman <strong>never speaks the equation</strong>. Chalkboard extracts the full angular momentum derivation through pure visual comprehension.
      </>
    ),
    startAt: 1290,
  },
  {
    id: "0JUN9aDxVmI",
    label: "Advanced Algorithms",
    description: (
      <>
        Harvard CS 224, Lecture 1 — a slide-driven theory lecture. Chalkboard captures the full <strong>spoken transcript</strong>, the <strong>slide content</strong> as text, and pseudocode blocks as code.
      </>
    ),
    startAt: 5,
  },
  {
    id: "JAf_aSIJryg",
    label: "Partial Derivatives",
    description:
      "A full 60-minute calculus lecture. 567 transcript segments word-aligned against YouTube captions. 179 equations extracted.",
    startAt: 7,
  },
];

const DEMO_IDS: readonly string[] = DEMOS.map((d) => d.id);

function demoTabId(id: string): string {
  return `demo-tab-${id}`;
}

function demoPanelId(id: string): string {
  return `demo-panel-${id}`;
}

function AutoCaptionPanel({
  captions,
  currentTime,
}: {
  captions: AutoCaption[];
  currentTime: number;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  let activeIndex = -1;
  for (let i = 0; i < captions.length; i++) {
    if (captions[i].start <= currentTime) activeIndex = i;
    else break;
  }

  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const c = containerRef.current;
      const el = activeRef.current;
      c.scrollTo({
        top: el.offsetTop - c.offsetTop - c.clientHeight / 3,
        behavior: getPreferredScrollBehavior(),
      });
    }
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto px-3 py-2 space-y-1"
      tabIndex={0}
      aria-live="off"
      aria-label="Standard captions"
    >
      {captions.map((cap, i) => {
        const isActive = i === activeIndex;
        return (
          <div
            key={i}
            ref={isActive ? activeRef : null}
            className="rounded px-2 py-1.5 transition-all duration-300"
            style={{
              background: isActive ? "var(--active)" : "transparent",
              borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <p
              className="text-xs leading-relaxed"
              style={{
                fontFamily: "var(--font-mono)",
                color: isActive ? "var(--foreground)" : "var(--ink-2)",
              }}
            >
              {cap.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function getVideoSource(data: DemoData): VideoSource {
  if (data.videoUrl) return { type: "upload", videoUrl: data.videoUrl };
  return { type: "youtube", videoId: data.videoId! };
}

function buildVisuals(data: DemoData): VisualContent[] {
  if (data.visualContent) {
    return data.visualContent.map((v) => ({
      ...v,
      start: Number(v.start),
      end: Number(v.end),
      confidence: Number(v.confidence),
    }));
  }
  return data.equations.map((e) => ({
    id: e.id,
    contentType: "equation",
    description: e.description,
    confidence: Number(e.confidence),
    start: Number(e.start),
    end: Number(e.end),
    latex: e.latex,
  }));
}

function buildAnchoredSegments(
  data: DemoData,
  visuals: VisualContent[]
): AnchoredSegment[] {
  const segments: Segment[] = data.segments.map((s) => ({
    ...s,
    start: Number(s.start),
    end: Number(s.end),
  }));
  return anchorVisualsToSegments(segments, visuals);
}

export default function DemoViewer() {
  const [activeDemo, setActiveDemo] = useState(DEMOS[0].id);
  const [data, setData] = useState<DemoData | null>(null);
  const [anchored, setAnchored] = useState<AnchoredSegment[]>([]);
  const [visuals, setVisuals] = useState<VisualContent[]>([]);
  const [currentTime, setCurrentTime] = useState(DEMOS[0].startAt);
  const [selectedStartAt, setSelectedStartAt] = useState(DEMOS[0].startAt);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"compare" | "transcript" | "outputs">("compare");
  const playerRef = useRef<PlayerHandle>(null);
  const demoTabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const isMobile = useIsMobile();

  const selectDemo = useCallback((id: string, startAt?: number) => {
    const start = startAt ?? DEMOS.find((demo) => demo.id === id)?.startAt ?? 0;
    setCurrentTime(start);

    if (id === activeDemo) {
      playerRef.current?.seekTo(start);
      return;
    }

    setSelectedStartAt(start);
    setLoading(true);
    setLoadError(null);
    setData(null);
    setAnchored([]);
    setVisuals([]);
    setActiveDemo(id);
  }, [activeDemo]);

  const handleDemoKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = DEMOS.findIndex((demo) => demo.id === activeDemo);
      let nextIdx = idx;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % DEMOS.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + DEMOS.length) % DEMOS.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = DEMOS.length - 1;
      else return;

      e.preventDefault();
      const nextDemo = DEMOS[nextIdx];
      selectDemo(nextDemo.id, nextDemo.startAt);
      demoTabRefs.current.get(nextDemo.id)?.focus();
    },
    [activeDemo, selectDemo]
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.id || !DEMO_IDS.includes(detail.id)) return;
      selectDemo(detail.id, detail.startAt);
    };
    window.addEventListener("chalkboard-demo-select", handler);
    return () => window.removeEventListener("chalkboard-demo-select", handler);
  }, [selectDemo]);

  useEffect(() => {
    if (!DEMO_IDS.includes(activeDemo)) return;
    const controller = new AbortController();

    fetch(`/demo/${activeDemo}.json`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: DemoData) => {
        d.autoCaptions = (d.autoCaptions || []).map((c) => ({
          ...c,
          start: Number(c.start),
          end: Number(c.end),
        }));
        setData(d);
        const v = buildVisuals(d);
        setVisuals(v);
        setAnchored(buildAnchoredSegments(d, v));
        setLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setLoadError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, [activeDemo]);

  const handleTimeUpdate = useCallback((t: number) => setCurrentTime(t), []);
  const handleSeek = useCallback((t: number) => {
    playerRef.current?.seekTo(t);
    setCurrentTime(t);
  }, []);

  const activeDemoMeta = DEMOS.find((d) => d.id === activeDemo)!;
  const sections = data?.sections ?? null;

  return (
    <section
      id="live"
      className="px-6 md:px-10 py-14 md:py-16"
      style={{ background: "var(--background)", borderTop: "1px solid var(--rule)" }}
    >
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:[grid-template-columns:1fr_2fr] gap-4 md:gap-10 mb-7">
          <div>
            <div
              className="text-[11px] uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.14em",
                color: "var(--muted-fg)",
              }}
            >
              02 · See it work
            </div>
            <h2
              className="mt-2 mb-0"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 400,
                fontSize: "clamp(28px, 3.6vw, 44px)",
                lineHeight: 1.04,
                letterSpacing: "-0.02em",
                textWrap: "balance",
                maxWidth: "18ch",
                color: "var(--foreground)",
              }}
            >
              Pick a lecture and{" "}
              <em style={{ fontStyle: "italic", color: "var(--accent-2)" }}>
                see it render.
              </em>
            </h2>
          </div>
          <p
            className="m-0 text-[15.5px] leading-[1.55] max-w-[60ch]"
            style={{ color: "var(--muted-fg)", textWrap: "pretty" }}
          >
            Real lectures — chalkboard, whiteboard, tablet, 1960s film. Click any
            transcript line to seek. Compare the standard captions (grey) to
            Chalkboard&apos;s rendered transcript (orange).
          </p>
        </div>

        <div
          className="flex gap-2 mb-4 justify-center flex-wrap"
          role="tablist"
          aria-label="Demo lectures"
        >
          {DEMOS.map((demo) => {
            const isActive = activeDemo === demo.id;
            return (
              <button
                key={demo.id}
                id={demoTabId(demo.id)}
                role="tab"
                aria-selected={isActive}
                aria-controls={demoPanelId(demo.id)}
                tabIndex={isActive ? 0 : -1}
                ref={(el) => {
                  if (el) demoTabRefs.current.set(demo.id, el);
                  else demoTabRefs.current.delete(demo.id);
                }}
                onClick={() => selectDemo(demo.id, demo.startAt)}
                onKeyDown={handleDemoKeyDown}
                className="px-5 py-2.5 text-[14px] font-semibold transition-all rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={
                  isActive
                    ? {
                        background: "var(--accent-2)",
                        color: "#fff",
                        boxShadow: "0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent)",
                      }
                    : {
                        background: "var(--card)",
                        color: "var(--muted-fg)",
                        border: "1px solid var(--border)",
                      }
                }
              >
                {demo.label}
              </button>
            );
          })}
        </div>

        <div
          id={demoPanelId(activeDemo)}
          role="tabpanel"
          aria-labelledby={demoTabId(activeDemo)}
        >
          <p
            className="text-[15px] text-center mb-5 max-w-3xl mx-auto"
            style={{ color: "var(--foreground)" }}
          >
            {activeDemoMeta.description}
          </p>

          <div
            className="rounded-xl overflow-hidden flex flex-col md:flex-row"
            style={{ border: "1px solid var(--border)", height: "70vh" }}
          >
          {loadError ? (
            <div
              className="flex flex-col items-center justify-center flex-1 gap-2 px-4 text-center"
              style={{ color: "var(--muted-fg)" }}
              role="alert"
            >
              <span className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                Demo failed to load
              </span>
              <span className="text-xs" style={{ fontFamily: "var(--font-mono)" }}>
                {loadError}
              </span>
            </div>
          ) : loading || !data ? (
            <div className="flex items-center justify-center flex-1" style={{ color: "var(--muted-fg)" }}>
              Loading demo...
            </div>
          ) : isMobile ? (
            // Mobile: sticky video on top, tabbed panel, bottom tab bar.
            // Conditional render keeps the YouTube iframe to a single instance — see review #1.
            <div className="flex flex-1 flex-col min-h-0 w-full">
              <div className="bg-black shrink-0">
                <VideoPlayer
                  key={activeDemo}
                  ref={playerRef}
                  source={getVideoSource(data)}
                  onTimeUpdate={handleTimeUpdate}
                  startAt={selectedStartAt}
                  title={data.title || activeDemoMeta.label}
                />
              </div>

              <div
                className="flex-1 min-h-0 relative"
                style={{ background: "var(--card)", borderTop: "1px solid var(--border)" }}
              >
                <div
                  id="mobile-panel-compare"
                  role="tabpanel"
                  aria-labelledby="mobile-tab-compare"
                  className="absolute inset-0 flex flex-col"
                  style={{ display: mobileTab === "compare" ? "flex" : "none" }}
                >
                  <div style={{ height: "30%", borderBottom: "1px solid var(--border)" }} className="flex flex-col">
                    <div
                      className="px-3 py-1.5 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-center"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--muted-fg)",
                        borderBottom: "1px solid var(--border)",
                        background: "var(--card)",
                      }}
                    >
                      Standard captions
                    </div>
                    <div className="flex-1 min-h-0" style={{ background: "var(--card)" }}>
                      <AutoCaptionPanel captions={data.autoCaptions} currentTime={currentTime} />
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col min-h-0">
                    <div
                      className="px-3 py-1.5 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-center"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--accent-2)",
                        borderBottom: "1px solid var(--border)",
                        background: "var(--card)",
                      }}
                    >
                      Chalkboard Transcript
                    </div>
                    <div className="flex-1 min-h-0">
                      <SegmentList
                        segments={anchored}
                        sections={sections}
                        currentTime={currentTime}
                        onSeek={handleSeek}
                      />
                    </div>
                  </div>
                </div>

                <div
                  id="mobile-panel-transcript"
                  role="tabpanel"
                  aria-labelledby="mobile-tab-transcript"
                  className="absolute inset-0"
                  style={{ display: mobileTab === "transcript" ? "block" : "none" }}
                >
                  <SegmentList
                    segments={anchored}
                    sections={sections}
                    currentTime={currentTime}
                    onSeek={handleSeek}
                  />
                </div>

                <div
                  id="mobile-panel-outputs"
                  role="tabpanel"
                  aria-labelledby="mobile-tab-outputs"
                  className="absolute inset-0"
                  style={{ display: mobileTab === "outputs" ? "block" : "none" }}
                >
                  <VisualsPanel
                    visuals={visuals}
                    sections={sections}
                    currentTime={currentTime}
                  />
                </div>
              </div>

              <MobileTabBar
                tabs={[
                  { key: "compare", label: "Compare" },
                  { key: "transcript", label: "Transcript", count: anchored.length },
                  { key: "outputs", label: "Outputs", count: visuals.length },
                ]}
                active={mobileTab}
                onChange={setMobileTab}
              />
            </div>
          ) : (
            <>
              <div className="flex w-[55%] shrink-0 flex-col min-h-0">
                <FocusCard
                  key={activeDemo}
                  ref={playerRef}
                  source={getVideoSource(data)}
                  visuals={visuals}
                  sections={sections}
                  currentTime={currentTime}
                  onTimeUpdate={handleTimeUpdate}
                  startAt={selectedStartAt}
                  title={data.title || activeDemoMeta.label}
                />
              </div>

              <div
                className="flex flex-1 flex-col min-h-0 border-l"
                style={{ borderColor: "var(--border)" }}
              >
                <div style={{ height: "30%", borderBottom: "1px solid var(--border)" }} className="flex flex-col">
                  <div
                    className="px-3 py-1.5 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-center"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--muted-fg)",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--card)",
                    }}
                  >
                    Standard captions
                  </div>
                  <div className="flex-1 min-h-0" style={{ background: "var(--card)" }}>
                    <AutoCaptionPanel captions={data.autoCaptions} currentTime={currentTime} />
                  </div>
                </div>

                <div className="flex-1 flex flex-col min-h-0">
                  <div
                    className="px-3 py-1.5 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-center"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--accent-2)",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--card)",
                    }}
                  >
                    Chalkboard Transcript
                    <span className="font-normal normal-case" style={{ color: "var(--muted-fg)" }}>
                      {" "}— click any line to seek
                    </span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <SegmentList
                      segments={anchored}
                      sections={sections}
                      currentTime={currentTime}
                      onSeek={handleSeek}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
          </div>
        </div>
      </div>
    </section>
  );
}
