import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from src.extraction.usage import UsageAccumulator


def test_frame_times_stay_inside_the_selected_artifact():
    from src.extraction.notes_illustrations import frame_times

    assert frame_times(10, 20, 60) == [10.5, 15.0, 19.5]
    assert frame_times(5, 5, 60) == [5]
    for values in ((-1, 2, 60), (20, 10, 60), (1, 61, 60), (float("nan"), 3, 60)):
        with pytest.raises(ValueError):
            frame_times(*values)


def test_video_source_cache_reuses_complete_media_and_rejects_arbitrary_urls(tmp_path, monkeypatch):
    from src.extraction.notes_illustrations import load_video_source

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    source = tmp_path / ".cache/chalkboard/notes-video/example/source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"complete cached download")
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: pytest.fail("unnecessary download"))
    assert load_video_source("https://www.youtube.com/watch?v=example", None) == source
    with pytest.raises(ValueError):
        load_video_source("http://127.0.0.1/private", None)


@pytest.mark.parametrize("direct_fails", [False, True])
def test_youtube_frame_download_uses_bounded_direct_media_before_proxy(tmp_path, monkeypatch, direct_fails):
    from src.extraction.notes_illustrations import load_video_source

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("YT_DLP_PROXY", "http://proxy.example:80")
    calls = []

    def run(args, **_kwargs):
        calls.append(args)
        if direct_fails and len(calls) == 1:
            raise subprocess.CalledProcessError(1, args, stderr=b"HTTP 429")
        output = Path(args[args.index("-o") + 1].replace("%(ext)s", "mp4"))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"video frame source")
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(subprocess, "run", run)
    result = load_video_source("https://www.youtube.com/watch?v=ZhsWaYRjk0U", None)
    assert result.read_bytes() == b"video frame source"
    assert "--proxy" not in calls[0]
    assert "bestvideo/best" not in calls[0]
    assert calls[0][calls[0].index("--http-chunk-size") + 1] == "1M"
    assert "vcodec^=av01" in calls[0][calls[0].index("-f") + 1]
    assert len(calls) == (2 if direct_fails else 1)
    if direct_fails:
        assert calls[1][calls[1].index("--proxy") + 1] == "http://proxy.example:80"


@pytest.mark.parametrize("selection", [
    {"frame_id": "other", "box_2d": [1, 2, 30, 40]},
    {"frame_id": "f1", "box_2d": [30, 2, 1, 40]},
    {"frame_id": "f1", "box_2d": [-1, 2, 30, 40]},
    {"frame_id": "f1", "box_2d": [1, 2, float("nan"), 40]},
    {"frame_id": "f1", "box_2d": [True, 2, 30, 40]},
])
def test_box_selection_rejects_wrong_frames_or_invalid_coordinates(selection):
    from src.extraction.notes_illustrations import validate_selection

    with pytest.raises(ValueError):
        validate_selection(selection, [{"id": "f1"}])


def test_box_selection_accepts_explicit_abstention():
    from src.extraction.notes_illustrations import validate_selection

    assert validate_selection({"frame_id": None, "box_2d": None}, [{"id": "f1"}]) is None


def test_boxing_sends_only_supplied_images_and_own_locator_and_records_usage(tmp_path, monkeypatch):
    from src.extraction.notes_illustrations import request_box

    path = tmp_path / "frame.jpg"
    path.write_bytes(b"original frame bytes")
    frames = [{"id": "f1", "path": str(path), "requested_time": 15, "width": 320, "height": 180}]
    requests = []
    urls = []

    def respond(client, request, *args, **kwargs):
        requests.append(json.loads(request.content))
        urls.append(str(request.url))
        return httpx.Response(200, request=request, json={
            "candidates": [{"content": {"parts": [{"text": json.dumps({
                "frame_id": "f1", "box_2d": [10, 20, 800, 900],
            })}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20,
                              "thoughtsTokenCount": 5, "totalTokenCount": 125},
        })

    monkeypatch.setenv("GEMINI_API_KEY", "test-key-never-sent")
    monkeypatch.delenv("NOTES_MODEL", raising=False)
    monkeypatch.setattr(httpx.Client, "send", respond)
    accumulator = UsageAccumulator()
    result = request_box(frames, "Locate the recursive tree diagram", accumulator)
    assert result == {"frame_id": "f1", "box_2d": [10, 20, 800, 900]}
    assert "gemini-3.8-flash" in urls[0]
    assert requests[0]["generationConfig"]["thinkingConfig"]["thinking_level"] == "HIGH"
    parts = requests[0]["contents"][0]["parts"]
    assert len([part for part in parts if "inlineData" in part]) == 1
    assert all("fileData" not in part for part in parts)
    assert "Locate the recursive tree diagram" in " ".join(part.get("text", "") for part in parts)
    assert accumulator.summary()["by_kind"] == {"notes_illustration": 1}
    assert accumulator.summary()["totals"]["thoughts_tokens"] == 5


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_frame_extraction_and_publication_preserve_original_size_and_hash(tmp_path, monkeypatch):
    from src.extraction import notes_illustrations as module

    video = tmp_path / "source.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "color=c=white:s=320x180:r=10", "-t", "1", "-y", str(video)], check=True)
    frames = module.extract_frames(video, [0.5], tmp_path)
    for key in (*module.R2_ENV_KEYS, "RAILWAY_ENVIRONMENT", "CHALKBOARD_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(module, "LOCAL_FRAME_DIR", tmp_path / "public")
    frame = module.publish_frame(frames[0])
    assert (frame["width"], frame["height"], frame["requested_time"]) == (320, 180, 0.5)
    digest = hashlib.sha256((tmp_path / "f1.jpg").read_bytes()).hexdigest()
    assert frame["sha256"] == digest
    assert frame["url"] == f"/notes-frames/{digest}.jpg"
    assert (tmp_path / "public" / f"{digest}.jpg").read_bytes() == (tmp_path / "f1.jpg").read_bytes()
    assert module.publish_frame(frames[0]) == frame
    assert "path" not in frame


def test_local_frame_publication_does_not_hide_partial_r2_configuration(tmp_path, monkeypatch):
    from src.extraction import notes_illustrations as module

    path = tmp_path / "frame.jpg"
    path.write_bytes(b"source image")
    for key in module.R2_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("R2_ACCOUNT_ID", "incomplete-config")
    with pytest.raises(RuntimeError, match="R2 configuration"):
        module.publish_frame({"path": str(path)})


@pytest.mark.parametrize("outcome", ["crop", "abstain", "invalid_box", "provider_error", "no_frames"])
def test_enrichment_crops_text_visuals_and_omits_unavailable_inline_artifacts(tmp_path, monkeypatch, outcome):
    from src.extraction import notes_illustrations as module

    source = {"id": "diagram", "kind": "visual", "start": 10, "end": 20,
              "text": "Original slide text", "visual": {"contentType": "text"}}
    equation = {"id": "equation", "kind": "visual", "start": 10, "end": 20,
                "text": "Original equation", "visual": {"contentType": "equation"}}
    block = {"text": "Chapter prose", "citations": ["diagram", "equation"],
             "artifacts": [{"source_id": "diagram", "caption": "Explanation"},
                           {"source_id": "equation", "caption": "Equation"}]}
    document = {"overview": [block], "sections": [{"blocks": [block]}], "sources": [source, equation]}
    calls = []
    monkeypatch.setattr(module, "load_video_source", lambda *args: tmp_path / "source.mp4")

    def extract(*args):
        if outcome == "no_frames":
            raise ValueError("missing original frame")
        return [{"id": "f1", "path": "unused", "width": 320, "height": 180, "requested_time": 15}]

    def box(frames, locator, accumulator):
        calls.append(locator)
        if outcome == "provider_error":
            raise RuntimeError("provider failed")
        if outcome == "abstain":
            return None
        return {"frame_id": "unknown" if outcome == "invalid_box" else "f1",
                "box_2d": [10, 20, 800, 900]}

    monkeypatch.setattr(module, "extract_frames", extract)
    monkeypatch.setattr(module, "request_box", box)
    monkeypatch.setattr(module, "publish_frame", lambda frame: {k: v for k, v in frame.items() if k != "path"})
    module.enrich_illustrations(document, youtube_url="https://www.youtube.com/watch?v=test",
                                r2_key=None, duration=60, accumulator=UsageAccumulator(),
                                checkpoint=lambda stage: None)
    assert source["text"] == "Original slide text"
    assert block["text"] == "Chapter prose"
    assert "illustration" not in equation
    assert [artifact["source_id"] for artifact in block["artifacts"]] == (
        ["diagram", "equation"] if outcome == "crop" else ["equation"]
    )
    assert len(calls) == (0 if outcome == "no_frames" else 1)
    expected = "ready" if outcome == "crop" else "unavailable" if outcome == "no_frames" else "full_frame"
    assert source["illustration"]["status"] == expected
    if outcome == "crop":
        assert source["illustration"]["box_2d"] == [10, 20, 800, 900]
    elif outcome != "no_frames":
        assert source["illustration"]["frame"]["requested_time"] == 15
