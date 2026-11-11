import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteSource, NotesJob } from "./notes-types";

const load = createRequire(import.meta.url);
const cssLoader = load.extensions[".css"];
load.extensions[".css"] = module => { module.exports = {}; };
const { StudyNotes } = load("../components/notes/StudyNotes") as typeof import("../components/notes/StudyNotes");
if (cssLoader) load.extensions[".css"] = cssLoader;
else delete load.extensions[".css"];

test("notes render original-frame crops, clip their bounds, and preserve full-frame and text fallbacks", () => {
  const source: NoteSource = { id: "source-1", kind: "visual", start: 10, end: 20,
    text: "Velocity plotted against time.", visual: { id: "source-1", contentType: "chart_description",
      description: "Velocity plotted against time.", confidence: 0.9, start: 10, end: 20 } };
  const frame = { id: "frame-1", url: "https://example.com/frame.jpg", key: "frames/frame.jpg",
    sha256: "abc", width: 1920, height: 1080, requested_time: 14 };
  const render = (illustration?: NoteSource["illustration"], bothLayers = false,
    contentType = "chart_description") => {
    const block = { text: "Compare velocity over time.", citations: [source.id],
      artifacts: [{ source_id: source.id, caption: "Read the slope." }] };
    const job: NotesJob = { id: "job", status: "complete", progress: {}, error: null,
      created_at: "2026-09-15T00:00:00Z", source_run_id: "run", notes: { version: 1,
        title: "Velocity", overview: [block], sections: [{ id: "section-1", title: "The slope", blocks: [block] }],
        sources: [{ ...source, visual: { ...source.visual!, contentType }, illustration }] } };
    if (bothLayers && job.notes) job.notes.condensed = {
      title: "Quick review", overview: [block], sections: [{ id: "review-1", title: "Key result", blocks: [block] }],
    };
    return renderToStaticMarkup(createElement(StudyNotes, { videoId: "video", sourceRunId: "run",
      title: "Lecture", source: { type: "youtube", videoId: "0JUN9aDxVmI" }, initialJob: job }));
  };
  const both = render(undefined, true);
  assert.match(both, /aria-label="Notes depth"/);
  assert.match(both, /aria-pressed="true"[^>]*>Comprehensive/);
  assert.match(both, /aria-pressed="false"[^>]*>Condensed/);
  assert.doesNotMatch(both, /<h[12][^>]*>Quick review/);
  const cropped = render({ status: "ready", frame, box_2d: [100, 200, 500, 700], prompt_version: "v1" });
  assert.match(cropped, /viewBox="336 86.4 1056 475.2"/);
  assert.match(cropped, /<rect x="336" y="86.4" width="1056" height="475.2"/);
  assert.match(cropped, /<image[^>]*width="1920" height="1080"[^>]*clip-path="url\(#/);
  assert.match(cropped, /role="img" aria-label="Detail from the original lecture frame at 0:14\./);
  assert.doesNotMatch(cropped, /Velocity plotted against time|View full lecture frame|Read the extracted description/);
  const clipIds = [...cropped.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(clipIds.length, 2);
  assert.equal(new Set(clipIds).size, 2, "repeated sources need distinct clip IDs");
  for (const illustration of [
    { status: "full_frame" as const, frame, prompt_version: "v1" },
    { status: "ready" as const, frame, box_2d: [500, 700, 100, 200] as [number, number, number, number], prompt_version: "v1" },
  ]) {
    const full = render(illustration);
    assert.doesNotMatch(full, /<svg|Velocity plotted against time/);
    assert.doesNotMatch(full, /<clipPath/);
  }
  const edges = render({ status: "ready", frame, box_2d: [0, 0, 1000, 1000], prompt_version: "v1" });
  assert.match(edges, /viewBox="0 0 1920 1080"/);
  const unavailable = render({ status: "unavailable", prompt_version: "v1" });
  assert.doesNotMatch(unavailable, /Image unavailable|Velocity plotted against time/);
  assert.doesNotMatch(unavailable, /<svg/);
  assert.doesNotMatch(render(), /Image unavailable|<svg|Read the extracted description/);
  assert.match(render(undefined, false, "equation"), /Velocity plotted against time/);
});
