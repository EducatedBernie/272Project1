import assert from "node:assert/strict";
import test from "node:test";

import { GEMINI_MODEL_OPTIONS, modelOverride } from "./model-config";

test("live model picker defaults to the centralized worker default", () => {
  const modelValues: string[] = GEMINI_MODEL_OPTIONS.map((option) => option.value);
  assert.deepEqual(GEMINI_MODEL_OPTIONS[0], { value: "", label: "Pipeline default" });
  assert.equal(modelValues.includes("gemini-3.7-flash"), true);
  assert.equal(modelValues.includes("gemini-3-flash-preview"), false);
});

test("model override is omitted for the default selection and preserves explicit choices", () => {
  assert.deepEqual(modelOverride(undefined), {});
  assert.deepEqual(modelOverride(null), {});
  assert.deepEqual(modelOverride(""), {});
  assert.deepEqual(modelOverride("gemini-2.5-pro-preview-06-05"), {
    model: "gemini-2.5-pro-preview-06-05",
  });
});
