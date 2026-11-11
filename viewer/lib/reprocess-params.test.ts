import assert from "node:assert/strict";
import test from "node:test";

import { buildFullReprocessParams } from "./reprocess-params";

test("full reprocess params canonicalize YouTube source", () => {
  assert.deepEqual(
    buildFullReprocessParams({
      youtube_url: "https://www.youtube.com/watch?v=abc&list=playlist&index=8",
      title: "Lecture",
      r2_key: null,
      r2_url: null,
    }),
    {
      source: "https://www.youtube.com/watch?v=abc",
      title: "Lecture",
      raw_source: "https://www.youtube.com/watch?v=abc&list=playlist&index=8",
    },
  );
});

test("full reprocess params use r2_key as upload source", () => {
  assert.deepEqual(
    buildFullReprocessParams({
      youtube_url: "https://pub.example.r2.dev/uploads/abc/lecture.mp4",
      title: "Uploaded lecture",
      r2_key: "uploads/abc/lecture.mp4",
      r2_url: "https://pub.example.r2.dev/uploads/abc/lecture.mp4",
    }),
    {
      source: "uploads/abc/lecture.mp4",
      title: "Uploaded lecture",
      video_url: "https://pub.example.r2.dev/uploads/abc/lecture.mp4",
    },
  );
});

test("full reprocess params fall back to youtube_url as upload playback URL", () => {
  assert.deepEqual(
    buildFullReprocessParams({
      youtube_url: "https://pub.example.r2.dev/uploads/abc/lecture.mp4",
      title: null,
      r2_key: "uploads/abc/lecture.mp4",
      r2_url: null,
    }),
    {
      source: "uploads/abc/lecture.mp4",
      title: null,
      video_url: "https://pub.example.r2.dev/uploads/abc/lecture.mp4",
    },
  );
});
