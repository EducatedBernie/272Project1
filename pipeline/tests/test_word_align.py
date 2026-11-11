"""Regression tests for alignment_meta shape contract.

The viewer's debug page reads specific keys from alignment_meta (see the
AlignmentMeta interface in viewer/lib/alignment-meta.ts). There is no
compile-time link between this Python producer and the TypeScript consumer,
so a rename here silently breaks the debug page — exactly the bug class
that PR #5 had to fix when stripped keys made the UI render "no alignment
data" for every Railway-processed video.

These tests lock the contract: if a key gets renamed or dropped, this test
fails before the change reaches production.
"""

from src.processing.word_align import align_sentences_to_captions


# Mirrors viewer/lib/alignment-meta.ts AlignmentMeta interface.
EXPECTED_KEYS = {
    "matched_sentences",
    "total_sentences",
    "matched_words",
    "total_gemini_words",
    "total_ref_words",
    "word_coverage",
    "ref_coverage",
    "unmatched_ref_words",
    "merged_count",
}


def _align(sentences, captions):
    """Run alignment and return the meta dict."""
    _times, _sents, meta = align_sentences_to_captions(sentences, captions)
    return meta


def test_alignment_meta_has_exactly_the_viewer_contract_keys():
    """Catches additions and removals — both can break the viewer.

    Adding a new key isn't strictly breaking, but it indicates the schema
    drifted and the TS interface needs updating in the same change.
    """
    meta = _align(
        ["The velocity is increasing."],
        [{"start": 0.0, "end": 2.0, "text": "the velocity is increasing"}],
    )
    assert set(meta.keys()) == EXPECTED_KEYS


def test_alignment_meta_field_types_match_viewer_expectations():
    """The viewer does Math.round(ref_coverage * 100) and reads
    total_ref_words as a number — string/null leak in here causes NaN%.
    """
    meta = _align(
        ["The velocity is increasing.", "By acceleration over time."],
        [
            {"start": 0.0, "end": 2.0, "text": "the velocity is increasing"},
            {"start": 2.0, "end": 4.0, "text": "by acceleration over time"},
        ],
    )
    assert isinstance(meta["matched_sentences"], int)
    assert isinstance(meta["total_sentences"], int)
    assert isinstance(meta["matched_words"], int)
    assert isinstance(meta["total_gemini_words"], int)
    assert isinstance(meta["total_ref_words"], int)
    assert isinstance(meta["merged_count"], int)
    assert isinstance(meta["word_coverage"], float)
    assert isinstance(meta["ref_coverage"], float)
    assert isinstance(meta["unmatched_ref_words"], list)


def test_unmatched_ref_words_entry_shape():
    """Each entry must be {time: float, word: str} — the debug UI
    iterates these as `{time, word}` and would crash on a different shape.
    """
    # Deliberately mismatched so unmatched_ref_words is non-empty.
    meta = _align(
        ["Force equals mass times acceleration."],
        [{"start": 0.0, "end": 5.0, "text": "the velocity is increasing rapidly today"}],
    )
    assert len(meta["unmatched_ref_words"]) > 0, "fixture should produce unmatched words"
    for entry in meta["unmatched_ref_words"]:
        assert set(entry.keys()) == {"time", "word"}
        assert isinstance(entry["time"], (int, float))
        assert isinstance(entry["word"], str)


def test_coverage_fields_are_fractions_not_percentages():
    """word_coverage and ref_coverage are 0.0–1.0 fractions.

    Locks in the contract that notify_pipeline_event and the viewer both
    rely on. A previous bug at process_video_v2.py:487/997 read a
    nonexistent `word_coverage_pct` and divided by 100 — fixed in #6.
    """
    meta = _align(
        ["The velocity is increasing."],
        [{"start": 0.0, "end": 2.0, "text": "the velocity is increasing"}],
    )
    assert 0.0 <= meta["word_coverage"] <= 1.0
    assert 0.0 <= meta["ref_coverage"] <= 1.0
