"""Tests for src.extraction.usage.UsageAccumulator.

Covers the behaviors that matter for the v2 pipeline integration:
- Thread safety under the ThreadPoolExecutor concurrency model
- Defensive handling of MagicMock-shaped responses (existing tests
  use `MagicMock()` as the response object)
- Truncation flag when over MAX_CALLS
- Summary aggregation correctness
- summary() returns a freshly-built dict each call (safe to merge into
  SQLAlchemy JSONB while the accumulator is being mutated by other threads)
"""

import threading
from unittest.mock import MagicMock

import pytest

from src.extraction.usage import (
    MAX_CALLS,
    UsageAccumulator,
    _capture_usage,
)


# ── _capture_usage ─────────────────────────────────────────────────────────


def _fake_response(*, prompt=None, candidates=None, total=None, cached=None,
                   thoughts=None, model_version="gemini-3-flash-preview-1234567"):
    """Build a duck-typed response object with the fields _capture_usage reads.

    Plain SimpleNamespace so we don't get MagicMock's auto-attribute behavior.
    """
    from types import SimpleNamespace
    um = SimpleNamespace(
        prompt_token_count=prompt,
        candidates_token_count=candidates,
        total_token_count=total,
        cached_content_token_count=cached,
        thoughts_token_count=thoughts,
    )
    return SimpleNamespace(usage_metadata=um, model_version=model_version)


def test_capture_usage_returns_none_for_real_none_metadata():
    response = MagicMock(usage_metadata=None)
    assert _capture_usage(response, model="gemini-3-flash-preview", kind="transcript", section_index=0) is None


def test_capture_usage_returns_none_for_magicmock_polluted_metadata():
    # MagicMock without explicit usage_metadata=None — getattr returns
    # another MagicMock for every field. _capture_usage must bail.
    response = MagicMock()
    assert _capture_usage(response, model="m", kind="transcript", section_index=0) is None


def test_capture_usage_real_response():
    response = _fake_response(prompt=33000, candidates=1500, total=34500, cached=2100, thoughts=0)
    out = _capture_usage(response, model="gemini-3-flash-preview", kind="transcript", section_index=2)
    assert out == {
        "kind": "transcript",
        "section_index": 2,
        "model_requested": "gemini-3-flash-preview",
        "model_version": "gemini-3-flash-preview-1234567",
        "prompt_token_count": 33000,
        "candidates_token_count": 1500,
        "total_token_count": 34500,
        "cached_content_token_count": 2100,
        "thoughts_token_count": 0,
    }


def test_capture_usage_partial_fields_still_records():
    # Some SDK responses return only prompt/candidates without total
    response = _fake_response(prompt=100, candidates=20)
    out = _capture_usage(response, model="m", kind="topic_map", section_index=None)
    assert out is not None
    assert out["prompt_token_count"] == 100
    assert out["candidates_token_count"] == 20
    assert out["total_token_count"] is None


def test_capture_usage_skips_non_int_pollution():
    # If a field somehow comes back as a MagicMock (e.g. partial mock),
    # it should be coerced to None rather than passed through.
    from types import SimpleNamespace
    um = SimpleNamespace(
        prompt_token_count=MagicMock(),  # not an int
        candidates_token_count=MagicMock(),
        total_token_count=MagicMock(),
        cached_content_token_count=MagicMock(),
        thoughts_token_count=MagicMock(),
    )
    response = SimpleNamespace(usage_metadata=um, model_version="m")
    # All numeric fields are non-int → bail
    assert _capture_usage(response, model="m", kind="transcript", section_index=0) is None


def test_capture_usage_non_string_model_version_coerced_to_none():
    response = _fake_response(prompt=10, candidates=5, total=15, model_version=MagicMock())
    out = _capture_usage(response, model="m", kind="transcript", section_index=0)
    assert out is not None
    assert out["model_version"] is None


# ── UsageAccumulator basic ─────────────────────────────────────────────────


def test_record_silently_skips_unusable_response():
    acc = UsageAccumulator()
    acc.record(MagicMock(), model="m", kind="transcript", section_index=0)
    s = acc.summary()
    assert s["totals"]["calls"] == 0
    assert s["calls"] == []
    assert s["truncated"] is False


def test_record_appends_real_usage():
    acc = UsageAccumulator()
    acc.record(_fake_response(prompt=100, candidates=20, total=120), model="m1", kind="transcript", section_index=0)
    acc.record(_fake_response(prompt=200, candidates=40, total=240, cached=50), model="m1", kind="equations", section_index=0)
    s = acc.summary()
    assert s["totals"]["calls"] == 2
    assert s["totals"]["prompt_tokens"] == 300
    assert s["totals"]["candidates_tokens"] == 60
    assert s["totals"]["total_tokens"] == 360
    assert s["totals"]["cached_tokens"] == 50
    assert s["by_kind"] == {"transcript": 1, "equations": 1}
    assert len(s["calls"]) == 2


def test_summary_aggregates_by_model_version():
    acc = UsageAccumulator()
    acc.record(_fake_response(prompt=100, candidates=10, total=115, thoughts=5, model_version="model-A"), model="req", kind="transcript", section_index=0)
    acc.record(_fake_response(prompt=200, candidates=20, total=230, cached=40, thoughts=10, model_version="model-A"), model="req", kind="transcript", section_index=1)
    acc.record(_fake_response(prompt=50, candidates=5, total=58, cached=10, thoughts=3, model_version="model-B"), model="req", kind="visual_content", section_index=0)
    s = acc.summary()
    assert s["by_model_version"]["model-A"] == {
        "calls": 2,
        "prompt_tokens": 300,
        "candidates_tokens": 30,
        "cached_tokens": 40,
        "thoughts_tokens": 15,
        "total_tokens": 345,
    }
    assert s["by_model_version"]["model-B"] == {
        "calls": 1,
        "prompt_tokens": 50,
        "candidates_tokens": 5,
        "cached_tokens": 10,
        "thoughts_tokens": 3,
        "total_tokens": 58,
    }


def test_summary_falls_back_to_model_requested_when_version_missing():
    response = _fake_response(prompt=100, candidates=10, total=110, model_version=None)
    acc = UsageAccumulator()
    acc.record(response, model="gemini-3-flash-preview", kind="transcript", section_index=0)
    s = acc.summary()
    assert "gemini-3-flash-preview" in s["by_model_version"]


# ── Truncation cap ─────────────────────────────────────────────────────────


def test_truncation_cap():
    """Once MAX_CALLS is hit, additional records are dropped and truncated=True."""
    acc = UsageAccumulator(max_calls=3)
    for i in range(5):
        acc.record(_fake_response(prompt=10, candidates=5, total=15), model="m", kind="transcript", section_index=i)
    s = acc.summary()
    assert s["totals"]["calls"] == 3
    assert s["truncated"] is True
    assert len(s["calls"]) == 3


def test_default_max_calls_is_200():
    assert MAX_CALLS == 200
    # Sanity: with default cap, 250 records fit into 200 + truncated
    acc = UsageAccumulator()
    for i in range(250):
        acc.record(_fake_response(prompt=1, candidates=1, total=2), model="m", kind="transcript", section_index=i)
    s = acc.summary()
    assert s["totals"]["calls"] == 200
    assert s["truncated"] is True


# ── Thread safety ──────────────────────────────────────────────────────────


def test_concurrent_record_no_lost_entries():
    """50 threads × 100 records each = 5000 entries (well under default cap),
    no records lost to races."""
    acc = UsageAccumulator(max_calls=10000)

    def worker(idx):
        for i in range(100):
            acc.record(
                _fake_response(prompt=1, candidates=1, total=2),
                model="m", kind="transcript", section_index=idx,
            )

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    s = acc.summary()
    assert s["totals"]["calls"] == 5000
    assert s["totals"]["prompt_tokens"] == 5000
    assert s["truncated"] is False


def test_concurrent_record_truncates_correctly():
    """Concurrent recording past cap still truncates exactly to cap."""
    acc = UsageAccumulator(max_calls=100)

    def worker():
        for _ in range(50):
            acc.record(
                _fake_response(prompt=1, candidates=1, total=2),
                model="m", kind="transcript", section_index=0,
            )

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    s = acc.summary()
    assert s["totals"]["calls"] == 100  # exactly the cap, no off-by-one
    assert s["truncated"] is True


# ── summary() isolation ────────────────────────────────────────────────────


def test_summary_returns_independent_copy():
    """Mutating the returned summary's `calls` list must not affect the
    accumulator's internal state. Critical when the dict is handed off to
    SQLAlchemy for serialization while another thread keeps recording."""
    acc = UsageAccumulator()
    acc.record(_fake_response(prompt=100, candidates=10, total=110), model="m", kind="transcript", section_index=0)

    s1 = acc.summary()
    s1["calls"].append({"injected": True})
    s1["calls"][0]["prompt_token_count"] = 999999

    s2 = acc.summary()
    assert len(s2["calls"]) == 1  # injection didn't leak
    assert s2["calls"][0]["prompt_token_count"] == 100  # mutation didn't leak


def test_summary_independence_under_concurrent_record():
    """Take a snapshot, then keep recording; the snapshot stays stable."""
    acc = UsageAccumulator(max_calls=10000)
    for i in range(10):
        acc.record(_fake_response(prompt=10, candidates=1, total=11), model="m", kind="transcript", section_index=i)
    snapshot = acc.summary()
    snapshot_calls_before = snapshot["totals"]["calls"]

    for i in range(20):
        acc.record(_fake_response(prompt=10, candidates=1, total=11), model="m", kind="equations", section_index=i)

    # The snapshot we already took is unchanged
    assert snapshot["totals"]["calls"] == snapshot_calls_before == 10
    # A fresh summary reflects the new state
    fresh = acc.summary()
    assert fresh["totals"]["calls"] == 30
