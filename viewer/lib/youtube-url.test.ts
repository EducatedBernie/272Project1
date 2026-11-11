import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeYouTubeUrl,
  canonicalizeYouTubeUrlIfPossible,
  extractYouTubeId,
} from "./youtube-url";

test("canonicalizes playlist watch URLs to bare watch URLs", () => {
  assert.equal(
    canonicalizeYouTubeUrl("https://www.youtube.com/watch?v=hXDIZnfCRws&list=PL6539BAED55972D64&index=8"),
    "https://www.youtube.com/watch?v=hXDIZnfCRws",
  );
});

test("extracts and canonicalizes common YouTube URL forms", () => {
  const cases = [
    "https://youtu.be/hXDIZnfCRws?t=30",
    "https://www.youtube.com/embed/hXDIZnfCRws?start=30",
    "https://m.youtube.com/shorts/hXDIZnfCRws?feature=share",
    "https://www.youtube-nocookie.com/embed/hXDIZnfCRws",
    "www.youtube.com/watch?v=hXDIZnfCRws",
    "youtube.com/watch?feature=share&v=hXDIZnfCRws",
  ];

  for (const value of cases) {
    assert.equal(extractYouTubeId(value), "hXDIZnfCRws");
    assert.equal(canonicalizeYouTubeUrl(value), "https://www.youtube.com/watch?v=hXDIZnfCRws");
  }
});

test("does not rewrite non-YouTube URLs", () => {
  const source = "https://pub.example.r2.dev/uploads/abc/lecture.mp4";
  assert.equal(canonicalizeYouTubeUrl(source), null);
  assert.equal(canonicalizeYouTubeUrlIfPossible(source), source);
});

test("does not rewrite non-YouTube URLs with v query params", () => {
  const cases = [
    "https://example.com/watch?v=notyoutube",
    "https://pub.example.r2.dev/uploads/lecture.mp4?v=cachebuster",
    "example.com/watch?v=notyoutube",
  ];

  for (const source of cases) {
    assert.equal(canonicalizeYouTubeUrl(source), null);
    assert.equal(canonicalizeYouTubeUrlIfPossible(source), source);
  }
});
