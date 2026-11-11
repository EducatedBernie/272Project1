"""
Chalkboard evaluation harness.

Benchmarks pipeline extraction output against MathSpeech ground truth.
Runs offline — does NOT call Gemini. You provide pre-extracted JSON files.

Usage:
    # Evaluate a single video's extraction against ground truth:
    python eval/run_eval.py --extractions eval/extractions/ --dataset dataset/mathspeech_by_video.json

    # The extractions/ directory should contain JSON files named by YouTube video ID, e.g.:
    #   eval/extractions/YBajUR3EFSM.json
    #
    # Each file should match the pipeline output format:
    #   { "equations": [{"latex": "...", ...}, ...] }
    #
    # Only videos that have both ground truth AND an extraction file are evaluated.

    # To extract a single video for eval (saves to eval/extractions/):
    python eval/run_eval.py --extract "https://www.youtube.com/watch?v=YBajUR3EFSM"
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

from eval.match import match_video
from eval.report import (
    build_summary,
    build_video_report,
    print_misses,
    print_summary,
)


def extract_video_id(url: str) -> str | None:
    """Extract YouTube video ID from URL."""
    patterns = [
        r'youtu\.be/([^?&\s]+)',
        r'[?&]v=([^&\s]+)',
    ]
    for p in patterns:
        m = re.search(p, url.strip())
        if m:
            return m.group(1)
    return None


def load_ground_truth(dataset_path: str) -> dict[str, list[dict]]:
    """Load MathSpeech ground truth, keyed by video ID."""
    with open(dataset_path) as f:
        data = json.load(f)

    by_id: dict[str, list[dict]] = {}
    for url, equations in data.items():
        vid = extract_video_id(url)
        if vid:
            by_id[vid] = equations
    return by_id


def load_extraction(path: str) -> list[dict]:
    """Load a pipeline extraction JSON file."""
    with open(path) as f:
        data = json.load(f)
    return data.get("equations", data if isinstance(data, list) else [])


def extract_single_video(youtube_url: str, output_dir: str) -> str:
    """Run the pipeline on a single video and save extraction for eval.

    Returns the output file path.
    """
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")

    from src.extraction.gemini import extract_equations
    from src.extraction.latex_fix import fix_latex_escapes

    vid = extract_video_id(youtube_url)
    if not vid:
        raise ValueError(f"Cannot extract video ID from: {youtube_url}")

    print(f"Extracting equations from {youtube_url} ...")
    equations_output, raw = extract_equations(youtube_url)

    # Build output in the expected format
    equations = []
    for eq in equations_output.equations:
        equations.append({
            "latex": fix_latex_escapes(eq.latex),
            "description": eq.description,
            "discussed_start": eq.discussed_start,
            "discussed_end": eq.discussed_end,
            "confidence": eq.confidence,
        })

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{vid}.json")
    with open(output_path, "w") as f:
        json.dump({"equations": equations}, f, indent=2)

    print(f"Saved {len(equations)} equations to {output_path}")
    return output_path


def run_eval(
    dataset_path: str,
    extractions_dir: str,
    fuzzy_threshold: float = 0.3,
    show_misses: int = 20,
) -> None:
    """Run evaluation across all videos that have extraction files."""
    gt_by_id = load_ground_truth(dataset_path)
    print(f"Ground truth: {len(gt_by_id)} videos, {sum(len(v) for v in gt_by_id.values())} equations")

    # Find extraction files
    extraction_files = {}
    if os.path.isdir(extractions_dir):
        for fname in os.listdir(extractions_dir):
            if fname.endswith(".json"):
                vid = fname.replace(".json", "")
                extraction_files[vid] = os.path.join(extractions_dir, fname)

    # Match available extractions to ground truth
    matched_ids = set(gt_by_id.keys()) & set(extraction_files.keys())
    if not matched_ids:
        print(f"\nNo matching videos found between ground truth and {extractions_dir}/")
        print(f"Ground truth video IDs: {list(gt_by_id.keys())[:5]}...")
        print(f"Extraction files: {list(extraction_files.keys())[:5]}...")
        return

    print(f"Evaluating {len(matched_ids)} videos with extraction data")
    print()

    video_reports = []
    all_results = []

    for vid in sorted(matched_ids):
        gt = gt_by_id[vid]
        extracted = load_extraction(extraction_files[vid])

        results = match_video(gt, extracted, fuzzy_threshold)
        report = build_video_report(
            video_url=f"https://www.youtube.com/watch?v={vid}",
            results=results,
            extracted_count=len(extracted),
        )
        video_reports.append(report)

        for gt_eq, result in zip(gt, results):
            all_results.append((gt_eq["latex"], result))

        print(f"  {vid}: recall={report.recall:.0%} "
              f"({report.exact_matches}E+{report.fuzzy_matches}F/{report.gt_count}) "
              f"extracted={report.extracted_count}")

    summary = build_summary(video_reports, all_results)
    print()
    print_summary(summary)

    if show_misses > 0:
        print_misses(summary, limit=show_misses)


def main():
    parser = argparse.ArgumentParser(description="Chalkboard evaluation harness")
    parser.add_argument(
        "--dataset",
        default="dataset/mathspeech_by_video.json",
        help="Path to MathSpeech ground truth JSON",
    )
    parser.add_argument(
        "--extractions",
        default="eval/extractions",
        help="Directory containing per-video extraction JSON files",
    )
    parser.add_argument(
        "--extract",
        help="Extract a single YouTube video and save to extractions dir (costs 1 Gemini call)",
    )
    parser.add_argument(
        "--fuzzy-threshold",
        type=float,
        default=0.3,
        help="Max CER for fuzzy matching (default: 0.3)",
    )
    parser.add_argument(
        "--show-misses",
        type=int,
        default=20,
        help="Number of missed equations to display (default: 20)",
    )
    args = parser.parse_args()

    if args.extract:
        extract_single_video(args.extract, args.extractions)
        print()

    run_eval(args.dataset, args.extractions, args.fuzzy_threshold, args.show_misses)


if __name__ == "__main__":
    main()
