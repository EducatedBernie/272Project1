"""Round-trip tests for _build_content_meta — locks the contract that
visual_observation (and other persistence-relevant fields) survive the
extraction → demo-JSON → DB-persist path.

The pattern matters: _build_content_meta runs twice per item (once on the
Pydantic, once on the vc dict at DB-insert time). Both paths must produce
the same camelCase key for the field to land in content_metadata JSONB.
"""

from src.extraction.schemas import VisualContentItem, TextBlock
from scripts.process_video_v2 import _build_content_meta, _CONTENT_META_FIELDS


def _full_item(**overrides):
    base = dict(
        visual_observation="A diagram showing Java compilation steps.",
        content_type="diagram_description",
        description="A flowchart of Java compilation.",
        discussed_start="0:10", discussed_end="0:20",
        confidence=0.9,
        latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[],
        title="", caption="", text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def test_build_content_meta_includes_visual_observation_from_pydantic():
    item = _full_item()
    meta = _build_content_meta(item)
    assert meta.get("visualObservation") == "A diagram showing Java compilation steps."


def test_build_content_meta_round_trips_visual_observation_via_vc_dict():
    """Critical contract: viewer/persistence path runs build_content_meta
    on a Pydantic, spreads into a vc dict, then runs build_content_meta
    again on the vc dict at EquationModel construction time. The second
    call must preserve visualObservation."""
    item = _full_item()
    meta_from_pydantic = _build_content_meta(item)
    vc_dict = {"id": "vc-0", **meta_from_pydantic}
    meta_from_vc = _build_content_meta(vc_dict)
    assert meta_from_vc.get("visualObservation") == "A diagram showing Java compilation steps."


def test_build_content_meta_drops_empty_visual_observation():
    """Falsy values stay out of content_metadata to keep the JSONB compact —
    matches the existing behavior for empty code/headers/etc."""
    item = _full_item(visual_observation="")
    meta = _build_content_meta(item)
    assert "visualObservation" not in meta


def test_visual_observation_in_content_meta_field_list():
    """Sanity: someone removing the field would have to also delete this
    test, signaling the intent."""
    py_attrs = {py_attr for py_attr, _ in _CONTENT_META_FIELDS}
    out_keys = {out_key for _, out_key in _CONTENT_META_FIELDS}
    assert "visual_observation" in py_attrs
    assert "visualObservation" in out_keys


def test_build_content_meta_text_blocks_round_trip_unchanged():
    """Regression test: textBlocks behavior must not change when we add new
    fields. List-of-TextBlock → list-of-dicts on first pass, preserved on
    second pass."""
    item = _full_item(
        content_type="text",
        text_blocks=[TextBlock(kind="heading", text="Title", depth=0)],
    )
    meta1 = _build_content_meta(item)
    assert meta1["textBlocks"][0]["text"] == "Title"
    vc_dict = {"id": "vc-1", **meta1}
    meta2 = _build_content_meta(vc_dict)
    assert meta2["textBlocks"][0]["text"] == "Title"
