from types import SimpleNamespace

import pytest

from src.exceptions import ExtractionFailedError


def test_get_video_metadata_uses_no_playlist(monkeypatch):
    from scripts import process_video_v2

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="Lecture title\n2975\npublic\n", stderr="")

    monkeypatch.setattr(process_video_v2.subprocess, "run", fake_run)

    assert process_video_v2.get_video_metadata("https://www.youtube.com/watch?v=x&list=y") == (
        "Lecture title",
        2975.0,
        "public",
    )
    assert "--no-playlist" in calls[0]
    assert "%(availability)s" in calls[0]


def test_unlisted_youtube_is_rejected_before_caption_or_gemini_work(monkeypatch):
    from scripts import process_video_v2

    downstream_calls = []

    monkeypatch.setattr(process_video_v2.genai, "Client", lambda api_key=None: object())
    monkeypatch.setattr(
        process_video_v2,
        "get_video_metadata",
        lambda _url: ("Unlisted lecture", 600.0, "unlisted"),
    )
    monkeypatch.setattr(
        process_video_v2,
        "download_captions",
        lambda *_args, **_kwargs: downstream_calls.append("captions"),
    )
    monkeypatch.setattr(
        process_video_v2,
        "generate_topic_map",
        lambda *_args, **_kwargs: downstream_calls.append("topic_map"),
    )

    with pytest.raises(ValueError, match="Only public YouTube videos.*upload the video file"):
        process_video_v2.process_video(
            "https://www.youtube.com/watch?v=unlisted",
            return_payload=True,
        )

    assert downstream_calls == []


@pytest.mark.parametrize("availability", ["private", "needs_auth", "premium_only", "subscriber_only"])
def test_known_nonpublic_youtube_states_are_rejected(availability):
    from scripts.process_video_v2 import validate_youtube_availability

    with pytest.raises(ValueError, match=availability):
        validate_youtube_availability(availability)


@pytest.mark.parametrize("availability", ["public", "", None, "NA", "unknown"])
def test_public_or_unknown_youtube_states_are_allowed(availability):
    from scripts.process_video_v2 import validate_youtube_availability

    assert validate_youtube_availability(availability) is None


def test_download_captions_prefers_original_english_and_falls_back(monkeypatch, tmp_path):
    from scripts import process_video_v2

    calls = []
    original_available = True

    def fake_run(args, **_kwargs):
        language = args[args.index("--sub-lang") + 1]
        calls.append(language)
        if language == "en-orig" and original_available:
            (tmp_path / "captions.en-orig.srt").write_text("original", encoding="utf-8")
        elif language == "en":
            (tmp_path / "captions.en.srt").write_text("fallback", encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(process_video_v2.subprocess, "run", fake_run)
    assert process_video_v2.download_captions("https://youtu.be/example", str(tmp_path)).endswith(
        "captions.en-orig.srt"
    )
    assert calls == ["en-orig"]

    (tmp_path / "captions.en-orig.srt").unlink()
    original_available = False
    calls.clear()
    assert process_video_v2.download_captions("https://youtu.be/example", str(tmp_path)).endswith(
        "captions.en.srt"
    )
    assert calls == ["en-orig", "en"]


def test_full_run_with_zero_transcript_fails(monkeypatch, tmp_path):
    from scripts import process_video_v2

    srt_path = tmp_path / "captions.en.srt"
    srt_path.write_text(
        "1\n00:00:00,000 --> 00:00:05,000\nhello world\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(process_video_v2.genai, "Client", lambda api_key=None: object())
    monkeypatch.setattr(process_video_v2, "get_video_metadata", lambda _url: ("Title", 60.0, "public"))
    monkeypatch.setattr(process_video_v2, "download_captions", lambda _url, _tmpdir: str(srt_path))
    topic_models = []

    def fake_topic_map(_srt_path, accumulator=None, call_recorder=None, model=None):
        topic_models.append(model)
        return {
            "summary": "Summary",
            "sections": [{"start_time": "0:00", "end_time": "0:30", "title": "Intro", "description": ""}],
        }

    monkeypatch.setattr(process_video_v2, "generate_topic_map", fake_topic_map)
    monkeypatch.setattr(
        process_video_v2,
        "get_chunk_boundaries",
        lambda _topic_map, _duration: [(0, 30, "Intro", "context")],
    )
    monkeypatch.setattr(process_video_v2, "extract_transcript_chunk", lambda *args, **kwargs: [])
    monkeypatch.setattr(process_video_v2, "extract_visual_content_chunk", lambda *args, **kwargs: ([], None))
    monkeypatch.setattr(process_video_v2, "notify_pipeline_event", lambda **_kwargs: None)

    with pytest.raises(ExtractionFailedError, match="zero sentences"):
        process_video_v2.process_video(
            "https://www.youtube.com/watch?v=hXDIZnfCRws&list=playlist",
            model="gemini-explicit-override",
            return_payload=True,
        )

    assert topic_models == ["gemini-explicit-override"]


def test_full_run_cancels_pending_sections_after_terminal_extraction_failure(monkeypatch, tmp_path):
    from scripts import process_video_v2

    srt_path = tmp_path / "captions.en.srt"
    srt_path.write_text(
        "1\n00:00:00,000 --> 00:00:05,000\nhello world\n",
        encoding="utf-8",
    )

    transcript_calls = []

    def fail_transcript(_client, _url, start, *_args, **_kwargs):
        transcript_calls.append(start)
        raise ExtractionFailedError("Transcript extraction failed for section 1")

    monkeypatch.setattr(process_video_v2.genai, "Client", lambda api_key=None: object())
    monkeypatch.setattr(process_video_v2, "get_video_metadata", lambda _url: ("Title", 60.0, "public"))
    monkeypatch.setattr(process_video_v2, "download_captions", lambda _url, _tmpdir: str(srt_path))
    monkeypatch.setattr(
        process_video_v2,
        "generate_topic_map",
        lambda _srt_path, accumulator=None, call_recorder=None, model=None: {
            "summary": "Summary",
            "sections": [
                {"start_time": "0:00", "end_time": "0:30", "title": "Intro", "description": ""},
                {"start_time": "0:30", "end_time": "1:00", "title": "Next", "description": ""},
            ],
        },
    )
    monkeypatch.setattr(
        process_video_v2,
        "get_chunk_boundaries",
        lambda _topic_map, _duration: [
            (0, 30, "Intro", "context"),
            (30, 60, "Next", "context"),
        ],
    )
    monkeypatch.setattr(process_video_v2, "_pipeline_max_workers", lambda: 1)
    monkeypatch.setattr(process_video_v2, "extract_transcript_chunk", fail_transcript)
    monkeypatch.setattr(process_video_v2, "extract_visual_content_chunk", lambda *args, **kwargs: ([], None))
    monkeypatch.setattr(process_video_v2, "notify_pipeline_event", lambda **_kwargs: None)

    with pytest.raises(ExtractionFailedError, match="Transcript extraction failed"):
        process_video_v2.process_video(
            "https://www.youtube.com/watch?v=hXDIZnfCRws",
            return_payload=True,
        )

    assert transcript_calls == [0]
