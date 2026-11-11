import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorVisualsToSegments } from "./anchor";
import type { Segment, VisualContent } from "./types";

function seg(id: string, start: number, end: number): Segment {
  return { id, text: id, start, end };
}

function vis(id: string, start: number, end: number): VisualContent {
  return {
    id,
    contentType: "equation",
    description: id,
    confidence: 1,
    start,
    end,
  };
}

test("attaches visual to segment whose range contains its start", () => {
  const segments = [seg("a", 0, 5), seg("b", 5, 10), seg("c", 10, 15)];
  const visuals = [vis("v1", 7, 12)];
  const out = anchorVisualsToSegments(segments, visuals);
  assert.equal(out[0].visuals.length, 0);
  assert.equal(out[1].visuals.length, 1);
  assert.equal(out[1].visuals[0].id, "v1");
  assert.equal(out[2].visuals.length, 0);
});

test("attaches visual starting at exact segment boundary to earlier segment", () => {
  const segments = [seg("a", 0, 5), seg("b", 5, 10)];
  const visuals = [vis("v1", 5, 8)];
  const out = anchorVisualsToSegments(segments, visuals);
  assert.equal(out[0].visuals.length, 1);
  assert.equal(out[1].visuals.length, 0);
});

test("falls back to nearest following segment when no containing segment", () => {
  const segments = [seg("a", 0, 5), seg("b", 10, 15)];
  const visuals = [vis("v1", 7, 9)];
  const out = anchorVisualsToSegments(segments, visuals);
  assert.equal(out[0].visuals.length, 0);
  assert.equal(out[1].visuals.length, 1);
});

test("falls back to last segment if visual start is after every segment", () => {
  const segments = [seg("a", 0, 5), seg("b", 5, 10)];
  const visuals = [vis("v1", 99, 200)];
  const out = anchorVisualsToSegments(segments, visuals);
  assert.equal(out[0].visuals.length, 0);
  assert.equal(out[1].visuals.length, 1);
});

test("each segment's visuals are sorted by start", () => {
  const segments = [seg("a", 0, 100)];
  const visuals = [vis("v3", 50, 55), vis("v1", 10, 20), vis("v2", 30, 40)];
  const out = anchorVisualsToSegments(segments, visuals);
  assert.deepEqual(out[0].visuals.map((v) => v.id), ["v1", "v2", "v3"]);
});

test("empty inputs return empty anchored list", () => {
  assert.deepEqual(anchorVisualsToSegments([], []), []);
  const out = anchorVisualsToSegments([seg("a", 0, 5)], []);
  assert.equal(out[0].visuals.length, 0);
});

test("preserves all segment fields on the anchored segment", () => {
  const segments = [seg("a", 0, 5)];
  const out = anchorVisualsToSegments(segments, []);
  assert.equal(out[0].id, "a");
  assert.equal(out[0].text, "a");
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 5);
});

test("sorts unsorted segment input before anchoring", () => {
  const segments = [seg("c", 10, 15), seg("a", 0, 5), seg("b", 5, 10)];
  const visuals = [vis("v1", 7, 12), vis("v2", 11, 14)];
  const out = anchorVisualsToSegments(segments, visuals);
  // Output should be in start-ascending order: a, b, c
  assert.deepEqual(
    out.map((s) => s.id),
    ["a", "b", "c"]
  );
  // v1 starts at 7 (in b's range 5-10); v2 starts at 11 (in c's range 10-15)
  assert.equal(out[0].visuals.length, 0);
  assert.equal(out[1].visuals.length, 1);
  assert.equal(out[1].visuals[0].id, "v1");
  assert.equal(out[2].visuals.length, 1);
  assert.equal(out[2].visuals[0].id, "v2");
});
