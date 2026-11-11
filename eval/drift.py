"""
Measure timestamp drift between Chalkboard transcript and YouTube auto-captions.

Usage:
    python eval/drift.py <video-db-id> <youtube-srt-path>

Outputs drift measurements at every matched anchor point across the lecture.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def parse_srt(path: str) -> list[tuple[float, str]]:
    """Parse SRT file into list of (timestamp_seconds, text)."""
    with open(path) as f:
        content = f.read()
    blocks = re.split(r'\n\n+', content.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue
        time_match = re.match(
            r'(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)',
            lines[1],
        )
        if not time_match:
            continue
        g = time_match.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        text = ' '.join(lines[2:]).strip()
        if text:
            entries.append((start, text))
    return entries


def normalize(text: str) -> str:
    """Strip LaTeX, punctuation, lowercase — just words."""
    # Remove $...$ LaTeX blocks
    text = re.sub(r'\$[^$]+\$', ' MATH ', text)
    # Remove punctuation
    text = re.sub(r'[^\w\s]', ' ', text)
    # Lowercase, collapse whitespace
    return re.sub(r'\s+', ' ', text.lower()).strip()


def extract_ngrams(text: str, n: int = 5) -> list[str]:
    """Extract word n-grams from normalized text."""
    words = text.split()
    return [' '.join(words[i:i + n]) for i in range(len(words) - n + 1)]


def find_anchors(
    yt_entries: list[tuple[float, str]],
    cb_entries: list[tuple[float, str]],
    ngram_size: int = 5,
) -> list[tuple[float, float, str]]:
    """Find matching anchor points between YouTube and Chalkboard transcripts.

    Returns list of (yt_time, cb_time, matched_phrase).
    """
    # Build ngram → list of timestamps for Chalkboard (a phrase can appear multiple times)
    cb_index: dict[str, list[float]] = {}
    for ts, text in cb_entries:
        for ngram in extract_ngrams(normalize(text), ngram_size):
            cb_index.setdefault(ngram, []).append(ts)

    # For each YouTube entry, find the closest Chalkboard match
    # that is monotonically increasing AND within a proximity window
    anchors = []
    last_cb_time = -1
    max_drift = 60.0  # reject matches more than 60s away from expected position

    for yt_time, yt_text in yt_entries:
        yt_norm = normalize(yt_text)
        best_match = None
        best_distance = float("inf")

        for ngram in extract_ngrams(yt_norm, ngram_size):
            if ngram not in cb_index:
                continue
            for cb_time in cb_index[ngram]:
                # Must be monotonically after last match
                if cb_time <= last_cb_time:
                    continue
                # Must be within proximity window of YouTube time
                distance = abs(cb_time - yt_time)
                if distance > max_drift:
                    continue
                if distance < best_distance:
                    best_distance = distance
                    best_match = (cb_time, ngram)

        if best_match is not None:
            cb_time, ngram = best_match
            anchors.append((yt_time, cb_time, ngram))
            last_cb_time = cb_time

    return anchors


def report_drift(anchors: list[tuple[float, float, str]], video_duration: float):
    """Print drift report."""
    if not anchors:
        print("No anchor points found.")
        return

    drifts = [(yt, cb, cb - yt, phrase) for yt, cb, phrase in anchors]

    print(f"{'YT':>8} {'CB':>8} {'Drift':>8}  Phrase")
    print("-" * 70)

    # Sample evenly — show ~30 points max
    step = max(1, len(drifts) // 30)
    for i in range(0, len(drifts), step):
        yt, cb, drift, phrase = drifts[i]
        yt_fmt = f"{int(yt)//60}:{int(yt)%60:02d}"
        cb_fmt = f"{int(cb)//60}:{int(cb)%60:02d}"
        print(f"{yt_fmt:>8} {cb_fmt:>8} {drift:>+7.1f}s  {phrase[:40]}")

    # Summary stats
    drift_vals = [d for _, _, d, _ in drifts]
    print()
    print(f"Anchor points:  {len(anchors)}")
    print(f"Mean drift:     {sum(drift_vals)/len(drift_vals):+.1f}s")
    print(f"Max drift:      {max(drift_vals):+.1f}s")
    print(f"Min drift:      {min(drift_vals):+.1f}s")
    print(f"Std dev:        {(sum((d - sum(drift_vals)/len(drift_vals))**2 for d in drift_vals) / len(drift_vals)) ** 0.5:.1f}s")

    # Drift by 5-minute bucket
    print()
    print("Drift by 5-minute window:")
    buckets: dict[int, list[float]] = {}
    for yt, _, drift, _ in drifts:
        bucket = int(yt // 300) * 5
        buckets.setdefault(bucket, []).append(drift)

    for bucket in sorted(buckets):
        vals = buckets[bucket]
        avg = sum(vals) / len(vals)
        print(f"  {bucket:>3}-{bucket+5:<3} min: {avg:>+7.1f}s avg ({len(vals)} points)")


def main():
    if len(sys.argv) < 3:
        print("Usage: python eval/drift.py <video-db-id> <youtube-srt-path>")
        sys.exit(1)

    video_id = sys.argv[1]
    srt_path = sys.argv[2]

    # Load Chalkboard transcript from DB
    from src.models import Video, TranscriptSegment
    from src.models.database import SessionLocal
    session = SessionLocal()

    video = session.query(Video).filter_by(id=video_id).first()
    if not video:
        print(f"Video {video_id} not found in DB")
        sys.exit(1)

    segs = session.query(TranscriptSegment).filter_by(
        video_id=video_id
    ).order_by(TranscriptSegment.timestamp_start).all()

    cb_entries = [(s.timestamp_start, s.text) for s in segs]

    # Load YouTube SRT
    yt_entries = parse_srt(srt_path)

    print(f"Video: {video.title}")
    print(f"Duration: {video.duration:.0f}s ({int(video.duration//60)}:{int(video.duration%60):02d})")
    print(f"YouTube captions: {len(yt_entries)} entries")
    print(f"Chalkboard segments: {len(cb_entries)} segments")
    print()

    anchors = find_anchors(yt_entries, cb_entries)
    report_drift(anchors, video.duration)


if __name__ == "__main__":
    main()
