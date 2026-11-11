"""Tests for VisualContentItem schema expansions (prompt determinism v2)."""
import pytest
from pydantic import ValidationError
from src.extraction.schemas import TextBlock, VisualContentItem


class TestTextBlock:
    def test_heading_block(self):
        b = TextBlock(kind="heading", text="Warm-Up")
        assert b.kind == "heading"
        assert b.text == "Warm-Up"
        assert b.depth == 0

    def test_bullet_with_depth(self):
        b = TextBlock(kind="bullet", text="Sub-item", depth=1)
        assert b.depth == 1

    def test_paragraph_block(self):
        b = TextBlock(kind="paragraph", text="Running text with $x = 2$.")
        assert b.kind == "paragraph"

    def test_invalid_kind_rejected(self):
        with pytest.raises(ValidationError):
            TextBlock(kind="bogus", text="nope")


class TestVisualContentItem:
    def _base(self, **over):
        defaults = dict(
            content_type="text",
            description="",
            discussed_start="0:00",
            discussed_end="0:10",
            confidence=0.9,
        )
        defaults.update(over)
        return VisualContentItem(**defaults)

    def test_text_with_text_blocks(self):
        item = self._base(text_blocks=[
            TextBlock(kind="heading", text="Warm-Up"),
            TextBlock(kind="bullet", text="Bullet one"),
        ])
        assert len(item.text_blocks) == 2
        assert item.text_blocks[0].kind == "heading"

    def test_text_blocks_default_empty(self):
        item = self._base()
        assert item.text_blocks == []

    def test_table_title_and_caption(self):
        item = self._base(
            content_type="table",
            title="Boiling Points",
            caption="Comparison of boiling points across three solvents.",
            headers=["Solvent", "B.P. (C)"],
            rows=[["Water", "100"], ["Ethanol", "78"]],
        )
        assert item.title == "Boiling Points"
        assert item.caption.startswith("Comparison of")
        assert item.headers == ["Solvent", "B.P. (C)"]

    def test_table_title_defaults_empty(self):
        item = self._base(content_type="table")
        assert item.title == ""
        assert item.caption == ""

    def test_code_purpose_and_structure(self):
        item = self._base(
            content_type="code",
            code="def f(n):\n    return n * 2",
            language="python",
            purpose="Doubles the input integer.",
            structure=["Function signature taking n", "Return statement doubling n"],
        )
        assert item.purpose == "Doubles the input integer."
        assert len(item.structure) == 2

    def test_code_structure_default_empty(self):
        item = self._base(content_type="code")
        assert item.structure == []
        assert item.purpose == ""

    def test_other_content_type_accepted(self):
        # 'other' is a valid content_type (no runtime enum enforcement today, just string)
        item = self._base(content_type="other", description="A photograph showing...")
        assert item.content_type == "other"

    def test_old_shape_still_loads(self):
        # Demo JSONs from before this change must still deserialize
        # Only the pre-existing fields are present — new fields get defaults
        old = {
            "content_type": "equation",
            "description": "Force equals mass times acceleration",
            "discussed_start": "1:00",
            "discussed_end": "1:05",
            "confidence": 0.95,
            "latex": "F = ma",
        }
        item = VisualContentItem(**old)
        assert item.latex == "F = ma"
        assert item.text_blocks == []
        assert item.title == ""
        assert item.purpose == ""

    def test_visual_observation_defaults_empty(self):
        """Old data (before v0.5.0) doesn't have visual_observation; the
        field must default to empty string for backward compatibility."""
        item = self._base()
        assert item.visual_observation == ""

    def test_visual_observation_round_trips(self):
        item = self._base(visual_observation="Handwritten Java code on whiteboard.")
        assert item.visual_observation == "Handwritten Java code on whiteboard."


class TestVisualContentItemFieldOrder:
    """Pydantic v2 emits JSON properties in declaration order under
    structured-output. The describe-first reasoning lever (v0.5.0) depends
    on visual_observation being the FIRST field so Gemini emits it before
    content_type. If field declaration order changes, this test fails
    LOUDLY before the silent regression reaches production."""

    def test_visual_observation_is_first_field(self):
        first_field = next(iter(VisualContentItem.model_fields.keys()))
        assert first_field == "visual_observation", (
            f"visual_observation must be the first field in VisualContentItem "
            f"declaration order (Pydantic emits properties in this order under "
            f"structured-output, and the describe-first prompt depends on it). "
            f"Got: {first_field!r} as first field. "
            f"Full order: {list(VisualContentItem.model_fields.keys())}"
        )

    def test_content_type_immediately_follows_visual_observation(self):
        """Reasoning-before-classification: visual_observation, then
        content_type, then everything else."""
        keys = list(VisualContentItem.model_fields.keys())
        assert keys[0] == "visual_observation"
        assert keys[1] == "content_type", (
            f"content_type should be the SECOND field, immediately after "
            f"visual_observation. Got: {keys[1]!r}. Full order: {keys}"
        )

    def test_json_schema_property_order_matches_declaration(self):
        """The Pydantic JSON schema (which is what Gemini sees as
        response_schema) must list visual_observation first too."""
        schema = VisualContentItem.model_json_schema()
        properties = list(schema["properties"].keys())
        assert properties[0] == "visual_observation"
        assert properties[1] == "content_type"
