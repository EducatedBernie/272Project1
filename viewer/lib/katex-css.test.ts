import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("global KaTeX color rule preserves inline transparent placeholders", () => {
  assert.match(globalsCss, /\.katex\s*\{[\s\S]*color:\s*var\(--foreground\);/);
  assert.doesNotMatch(
    globalsCss,
    /\.katex\s*,\s*\.katex\s+\*\s*\{[\s\S]*color:[^}]*!important/
  );
  assert.doesNotMatch(globalsCss, /\.katex\s+\*\s*\{[\s\S]*color:[^}]*!important/);
});
