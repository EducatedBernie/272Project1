/**
 * Per-run Gemini token-usage summary, persisted into pipeline_runs.progress.usage
 * by pipeline/src/extraction/usage.py::UsageAccumulator.summary().
 *
 * Mirrors the Python shape exactly. The pipeline-side test
 * (pipeline/tests/test_usage_accumulator.py) locks the key names so a rename
 * there fails CI before reaching the viewer.
 *
 * Pricing isn't persisted — counts are stable, prices change. Compute dollar
 * estimates client-side from approxCost() so we can update rates without a
 * backfill.
 */

export interface UsageTotals {
  calls: number;
  prompt_tokens: number;
  candidates_tokens: number;
  cached_tokens: number;
  thoughts_tokens: number;
  total_tokens: number;
}

export interface UsageByModel {
  calls: number;
  prompt_tokens: number;
  candidates_tokens: number;
  cached_tokens?: number;
  thoughts_tokens?: number;
  total_tokens: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  by_model_version: Record<string, UsageByModel>;
  by_kind: Record<string, number>;
  truncated: boolean;
}

export function isValidUsageSummary(value: unknown): value is UsageSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!v.totals || typeof v.totals !== "object") return false;
  const t = v.totals as Record<string, unknown>;
  return typeof t.total_tokens === "number" && typeof t.calls === "number";
}

export function selectUsageSummary(progress: unknown): UsageSummary | null {
  if (!progress || typeof progress !== "object") return null;
  const usage = (progress as Record<string, unknown>).usage;
  return isValidUsageSummary(usage) ? usage : null;
}

// Approximate USD cost per 1M tokens. These are rough estimates kept here
// (not persisted) so we can refresh without a backfill. Update when Google
// publishes new pricing. Falls through to a generic rate for unknown models.
const PRICING_USD_PER_M: Record<string, { input: number; output: number; cached: number }> = {
  // Introductory Standard rates through 2026-12-31.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3-flash-preview": { input: 0.50, output: 3.00, cached: 0.05 },
  "gemini-2.5-flash":        { input: 0.30, output: 2.50, cached: 0.03 },
  "gemini-2.5-pro":          { input: 1.25, output: 10.00, cached: 0.31 },
  "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10.00, cached: 0.31 },
};
const FALLBACK_RATE = PRICING_USD_PER_M["gemini-3.7-flash"];

function rateFor(model: string): { input: number; output: number; cached: number } {
  if (PRICING_USD_PER_M[model]) return PRICING_USD_PER_M[model];
  // Fuzzy match common families.
  if (model.includes("gemini-3.8-flash")) return PRICING_USD_PER_M["gemini-3.8-flash"];
  if (model.includes("gemini-3.7-flash")) return PRICING_USD_PER_M["gemini-3.7-flash"];
  if (model.includes("gemini-3-flash")) return PRICING_USD_PER_M["gemini-3-flash-preview"];
  if (model.includes("flash")) return PRICING_USD_PER_M["gemini-2.5-flash"];
  if (model.includes("pro")) return PRICING_USD_PER_M["gemini-2.5-pro"];
  return FALLBACK_RATE;
}

/**
 * Approximate USD cost from the by_model_version breakdown. Best-effort —
 * pricing changes frequently and the UI labels the value with a `~` so
 * operators don't read it as authoritative.
 */
export function approxCost(summary: UsageSummary): number {
  let cost = 0;
  const modelEntries = Object.entries(summary.by_model_version);
  const singleModel = modelEntries.length === 1;
  for (const [model, m] of modelEntries) {
    const rate = rateFor(model);
    const cachedTokens = m.cached_tokens ?? (singleModel ? summary.totals.cached_tokens : 0);
    const thoughtsTokens = m.thoughts_tokens ?? (singleModel ? summary.totals.thoughts_tokens : 0);
    const uncachedPromptTokens = Math.max(0, m.prompt_tokens - cachedTokens);
    const billableOutputTokens = m.candidates_tokens + thoughtsTokens;

    cost += (uncachedPromptTokens / 1_000_000) * rate.input;
    cost += (cachedTokens / 1_000_000) * rate.cached;
    cost += (billableOutputTokens / 1_000_000) * rate.output;
  }
  return Math.max(0, cost);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
