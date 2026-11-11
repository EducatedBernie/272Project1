import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInlineLatex } from "./parse-inline-latex";

test("plain text without math returns single text part", () => {
  const parts = parseInlineLatex("hello world");
  assert.deepEqual(parts, [{ type: "text", content: "hello world" }]);
});

test("simple math env splits text and latex", () => {
  const parts = parseInlineLatex("Force is $F = ma$ in Newtonian mechanics");
  assert.deepEqual(parts, [
    { type: "text", content: "Force is " },
    { type: "latex", content: "F = ma" },
    { type: "text", content: " in Newtonian mechanics" },
  ]);
});

test("multiple math envs in one string", () => {
  const parts = parseInlineLatex("Let $x$ and $y$ be variables");
  assert.deepEqual(parts, [
    { type: "text", content: "Let " },
    { type: "latex", content: "x" },
    { type: "text", content: " and " },
    { type: "latex", content: "y" },
    { type: "text", content: " be variables" },
  ]);
});

test("escaped currency outside math env renders as literal $ (no backslash)", () => {
  const parts = parseInlineLatex("Pay \\$5 and \\$10 today");
  assert.deepEqual(parts, [
    { type: "text", content: "Pay $5 and $10 today" },
  ]);
});

test("escaped currency at start of string", () => {
  const parts = parseInlineLatex("\\$21 dollars");
  assert.deepEqual(parts, [{ type: "text", content: "$21 dollars" }]);
});

test("escaped currency inside math env preserves \\$ for KaTeX", () => {
  // Visual content stores `Mean: $\$61.60$` — math env containing literal $.
  const parts = parseInlineLatex("Mean: $\\$61.60$");
  assert.deepEqual(parts, [
    { type: "text", content: "Mean: " },
    { type: "latex", content: "\\$61.60" },
  ]);
});

test("multiple escaped currencies inside math envs", () => {
  const parts = parseInlineLatex("$\\$5$ and $\\$10$");
  assert.deepEqual(parts, [
    { type: "latex", content: "\\$5" },
    { type: "text", content: " and " },
    { type: "latex", content: "\\$10" },
  ]);
});

test("mixed math variable and escaped currency", () => {
  // After the prompt fix Gemini should write: `the variable $x$ is \$5`
  const parts = parseInlineLatex("the variable $x$ is \\$5");
  assert.deepEqual(parts, [
    { type: "text", content: "the variable " },
    { type: "latex", content: "x" },
    { type: "text", content: " is $5" },
  ]);
});

test("escaped currency before math env does not consume the math delimiter", () => {
  const parts = parseInlineLatex("Pay \\$5 and solve $x$");
  assert.deepEqual(parts, [
    { type: "text", content: "Pay $5 and solve " },
    { type: "latex", content: "x" },
  ]);
});

test("unclosed math delimiter falls through as plain text", () => {
  const parts = parseInlineLatex("Total cost was $5");
  assert.deepEqual(parts, [{ type: "text", content: "Total cost was $5" }]);
});

test("empty string returns empty array", () => {
  assert.deepEqual(parseInlineLatex(""), []);
});

test("string with only math env", () => {
  const parts = parseInlineLatex("$E = mc^2$");
  assert.deepEqual(parts, [{ type: "latex", content: "E = mc^2" }]);
});

test("math env with digit-leading content (e.g., $2x$) still treated as math", () => {
  const parts = parseInlineLatex("Solve $2x = 10$");
  assert.deepEqual(parts, [
    { type: "text", content: "Solve " },
    { type: "latex", content: "2x = 10" },
  ]);
});

test("regression: bare $ pairs still match (Bug 1 needs prompt+reprocess to fix at source)", () => {
  // This documents the limitation: pre-fix data with bare currency $
  // continues to render incorrectly. The parser fix alone cannot
  // distinguish currency from math when neither is escaped.
  const parts = parseInlineLatex("Mean is $61.60 and stddev is $28.01.");
  assert.equal(parts.length, 3);
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "latex"); // wrongly renders as math — expected
  assert.equal(parts[2].type, "text");
});
