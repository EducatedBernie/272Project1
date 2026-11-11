"""Tests for `_load_auto_captions` — the helper that lets reprocess flows
reuse persisted captions instead of re-fetching via yt-dlp / Chirp.

Captions are immutable per video; the architectural rule is that reprocess
never regenerates them. This file locks two contracts:

1. The newest *complete* run carrying captions wins (so re-runs of the
   primary process pipeline overwrite older snapshots).
2. If no run on this video has captions, the helper raises with a clear
   "run a full reprocess first" message — never silently regenerates.
"""
from datetime import datetime, timedelta

import pytest

from scripts.process_video_v2 import _load_auto_captions
from src.models.pipeline_run import RunStatus


def _captions(text="hello world"):
    return [{"start": 0.0, "end": 1.0, "text": text}]


def test_returns_most_recent_complete_run_with_captions(session, make_video, make_run):
    video = make_video()
    base = datetime(2026, 4, 30, 12, 0, 0)

    make_run(
        video=video,
        status=RunStatus.complete,
        auto_captions=_captions("older"),
        created_at=base,
    )
    make_run(
        video=video,
        status=RunStatus.complete,
        auto_captions=_captions("newer"),
        created_at=base + timedelta(minutes=10),
    )
    session.flush()

    result = _load_auto_captions(session, video.id)
    assert result == _captions("newer")


def test_raises_when_no_run_has_captions(session, make_video, make_run):
    video = make_video()
    make_run(video=video, status=RunStatus.complete, auto_captions=None)
    session.flush()

    with pytest.raises(RuntimeError, match="No persisted auto_captions"):
        _load_auto_captions(session, video.id)


def test_ignores_failed_run_even_if_it_has_captions(session, make_video, make_run):
    """Defensive against a future change that persists captions before the
    `complete` transition. Today auto_captions is only set at end-of-run, so
    a failed run shouldn't have it — but the filter must hold regardless.
    """
    video = make_video()
    base = datetime(2026, 4, 30, 12, 0, 0)

    # Failed run with captions — must be ignored
    make_run(
        video=video,
        status=RunStatus.failed,
        auto_captions=_captions("from-failed-run"),
        created_at=base + timedelta(minutes=10),
    )
    # Older complete run with captions — must win
    make_run(
        video=video,
        status=RunStatus.complete,
        auto_captions=_captions("from-complete-run"),
        created_at=base,
    )
    session.flush()

    result = _load_auto_captions(session, video.id)
    assert result == _captions("from-complete-run")


def test_ignores_other_videos_runs(session, make_video, make_run):
    """Bug class: WHERE clause picking up captions from a different video.
    The filter must scope by video_id."""
    target = make_video()
    other = make_video()

    make_run(
        video=other,
        status=RunStatus.complete,
        auto_captions=_captions("wrong-video"),
    )
    session.flush()

    with pytest.raises(RuntimeError, match="No persisted auto_captions"):
        _load_auto_captions(session, target.id)
