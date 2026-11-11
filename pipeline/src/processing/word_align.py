"""
Word-level alignment of Gemini transcript against YouTube captions.

Approach:
1. YouTube captions → timestamped word stream (each word has a timestamp)
2. Gemini sentences → plain word stream (LaTeX stripped)
3. Sequential word matching between the two streams
4. Each Gemini sentence inherits timestamps from its matched word range

This handles LaTeX-heavy sentences where only 1-2 speech words exist —
those words still match sequentially in the word stream.
"""

import re
import logging
from difflib import SequenceMatcher

logger = logging.getLogger("chalkboard")


def parse_srt_to_words(path: str) -> list[tuple[float, str]]:
    """Parse SRT into a flat list of (timestamp, word) pairs.

    Each word inherits the start timestamp of its SRT block.
    """
    with open(path) as f:
        content = f.read()
    blocks = re.split(r'\n\n+', content.strip())
    words = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue
        time_match = re.match(
            r'(\d+):(\d+):(\d+),(\d+)',
            lines[1],
        )
        if not time_match:
            continue
        g = time_match.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        text = ' '.join(lines[2:]).strip()
        block_words = _normalize_to_words(text)
        for w in block_words:
            words.append((start, w))
    return words


def captions_to_words(captions: list[dict]) -> list[tuple[float, str]]:
    """Convert a persisted auto_captions list to (timestamp, word) pairs.

    Mirrors parse_srt_to_words. Each caption entry is
    ``{"start": float, "end": float, "text": str}`` — the shape produced by
    process_video_v2.py when it persists captions to pipeline_runs.auto_captions.
    """
    words: list[tuple[float, str]] = []
    for cap in captions:
        start = cap.get("start")
        text = cap.get("text", "")
        if start is None or not text:
            continue
        for w in _normalize_to_words(text):
            words.append((float(start), w))
    return words


def _normalize_to_words(text: str) -> list[str]:
    """Normalize text to lowercase words, stripping punctuation."""
    text = text.lower()
    text = re.sub(r'[^\w\s]', ' ', text)
    return [w for w in text.split() if w]


def _strip_latex(text: str) -> str:
    """Remove $...$ LaTeX blocks from text."""
    return re.sub(r'\$[^$]+\$', ' ', text)


def sentences_to_words(sentences: list[str]) -> list[tuple[int, int, str]]:
    """Convert Gemini sentences to word list with sentence indices.

    Returns list of (sentence_index, word_position_in_sentence, word).
    """
    words = []
    for sent_idx, sentence in enumerate(sentences):
        plain = _strip_latex(sentence)
        sent_words = _normalize_to_words(plain)
        for word_pos, w in enumerate(sent_words):
            words.append((sent_idx, word_pos, w))
    return words


def align_words(
    gemini_words: list[str],
    ref_words: list[tuple[float, str]],
) -> list[int | None]:
    """Align Gemini word stream against reference word stream.

    Returns a list parallel to gemini_words where each entry is the
    index into ref_words that this Gemini word matched to, or None.

    Uses sequential greedy matching — walks forward through both streams.
    """
    ref_texts = [w for _, w in ref_words]
    n_gemini = len(gemini_words)
    n_ref = len(ref_texts)

    # Use SequenceMatcher on the full word lists
    matcher = SequenceMatcher(None, gemini_words, ref_texts, autojunk=False)
    matches = matcher.get_matching_blocks()

    # Build alignment map: gemini_index → ref_index
    alignment: list[int | None] = [None] * n_gemini
    for a, b, size in matches:
        for i in range(size):
            alignment[a + i] = b + i

    return alignment


def align_sentences_to_timestamps(
    sentences: list[str],
    srt_path: str,
):
    """Align Gemini sentences to caption timestamps from an SRT file.

    Returns ``(merged_results, merged_sentences, alignment_meta)``.
    """
    ref_words = parse_srt_to_words(srt_path)
    return _align_sentences_against_ref(sentences, ref_words)


def align_sentences_to_captions(
    sentences: list[str],
    captions: list[dict],
):
    """Align Gemini sentences against persisted auto_captions.

    Same return shape as align_sentences_to_timestamps, but takes the JSONB
    captions list directly so reprocess flows can reuse the parent run's
    captions without round-tripping through a temp SRT file.
    """
    ref_words = captions_to_words(captions)
    return _align_sentences_against_ref(sentences, ref_words)


def _align_sentences_against_ref(
    sentences: list[str],
    ref_words: list[tuple[float, str]],
):
    """Core alignment shared by SRT-path and captions-list entry points."""
    gemini_word_entries = sentences_to_words(sentences)

    if not ref_words or not gemini_word_entries:
        logger.warning("Empty word streams — returning zero timestamps")
        return [(0.0, 0.0)] * len(sentences)

    # Extract just the words for alignment
    gemini_plain = [w for _, _, w in gemini_word_entries]
    ref_plain = [w for _, w in ref_words]

    # Align
    alignment = align_words(gemini_plain, ref_words)

    # Map alignment back to sentences
    # For each sentence, find the earliest and latest matched ref timestamp
    sentence_starts: dict[int, float] = {}
    sentence_ends: dict[int, float] = {}

    for gem_idx, ref_idx in enumerate(alignment):
        if ref_idx is None:
            continue
        sent_idx = gemini_word_entries[gem_idx][0]
        ref_time = ref_words[ref_idx][0]

        if sent_idx not in sentence_starts or ref_time < sentence_starts[sent_idx]:
            sentence_starts[sent_idx] = ref_time
        if sent_idx not in sentence_ends or ref_time > sentence_ends[sent_idx]:
            sentence_ends[sent_idx] = ref_time

    # Build result, interpolating for unmatched sentences
    results: list[tuple[float, float]] = []
    last_end = 0.0

    for i in range(len(sentences)):
        if i in sentence_starts:
            start = sentence_starts[i]
            end = sentence_ends.get(i, start + 3.0)
            # End should be at least a bit after start
            if end <= start:
                end = start + 2.0
            results.append((start, end))
            last_end = end
        else:
            # Interpolate from neighbors
            # Find next matched sentence
            next_start = None
            for j in range(i + 1, len(sentences)):
                if j in sentence_starts:
                    next_start = sentence_starts[j]
                    break

            if next_start is not None:
                # Interpolate between last_end and next_start
                gap_sentences = 0
                for j in range(i, len(sentences)):
                    if j in sentence_starts:
                        break
                    gap_sentences += 1
                frac = 1 / max(gap_sentences, 1)
                interp_start = last_end + frac * (next_start - last_end) * (i - (i - 1))
                results.append((last_end, last_end + 2.0))
                last_end = last_end + 2.0
            else:
                results.append((last_end, last_end + 2.0))
                last_end = last_end + 2.0

    # Merge consecutive sentences with identical start timestamps
    merged_results = []
    merged_sentences = []
    for i, (start, end) in enumerate(results):
        if merged_results and abs(start - merged_results[-1][0]) < 0.5:
            # Same timestamp — merge with previous
            prev_start, prev_end = merged_results[-1]
            merged_results[-1] = (prev_start, max(prev_end, end))
            merged_sentences[-1] = merged_sentences[-1] + " " + sentences[i]
        else:
            merged_results.append((start, end))
            merged_sentences.append(sentences[i])

    matched_sentences = sum(1 for i in range(len(sentences)) if i in sentence_starts)
    matched_words = sum(1 for a in alignment if a is not None)
    total_gemini_words = len(gemini_plain)
    total_ref_words = len(ref_plain)

    logger.info(
        f"  Word alignment: {matched_sentences}/{len(sentences)} sentences matched "
        f"({matched_words}/{total_gemini_words} words aligned), "
        f"{len(sentences) - len(merged_sentences)} merged"
    )

    # Build unmatched ref words list (YouTube words that no Gemini word matched to)
    matched_ref_indices = set()
    for ref_idx in alignment:
        if ref_idx is not None:
            matched_ref_indices.add(ref_idx)

    unmatched_ref_words = []
    for idx, (ts, word) in enumerate(ref_words):
        if idx not in matched_ref_indices:
            unmatched_ref_words.append({"time": round(ts, 1), "word": word})

    alignment_meta = {
        "matched_sentences": matched_sentences,
        "total_sentences": len(sentences),
        "matched_words": matched_words,
        "total_gemini_words": total_gemini_words,
        "total_ref_words": total_ref_words,
        "word_coverage": round(matched_words / total_gemini_words, 4) if total_gemini_words > 0 else 1.0,
        "ref_coverage": round(len(matched_ref_indices) / total_ref_words, 4) if total_ref_words > 0 else 1.0,
        "unmatched_ref_words": unmatched_ref_words,
        "merged_count": len(sentences) - len(merged_sentences),
    }

    return merged_results, merged_sentences, alignment_meta
