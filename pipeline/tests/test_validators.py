"""Unit tests for src.extraction.validators.

Pure-function tests — no DB, no fixtures, no Gemini calls. Each rule has
positive and negative cases, plus a check that validators only fire on
items of their target content_type.
"""

from src.extraction.schemas import VisualContentItem, TextBlock
from src.extraction.validators import (
    ValidationIssue,
    validate_code,
    validate_text,
    validate_equation,
    validate_table,
    validate_diagram_or_chart,
    validate_other,
    validate_item,
)


# ---- ValidationIssue dataclass ----

def test_validation_issue_has_required_fields():
    issue = ValidationIssue(
        rule="code_field_empty",
        message="content_type='code' but `code` field is empty",
        severity="error",
        repairable=True,
    )
    assert issue.rule == "code_field_empty"
    assert issue.severity == "error"
    assert issue.repairable is True


# ---- Test fixture builders ----

def _code_item(**overrides) -> VisualContentItem:
    base = dict(
        content_type="code",
        description="",
        discussed_start="0:10",
        discussed_end="0:20",
        confidence=0.9,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def _text_item(**overrides) -> VisualContentItem:
    base = dict(
        content_type="text",
        description="",
        discussed_start="0:00",
        discussed_end="0:10",
        confidence=1.0,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def _eq_item(**overrides) -> VisualContentItem:
    base = dict(
        content_type="equation",
        description="",
        discussed_start="0:00",
        discussed_end="0:05",
        confidence=1.0,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def _table_item(**overrides) -> VisualContentItem:
    base = dict(
        content_type="table",
        description="",
        discussed_start="0:00",
        discussed_end="0:05",
        confidence=1.0,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def _diag_item(content_type, **overrides) -> VisualContentItem:
    base = dict(
        content_type=content_type,
        description="",
        discussed_start="0:00",
        discussed_end="0:05",
        confidence=1.0,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def _other_item(**overrides) -> VisualContentItem:
    base = dict(
        content_type="other",
        description="",
        discussed_start="0:00",
        discussed_end="0:05",
        confidence=1.0,
        latex="",
        code="",
        language="",
        purpose="",
        structure=[],
        headers=[],
        rows=[],
        title="",
        caption="",
        text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


# ---- validate_code ----

def test_validate_code_passes_when_code_field_populated():
    item = _code_item(code="def foo():\n    return 1", language="python", purpose="trivial")
    assert validate_code(item) == []


def test_validate_code_flags_empty_code_with_textblocks_as_repairable():
    item = _code_item(
        code="",
        text_blocks=[TextBlock(kind="paragraph", text="def foo(): pass", depth=0)],
    )
    issues = validate_code(item)
    assert len(issues) == 1
    assert issues[0].rule == "code_in_text_blocks"
    assert issues[0].severity == "error"
    assert issues[0].repairable is True


def test_validate_code_flags_empty_code_with_nothing_else_as_unrepairable():
    item = _code_item(code="")
    issues = validate_code(item)
    assert len(issues) == 1
    assert issues[0].rule == "code_field_empty"
    assert issues[0].repairable is False


def test_validate_code_only_runs_for_code_items():
    item = _code_item(content_type="text", code="")
    assert validate_code(item) == []


# ---- validate_text ----

def test_validate_text_passes_with_populated_blocks():
    item = _text_item(text_blocks=[TextBlock(kind="heading", text="Warm-Up", depth=0)])
    assert validate_text(item) == []


def test_validate_text_flags_empty_blocks_with_description_as_repairable():
    item = _text_item(text_blocks=[], description="A bullet list of three items.")
    issues = validate_text(item)
    assert len(issues) == 1
    assert issues[0].rule == "text_blocks_empty_description_set"
    assert issues[0].repairable is True


def test_validate_text_flags_fully_empty_text_as_unrepairable():
    item = _text_item(text_blocks=[])
    issues = validate_text(item)
    assert issues[0].rule == "text_blocks_empty"
    assert issues[0].repairable is False


def test_validate_text_flags_blocks_that_are_all_whitespace():
    item = _text_item(text_blocks=[TextBlock(kind="paragraph", text="   ", depth=0)])
    assert validate_text(item)[0].repairable is False


def test_validate_text_only_runs_for_text_items():
    item = _text_item(content_type="other", text_blocks=[])
    assert validate_text(item) == []


# ---- validate_equation ----

def test_validate_equation_passes_with_latex():
    assert validate_equation(_eq_item(latex="F = ma")) == []


def test_validate_equation_flags_empty_latex_unrepairable():
    issues = validate_equation(_eq_item(latex=""))
    assert issues[0].rule == "equation_latex_empty"
    assert issues[0].repairable is False


def test_validate_equation_only_runs_for_equation_items():
    assert validate_equation(_eq_item(content_type="code", latex="")) == []


# ---- validate_table ----

def test_validate_table_passes_with_headers_and_rows():
    item = _table_item(headers=["A", "B"], rows=[["1", "2"]], caption="A test table")
    assert validate_table(item) == []


def test_validate_table_flags_missing_rows():
    issues = validate_table(_table_item(headers=["A"], rows=[]))
    assert any(i.rule == "table_rows_empty" for i in issues)
    assert all(i.repairable is False for i in issues)


def test_validate_table_flags_missing_headers():
    issues = validate_table(_table_item(headers=[], rows=[["x"]]))
    assert any(i.rule == "table_headers_empty" for i in issues)


def test_validate_table_flags_both_when_both_missing():
    issues = validate_table(_table_item(headers=[], rows=[]))
    rules = {i.rule for i in issues}
    assert rules == {"table_headers_empty", "table_rows_empty"}


# ---- validate_diagram_or_chart ----

def test_validate_diagram_passes_with_description():
    item = _diag_item("diagram_description", description="A Lewis structure of methane.")
    assert validate_diagram_or_chart(item) == []


def test_validate_diagram_flags_empty_description_with_textblocks_as_repairable():
    item = _diag_item(
        "diagram_description",
        description="",
        text_blocks=[TextBlock(kind="paragraph", text="A flowchart showing X", depth=0)],
    )
    issues = validate_diagram_or_chart(item)
    assert issues[0].rule == "diagram_description_misplaced"
    assert issues[0].repairable is True


def test_validate_diagram_flags_empty_description_with_purpose_as_repairable():
    item = _diag_item(
        "diagram_description",
        description="",
        purpose="Illustrates the variable scoping rules during execution.",
    )
    issues = validate_diagram_or_chart(item)
    assert issues[0].rule == "diagram_description_misplaced"
    assert issues[0].repairable is True


def test_validate_diagram_flags_fully_empty_as_perception_error():
    """Perception failures are user-visible (empty description = blank in viewer),
    so they're severity='error' even though they're unrepairable from text alone."""
    issues = validate_diagram_or_chart(_diag_item("diagram_description"))
    assert issues[0].rule == "diagram_description_empty"
    assert issues[0].severity == "error"
    assert issues[0].repairable is False


def test_validate_chart_misplaced_into_title_caption():
    item = _diag_item(
        "chart_description",
        description="",
        title="Big-O Complexity Chart",
        caption="Comparison of growth rates.",
    )
    issues = validate_diagram_or_chart(item)
    assert issues[0].rule == "chart_description_misplaced"
    assert issues[0].repairable is True


def test_validate_chart_fully_empty():
    issues = validate_diagram_or_chart(_diag_item("chart_description"))
    assert issues[0].rule == "chart_description_empty"
    assert issues[0].repairable is False


def test_validate_diagram_only_runs_for_diagram_or_chart():
    assert validate_diagram_or_chart(_diag_item("text")) == []


# ---- validate_other ----

def test_validate_other_passes_with_description():
    assert validate_other(_other_item(description="A QED mark.")) == []


def test_validate_other_flags_misplacement_into_title_caption_as_repairable():
    item = _other_item(description="", title="Separator Line", caption="A line above the proof.")
    issues = validate_other(item)
    assert issues[0].rule == "other_content_in_other_fields"
    assert issues[0].repairable is True


def test_validate_other_flags_misplacement_into_textblocks_as_repairable():
    item = _other_item(
        description="",
        text_blocks=[TextBlock(kind="paragraph", text="Handwritten note in red", depth=0)],
    )
    issues = validate_other(item)
    assert issues[0].rule == "other_content_in_other_fields"
    assert issues[0].repairable is True


def test_validate_other_flags_fully_empty_as_unrepairable():
    issues = validate_other(_other_item())
    assert issues[0].rule == "other_description_empty"
    assert issues[0].repairable is False


def test_validate_other_only_runs_for_other_items():
    assert validate_other(_other_item(content_type="code")) == []


# ---- validate_item dispatcher ----

def test_validate_item_dispatches_to_code():
    item = _code_item(code="", text_blocks=[TextBlock(kind="paragraph", text="x = 1", depth=0)])
    issues = validate_item(item)
    assert any(i.rule == "code_in_text_blocks" for i in issues)


def test_validate_item_dispatches_to_text():
    issues = validate_item(_text_item(text_blocks=[]))
    assert any(i.rule == "text_blocks_empty" for i in issues)


def test_validate_item_dispatches_to_diagram():
    item = _diag_item(
        "diagram_description",
        description="",
        text_blocks=[TextBlock(kind="paragraph", text="A flowchart", depth=0)],
    )
    assert any(i.rule == "diagram_description_misplaced" for i in validate_item(item))


def test_validate_item_dispatches_to_chart():
    item = _diag_item(
        "chart_description",
        description="",
        title="Bar Chart",
    )
    assert any(i.rule == "chart_description_misplaced" for i in validate_item(item))


def test_validate_item_returns_empty_for_unknown_content_type():
    item = _code_item(content_type="something_new", code="ok")
    assert validate_item(item) == []


def test_validate_item_returns_empty_for_clean_item():
    assert validate_item(_eq_item(latex="F=ma")) == []
