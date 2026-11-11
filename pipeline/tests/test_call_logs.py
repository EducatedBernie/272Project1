"""Tests for raw Gemini call logging.

The recorder must preserve a compact manifest, survive R2 failures, and stay
safe under the parallel section-processing model.
"""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from src.extraction.call_logs import GeminiCallRecorder


def _fake_response(text='{"items":[]}', parsed=None):
    usage = SimpleNamespace(
        prompt_token_count=100,
        candidates_token_count=20,
        total_token_count=120,
        cached_content_token_count=0,
        thoughts_token_count=0,
    )
    return SimpleNamespace(
        text=text,
        parsed=parsed if parsed is not None else {"items": []},
        usage_metadata=usage,
        model_version="gemini-3-flash-preview-abc",
    )


def test_recorder_writes_manifest_entry(monkeypatch):
    uploads = {}

    def fake_put_json(key, payload):
        uploads[key] = payload
        return 1234

    monkeypatch.setattr("src.storage.r2.put_json", fake_put_json)
    rec = GeminiCallRecorder("run-123")
    rec.record_attempt(
        kind="visual_content",
        attempt=1,
        model="gemini-3-flash-preview",
        started_at=1.0,
        prompt_version="v0.5.0",
        section_index=2,
        start_time=120,
        end_time=180,
        fps=0.5,
        schema="VisualContentExtractionOutput",
        system_instruction="system",
        user_prompt="user",
        response=_fake_response(),
        parsed={"items": []},
        item_count=0,
    )

    summary = rec.summary()
    assert summary["capture_status"] == "complete"
    assert len(summary["calls"]) == 1
    call = summary["calls"][0]
    assert call["kind"] == "visual_content"
    assert call["section_index"] == 2
    assert call["r2_key"].startswith("debug/gemini-call-logs/run-123/")
    assert call["usage"]["total_token_count"] == 120
    assert list(uploads.values())[0]["response"]["text"] == '{"items":[]}'


def test_recorder_continues_when_r2_fails(monkeypatch):
    def boom(_key, _payload):
        raise RuntimeError("r2 down")

    monkeypatch.setattr("src.storage.r2.put_json", boom)
    rec = GeminiCallRecorder("run-123")
    rec.record_attempt(
        kind="transcript",
        attempt=1,
        model="gemini-3-flash-preview",
        started_at=1.0,
        response=_fake_response(),
        parsed={"sentences": []},
    )

    summary = rec.summary()
    assert summary["capture_status"] == "failed"
    assert summary["calls"][0]["r2_key"] is None
    assert summary["calls"][0]["capture_error"]["message"] == "r2 down"


def test_recorder_is_thread_safe(monkeypatch):
    monkeypatch.setattr("src.storage.r2.put_json", lambda _key, _payload: 10)
    rec = GeminiCallRecorder("run-123", max_calls=100)

    def record(i):
        rec.record_attempt(
            kind="transcript",
            attempt=1,
            model="gemini-3-flash-preview",
            started_at=1.0,
            section_index=i,
            response=_fake_response(),
            parsed={"sentences": []},
        )

    with ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(record, range(50)))

    summary = rec.summary()
    assert summary["capture_status"] == "complete"
    assert len(summary["calls"]) == 50
    assert len({c["call_id"] for c in summary["calls"]}) == 50


def test_disabled_recorder_is_unavailable():
    rec = GeminiCallRecorder(None)
    rec.record_attempt(
        kind="topic_map",
        attempt=1,
        model="m",
        started_at=1.0,
    )
    assert rec.summary()["capture_status"] == "unavailable"
    assert rec.summary()["calls"] == []
