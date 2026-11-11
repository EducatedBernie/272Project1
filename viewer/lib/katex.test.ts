import { test } from "node:test";
import assert from "node:assert/strict";
import katex from "./katex";

test("configured KaTeX renders mhchem water notation", () => {
  const html = katex.renderToString("\\ce{H2O}", {
    throwOnError: true,
    output: "htmlAndMathml",
  });

  assert.match(html, /H/);
  assert.match(html, /O/);
});

test("configured KaTeX renders mhchem organic reaction notation", () => {
  const html = katex.renderToString("\\ce{(CH3)2C=CH2 + H2O}", {
    throwOnError: true,
    output: "htmlAndMathml",
  });

  assert.match(html, /CH/);
  assert.match(html, /H2O|H[\s\S]*O/);
});

test("configured KaTeX still renders ordinary math", () => {
  const html = katex.renderToString("F = ma", {
    throwOnError: true,
    output: "htmlAndMathml",
  });

  assert.match(html, /F/);
  assert.match(html, /m/);
});
