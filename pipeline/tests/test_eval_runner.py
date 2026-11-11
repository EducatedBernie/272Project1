"""Unit tests for compare_outputs in eval_runner.py.

Pure dict-shaped fixtures — no Gemini calls, no DB. Verifies the three
regression signals (validator deltas, per-type count drops, total
collapse) and the camelCase-aware key handling.
"""

from scripts.eval_runner import compare_outputs


def _item(content_type, **fields):
    """Build a baseline-shaped item with camelCase keys (matches what
    process_video persists to disk). The eval runner converts these to
    snake_case before passing to validators."""
    base = dict(
        contentType=content_type, discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, description="", latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", textBlocks=[],
    )
    base.update(fields)
    return base


def test_compare_outputs_no_diff_when_identical():
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    current = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    diff = compare_outputs(baseline, current)
    assert diff.regressions == []
    assert diff.improvements == []
    assert diff.unchanged is True


def test_compare_outputs_correctly_reads_camelCase_textBlocks():
    """Regression test for the camelCase bug: validator must NOT false-positive
    on text items that have textBlocks populated (camelCase) but text_blocks
    absent (snake_case). This is the dominant baseline shape."""
    populated = _item("text", textBlocks=[{"kind": "paragraph", "text": "ok", "depth": 0}])
    diff = compare_outputs({"items": [populated]}, {"items": [populated]})
    assert diff.regressions == []
    assert diff.improvements == []


def test_compare_outputs_detects_validator_regression():
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "Title", "depth": 0}])]}
    current = {"items": [_item("text", textBlocks=[])]}
    diff = compare_outputs(baseline, current)
    assert any("text_blocks_empty" in r for r in diff.regressions)


def test_compare_outputs_detects_validator_improvement():
    """Going from broken → clean shows up as an improvement, not regression."""
    baseline = {"items": [_item("text", textBlocks=[])]}
    current = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    diff = compare_outputs(baseline, current)
    assert any("resolved validation hit" in r for r in diff.improvements)
    assert diff.regressions == []


def test_compare_outputs_flags_per_content_type_count_drop():
    """A prompt change that silently drops half the equations is a regression
    even if the items that DO come out are individually clean."""
    baseline = {"items": [_item("equation", latex=f"x_{i}") for i in range(10)]}
    current = {"items": [_item("equation", latex=f"x_{i}") for i in range(4)]}  # 60% drop
    diff = compare_outputs(baseline, current)
    assert any("equation count" in r and "60%" in r for r in diff.regressions)


def test_compare_outputs_does_not_flag_small_count_swings():
    """Gemini is non-deterministic — small swings shouldn't fire false alarms."""
    baseline = {"items": [_item("equation", latex=f"x_{i}") for i in range(20)]}
    current = {"items": [_item("equation", latex=f"x_{i}") for i in range(18)]}  # 10% drop
    diff = compare_outputs(baseline, current)
    assert not any("equation count" in r for r in diff.regressions)


def test_compare_outputs_flags_total_item_count_collapse():
    """Catches chunk-level failure modes (e.g., schema rejection). 50→1 is
    a 98% drop."""
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": str(i), "depth": 0}]) for i in range(50)]}
    current = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    diff = compare_outputs(baseline, current)
    assert any("total items" in r for r in diff.regressions)


def test_compare_outputs_unchanged_baseline_no_current_means_total_collapse():
    """Edge: baseline has items, current has zero → flagged as collapse."""
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}]) for _ in range(10)]}
    current = {"items": []}
    diff = compare_outputs(baseline, current)
    assert any("total items" in r for r in diff.regressions)
