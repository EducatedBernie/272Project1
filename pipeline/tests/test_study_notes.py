"""Citation provenance and the real database-backed notes job lifecycle."""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

from src.models import Equation, PipelineRun, RunStatus, TranscriptSegment


def segment(expected_video_id, expected_run_id, **changes):
    return TranscriptSegment(**{
        "id": uuid.uuid4(), "video_id": expected_video_id, "run_id": expected_run_id,
        "text": "Acceleration is the derivative of velocity.",
        "timestamp_start": 10.0, "timestamp_end": 18.0, **changes,
    })


def chapter(source_id):
    block = {"text": "Acceleration measures change in velocity.", "citations": [source_id]}
    return {"title": "Acceleration", "overview": [block], "sections": [
        {"title": "From velocity to acceleration", "blocks": [block]},
    ]}


def chunk(source_id):
    block = {"text": "Preserve this part of the lecture.", "citations": [source_id]}
    return {"overview": block, "comprehensive": [block], "condensed": [block]}


def test_notes_windows_cover_every_transcript_segment_in_order():
    from src.extraction.study_notes import chunk_sources

    sources = [{"id": str(index), "kind": "transcript", "start": second,
                "end": second + 1, "text": f"Claim {index}"}
               for index, second in enumerate((0, 419, 421, 839, 841, 1259))]
    topics = [{"title": "First", "start_time": "0:00"},
              {"title": "Second", "start_time": "14:00"}]
    windows = chunk_sources(topics, sources, 1260)
    assert [name for name, _ in windows] == ["First", "Second"]
    assert [end - start for _, parts in windows for start, end, _ in parts] == [420, 420, 420]
    observed = [source["id"] for _, parts in windows for _, _, rows in parts
                for source in rows if source["kind"] == "transcript"]
    assert observed == [str(index) for index in range(len(sources))]


def test_notes_dispatch_requires_pinned_source_only():
    from scripts.worker import _validate_params

    source_id = str(uuid.uuid4())
    assert _validate_params("generate_notes", {"source_run_id": source_id}) is None
    for params in ({}, {"source_run_id": "bad"}, {"source_run_id": None},
                   {"source_run_id": source_id, "source": "unexpected"}):
        assert _validate_params("generate_notes", params) is not None


def test_snapshot_preserves_original_evidence_and_visual_shape():
    from src.extraction.study_notes import build_notes_document, snapshot_sources

    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    spoken = segment(video_id, run_id)
    unused = segment(video_id, run_id, text="Uncited later example", timestamp_start=20)
    unused.timestamp_end = 22
    visual = Equation(
        id=uuid.uuid4(), video_id=video_id, run_id=run_id, content_type="table",
        latex_string="", description="Velocity measurements", confidence=0.9,
        timestamp_start=12, timestamp_end=20,
        content_metadata={"headers": ["Time", "Velocity"], "rows": [["1", "4"]],
                          "text_blocks": [{"kind": "paragraph", "text": "Given", "depth": 0}],
                          "internal_secret": "must not propagate"},
    )
    snapshots = snapshot_sources([spoken, unused], [visual], video_id, run_id)
    raw = chapter(str(spoken.id))
    raw["sections"][0]["blocks"] = [{
        "text": "Use $\frac{dv}{dt}$$.", "citations": [str(visual.id), str(visual.id)],
        "artifacts": [{"source_id": str(visual.id),
                       "caption": "Compare these measurements to $\frac{dv}{dt}$$."}],
    }]
    result = build_notes_document(raw, snapshots)
    assert result["version"] == 1
    assert result["overview"][0]["artifacts"] == []  # Older blocks need no migration.
    assert result["sections"][0]["id"] == "section-1"
    assert result["sections"][0]["blocks"] == [{
        "text": r"Use $\frac{dv}{dt}$.", "citations": [str(visual.id)],
        "artifacts": [{"source_id": str(visual.id),
                       "caption": r"Compare these measurements to $\frac{dv}{dt}$."}],
    }]
    assert [item["id"] for item in result["sources"]] == [str(spoken.id), str(visual.id)]
    assert result["sources"][0]["text"] == "Acceleration is the derivative of velocity."
    saved_visual = result["sources"][1]["visual"]
    assert saved_visual["contentType"] == "table"
    assert saved_visual["rows"] == [["1", "4"]]
    assert saved_visual["textBlocks"] == [{"kind": "paragraph", "text": "Given", "depth": 0}]
    assert "internal_secret" not in saved_visual
    visual.content_metadata["rows"][0][0] = "changed after snapshot"
    assert saved_visual["rows"] == [["1", "4"]]


@pytest.mark.parametrize("invalid_artifact", [
    "unknown_source", "transcript_source", "uncited_visual", "missing_visual",
    "empty_caption", "empty_repaired_caption", "too_many_artifacts", "invented_payload",
])
def test_artifacts_require_cited_visual_evidence_and_bounded_explanatory_captions(invalid_artifact):
    from src.extraction.study_notes import build_notes_document, snapshot_sources

    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    spoken = segment(video_id, run_id)
    visual = Equation(
        id=uuid.uuid4(), video_id=video_id, run_id=run_id, content_type="equation",
        latex_string="a=dv/dt", description="Acceleration from velocity", confidence=0.9,
        timestamp_start=12, timestamp_end=20,
    )
    snapshots = snapshot_sources([spoken], [visual], video_id, run_id)
    artifact = {"source_id": str(visual.id), "caption": "This equation defines acceleration."}
    block = {"text": "Differentiate velocity.", "citations": [str(visual.id)],
             "artifacts": [artifact]}
    if invalid_artifact == "unknown_source":
        artifact["source_id"] = str(uuid.uuid4())
    elif invalid_artifact == "transcript_source":
        artifact["source_id"] = str(spoken.id)
        block["citations"] = [str(spoken.id)]
    elif invalid_artifact == "uncited_visual":
        block["citations"] = [str(spoken.id)]
    elif invalid_artifact == "missing_visual":
        snapshots[1].pop("visual")
    elif invalid_artifact == "empty_caption":
        artifact["caption"] = "  "
    elif invalid_artifact == "empty_repaired_caption":
        artifact["caption"] = "$"
    elif invalid_artifact == "too_many_artifacts":
        block["artifacts"] = [artifact, artifact, artifact]
    else:
        artifact["latex"] = "invented equation"
    raw = chapter(str(spoken.id))
    raw["sections"][0]["blocks"] = [block]
    with pytest.raises(ValueError):
        build_notes_document(raw, snapshots)


@pytest.mark.parametrize("changes", [
    {"timestamp_start": -1}, {"timestamp_start": float("nan")},
    {"timestamp_end": float("inf")}, {"timestamp_end": 9},
    {"run_id": uuid.uuid4()}, {"video_id": uuid.uuid4()}, {"text": "  "},
])
def test_snapshot_rejects_invalid_or_mismatched_evidence(changes):
    from src.extraction.study_notes import snapshot_sources

    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    with pytest.raises(ValueError):
        snapshot_sources([segment(video_id, run_id, **changes)], [], video_id, run_id)


@pytest.mark.parametrize("citations", [[], [str(uuid.uuid4())], ["made-up"]])
def test_chapter_rejects_uncited_or_invented_references(citations):
    from src.extraction.study_notes import build_notes_document, snapshot_sources

    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    spoken = segment(video_id, run_id)
    raw = chapter(str(spoken.id))
    raw["sections"][0]["blocks"] = [{"text": "Unsupported claim", "citations": citations}]
    with pytest.raises(ValueError):
        build_notes_document(raw, snapshot_sources([spoken], [], video_id, run_id))


def test_prompt_rejects_oversized_input_without_truncating():
    from src.extraction.study_notes import MAX_INPUT_BYTES, build_prompt

    with pytest.raises(ValueError, match="too large"):
        build_prompt("Lecture", [], [{"text": "x" * MAX_INPUT_BYTES}])


@pytest.mark.parametrize("finish_reason", ["STOP", "MAX_TOKENS"])
def test_real_sdk_request_parses_complete_output_and_rejects_truncation(monkeypatch, finish_reason):
    from src.extraction.study_notes import request_notes

    source_id = str(uuid.uuid4())
    seen = []

    def respond(client, request, *args, **kwargs):
        seen.append(request)
        return httpx.Response(200, request=request, json={"candidates": [{
            "content": {"role": "model", "parts": [{"text": json.dumps(chunk(source_id))}]},
            "finishReason": finish_reason,
        }]})

    monkeypatch.setenv("GEMINI_API_KEY", "test-key-never-sent")
    monkeypatch.delenv("NOTES_MODEL", raising=False)
    monkeypatch.setattr(httpx.Client, "send", respond)
    if finish_reason == "STOP":
        assert request_notes("Evidence data").overview.citations == [source_id]
    else:
        with pytest.raises(ValueError, match="did not finish"):
            request_notes("Evidence data")
    payload = json.loads(seen[0].content)
    assert "gemini-3.8-flash" in str(seen[0].url)
    assert payload["generationConfig"]["thinkingConfig"]["thinking_level"] == "HIGH"
    assert payload["generationConfig"]["maxOutputTokens"] == 32768
    assert "consecutive lecture window" in json.dumps(payload["systemInstruction"])
    assert payload["generationConfig"]["responseMimeType"] == "application/json"
    assert "responseSchema" not in payload["generationConfig"]
    schema = payload["generationConfig"]["responseJsonSchema"]
    assert "additional_properties" not in json.dumps(schema)
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["NoteBlock"]["additionalProperties"] is False
    assert set(schema["properties"]) == {"overview", "comprehensive", "condensed"}
    assert 0 < seen[0].extensions["timeout"]["read"] <= 360


def test_real_sdk_response_still_rejects_unrequested_fields(monkeypatch):
    from src.extraction.study_notes import request_notes

    raw = chunk(str(uuid.uuid4()))
    raw["comprehensive"][0]["start"] = 12

    def respond(client, request, *args, **kwargs):
        return httpx.Response(200, request=request, json={"candidates": [{
            "content": {"role": "model", "parts": [{"text": json.dumps(raw)}]},
            "finishReason": "STOP",
        }]})

    monkeypatch.setenv("GEMINI_API_KEY", "test-key-never-sent")
    monkeypatch.setattr(httpx.Client, "send", respond)
    with pytest.raises(ValueError):
        request_notes("Evidence data")


@pytest.mark.parametrize("location", ["title", "section_title", "block"])
def test_chapter_rejects_text_that_latex_repair_makes_empty(location):
    from src.extraction.study_notes import build_notes_document, snapshot_sources

    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    spoken = segment(video_id, run_id)
    raw = chapter(str(spoken.id))
    if location == "title":
        raw["title"] = "$"
    elif location == "section_title":
        raw["sections"][0]["title"] = "$"
    else:
        raw["overview"][0]["text"] = "$"
    with pytest.raises(ValueError, match="empty"):
        build_notes_document(raw, snapshot_sources([spoken], [], video_id, run_id))


@pytest.fixture
def study_job(session, make_run):
    source = make_run(status=RunStatus.complete)
    spoken = segment(source.video_id, source.id)
    session.add(spoken)
    job = make_run(video=source.video, run_type="generate_notes",
                   params={"source_run_id": str(source.id)})
    session.commit()
    yield SimpleNamespace(source=source, spoken=spoken, job=job)
    session.rollback()
    session.execute(delete(TranscriptSegment).where(TranscriptSegment.run_id == source.id))
    session.commit()


def test_worker_generates_notes_without_changing_extraction(session, study_job, monkeypatch):
    from scripts.worker import poll_once
    from src.extraction import study_notes

    monkeypatch.setattr(study_notes, "request_notes", lambda prompt, **kwargs: chunk(str(study_job.spoken.id)))
    assert poll_once(session)
    session.expire_all()
    assert study_job.job.status == RunStatus.complete
    assert study_job.job.notes["sources"][0]["id"] == str(study_job.spoken.id)
    assert "usage" not in study_job.job.progress  # Missing metadata must not imply zero cost.
    assert study_job.source.status == RunStatus.complete
    assert study_job.source.notes is None
    assert study_job.spoken.text == "Acceleration is the derivative of velocity."


def test_worker_assembles_late_lecture_window_in_its_topic(session, study_job, monkeypatch):
    from scripts.worker import poll_once
    from src.extraction import study_notes

    late = segment(study_job.source.video_id, study_job.source.id,
                   text="The narrator explains why a comforting dismissal appealed to him.",
                   timestamp_start=135.0, timestamp_end=145.0)
    study_job.source.video.duration = 240
    study_job.source.sections = [{"title": "Opening", "start_time": "0:00"},
                                 {"title": "Closing", "start_time": "2:00"}]
    session.add(late)
    session.commit()
    calls = []

    def respond(prompt, **_kwargs):
        source = next(item for item in json.loads(prompt)["sources"] if item["kind"] == "transcript")
        calls.append(source["id"])
        result = chunk(source["id"])
        result["comprehensive"][0]["text"] = source["text"]
        return result

    monkeypatch.setattr(study_notes, "request_notes", respond)
    assert poll_once(session)
    session.expire_all()
    assert calls == [str(study_job.spoken.id), str(late.id)]
    assert [section["title"] for section in study_job.job.notes["sections"]] == ["Opening", "Closing"]
    assert study_job.job.notes["sections"][1]["blocks"][0]["citations"] == [str(late.id)]
    assert "comforting dismissal" in study_job.job.notes["sections"][1]["blocks"][0]["text"]


def test_notes_source_deduplication_allows_new_run_after_completion(session, study_job, make_run):
    with pytest.raises(IntegrityError), session.begin_nested():
        make_run(video=study_job.source.video, run_type="generate_notes",
                 params={"source_run_id": str(study_job.source.id)})
    study_job.job.status = RunStatus.failed
    session.commit()
    retried = make_run(video=study_job.source.video, run_type="generate_notes",
                       params={"source_run_id": str(study_job.source.id)})
    session.commit()
    assert retried.status == RunStatus.queued
    retried.status = RunStatus.complete
    session.commit()
    newer = make_run(video=study_job.source.video, run_type="generate_notes",
                     params={"source_run_id": str(study_job.source.id)})
    session.commit()
    assert newer.status == RunStatus.queued
    with pytest.raises(IntegrityError), session.begin_nested():
        make_run(video=study_job.source.video, run_type="generate_notes",
                 params={"source_run_id": str(study_job.source.id)})


@pytest.mark.parametrize("cancel_during_box", [False, True])
def test_notes_worker_saves_original_diagram_and_combined_usage(
    session, study_job, monkeypatch, tmp_path, cancel_during_box,
):
    from scripts.worker import poll_once
    from src.extraction import notes_illustrations as illustrations
    from src.models.database import SessionLocal

    visual = Equation(id=uuid.uuid4(), video_id=study_job.source.video_id, run_id=study_job.source.id,
                      content_type="diagram_description", latex_string="", description="A recursive tree",
                      confidence=0.9, timestamp_start=10, timestamp_end=20)
    session.add(visual)
    session.commit()
    raw = chunk(str(study_job.spoken.id))
    raw["comprehensive"] = [{"text": "The recursion partitions the tree.",
        "citations": [str(visual.id)],
        "artifacts": [{"source_id": str(visual.id), "caption": "Each subtree repeats the structure."}]}]
    image = tmp_path / "source.jpg"
    image.write_bytes(b"original source pixels")
    monkeypatch.setattr(illustrations, "load_video_source", lambda *args: tmp_path / "video.mp4")
    monkeypatch.setattr(illustrations, "extract_frames", lambda *args: [{
        "id": "f1", "path": str(image), "requested_time": 15, "width": 320, "height": 180,
    }])
    monkeypatch.setattr(illustrations, "LOCAL_FRAME_DIR", tmp_path / "published")
    for key in (*illustrations.R2_ENV_KEYS, "RAILWAY_ENVIRONMENT", "CHALKBOARD_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-never-sent")

    def respond(client, request, *args, **kwargs):
        request_data = json.loads(request.content)
        is_boxing = any("inlineData" in part for part in request_data["contents"][0]["parts"])
        if is_boxing and cancel_during_box:
            with SessionLocal() as other:
                active = other.get(PipelineRun, study_job.job.id)
                active.cancel_requested = True
                other.commit()
        output = {"frame_id": "f1", "box_2d": [10, 20, 800, 900]} if is_boxing else raw
        return httpx.Response(200, request=request, json={
            "candidates": [{"content": {"parts": [{"text": json.dumps(output)}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120},
        })

    monkeypatch.setattr(httpx.Client, "send", respond)
    try:
        assert poll_once(session)
        session.expire_all()
        assert study_job.job.progress["usage"]["by_kind"] == {"study_notes_chunk": 1, "notes_illustration": 1}
        assert study_job.job.progress["usage"]["totals"]["prompt_tokens"] == 200
        if cancel_during_box:
            assert study_job.job.status == RunStatus.failed
            assert study_job.job.notes is None
            assert study_job.job.error == "Cancelled by user"
        else:
            assert study_job.job.status == RunStatus.complete
            saved = next(source for source in study_job.job.notes["sources"] if source["id"] == str(visual.id))
            assert saved["text"] == "A recursive tree"
            assert saved["illustration"]["status"] == "ready"
            assert saved["illustration"]["frame"]["requested_time"] == 15
    finally:
        session.rollback()
        session.execute(delete(Equation).where(Equation.id == visual.id))
        session.commit()


@pytest.mark.parametrize("change", [
    "other_video", "section_run", "legacy_section_scope", "legacy_item_scope",
    "incomplete", "no_transcript",
])
def test_generator_revalidates_source_before_model_call(
    session, study_job, monkeypatch, make_video, change,
):
    from scripts.worker import poll_once
    from src.extraction import study_notes

    if change == "other_video":
        study_job.job.video_id = make_video().id
    elif change == "section_run":
        study_job.source.run_type = "reprocess_section"
    elif change in ("legacy_section_scope", "legacy_item_scope"):
        study_job.source.progress = {"scope": "section" if "section" in change else "item"}
    elif change == "incomplete":
        study_job.source.status = RunStatus.failed
    else:
        session.delete(study_job.spoken)
    session.commit()
    def must_not_call(prompt, **kwargs):
        pytest.fail("invalid source reached the model")
    monkeypatch.setattr(study_notes, "request_notes", must_not_call)
    assert poll_once(session)
    session.expire_all()
    assert study_job.job.status == RunStatus.failed
    assert study_job.job.notes is None


@pytest.mark.parametrize("terminal_change", ["cancel", "stale_failure", "invalid_output"])
def test_late_cancel_failure_or_bad_output_never_persists_notes(
    session, study_job, monkeypatch, terminal_change,
):
    from scripts.worker import poll_once
    from src.extraction import study_notes

    def respond(prompt, **kwargs):
        if terminal_change == "invalid_output":
            return chunk(str(uuid.uuid4()))
        with study_notes.SessionLocal() as other:
            job = other.get(PipelineRun, study_job.job.id)
            if terminal_change == "cancel":
                job.cancel_requested = True
            else:
                job.status = RunStatus.failed
                job.error = "Worker crashed before saving"
            other.commit()
        return chunk(str(study_job.spoken.id))

    monkeypatch.setattr(study_notes, "request_notes", respond)
    assert poll_once(session)
    session.expire_all()
    assert study_job.job.status == RunStatus.failed
    assert study_job.job.notes is None
    if terminal_change == "cancel":
        assert study_job.job.error == "Cancelled by user"
    elif terminal_change == "stale_failure":
        assert study_job.job.error == "Worker crashed before saving"


@pytest.mark.parametrize("outcome", ["complete", "invalid_output", "truncated", "cancel", "stale_failure"])
def test_notes_persists_actual_sdk_usage_even_when_output_cannot_be_saved(
    session, study_job, monkeypatch, outcome,
):
    from scripts.worker import poll_once
    from src.extraction import study_notes

    raw = chunk(str(study_job.spoken.id))
    if outcome == "invalid_output":
        raw["overview"]["citations"] = [str(uuid.uuid4())]

    def respond(client, request, *args, **kwargs):
        if outcome in ("cancel", "stale_failure"):
            with study_notes.SessionLocal() as other:
                job = other.get(PipelineRun, study_job.job.id)
                if outcome == "cancel":
                    job.cancel_requested = True
                else:
                    job.status = RunStatus.failed
                    job.error = "Worker crashed before saving"
                other.commit()
        return httpx.Response(200, request=request, json={
            "candidates": [{
                "content": {"role": "model", "parts": [{"text": json.dumps(raw)}]},
                "finishReason": "MAX_TOKENS" if outcome == "truncated" else "STOP",
            }],
            "modelVersion": "resolved-model-test",
            "usageMetadata": {
                "promptTokenCount": 1000, "candidatesTokenCount": 200,
                "cachedContentTokenCount": 100, "thoughtsTokenCount": 50, "totalTokenCount": 1250,
            },
        })

    monkeypatch.setenv("GEMINI_API_KEY", "test-key-never-sent")
    monkeypatch.setenv("NOTES_MODEL", "requested-model-test")
    monkeypatch.setattr(httpx.Client, "send", respond)
    assert poll_once(session)
    session.expire_all()
    usage = study_job.job.progress["usage"]
    count = 1
    assert usage["totals"] == {
        "calls": count, "prompt_tokens": 1000 * count, "candidates_tokens": 200 * count,
        "cached_tokens": 100 * count, "thoughts_tokens": 50 * count, "total_tokens": 1250 * count,
    }
    assert usage["calls"][0]["model_requested"] == "requested-model-test"
    assert usage["calls"][0]["model_version"] == "resolved-model-test"
    assert usage["by_kind"] == {"study_notes_chunk": 1}
    assert study_job.job.status == (RunStatus.complete if outcome == "complete" else RunStatus.failed)
    assert (study_job.job.notes is not None) == (outcome == "complete")
    if outcome == "stale_failure":
        assert study_job.job.error == "Worker crashed before saving"
    elif outcome == "cancel":
        assert study_job.job.error == "Cancelled by user"


def test_two_layers_validate_citations_and_share_original_sources():
    from src.extraction.study_notes import attach_condensed, build_notes_document, snapshot_sources
    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    first = segment(video_id, run_id)
    second = segment(video_id, run_id, text='Another key result.')
    sources = snapshot_sources([first, second], [], video_id, run_id)
    document = build_notes_document(chapter(str(first.id)), sources)
    attach_condensed(document, chapter(str(second.id)), sources)
    assert len(document['sources']) == 2
    assert document['condensed']['overview'][0]['citations'] == [str(second.id)]
    assert 'sources' not in document['condensed']
    with pytest.raises(ValueError, match='unknown source'):
        attach_condensed(document, chapter(str(uuid.uuid4())), sources)


@pytest.mark.parametrize('kind,latex,metadata,expected', [
    ('text', '', {'textBlocks': [
        {'kind': 'heading', 'text': 'Theory of NP-completeness', 'depth': 0},
        {'kind': 'paragraph', 'text': r'What does $\mathbb{P}$ vs $\mathbb{NP}$ mean?', 'depth': 0},
    ]}, 'Theory of NP-completeness'),
    ('slide', '', {'text_blocks': [{'kind': 'bullet', 'text': 'Key result', 'depth': 0}]}, 'Key result'),
    ('equation', 'x=1', {}, 'x=1'),
    ('code', '', {'code': 'return x', 'language': 'python'}, 'return x'),
    ('table', '', {'headers': ['x'], 'rows': [['1']]}, '1'),
    ('table', '', {'headers': [], 'rows': [['1']]}, '1'),
])
def test_structured_visual_without_prose_description_remains_citable(kind, latex, metadata, expected):
    from src.extraction.study_notes import snapshot_sources, build_notes_document
    video_id, run_id = uuid.uuid4(), uuid.uuid4()
    visual = Equation(id=uuid.uuid4(), video_id=video_id, run_id=run_id,
                      content_type=kind, description='', latex_string=latex,
                      confidence=0.95, timestamp_start=0, timestamp_end=72,
                      content_metadata=metadata)
    sources = snapshot_sources([segment(video_id, run_id)], [visual], video_id, run_id)
    source = next(s for s in sources if s['kind'] == 'visual')
    assert expected in source['text']
    assert source['visual']['description'] == ''
    raw = chapter(str(visual.id))
    raw['overview'][0]['artifacts'] = [{'source_id': str(visual.id), 'caption': 'Source material'}]
    assert build_notes_document(raw, sources)['sources'][0] == source
    visual.content_metadata = {}
    visual.latex_string = ''
    with pytest.raises(ValueError, match='Empty source text'):
        snapshot_sources([segment(video_id, run_id)], [visual], video_id, run_id)
