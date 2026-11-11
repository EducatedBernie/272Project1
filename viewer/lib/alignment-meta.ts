/**
 * Alignment metadata produced by pipeline/src/processing/word_align.py.
 *
 * Same shape as the alignment_meta dict at word_align.py:220. The Python side
 * has a regression test (pipeline/tests/test_word_align.py) that locks the key
 * names so a rename there fails CI before reaching this consumer.
 */

export interface UnmatchedRefWord {
  time: number;
  word: string;
}

export interface AlignmentMeta {
  matched_sentences: number;
  total_sentences: number;
  matched_words: number;
  total_gemini_words: number;
  total_ref_words: number;
  word_coverage: number;
  ref_coverage: number;
  unmatched_ref_words: UnmatchedRefWord[];
  merged_count: number;
}

/**
 * Treats unknown JSONB as a candidate AlignmentMeta only if the fields the
 * debug UI actually reads are present and well-typed. The Array.isArray
 * check rules out pre-fix Railway runs that wrote `unmatched_word_count`
 * (an integer) instead of the full unmatched list.
 */
export function isValidAlignmentMeta(value: unknown): value is AlignmentMeta {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.unmatched_ref_words) &&
    typeof v.ref_coverage === "number" &&
    typeof v.total_ref_words === "number"
  );
}

/**
 * Picks the alignment metadata for the debug page, preferring the curated
 * demo JSON over the database fallback. Returns null when neither source
 * has usable data — the UI then falls back to client-side approximation.
 *
 * Precedence: demo > db > null. Never reverse this without updating the
 * test suite — landing-page demo videos depend on the demo source winning.
 */
export function selectAlignmentMeta(
  demoAlignment: AlignmentMeta | undefined,
  dbAlignment: unknown,
): AlignmentMeta | null {
  if (demoAlignment) return demoAlignment;
  if (isValidAlignmentMeta(dbAlignment)) return dbAlignment;
  return null;
}
