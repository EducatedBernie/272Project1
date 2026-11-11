import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAlignmentMeta, selectAlignmentMeta, type AlignmentMeta } from "./alignment-meta";

const wellFormed: AlignmentMeta = {
  matched_sentences: 10,
  total_sentences: 12,
  matched_words: 95,
  total_gemini_words: 100,
  total_ref_words: 110,
  word_coverage: 0.95,
  ref_coverage: 0.86,
  unmatched_ref_words: [{ time: 1.5, word: "uh" }],
  merged_count: 0,
};

test("isValidAlignmentMeta accepts well-formed data", () => {
  assert.equal(isValidAlignmentMeta(wellFormed), true);
});

test("isValidAlignmentMeta rejects null/undefined/non-object", () => {
  assert.equal(isValidAlignmentMeta(null), false);
  assert.equal(isValidAlignmentMeta(undefined), false);
  assert.equal(isValidAlignmentMeta("string"), false);
  assert.equal(isValidAlignmentMeta(42), false);
  assert.equal(isValidAlignmentMeta([]), false);
});

test("isValidAlignmentMeta rejects pre-fix runs that wrote unmatched_word_count", () => {
  // Railway runs from before #5 persisted unmatched_word_count (an int) instead
  // of the unmatched_ref_words list. The viewer must fall through to its
  // client-side approximation rather than crashing on .filter() of a number.
  const preFixRun = {
    matched_sentences: 10,
    total_sentences: 12,
    matched_words: 95,
    total_gemini_words: 100,
    total_ref_words: 110,
    word_coverage: 0.95,
    ref_coverage: 0.86,
    unmatched_word_count: 15,
    merged_count: 0,
  };
  assert.equal(isValidAlignmentMeta(preFixRun), false);
});

test("isValidAlignmentMeta rejects malformed numeric fields", () => {
  // Math.round(ref_coverage * 100) on a string yields NaN%. Schema migrations
  // or partial JSONB writes are the realistic ways this could leak in.
  assert.equal(isValidAlignmentMeta({ ...wellFormed, ref_coverage: "0.86" }), false);
  assert.equal(isValidAlignmentMeta({ ...wellFormed, ref_coverage: null }), false);
  assert.equal(isValidAlignmentMeta({ ...wellFormed, total_ref_words: null }), false);
});

test("selectAlignmentMeta prefers demo over db", () => {
  const dbAlt: AlignmentMeta = { ...wellFormed, ref_coverage: 0.5 };
  const result = selectAlignmentMeta(wellFormed, dbAlt);
  // Reference equality — demo wins, db is not even read.
  assert.strictEqual(result, wellFormed);
});

test("selectAlignmentMeta falls back to db when demo absent", () => {
  const result = selectAlignmentMeta(undefined, wellFormed);
  assert.strictEqual(result, wellFormed);
});

test("selectAlignmentMeta returns null when db data is invalid", () => {
  // Pre-fix Railway run — UI falls through to client-side approximation.
  const result = selectAlignmentMeta(undefined, { unmatched_word_count: 15 });
  assert.equal(result, null);
});

test("selectAlignmentMeta returns null when both sources missing", () => {
  assert.equal(selectAlignmentMeta(undefined, null), null);
  assert.equal(selectAlignmentMeta(undefined, undefined), null);
});
