"""Containment-based matching between ground truth fragments and extracted equations.

MathSpeech annotates equations piecewise (fragments as spoken). Our pipeline extracts
whole equations from the board. A single extracted equation may contain multiple
ground truth fragments as subexpressions.

Matching strategy:
1. Exact containment: normalized ground truth is a substring of any normalized extraction
2. Fuzzy containment: character error rate (CER) below threshold against best-matching
   substring of similar length in any extraction
"""

from dataclasses import dataclass

from .normalize import normalize_for_containment, normalize_latex


@dataclass
class MatchResult:
    """Result of matching a single ground truth fragment."""
    gt_id: int
    gt_latex: str
    gt_normalized: str
    matched: bool
    match_type: str  # "exact", "fuzzy", "none"
    matched_equation_latex: str | None
    cer: float  # Character Error Rate (0.0 = perfect, 1.0 = no match)


def char_error_rate(reference: str, hypothesis: str) -> float:
    """Compute Character Error Rate using Levenshtein distance.

    CER = levenshtein(ref, hyp) / len(ref)
    """
    if not reference:
        return 0.0 if not hypothesis else 1.0

    n, m = len(reference), len(hypothesis)
    dp = list(range(m + 1))

    for i in range(1, n + 1):
        prev = dp[:]
        dp[0] = i
        for j in range(1, m + 1):
            if reference[i - 1] == hypothesis[j - 1]:
                dp[j] = prev[j - 1]
            else:
                dp[j] = 1 + min(prev[j], dp[j - 1], prev[j - 1])

    return dp[m] / n


def best_substring_cer(needle: str, haystack: str) -> float:
    """Find the best CER between needle and any substring of haystack of similar length.

    Slides a window of size [len(needle)-delta, len(needle)+delta] across haystack
    and returns the lowest CER found.
    """
    if not needle or not haystack:
        return 1.0

    if needle in haystack:
        return 0.0

    n = len(needle)
    best = 1.0

    # Check windows of varying sizes around the needle length
    delta = max(3, n // 4)
    for win_size in range(max(1, n - delta), n + delta + 1):
        for start in range(len(haystack) - win_size + 1):
            substr = haystack[start:start + win_size]
            cer = char_error_rate(needle, substr)
            if cer < best:
                best = cer
                if best == 0.0:
                    return 0.0

    return best


def match_fragment(
    gt_latex: str,
    gt_id: int,
    extracted_equations: list[dict],
    fuzzy_threshold: float = 0.3,
) -> MatchResult:
    """Match a single ground truth fragment against all extracted equations.

    Args:
        gt_latex: Ground truth LaTeX string (may include $ delimiters)
        gt_id: Ground truth equation ID
        extracted_equations: List of dicts with 'latex' key from pipeline output
        fuzzy_threshold: Max CER to consider a fuzzy match

    Returns:
        MatchResult with match details
    """
    gt_norm = normalize_for_containment(gt_latex)

    if not gt_norm:
        return MatchResult(gt_id, gt_latex, gt_norm, False, "none", None, 1.0)

    # Try exact containment first
    for eq in extracted_equations:
        eq_norm = normalize_for_containment(eq["latex"])
        if gt_norm in eq_norm:
            return MatchResult(gt_id, gt_latex, gt_norm, True, "exact", eq["latex"], 0.0)

    # Try fuzzy containment
    best_cer = 1.0
    best_eq = None
    for eq in extracted_equations:
        eq_norm = normalize_for_containment(eq["latex"])
        cer = best_substring_cer(gt_norm, eq_norm)
        if cer < best_cer:
            best_cer = cer
            best_eq = eq["latex"]

    if best_cer <= fuzzy_threshold:
        return MatchResult(gt_id, gt_latex, gt_norm, True, "fuzzy", best_eq, best_cer)

    return MatchResult(gt_id, gt_latex, gt_norm, False, "none", best_eq, best_cer)


def match_video(
    ground_truth: list[dict],
    extracted_equations: list[dict],
    fuzzy_threshold: float = 0.3,
) -> list[MatchResult]:
    """Match all ground truth fragments for a video against extracted equations.

    Args:
        ground_truth: List of dicts with 'id', 'latex', 'transcription'
        extracted_equations: List of dicts with 'latex' from pipeline output
        fuzzy_threshold: Max CER for fuzzy matching

    Returns:
        List of MatchResult, one per ground truth fragment
    """
    results = []
    for gt in ground_truth:
        result = match_fragment(
            gt["latex"], gt["id"], extracted_equations, fuzzy_threshold
        )
        results.append(result)
    return results
