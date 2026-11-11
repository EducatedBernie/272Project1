"""Summary reporter for evaluation results."""

from dataclasses import dataclass

from .match import MatchResult


@dataclass
class VideoReport:
    """Evaluation results for a single video."""
    video_url: str
    gt_count: int
    extracted_count: int
    recall: float  # % of ground truth fragments found
    exact_matches: int
    fuzzy_matches: int
    misses: int
    avg_cer: float  # Average CER across matched pairs
    results: list[MatchResult]


@dataclass
class SummaryReport:
    """Aggregate evaluation results across all videos."""
    total_videos: int
    total_gt: int
    total_extracted: int
    overall_recall: float
    exact_match_rate: float
    fuzzy_match_rate: float
    miss_rate: float
    avg_cer_matched: float  # Average CER for matched pairs only
    recall_by_complexity: dict[str, float]  # simple/medium/complex
    video_reports: list[VideoReport]


def classify_complexity(latex: str) -> str:
    """Classify equation complexity by normalized length."""
    from .normalize import normalize_latex
    n = len(normalize_latex(latex))
    if n < 20:
        return "simple"
    elif n < 50:
        return "medium"
    else:
        return "complex"


def build_video_report(
    video_url: str,
    results: list[MatchResult],
    extracted_count: int,
) -> VideoReport:
    """Build evaluation report for a single video."""
    gt_count = len(results)
    exact = sum(1 for r in results if r.match_type == "exact")
    fuzzy = sum(1 for r in results if r.match_type == "fuzzy")
    misses = sum(1 for r in results if not r.matched)
    matched = [r for r in results if r.matched]

    recall = (exact + fuzzy) / gt_count if gt_count > 0 else 0.0
    avg_cer = sum(r.cer for r in matched) / len(matched) if matched else 1.0

    return VideoReport(
        video_url=video_url,
        gt_count=gt_count,
        extracted_count=extracted_count,
        recall=recall,
        exact_matches=exact,
        fuzzy_matches=fuzzy,
        misses=misses,
        avg_cer=avg_cer,
        results=results,
    )


def build_summary(video_reports: list[VideoReport], all_results: list[tuple[str, MatchResult]]) -> SummaryReport:
    """Build aggregate summary across all videos.

    Args:
        video_reports: List of per-video reports
        all_results: List of (gt_latex, MatchResult) tuples for complexity breakdown
    """
    total_gt = sum(v.gt_count for v in video_reports)
    total_extracted = sum(v.extracted_count for v in video_reports)
    total_exact = sum(v.exact_matches for v in video_reports)
    total_fuzzy = sum(v.fuzzy_matches for v in video_reports)
    total_matched = total_exact + total_fuzzy

    all_matched_cers = [
        r.cer for v in video_reports for r in v.results if r.matched
    ]

    # Complexity breakdown
    complexity_buckets: dict[str, list[bool]] = {"simple": [], "medium": [], "complex": []}
    for gt_latex, result in all_results:
        c = classify_complexity(gt_latex)
        complexity_buckets[c].append(result.matched)

    recall_by_complexity = {}
    for c, matches in complexity_buckets.items():
        recall_by_complexity[c] = sum(matches) / len(matches) if matches else 0.0

    return SummaryReport(
        total_videos=len(video_reports),
        total_gt=total_gt,
        total_extracted=total_extracted,
        overall_recall=total_matched / total_gt if total_gt > 0 else 0.0,
        exact_match_rate=total_exact / total_gt if total_gt > 0 else 0.0,
        fuzzy_match_rate=total_fuzzy / total_gt if total_gt > 0 else 0.0,
        miss_rate=(total_gt - total_matched) / total_gt if total_gt > 0 else 0.0,
        avg_cer_matched=sum(all_matched_cers) / len(all_matched_cers) if all_matched_cers else 1.0,
        recall_by_complexity=recall_by_complexity,
        video_reports=video_reports,
    )


def print_summary(report: SummaryReport) -> None:
    """Print a formatted summary report."""
    print("=" * 70)
    print("CHALKBOARD EVALUATION SUMMARY")
    print("=" * 70)
    print(f"Videos evaluated:    {report.total_videos}")
    print(f"Ground truth eqs:    {report.total_gt}")
    print(f"Extracted eqs:       {report.total_extracted}")
    print()
    print(f"Overall recall:      {report.overall_recall:.1%}")
    print(f"  Exact matches:     {report.exact_match_rate:.1%}")
    print(f"  Fuzzy matches:     {report.fuzzy_match_rate:.1%}")
    print(f"  Misses:            {report.miss_rate:.1%}")
    print(f"Avg CER (matched):   {report.avg_cer_matched:.3f}")
    print()
    print("Recall by complexity:")
    for c in ["simple", "medium", "complex"]:
        if c in report.recall_by_complexity:
            print(f"  {c:>8}: {report.recall_by_complexity[c]:.1%}")
    print()

    # Show worst-performing videos
    ranked = sorted(report.video_reports, key=lambda v: v.recall)
    print("Bottom 5 videos by recall:")
    for v in ranked[:5]:
        print(f"  {v.recall:.0%} ({v.exact_matches}E+{v.fuzzy_matches}F/{v.gt_count}) {v.video_url[:60]}")
    print()
    print("Top 5 videos by recall:")
    for v in ranked[-5:]:
        print(f"  {v.recall:.0%} ({v.exact_matches}E+{v.fuzzy_matches}F/{v.gt_count}) {v.video_url[:60]}")


def print_misses(report: SummaryReport, limit: int = 20) -> None:
    """Print missed ground truth equations for debugging."""
    print()
    print("=" * 70)
    print(f"MISSED EQUATIONS (showing first {limit})")
    print("=" * 70)
    count = 0
    for vr in report.video_reports:
        for r in vr.results:
            if not r.matched:
                print(f"  [{r.gt_id}] {r.gt_latex}")
                print(f"    Best CER: {r.cer:.2f} vs: {r.matched_equation_latex[:80] if r.matched_equation_latex else 'N/A'}")
                print(f"    Video: {vr.video_url[:60]}")
                print()
                count += 1
                if count >= limit:
                    return
