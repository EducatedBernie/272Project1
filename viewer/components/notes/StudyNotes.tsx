"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";
import VideoPlayer, { type PlayerHandle } from "@/components/VideoPlayer";
import VisualContentBody from "@/components/VisualContentBody";
import { SegmentText } from "@/lib/inline-latex";
import { formatTime } from "@/lib/time";
import { needsAttention } from "@/lib/issues";
import { approxCost, selectUsageSummary } from "@/lib/usage";
import type { NoteBlock, NoteSource, NotesJob } from "@/lib/notes-types";
import type { VideoSource } from "@/lib/types";
import styles from "./StudyNotes.module.css";

interface StudyNotesProps {
  videoId: string;
  sourceRunId: string;
  title: string;
  source: VideoSource;
  initialJob: NotesJob | null;
}

type SourceEntry = { source: NoteSource; number: number };
const ignoreTimeUpdate = () => {};
const isTerminal = (status: string) => status === "complete" || status === "failed";
const STACKED_QUERY = "(max-width: 1050px)";
const isStacked = () => window.matchMedia(STACKED_QUERY).matches;

function frameCrop(illustration: NoteSource["illustration"]) {
  const frame = illustration?.frame;
  const box = illustration?.box_2d;
  if (illustration?.status !== "ready" || !frame?.url || !Number.isFinite(frame.width) ||
      !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0 ||
      !box || box.length !== 4 || !box.every(value => Number.isFinite(value) && value >= 0 && value <= 1000) ||
      box[2] <= box[0] || box[3] <= box[1]) return null;
  const padX = (box[3] - box[1]) * 0.05, padY = (box[2] - box[0]) * 0.05;
  const left = Math.max(0, box[1] - padX), top = Math.max(0, box[0] - padY);
  const right = Math.min(1000, box[3] + padX), bottom = Math.min(1000, box[2] + padY);
  return [left * frame.width / 1000, top * frame.height / 1000,
    (right - left) * frame.width / 1000, (bottom - top) * frame.height / 1000];
}

function SourceContent({ source, inline = false }: { source: NoteSource; inline?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const cropId = useId();
  const illustration = source.illustration;
  const frame = illustration?.frame;
  const hasImage = illustration?.status !== "unavailable" && frame?.url && failedUrl !== frame.url &&
    Number.isFinite(frame.width) && frame.width > 0 && Number.isFinite(frame.height) && frame.height > 0;
  const description = source.visual ? <VisualContentBody item={source.visual} /> : <blockquote><SegmentText text={source.text} /></blockquote>;
  const crop = frameCrop(illustration);

  if (inline && (!hasImage || !crop)) return null;
  if (!hasImage || !frame) return <>
    {illustration && <p className={styles.imageUnavailable}>Image unavailable. You can read the extracted description or review this moment in the video.</p>}
    {description}
  </>;

  const frameTime = formatTime(frame.requested_time);
  return <div data-source-id={source.id} data-frame-id={frame.id} data-frame-sha256={frame.sha256}>
    <svg viewBox={crop?.join(" ") ?? `0 0 ${frame.width} ${frame.height}`} className={styles.illustrationImage}
      role="img" aria-label={`${crop ? "Detail from the original lecture frame" : "Original lecture frame"} at ${frameTime}.${inline ? "" : ` ${source.text}`}`}>
      {crop && <defs><clipPath id={cropId}><rect x={crop[0]} y={crop[1]} width={crop[2]} height={crop[3]} /></clipPath></defs>}
      <image href={frame.url} width={frame.width} height={frame.height} clipPath={crop ? `url(#${cropId})` : undefined}
        onError={() => setFailedUrl(frame.url)} />
    </svg>
    {!inline && <p className={styles.illustrationMeta}>{crop ? "Detail from the original lecture frame" : "Original lecture frame"} · {frameTime}</p>}
    {!inline && (crop ? <details className={styles.illustrationDetails}>
      <summary>View full lecture frame</summary>
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} className={styles.illustrationImage}
        role="img" aria-label={`Full original lecture frame at ${frameTime}, containing: ${source.text}`}>
        <image href={frame.url} width={frame.width} height={frame.height} onError={() => setFailedUrl(frame.url)} />
      </svg>
    </details> : <p className={styles.illustrationMeta}>Showing the full frame because a crop is unavailable.</p>)}
    {!inline && <a className={styles.frameLink} href={frame.url} target="_blank" rel="noreferrer">Open original frame at {frameTime}</a>}
    {!inline && <details className={styles.illustrationDetails}>
      <summary>Read the extracted description</summary>
      {description}
    </details>}
  </div>;
}

function CitedParagraph({ block, sources, selectedId, onSelect }: {
  block: NoteBlock;
  sources: Map<string, SourceEntry>;
  selectedId: string | null;
  onSelect: (id: string, button: HTMLButtonElement) => void;
}) {
  return (
    <>
      <p className={styles.paragraph}>
        <SegmentText text={block.text} />
        {block.citations.map((id) => {
          const entry = sources.get(id);
          if (!entry) return null;
          return (
            <button
              key={id}
              type="button"
              className={styles.citation}
              aria-label={`Source ${entry.number}: ${entry.source.kind}, ${formatTime(entry.source.start)}`}
              aria-controls="notes-source"
              aria-pressed={selectedId === id}
              onClick={(event) => onSelect(id, event.currentTarget)}
            >
              {entry.number}
            </button>
          );
        })}
      </p>
      {block.artifacts?.map((artifact) => {
        const entry = sources.get(artifact.source_id);
        const visual = entry?.source.visual;
        if (!entry || !visual) return null;
        const equation = visual.contentType === "equation";
        if (!equation && !frameCrop(entry.source.illustration)) return null;
        return (
          <figure key={artifact.source_id} className={styles.inlineArtifact}>
            <div className={styles.artifactLabel}>{equation ? "Equation" : "Original frame"} from the lecture</div>
            <div className={styles.artifactBody}><SourceContent source={entry.source} inline={!equation} /></div>
            {needsAttention(visual) ? <p className={styles.sourceWarning}>This example comes from an uncertain extraction and needs review.</p> : null}
            <figcaption className={styles.artifactCaption}>
              <SegmentText text={artifact.caption} />
              <button type="button" className={styles.artifactSource}
                aria-label={`Inspect source ${entry.number} for this example at ${formatTime(entry.source.start)}`}
                aria-controls="notes-source" aria-pressed={selectedId === artifact.source_id}
                onClick={(event) => onSelect(artifact.source_id, event.currentTarget)}>
                Source {entry.number} · {formatTime(entry.source.start)}
              </button>
            </figcaption>
          </figure>
        );
      })}
    </>
  );
}

export function StudyNotes({ videoId, sourceRunId, title, source, initialJob }: StudyNotesProps) {
  const [job, setJob] = useState(initialJob);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pollError, setPollError] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const playerRef = useRef<PlayerHandle>(null);
  const readerRef = useRef<HTMLElement>(null);
  const contentsRef = useRef<HTMLDetailsElement>(null);
  const evidenceRef = useRef<HTMLDetailsElement>(null);
  const evidenceRailRef = useRef<HTMLElement>(null);
  const evidenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const citationRef = useRef<HTMLButtonElement | null>(null);
  const [layer, setLayer] = useState<"comprehensive" | "condensed">("comprehensive");
  const savedNotes = job?.status === "complete" ? job.notes : null;
  const notes = layer === "condensed" && savedNotes?.condensed ? savedNotes.condensed : savedNotes;
  const generating = Boolean(job && !isTerminal(job.status));
  const sourceIndex = useMemo(() => {
    const index = new Map<string, SourceEntry>();
    if (!savedNotes) return index;
    const snapshots = new Map(savedNotes.sources.map((item) => [item.id, item]));
    const layers = [savedNotes, ...(savedNotes.condensed ? [savedNotes.condensed] : [])];
    for (const block of layers.flatMap(view => [...view.overview, ...view.sections.flatMap(section => section.blocks)])) {
      for (const id of block.citations) {
        const snapshot = snapshots.get(id);
        if (snapshot && !index.has(id)) index.set(id, { source: snapshot, number: index.size + 1 });
      }
    }
    return index;
  }, [savedNotes]);
  const usage = selectUsageSummary(job?.progress);
  const selected = selectedId ? sourceIndex.get(selectedId) : undefined;
  const viewerHref = `/video/${videoId}?${new URLSearchParams({ run: sourceRunId })}`;
  const notesHref = `/video/${videoId}/notes?${new URLSearchParams({ run: sourceRunId })}`;
  const loginHref = `/login?${new URLSearchParams({ from: notesHref })}`;
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    const media = window.matchMedia(STACKED_QUERY);
    const updateContents = () => {
      if (contentsRef.current) contentsRef.current.open = !media.matches;
    };
    updateContents();
    media.addEventListener("change", updateContents);
    return () => media.removeEventListener("change", updateContents);
  }, []);

  useEffect(() => {
    if (!jobId || !jobStatus || isTerminal(jobStatus)) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/notes/${jobId}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Could not check progress");
        const nextJob: NotesJob = await response.json();
        if (!nextJob || typeof nextJob.id !== "string" || typeof nextJob.status !== "string") {
          throw new Error("Could not read progress");
        }
        if (controller.signal.aborted) return;
        setJob(nextJob);
        setPollError(false);
        if (isTerminal(nextJob.status)) return;
      } catch {
        if (controller.signal.aborted) return;
        setPollError(true);
      }
      timeout = setTimeout(poll, 3000);
    };
    timeout = setTimeout(poll, 1500);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [jobId, jobStatus]);

  async function generateNotes() {
    if (submittingRef.current || generating || notes) return;
    submittingRef.current = true;
    setSubmitting(true);
    setRequestError(null);
    setNeedsLogin(false);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId, source_run_id: sourceRunId }),
      });
      if (response.status === 401) {
        setNeedsLogin(true);
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not start notes. Try again.");
      if (!data || typeof data.id !== "string" || typeof data.status !== "string") {
        throw new Error("Could not read the notes response. Try again.");
      }
      setJob(data as NotesJob);
      setPollError(false);
    } catch (error) {
      setRequestError(error instanceof Error && !(error instanceof TypeError)
        ? error.message : "Could not connect. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function goToSection(id: string) {
    const heading = document.getElementById(id);
    const reader = readerRef.current;
    if (!heading || !reader) return;
    if (isStacked()) heading.scrollIntoView({ block: "start", behavior: "instant" });
    else reader.scrollTo({ top: heading.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop - 40, behavior: "instant" });
    heading.focus({ preventScroll: true });
  }

  function selectCitation(id: string, button: HTMLButtonElement) {
    citationRef.current = button;
    setSelectedId(id);
    if (evidenceRef.current) evidenceRef.current.open = true;
    requestAnimationFrame(() => {
      if (isStacked()) evidenceRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
      else evidenceRailRef.current?.scrollTo({ top: 0, behavior: "instant" });
      evidenceHeadingRef.current?.focus({ preventScroll: true });
    });
  }

  function returnToNotes() {
    if (isStacked()) citationRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
    citationRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#notes-title" onClick={(event) => { event.preventDefault(); goToSection("notes-title"); }}>Skip to study chapter</a>
      <p className="sr-only" role="status">{notes ? "Your study chapter is ready." : ""}</p>
      <header className={styles.topbar}>
        <Link href="/dashboard" className={styles.brand}><Logo size="sm" /></Link>
        <span className={styles.topbarTitle}>{title}</span>
        <Link className={styles.backLink} href={viewerHref}>Back to lecture</Link>
      </header>

      <div className={styles.workspace}>
        <nav className={styles.contents} aria-label="Chapter contents">
          <details open ref={contentsRef}>
            <summary className={styles.railTitle}>Contents</summary>
            {notes ? (
              <ol className={styles.contentsList}>
                <li><a href="#notes-overview" onClick={(event) => { event.preventDefault(); goToSection("notes-overview"); }}>The big picture</a></li>
                {notes.sections.map((section, index) => (
                  <li key={section.id}>
                    <a href={`#notes-section-${index}`} onClick={(event) => { event.preventDefault(); goToSection(`notes-section-${index}`); }}><SegmentText text={section.title} /></a>
                  </li>
                ))}
              </ol>
            ) : <p className={styles.railHint}>Your chapter’s topics will appear here.</p>}
            <div className={styles.contentsFootnote}>Read at your own pace.<br />Use a citation to revisit the lecture.</div>
          </details>
        </nav>

        <main ref={readerRef} className={styles.reader} aria-label="Study chapter">
          <article className={styles.paper}>
            <div className={styles.chapterLabel}>Study notes{notes ? <span>AI-generated chapter</span> : null}</div>
            {savedNotes?.condensed ? <div id="notes-depth" tabIndex={-1} className={styles.layerSwitch} role="group" aria-label="Notes depth">
              {(["comprehensive", "condensed"] as const).map(mode => <button key={mode} type="button"
                aria-pressed={layer === mode} onClick={() => {
                  setLayer(mode); setSelectedId(null); citationRef.current = null;
                  requestAnimationFrame(() => goToSection("notes-depth"));
                }}>{mode === "comprehensive" ? "Comprehensive" : "Condensed"}</button>)}
            </div> : null}
            {notes ? <p className={styles.qualitySummary}>{layer === "condensed" && savedNotes?.condensed
              ? "Quick review of key concepts and results."
              : "Detailed explanations for learning without watching the lecture."}</p> : null}
            <h1 id="notes-title" tabIndex={-1} className={styles.title}><SegmentText text={notes?.title || title} /></h1>
            {notes ? (
              <>
                <p className={styles.chapterMeta}>{notes.sections.length} topics<span aria-hidden="true"> / </span>{sourceIndex.size} shared lecture sources</p>
                <p className={styles.qualitySummary}>Notes inherit errors from the lecture extraction. Citations link to sources; they do not verify correctness.</p>
                <p className={styles.usage}>{usage ? `Estimated generation cost: $${approxCost(usage).toFixed(3)} USD · ${usage.totals.total_tokens.toLocaleString()} tokens` : "Token usage was not recorded for this chapter."}</p>
                <section className={styles.overview} aria-labelledby="notes-overview">
                  <h2 id="notes-overview" tabIndex={-1}>The big picture</h2>
                  {notes.overview.map((block, index) => <CitedParagraph key={index} block={block} sources={sourceIndex} selectedId={selectedId} onSelect={selectCitation} />)}
                </section>
                {notes.sections.map((section, index) => (
                  <section className={styles.section} key={section.id} aria-labelledby={`notes-section-${index}`}>
                    <h2 id={`notes-section-${index}`} tabIndex={-1}><SegmentText text={section.title} /></h2>
                    {section.blocks.map((block, blockIndex) => <CitedParagraph key={blockIndex} block={block} sources={sourceIndex} selectedId={selectedId} onSelect={selectCitation} />)}
                  </section>
                ))}
                <footer className={styles.chapterFooter}>This chapter keeps the lecture sources it was written from. <Link href={viewerHref}>View the source transcript</Link>.</footer>
              </>
            ) : (
              <section className={styles.emptyState} aria-labelledby="notes-state-title" aria-busy={generating || submitting}>
                <h2 id="notes-state-title">{generating ? "Your chapter is taking shape." : job?.status === "failed" ? "Let’s try that again." : "A chapter you can study from."}</h2>
                <p>{generating ? "We’re turning this lecture into a study chapter and connecting its explanations to lecture sources. You can leave this page and come back." : "Generate both comprehensive notes for learning without watching and a condensed review of key concepts. Both include citations and useful lecture diagrams."}</p>
                {generating ? <p className={styles.status} role="status">{job?.status === "queued" ? "Waiting to begin…" : String(job?.progress.stage || "Writing both notes layers and linking sources…")}</p> : null}
                {pollError ? <p className={styles.error} role="status">Could not check progress. Retrying automatically…</p> : null}
                {job?.status === "failed" && !requestError ? <p className={styles.error} role="alert">{job.error || "The chapter could not be generated. Try again."}</p> : null}
                {requestError ? <p className={styles.error} role="alert">{requestError}</p> : null}
                {needsLogin ? <p className={styles.error} role="alert"><Link href={loginHref}>Log in to generate notes</Link>. You’ll return to this lecture.</p> : null}
                {!generating ? (
                  <aside id="notes-quality" className={styles.qualityNotice} aria-label="Before you generate notes">
                    <strong>Notes depend on the extraction</strong>
                    <p>These notes use the existing transcript and extracted equations and visuals. They do not independently re-check the video. Extraction mistakes, including uncertain equations, can carry into the notes, and AI may introduce new errors. Citations help you inspect the sources; they do not guarantee correctness.</p>
                    <Link href={viewerHref}>Review the lecture extraction</Link>
                  </aside>
                ) : null}
                {!generating && !needsLogin ? <button aria-describedby="notes-quality" type="button" className={styles.generateButton} disabled={submitting} onClick={generateNotes}>{submitting ? "Starting…" : job?.status === "failed" ? "Try generating again" : "Generate notes with citations"}</button> : null}
              </section>
            )}
          </article>
        </main>

        <aside ref={evidenceRailRef} className={styles.evidence} aria-label="Lecture and source evidence">
          <details open ref={evidenceRef}>
            <summary className={styles.railTitle}>Lecture &amp; sources</summary>
            <div className={styles.video}><VideoPlayer ref={playerRef} source={source} title={title} onTimeUpdate={ignoreTimeUpdate} /></div>
            <section id="notes-source" className={styles.sourcePanel} aria-labelledby="notes-source-heading">
              <h2 id="notes-source-heading" ref={evidenceHeadingRef} tabIndex={-1} className={styles.sourceHeading}>{selected ? `Source ${selected.number}` : "Keep the lecture close."}</h2>
              {selected ? (
                <>
                  <div className={styles.sourceMeta}><span>{selected.source.kind === "transcript" ? "Transcript excerpt" : "Visual from the lecture"}</span><span>{formatTime(selected.source.start)}–{formatTime(selected.source.end)}</span></div>
                  {selected.source.visual && needsAttention(selected.source.visual) ? <p className={styles.sourceWarning}>This source needs review: its extraction has low confidence or an unresolved issue. The notes may carry the same error.</p> : null}
                  <div className={styles.sourceBody}>
                    <SourceContent source={selected.source} />
                    {selected.source.visual && ["equation", "code"].includes(selected.source.visual.contentType) && selected.source.text ? (
                      <p className={styles.sourceDescription}><SegmentText text={selected.source.text} /></p>
                    ) : null}
                  </div>
                  <button type="button" className={styles.seekButton} onClick={() => playerRef.current?.seekTo(selected.source.start)}>Seek to {formatTime(selected.source.start)}</button>
                  <p className={styles.playHint}>Use the video’s play control to listen.</p>
                  <button type="button" className={styles.returnButton} onClick={returnToNotes}>Return to notes</button>
                </>
              ) : <p className={styles.railHint}>Choose a numbered citation in the chapter to see its source here. Seek to that moment when you want to review.</p>}
            </section>
          </details>
        </aside>
      </div>
    </div>
  );
}

export default StudyNotes;
