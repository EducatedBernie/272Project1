"""Integration test for the validate→heal wiring inside
extract_visual_content_chunk. Mocks the Gemini client; doesn't run a
real video. Verifies the function returns the uniform (items, summary | None)
tuple shape across all three return paths.

Replaces the LLM-repair integration test from PR 2 of the
validators-and-repair plan. Same wiring contract, deterministic engine."""

from unittest.mock import MagicMock

import pytest

from src.extraction.schemas import (
    TextBlock,
    VisualContentExtractionOutput,
    VisualContentItem,
)


def _broken_code_item() -> VisualContentItem:
    """Canonical code_in_text_blocks misplacement — the bug PR 2 was built
    to fix and the healer now handles deterministically."""
    return VisualContentItem(
        content_type="code", description="",
        discussed_start="0:10", discussed_end="0:20",
        confidence=0.9, latex="", code="", language="java",
        purpose="", structure=[], headers=[], rows=[], title="", caption="",
        text_blocks=[TextBlock(kind="paragraph", text="public class A {}", depth=0)],
    )


def test_extract_visual_content_chunk_heal_path():
    """Misplacement triggers heal → returns (fixed_items, summary)."""
    broken = _broken_code_item()
    fake_extraction_response = MagicMock(parsed=VisualContentExtractionOutput(items=[broken]), usage_metadata=None)

    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_extraction_response

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=0.5,
    )
    assert len(items) == 1
    assert items[0].code == "public class A {}"
    assert items[0].text_blocks == []
    assert summary is not None
    assert summary.healed_count == 1
    assert summary.statuses == ["fixed"]
    # Healer never calls Gemini — only the extraction call should have happened.
    assert fake_client.models.generate_content.call_count == 1


def test_extract_visual_content_chunk_happy_path():
    """No validator errors → no heal pass → summary is None, tuple shape preserved."""
    clean = VisualContentItem(
        content_type="equation", description="F=ma alt-text",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="F = ma", code="", language="",
        purpose="", structure=[], headers=[], rows=[],
        title="", caption="", text_blocks=[],
    )
    fake_response = MagicMock(parsed=VisualContentExtractionOutput(items=[clean]), usage_metadata=None)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=0.5,
    )
    assert len(items) == 1
    assert summary is None


def test_extract_visual_content_chunk_call_recorder_preserves_return_shape():
    """Raw logging is observability only; it must not alter chunk returns."""
    clean = VisualContentItem(
        content_type="equation", description="F=ma alt-text",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="F = ma", code="", language="",
        purpose="", structure=[], headers=[], rows=[],
        title="", caption="", text_blocks=[],
    )
    fake_response = MagicMock(parsed=VisualContentExtractionOutput(items=[clean]), usage_metadata=None)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    fake_recorder = MagicMock()

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=0.5, call_recorder=fake_recorder,
    )

    assert len(items) == 1
    assert summary is None
    fake_recorder.record_attempt.assert_called_once()


def test_extract_visual_content_chunk_extraction_failure(monkeypatch):
    """All 3 retries exhausted → typed failure, not a fake empty extraction."""
    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError("api boom")

    from scripts import process_video_v2
    from src.exceptions import ExtractionFailedError

    monkeypatch.setattr(process_video_v2.time, "sleep", lambda _seconds: None)
    with pytest.raises(ExtractionFailedError, match="Visual content extraction failed"):
        process_video_v2.extract_visual_content_chunk(
            client=fake_client, url="dummy://", start=0, end=30, context="",
            model="gemini-3-flash-preview", fps=0.5,
        )


def test_extract_visual_content_chunk_successful_empty_response():
    """A successful parsed response with no visual artifacts is still valid."""
    fake_response = MagicMock(parsed=VisualContentExtractionOutput(items=[]), usage_metadata=None)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=0.5,
    )
    assert items == []
    assert summary is None


def test_extract_visual_content_chunk_perception_failure_marked_skipped():
    """Empty diagram_description (no fallback content anywhere) is a
    perception failure — healer can't fix it but the run still returns
    cleanly with status='skipped' so the persistence layer can stamp
    repair_status accordingly."""
    perception_fail = VisualContentItem(
        content_type="diagram_description", description="",
        discussed_start="0:00", discussed_end="0:05",
        confidence=0.5, latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", text_blocks=[],
    )
    fake_response = MagicMock(parsed=VisualContentExtractionOutput(items=[perception_fail]), usage_metadata=None)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=0.5,
    )
    assert len(items) == 1
    assert summary is not None
    assert summary.healed_count == 0
    assert summary.skipped_count == 1
    assert summary.statuses == ["skipped"]
