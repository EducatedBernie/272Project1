"""Smoke tests for prompt content + version constants."""
from src.extraction import prompts


def test_equations_prompt_version_bumped():
    assert prompts.EQUATIONS_PROMPT_VERSION == "v0.4"


def test_equations_prompt_includes_granularity_rule():
    text = prompts.EQUATIONS_USER_PROMPT
    # Must explicitly address one-line-per-entry granularity
    assert "one written line" in text.lower() or "one line" in text.lower()
    assert "one entry" in text.lower()
    # Must include good/bad example
    assert "Good:" in text
    assert "Bad:" in text


def test_visual_content_prompt_version_bumped():
    # v0.5.x reflects the describe-first reasoning lever (visual_observation
    # field emitted before content_type). v0.4.x had the FIELD PLACEMENT
    # RULES + few-shot examples (still present, additive). Bump major-minor
    # for any subsequent semantic prompt rework.
    assert prompts.VISUAL_CONTENT_PROMPT_VERSION == "v0.5.1"


def test_visual_content_prompt_has_field_placement_rules():
    """Task 2.9: explicit FIELD PLACEMENT RULES must be in the system prompt
    so Gemini sees them before the more detailed per-type instructions."""
    text = prompts.VISUAL_CONTENT_SYSTEM_PROMPT
    assert "FIELD PLACEMENT RULES" in text
    assert "ANTI-PATTERN" in text
    assert "text_blocks" in text  # the anti-pattern field name


def test_visual_content_prompt_has_correct_vs_wrong_examples():
    """Task 2.9: few-shot examples block at the end of the user prompt
    showing correct field placement vs the textBlocks misplacement bug."""
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    assert "FIELD-PLACEMENT EXAMPLES" in text
    assert "CORRECT" in text and "WRONG" in text


def test_visual_content_prompt_has_describe_first_instructions():
    """v0.5.0 reasoning lever: the system prompt must instruct Gemini to
    emit visual_observation BEFORE content_type. The schema field declaration
    order alone is necessary but not sufficient — the prompt must reinforce
    the order explicitly. If this test fails, the v0.5.0 lever is broken
    even if the schema looks right."""
    sys_text = prompts.VISUAL_CONTENT_SYSTEM_PROMPT
    user_text = prompts.VISUAL_CONTENT_USER_PROMPT
    # System prompt: REASONING ORDER section instructs describe-before-classify.
    assert "REASONING ORDER" in sys_text
    assert "visual_observation" in sys_text
    # User prompt: REMINDER ON FIELD ORDER tail repeats the contract.
    assert "REMINDER ON FIELD ORDER" in user_text
    assert "visual_observation" in user_text


def test_visual_observation_field_in_schema():
    """Sanity: the prompt references a field that actually exists on the
    schema. If someone renames the schema field but forgets the prompt
    (or vice versa), this test fails."""
    from src.extraction.schemas import VisualContentItem
    assert "visual_observation" in VisualContentItem.model_fields


def test_visual_content_prompt_includes_seven_types():
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    for t in ["equation", "text", "diagram_description", "chart_description", "table", "code", "other"]:
        assert t in text, f"content type '{t}' missing from VISUAL_CONTENT_USER_PROMPT"


def test_visual_content_prompt_handles_annotated_formula_callouts():
    """Annotated formulas need arrow/callout relationships, not isolated
    text labels. This catches the Jeff Anderson determinant-style failure
    mode where labels like "row index" were transcribed but the arrows were
    lost."""
    sys_text = prompts.VISUAL_CONTENT_SYSTEM_PROMPT
    user_text = prompts.VISUAL_CONTENT_USER_PROMPT

    assert "annotated formulas" in sys_text
    assert "VISUAL RELATIONSHIPS AND CALLOUTS" in user_text
    assert "formula callouts" in user_text
    assert "isolated `text`" in user_text
    assert "arrow" in user_text
    assert "row index" in user_text
    assert "diagram_description" in user_text


def test_visual_content_prompt_has_text_blocks_guidance():
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    assert "text_blocks" in text
    assert "heading" in text and "paragraph" in text and "bullet" in text


def test_visual_content_prompt_has_table_fields():
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    for f in ["title", "caption", "headers", "rows"]:
        assert f in text


def test_visual_content_prompt_has_code_fields():
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    for f in ["purpose", "structure", "language"]:
        assert f in text


def test_topic_map_prompt_exists_and_versioned():
    assert hasattr(prompts, "TOPIC_MAP_PROMPT")
    assert hasattr(prompts, "TOPIC_MAP_PROMPT_VERSION")
    assert prompts.TOPIC_MAP_PROMPT_VERSION == "v0.2"


def test_topic_map_prompt_has_title_style_rule():
    text = prompts.TOPIC_MAP_PROMPT
    assert "Title Case" in text
    assert "50 characters" in text or "≤ 50" in text


def test_process_video_v2_imports_real_transcript_prompts():
    """v2 must use TRANSCRIPT_SYSTEM_PROMPT + TRANSCRIPT_USER_PROMPT, not an inline prompt."""
    import ast
    from pathlib import Path

    src = Path(__file__).parent.parent / "scripts" / "process_video_v2.py"
    tree = ast.parse(src.read_text())

    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and "prompts" in node.module:
            for n in node.names:
                imported.add(n.name)

    assert "TRANSCRIPT_SYSTEM_PROMPT" in imported, "TRANSCRIPT_SYSTEM_PROMPT not imported"
    assert "TRANSCRIPT_USER_PROMPT" in imported, "TRANSCRIPT_USER_PROMPT not imported"
