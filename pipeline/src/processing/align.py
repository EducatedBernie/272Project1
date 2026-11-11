"""
Align Gemini transcript timestamps against a reference transcript (YouTube captions or STT).

Gemini produces rich content (inline LaTeX) but unreliable timestamps.
The reference (YouTube/STT) has accurate timestamps but plain text.
This module matches Gemini segments to reference timestamps using
monotonic sequential text alignment.

Usage:
    from src.processing.align import align_timestamps, parse_srt

    ref_entries = parse_srt("/path/to/youtube.en.srt")
    aligned = align_timestamps(gemini_segments, ref_entries)
"""

import re
import logging

logger = logging.getLogger("chalkboard")


def parse_srt(path: str) -> list[tuple[float, float, str]]:
    """Parse SRT file into list of (start_seconds, end_seconds, text)."""
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
        end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
        text = ' '.join(lines[2:]).strip()
        if text:
            entries.append((start, end, text))
    return entries


def _normalize(text: str) -> str:
    """Strip LaTeX, punctuation, lowercase — just words for comparison."""
    # Remove $...$ LaTeX blocks, keep a marker
    text = re.sub(r'\$[^$]+\$', ' ', text)
    # Remove punctuation
    text = re.sub(r'[^\w\s]', ' ', text)
    # Lowercase, collapse whitespace
    return re.sub(r'\s+', ' ', text.lower()).strip()


def _ngrams(text: str, n: int = 4) -> set[str]:
    """Extract word n-grams as a set."""
    words = text.split()
    if len(words) < n:
        return {text} if text else set()
    return {' '.join(words[i:i + n]) for i in range(len(words) - n + 1)}


def _similarity(a: str, b: str) -> float:
    """Jaccard similarity on 4-grams between two normalized texts."""
    ngrams_a = _ngrams(a)
    ngrams_b = _ngrams(b)
    if not ngrams_a or not ngrams_b:
        return 0.0
    intersection = ngrams_a & ngrams_b
    union = ngrams_a | ngrams_b
    return len(intersection) / len(union)


def align_timestamps(
    segments: list[dict],
    ref_entries: list[tuple[float, float, str]],
    min_similarity: float = 0.15,
    search_window: int = 50,
) -> list[dict]:
    """Align Gemini segment timestamps against reference transcript.

    Uses monotonic sequential matching — each Gemini segment is matched
    to the best reference entry that comes AFTER the previous match.
    This prevents common phrases from matching to the wrong location.

    Args:
        segments: List of dicts with 'text', 'timestamp_start', 'timestamp_end'
        ref_entries: List of (start, end, text) from parse_srt
        min_similarity: Minimum Jaccard similarity to accept a match
        search_window: How many ref entries ahead to search from current position

    Returns:
        Same segments list with updated timestamp_start and timestamp_end.
        Unmatched segments keep their original timestamps.
    """
    if not ref_entries:
        logger.warning("No reference entries — skipping alignment")
        return segments

    # Build normalized reference text with cumulative windows
    # Group nearby ref entries into windows for better matching
    ref_windows = []
    i = 0
    while i < len(ref_entries):
        # Combine 3-5 consecutive ref entries into a window
        window_text = ""
        window_start = ref_entries[i][0]
        window_end = ref_entries[i][1]
        j = i
        while j < min(i + 4, len(ref_entries)):
            window_text += " " + ref_entries[j][2]
            window_end = ref_entries[j][1]
            j += 1
        ref_windows.append((window_start, window_end, _normalize(window_text)))
        i += 1  # slide by 1 for overlap

    ref_pos = 0  # current position in reference — only moves forward
    aligned_count = 0
    unaligned_count = 0
    matched_indices = set()
    originals = {}

    for idx, seg in enumerate(segments):
        originals[idx] = seg["timestamp_start"]

    for idx, seg in enumerate(segments):
        seg_norm = _normalize(seg["text"])
        non_math_words = len(seg_norm.split()) if seg_norm else 0

        if non_math_words < 4:
            # Too short after stripping LaTeX — interpolate later
            unaligned_count += 1
            continue

        best_score = 0.0
        best_idx = -1

        # Narrow search window — scale with expected position
        # Use original timestamp to estimate where in ref we should be
        expected_ref_pos = ref_pos
        window = min(search_window, max(20, non_math_words))

        end_search = min(expected_ref_pos + window, len(ref_windows))
        for k in range(expected_ref_pos, end_search):
            score = _similarity(seg_norm, ref_windows[k][2])
            if score > best_score:
                best_score = score
                best_idx = k

        # Higher threshold for short segments to avoid false matches
        threshold = min_similarity if non_math_words >= 8 else min_similarity * 1.5

        if best_score >= threshold and best_idx >= 0:
            # Sanity check: the matched ref time shouldn't be wildly different
            # from what we'd expect based on neighboring matches
            ref_time = ref_windows[best_idx][0]
            seg_time = seg["timestamp_start"]

            # If we have previous matches, check the jump isn't absurd
            if matched_indices:
                last_matched_idx = max(matched_indices)
                last_matched_time = segments[last_matched_idx]["timestamp_start"]
                last_orig_time = originals[last_matched_idx]
                time_since_last = seg_time - last_orig_time
                ref_jump = ref_time - last_matched_time

                # If ref jumps way more than expected (>3x), it's probably wrong
                if time_since_last > 0 and ref_jump > time_since_last * 3 + 30:
                    unaligned_count += 1
                    continue

            seg["timestamp_start"] = ref_time
            seg["timestamp_end"] = ref_windows[best_idx][1]
            ref_pos = best_idx + 1  # advance — monotonic
            aligned_count += 1
            matched_indices.add(idx)
        else:
            unaligned_count += 1

    # Post-pass: detect segments where alignment created non-monotonic timestamps
    # or implausible jumps, and revert those to unmatched for interpolation
    sorted_matched = sorted(matched_indices)
    reverted = 0
    for i in range(1, len(sorted_matched)):
        prev_idx = sorted_matched[i - 1]
        curr_idx = sorted_matched[i]
        prev_time = segments[prev_idx]["timestamp_start"]
        curr_time = segments[curr_idx]["timestamp_start"]

        # Timestamps should be monotonically increasing
        if curr_time < prev_time:
            matched_indices.discard(curr_idx)
            segments[curr_idx]["timestamp_start"] = originals[curr_idx]
            reverted += 1
            continue

        # Check for implausible jumps: if segments are close in sequence
        # but far apart in time, the match is probably wrong
        idx_gap = curr_idx - prev_idx
        time_gap = curr_time - prev_time
        if idx_gap <= 3 and time_gap > 120:
            matched_indices.discard(curr_idx)
            segments[curr_idx]["timestamp_start"] = originals[curr_idx]
            reverted += 1

    if reverted:
        aligned_count -= reverted
        unaligned_count += reverted
        logger.info(f"  Reverted {reverted} implausible matches")

    # Interpolate timestamps for unmatched segments from nearest matched neighbors
    matched_indices = [
        i for i, seg in enumerate(segments)
        if abs(seg["timestamp_start"] - originals.get(i, seg["timestamp_start"])) > 0.1
    ] if originals else []

    if matched_indices:
        interpolated = 0
        for i, seg in enumerate(segments):
            if i not in set(matched_indices):
                # Find nearest matched before and after
                before = [m for m in matched_indices if m < i]
                after = [m for m in matched_indices if m > i]
                if before and after:
                    b_idx = before[-1]
                    a_idx = after[0]
                    # Linear interpolation
                    frac = (i - b_idx) / (a_idx - b_idx)
                    b_start = segments[b_idx]["timestamp_start"]
                    a_start = segments[a_idx]["timestamp_start"]
                    b_end = segments[b_idx]["timestamp_end"]
                    a_end = segments[a_idx]["timestamp_end"]
                    seg["timestamp_start"] = b_start + frac * (a_start - b_start)
                    seg["timestamp_end"] = b_end + frac * (a_end - b_end)
                    interpolated += 1
                elif before:
                    # After the last match — use last matched segment's timing as anchor
                    seg["timestamp_start"] = segments[before[-1]]["timestamp_end"]
                    seg["timestamp_end"] = seg["timestamp_start"] + 5.0
                    interpolated += 1
        unaligned_count -= interpolated
        logger.info(
            f"  Alignment: {aligned_count} matched, {interpolated} interpolated, "
            f"{unaligned_count} unresolved (of {len(segments)} segments)"
        )
    else:
        logger.info(
            f"  Alignment: {aligned_count} matched, {unaligned_count} unmatched "
            f"(of {len(segments)} segments)"
        )

    return segments
