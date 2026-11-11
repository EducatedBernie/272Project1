import inspect
from types import SimpleNamespace

import pytest


def test_production_model_default_is_centralized_across_live_pipeline_paths():
    from scripts import process_video_v2, worker
    from src.config import DEFAULT_GEMINI_MODEL
    from src.extraction import gemini, topic_map

    assert DEFAULT_GEMINI_MODEL == "gemini-3.7-flash"
    assert gemini.MODEL == DEFAULT_GEMINI_MODEL
    assert topic_map.TOPIC_MAP_MODEL == DEFAULT_GEMINI_MODEL
    assert process_video_v2.DEFAULT_MODEL == DEFAULT_GEMINI_MODEL
    assert worker._requested_model({}) == DEFAULT_GEMINI_MODEL

    for function in (
        process_video_v2.extract_transcript_chunk,
        process_video_v2.extract_equations_chunk,
        process_video_v2.extract_visual_content_chunk,
        process_video_v2.reprocess_section,
        process_video_v2.reprocess_visual_content,
        process_video_v2.process_video,
        topic_map.generate_topic_map,
    ):
        assert inspect.signature(function).parameters["model"].default == DEFAULT_GEMINI_MODEL


def test_worker_model_override_wins_over_the_production_default():
    from scripts.worker import _requested_model

    assert _requested_model({"model": "gemini-explicit-override"}) == "gemini-explicit-override"


@pytest.mark.parametrize(
    ("run_type", "target", "params"),
    [
        ("process", "process_video", {"source": "https://youtube.com/watch?v=x"}),
        ("reprocess", "process_video", {"source": "https://youtube.com/watch?v=x"}),
        (
            "reprocess_section",
            "reprocess_section",
            {
                "youtube_url": "https://youtube.com/watch?v=x",
                "video_id": "video-id",
                "section_index": 0,
                "start_time": 0,
                "end_time": 30,
            },
        ),
        (
            "reprocess_visual",
            "reprocess_visual_content",
            {
                "youtube_url": "https://youtube.com/watch?v=x",
                "video_id": "video-id",
                "start_time": 0,
                "end_time": 30,
            },
        ),
    ],
)
def test_worker_dispatch_uses_shared_default_for_every_live_run_type(
    monkeypatch, run_type, target, params
):
    from scripts import worker
    from src.config import DEFAULT_GEMINI_MODEL

    captured = {}
    monkeypatch.setattr(worker, target, lambda **kwargs: captured.update(kwargs))
    run = SimpleNamespace(id="run-id", run_type=run_type, params=params)

    worker.dispatch(run, SimpleNamespace(commit=lambda: None))

    assert captured["model"] == DEFAULT_GEMINI_MODEL


def test_worker_dispatch_preserves_explicit_model_override(monkeypatch):
    from scripts import worker

    captured = {}
    monkeypatch.setattr(worker, "process_video", lambda **kwargs: captured.update(kwargs))
    run = SimpleNamespace(
        id="run-id",
        run_type="process",
        params={
            "source": "https://youtube.com/watch?v=x",
            "model": "gemini-explicit-override",
        },
    )

    worker.dispatch(run, SimpleNamespace(commit=lambda: None))

    assert captured["model"] == "gemini-explicit-override"


def test_topic_map_explicit_model_override_reaches_gemini(monkeypatch, tmp_path):
    from src.extraction import topic_map

    captured = {}

    class FakeModels:
        def generate_content(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                parsed={
                    "summary": "Summary",
                    "sections": [{
                        "start_time": "0:00",
                        "end_time": "0:30",
                        "title": "Intro",
                        "description": "Introduction",
                    }],
                },
            )

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(
        topic_map.genai,
        "Client",
        lambda api_key=None: SimpleNamespace(models=FakeModels()),
    )
    srt = tmp_path / "captions.srt"
    srt.write_text(
        "1\n00:00:00,000 --> 00:00:05,000\nhello world\n",
        encoding="utf-8",
    )

    result = topic_map.generate_topic_map(str(srt), model="gemini-explicit-override")

    assert result["summary"] == "Summary"
    assert captured["model"] == "gemini-explicit-override"
