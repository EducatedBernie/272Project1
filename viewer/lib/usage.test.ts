import assert from "node:assert/strict";
import test from "node:test";

import { approxCost, type UsageSummary } from "./usage";

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.000_001, `${actual} !== ${expected}`);
}

function summary(overrides: Partial<UsageSummary>): UsageSummary {
  return {
    totals: {
      calls: 1,
      prompt_tokens: 0,
      candidates_tokens: 0,
      cached_tokens: 0,
      thoughts_tokens: 0,
      total_tokens: 0,
    },
    by_model_version: {},
    by_kind: {},
    truncated: false,
    ...overrides,
  };
}

test("approxCost bills Gemini 3 Flash output plus thinking tokens", () => {
  const usage = summary({
    totals: {
      calls: 1,
      prompt_tokens: 1_000_000,
      candidates_tokens: 100_000,
      cached_tokens: 0,
      thoughts_tokens: 200_000,
      total_tokens: 1_300_000,
    },
    by_model_version: {
      "gemini-3-flash-preview": {
        calls: 1,
        prompt_tokens: 1_000_000,
        candidates_tokens: 100_000,
        thoughts_tokens: 200_000,
        cached_tokens: 0,
        total_tokens: 1_300_000,
      },
    },
  });

  assertClose(approxCost(usage), 1.4);
});

test("approxCost uses the Gemini 3.7 Flash introductory standard rate", () => {
  const usage = summary({
    totals: {
      calls: 1,
      prompt_tokens: 1_000_000,
      candidates_tokens: 100_000,
      cached_tokens: 0,
      thoughts_tokens: 200_000,
      total_tokens: 1_300_000,
    },
    by_model_version: {
      "gemini-3.7-flash": {
        calls: 1,
        prompt_tokens: 1_000_000,
        candidates_tokens: 100_000,
        thoughts_tokens: 200_000,
        cached_tokens: 0,
        total_tokens: 1_300_000,
      },
    },
  });

  assertClose(approxCost(usage), 1.875);
});

test("approxCost charges cached input tokens at cached rate", () => {
  const usage = summary({
    totals: {
      calls: 1,
      prompt_tokens: 1_000_000,
      candidates_tokens: 0,
      cached_tokens: 200_000,
      thoughts_tokens: 0,
      total_tokens: 1_000_000,
    },
    by_model_version: {
      "gemini-3-flash-preview": {
        calls: 1,
        prompt_tokens: 1_000_000,
        candidates_tokens: 0,
        cached_tokens: 200_000,
        thoughts_tokens: 0,
        total_tokens: 1_000_000,
      },
    },
  });

  assertClose(approxCost(usage), 0.41);
});

test("approxCost applies totals-level thoughts to legacy single-model summaries", () => {
  const usage = summary({
    totals: {
      calls: 1,
      prompt_tokens: 1_000_000,
      candidates_tokens: 100_000,
      cached_tokens: 0,
      thoughts_tokens: 200_000,
      total_tokens: 1_300_000,
    },
    by_model_version: {
      "gemini-3-flash-preview": {
        calls: 1,
        prompt_tokens: 1_000_000,
        candidates_tokens: 100_000,
        total_tokens: 1_300_000,
      },
    },
  });

  assertClose(approxCost(usage), 1.4);
});

test("notes model pricing includes cached input and thinking tokens", () => {
  for (const model of ["gemini-3.8-flash", "gemini-3.8-flash-001", "gemini-3.7-flash", "gemini-3.7-flash-001"]) {
    const usage = summary({
      by_model_version: {
        [model]: { calls: 1, prompt_tokens: 1_000_000, cached_tokens: 200_000,
          candidates_tokens: 100_000, thoughts_tokens: 200_000, total_tokens: 1_300_000 },
      },
    });
    assertClose(approxCost(usage), 1.74);
  }
});
