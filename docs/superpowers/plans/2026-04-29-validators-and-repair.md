# Validators + Repair Pass + CI Eval + Prompt Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 3-layer defense against Gemini visual-content misplacement bugs (validate → cheap text repair → human-readable telemetry), harden the extraction prompt against the dominant misplacement pattern, and add a CI eval seatbelt for prompt-version bumps.

**Architecture:** Validators are pure functions that take a parsed `VisualContentItem` and return a list of `ValidationIssue`s — they never raise during normal Gemini parsing. After visual-content extraction in the worker, every item runs through validators; items with `repairable=True` issues go to a Flash-Lite text-only repair call (~$0.0003 each); items that fail repair keep their original payload with a `repair_status='failed'` flag stored in `content_metadata`. The viewer's existing defensive fallbacks render whatever payload is present. CI eval runs the current pipeline against 20 hand-picked production videos on every prompt-version bump and diffs against committed JSON baselines. The extraction prompt is updated with explicit field-placement guidance and a textBlocks anti-pattern warning to reduce the misplacement rate at the source.

**Empirical grounding (verified 2026-04-30):** Categorization of the 187 broken items in prod's DSC30 run (e5ac668c) shows **95.2% are misplacements** (content placed in `textBlocks` instead of `description`/`code`/etc.) and 4.8% are perception failures (truly empty items). The text-only repair pass is therefore exactly the right tool: it can mechanically rewrite the misplaced content for the dominant bug class. A discriminated-union schema redesign was considered and ruled out — see KI-006 in operational notes.

**Tech Stack:** Python 3.12, Pydantic v2, `google-genai` SDK 1.69+ (Gemini 3 Flash for extraction, Gemini 3 Flash-Lite for repair), Alembic migrations, Postgres JSONB, pytest. No frontend changes. No new runtime dependencies — `notify_repair_summary` reuses the existing `urllib.request`-based Slack helper rather than adding `requests`.

---

## File Structure

**New files:**
- `pipeline/src/extraction/validators.py` — pure validation functions per content_type, returning `list[ValidationIssue]`
- `pipeline/src/extraction/repair.py` — Flash-Lite client + repair-pass logic
- `pipeline/tests/test_validators.py` — unit tests for every validator
- `pipeline/tests/test_repair.py` — unit tests for repair (mocking Flash-Lite)
- `pipeline/scripts/eval_runner.py` — CLI: run eval, write baselines, diff against committed baselines
- `eval/test_videos.json` — list of 20 video URLs hand-picked from prod DB
- `eval/baselines/<video_id>__<prompt_version>.json` — committed baseline outputs (one per video × prompt-version pair)
- `pipeline/alembic/versions/<rev>_add_repair_status_to_equations.py` — migration adding `repair_status` jsonb metadata key (or column — see Task 2.1)

**Modified files:**
- `pipeline/scripts/process_video_v2.py` — wire validators + repair into `extract_visual_content_chunk` (line 283); update FOUR call sites including the `process_section` closure inside `process_video` (lines 391, 555, 760-779, plus closure return shape); stamp `repair_status` at THREE persistence sites where `EquationModel` is constructed (lines 455, 582, 952); gate demo-JSON write on `return_payload` for eval-runner use; refactor `process_video` to optionally return `ProcessResult`
- `pipeline/src/extraction/prompts.py` — bump `VISUAL_CONTENT_PROMPT_VERSION`, add textBlocks anti-pattern guidance and few-shot examples to `VISUAL_CONTENT_USER_PROMPT`/`VISUAL_CONTENT_SYSTEM_PROMPT`
- `pipeline/scripts/inspect_run.py` — extend `--run` summary to show repair_status counts (Task 2.8)
- `pipeline/src/notifications/slack.py` — add `notify_repair_summary` helper using `urllib.request.urlopen` (matches existing module style — no `requests` dependency); use Block Kit format consistent with existing `notify_pipeline_event`

**Untouched:**
- Viewer (existing defensive fallbacks already handle any payload shape)
- DB schema for transcripts, runs, videos
- Worker polling/heartbeat logic
- `pipeline/src/extraction/schemas.py` — flat schema is correct for our bug class (95% misplacement, repairable). Discriminated-union refactor was empirically tested (B.0 v3 on 2026-04-30) and ruled out due to 31% chunk-loss rate. See KI-006.

---

## PR scope summary

This plan ships in **three sequential PRs**:

- **PR 1:** Validators module (standalone, no integration). ~0.5 day.
- **PR 2:** Repair pass + worker integration + DB index + Slack telemetry + `inspect_run.py` extension + prompt hardening. ~2 days.
- **PR 3:** CI eval set + baselines. ~1 day.

Total: ~3.5 days of focused work. Cancellation responsiveness during repair: chunks complete in ThreadPoolExecutor; cancel checkpoint fires after each chunk via `_update_run_progress`. Adding repair adds time per chunk but does not introduce new categorical hangs (assuming `RepairConfig.timeout_seconds` is wired through the SDK — see Task 2.4).

---

## PR 1: Validators module (standalone, no integration)

This PR ships a tested validators module that nothing yet calls. PR 2 will wire it in. Useful in isolation: PR 3 (CI eval) uses it to score baselines.

#### Task 1.1: Define `ValidationIssue` dataclass + skeleton module

**Files:**
- Create: `pipeline/src/extraction/validators.py`
- Test: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing test for the dataclass shape**

```python
# pipeline/tests/test_validators.py
from src.extraction.validators import ValidationIssue


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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate
python -m pytest tests/test_validators.py -v
```
Expected: ImportError or ModuleNotFoundError because `validators.py` doesn't exist.

- [ ] **Step 3: Create the validators module with the dataclass**

```python
# pipeline/src/extraction/validators.py
"""Per-content-type validators for VisualContentItem.

Validators are pure functions that take a parsed item and return a list of
ValidationIssue objects. They never raise during normal pipeline parsing —
the worker calls them after Gemini's structural validation succeeds, then
routes repairable issues to the repair pass.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Literal


Severity = Literal["error", "warning"]


@dataclass(frozen=True)
class ValidationIssue:
    """A single rule violation detected on a VisualContentItem.

    severity:
      - "error": the item is broken in a way that affects rendering.
      - "warning": noteworthy but not user-visible (e.g., low confidence).

    repairable:
      - True: a Flash-Lite text-only repair pass can plausibly fix it.
        This is true when the right content exists somewhere in the item
        but is in the wrong field (e.g., code stored in text_blocks).
      - False: the content is genuinely missing (perception failure) and
        no text-only repair will help. Re-extraction or human review only.
    """

    rule: str
    message: str
    severity: Severity
    repairable: bool
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): add ValidationIssue dataclass and module skeleton"
```

#### Task 1.2: `validate_code` — code field must be non-empty when content_type='code'

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append after existing test
from src.extraction.schemas import VisualContentItem, TextBlock
from src.extraction.validators import validate_code


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
    assert issues[0].repairable is False  # genuine perception/extraction failure


def test_validate_code_only_runs_for_code_items():
    item = _code_item(content_type="text", code="")
    assert validate_code(item) == []  # not a code item; not our problem
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: FAIL — `validate_code` is not defined.

- [ ] **Step 3: Implement `validate_code`**

```python
# pipeline/src/extraction/validators.py — append below ValidationIssue
from src.extraction.schemas import VisualContentItem


def validate_code(item: VisualContentItem) -> list[ValidationIssue]:
    """code items must have non-empty `code`. Repairable iff content lives
    elsewhere on the item (textBlocks) — Gemini's known misplacement pattern."""
    if item.content_type != "code":
        return []
    if item.code.strip():
        return []
    has_textblock_content = any((b.text or "").strip() for b in item.text_blocks)
    if has_textblock_content:
        return [ValidationIssue(
            rule="code_in_text_blocks",
            message="content_type='code' has empty `code` field but text_blocks contains content — Gemini misplaced the source",
            severity="error",
            repairable=True,
        )]
    return [ValidationIssue(
        rule="code_field_empty",
        message="content_type='code' has empty `code` field and no fallback content — perception/extraction failure",
        severity="error",
        repairable=False,
    )]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS (4 tests added in this task all green; earlier test still green).

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_code — flag misplaced code as repairable"
```

#### Task 1.3: `validate_text` — text_blocks must be non-empty when content_type='text'

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_text


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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_text_passes_with_populated_blocks -v
```
Expected: FAIL — `validate_text` not defined.

- [ ] **Step 3: Implement `validate_text`**

```python
# pipeline/src/extraction/validators.py — append
def validate_text(item: VisualContentItem) -> list[ValidationIssue]:
    if item.content_type != "text":
        return []
    has_block_content = any((b.text or "").strip() for b in item.text_blocks)
    if has_block_content:
        return []
    if (item.description or "").strip():
        return [ValidationIssue(
            rule="text_blocks_empty_description_set",
            message="content_type='text' has empty text_blocks but description is populated — Gemini misplaced text content into description",
            severity="error",
            repairable=True,
        )]
    return [ValidationIssue(
        rule="text_blocks_empty",
        message="content_type='text' has empty text_blocks and no fallback content",
        severity="error",
        repairable=False,
    )]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_text — flag missing text_blocks"
```

#### Task 1.4: `validate_equation` — latex must be non-empty when content_type='equation'

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_equation


def _eq_item(**overrides):
    base = dict(
        content_type="equation",
        description="",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def test_validate_equation_passes_with_latex():
    assert validate_equation(_eq_item(latex="F = ma")) == []


def test_validate_equation_flags_empty_latex_unrepairable():
    issues = validate_equation(_eq_item(latex=""))
    assert issues[0].rule == "equation_latex_empty"
    assert issues[0].repairable is False  # latex is the primary signal, no fallback in metadata
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_equation_passes_with_latex -v
```
Expected: FAIL — `validate_equation` not defined.

- [ ] **Step 3: Implement `validate_equation`**

```python
# pipeline/src/extraction/validators.py — append
def validate_equation(item: VisualContentItem) -> list[ValidationIssue]:
    if item.content_type != "equation":
        return []
    if item.latex.strip():
        return []
    return [ValidationIssue(
        rule="equation_latex_empty",
        message="content_type='equation' has empty `latex` field",
        severity="error",
        repairable=False,
    )]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_equation — flag empty latex field"
```

#### Task 1.5: `validate_table` — headers AND rows must be non-empty when content_type='table'

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_table


def _table_item(**overrides):
    base = dict(
        content_type="table",
        description="",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def test_validate_table_passes_with_headers_and_rows():
    item = _table_item(headers=["A", "B"], rows=[["1", "2"]], caption="A test table")
    assert validate_table(item) == []


def test_validate_table_flags_missing_rows():
    issues = validate_table(_table_item(headers=["A"], rows=[]))
    assert issues[0].rule == "table_rows_empty"
    assert issues[0].repairable is False


def test_validate_table_flags_missing_headers():
    issues = validate_table(_table_item(headers=[], rows=[["x"]]))
    assert issues[0].rule == "table_headers_empty"
    assert issues[0].repairable is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_table_passes_with_headers_and_rows -v
```
Expected: FAIL.

- [ ] **Step 3: Implement `validate_table`**

```python
# pipeline/src/extraction/validators.py — append
def validate_table(item: VisualContentItem) -> list[ValidationIssue]:
    if item.content_type != "table":
        return []
    issues: list[ValidationIssue] = []
    if not item.headers:
        issues.append(ValidationIssue(
            rule="table_headers_empty",
            message="content_type='table' has empty headers",
            severity="error",
            repairable=False,
        ))
    if not item.rows:
        issues.append(ValidationIssue(
            rule="table_rows_empty",
            message="content_type='table' has empty rows",
            severity="error",
            repairable=False,
        ))
    return issues
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_table — flag empty headers or rows"
```

#### Task 1.6: `validate_diagram_or_chart` — description must be non-empty (warning, unrepairable)

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_diagram_or_chart


def _diag_item(content_type, **overrides):
    base = dict(
        content_type=content_type, description="",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def test_validate_diagram_passes_with_description():
    item = _diag_item("diagram_description", description="A Lewis structure of methane.")
    assert validate_diagram_or_chart(item) == []


def test_validate_diagram_flags_empty_description_as_unrepairable_warning():
    issues = validate_diagram_or_chart(_diag_item("diagram_description"))
    assert issues[0].rule == "diagram_description_empty"
    assert issues[0].severity == "warning"  # perception failure, not data corruption
    assert issues[0].repairable is False


def test_validate_chart_description_same_rule():
    issues = validate_diagram_or_chart(_diag_item("chart_description"))
    assert issues[0].rule == "chart_description_empty"
    assert issues[0].repairable is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_diagram_passes_with_description -v
```
Expected: FAIL.

- [ ] **Step 3: Implement `validate_diagram_or_chart`**

```python
# pipeline/src/extraction/validators.py — append
def validate_diagram_or_chart(item: VisualContentItem) -> list[ValidationIssue]:
    if item.content_type not in ("diagram_description", "chart_description"):
        return []
    if item.description.strip():
        return []
    rule = f"{item.content_type}_empty"
    return [ValidationIssue(
        rule=rule,
        message=f"content_type='{item.content_type}' has empty description — likely perception failure (Gemini didn't see the diagram clearly)",
        severity="warning",
        repairable=False,
    )]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_diagram_or_chart — flag empty description as perception warning"
```

#### Task 1.7: `validate_other` — description must be non-empty; fall back to caption/title (repairable)

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_other


def _other_item(**overrides):
    base = dict(
        content_type="other", description="",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="", code="", language="", purpose="",
        structure=[], headers=[], rows=[], title="", caption="", text_blocks=[],
    )
    base.update(overrides)
    return VisualContentItem(**base)


def test_validate_other_passes_with_description():
    assert validate_other(_other_item(description="A QED mark.")) == []


def test_validate_other_flags_empty_description_with_title_caption_as_repairable():
    item = _other_item(description="", title="Separator Line", caption="A line above the proof.")
    issues = validate_other(item)
    assert issues[0].rule == "other_content_in_title_caption"
    assert issues[0].repairable is True


def test_validate_other_flags_fully_empty_as_unrepairable():
    issues = validate_other(_other_item())
    assert issues[0].rule == "other_description_empty"
    assert issues[0].repairable is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_other_passes_with_description -v
```
Expected: FAIL.

- [ ] **Step 3: Implement `validate_other`**

```python
# pipeline/src/extraction/validators.py — append
def validate_other(item: VisualContentItem) -> list[ValidationIssue]:
    if item.content_type != "other":
        return []
    if item.description.strip():
        return []
    if (item.title or "").strip() or (item.caption or "").strip():
        return [ValidationIssue(
            rule="other_content_in_title_caption",
            message="content_type='other' has empty description but title/caption populated — Gemini misplaced content (those fields belong to tables only)",
            severity="error",
            repairable=True,
        )]
    return [ValidationIssue(
        rule="other_description_empty",
        message="content_type='other' has fully empty description, title, and caption",
        severity="error",
        repairable=False,
    )]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): validate_other — flag content in title/caption as repairable"
```

#### Task 1.8: `validate_item` — dispatcher that runs the right validator for the content_type

**Files:**
- Modify: `pipeline/src/extraction/validators.py`
- Modify: `pipeline/tests/test_validators.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_validators.py — append
from src.extraction.validators import validate_item


def test_validate_item_dispatches_to_code():
    issues = validate_item(_code_item(code="", text_blocks=[TextBlock(kind="paragraph", text="x = 1", depth=0)]))
    assert any(i.rule == "code_in_text_blocks" for i in issues)


def test_validate_item_dispatches_to_text():
    issues = validate_item(_text_item(text_blocks=[]))
    assert any(i.rule == "text_blocks_empty" for i in issues)


def test_validate_item_returns_empty_for_unknown_content_type():
    item = _code_item(content_type="something_new", code="ok")
    assert validate_item(item) == []


def test_validate_item_returns_empty_for_clean_item():
    assert validate_item(_eq_item(latex="F=ma")) == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_validators.py::test_validate_item_dispatches_to_code -v
```
Expected: FAIL — `validate_item` not defined.

- [ ] **Step 3: Implement the dispatcher**

```python
# pipeline/src/extraction/validators.py — append
_VALIDATORS = {
    "code": validate_code,
    "text": validate_text,
    "equation": validate_equation,
    "table": validate_table,
    "diagram_description": validate_diagram_or_chart,
    "chart_description": validate_diagram_or_chart,
    "other": validate_other,
}


def validate_item(item: VisualContentItem) -> list[ValidationIssue]:
    """Run the validator matching the item's content_type. Unknown types
    return [] — we only flag types we have explicit rules for."""
    fn = _VALIDATORS.get(item.content_type)
    return fn(item) if fn else []
```

- [ ] **Step 4: Run all validator tests**

```bash
python -m pytest tests/test_validators.py -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/validators.py pipeline/tests/test_validators.py
git commit -m "feat(validators): add validate_item dispatcher and ship PR 1"
```

**End of PR 1.** Open as a PR titled `feat(validators): visual-content validators (PR 1/4)`. Description should note: standalone module, not yet wired into worker. Used by PR 2 (repair) and PR 3 (eval).

---

## PR 2: Repair pass + worker integration + DB column + prompt hardening

This PR wires validators into the live worker, sends repairable failures to Flash-Lite, and persists `repair_status` so we can query post-hoc.

#### Task 2.1: Alembic migration adding `repair_status` to `equations.content_metadata`

**Decision:** store `repair_status` inside the existing `content_metadata` JSONB rather than as a new column. Reasons: zero schema-shape risk, no follow-up migration needed if we want to add more repair telemetry later, and `inspect_run.py` already reads metadata. We'll add an index on `(run_id, (content_metadata->>'repair_status'))` for query speed.

**Files:**
- Create: `pipeline/alembic/versions/<auto-rev>_add_repair_status_index.py`

- [ ] **Step 1: Generate the migration skeleton**

```bash
cd pipeline && source .venv/bin/activate
alembic revision -m "add repair_status index on equations content_metadata"
```
Note the generated revision filename.

- [ ] **Step 2: Fill in the migration**

```python
# pipeline/alembic/versions/<rev>_add_repair_status_index.py
"""add repair_status index on equations content_metadata

Revision ID: <auto>
Revises: d9a72b1e4c01
Create Date: 2026-04-29 ...

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "<auto>"
down_revision = "d9a72b1e4c01"  # last existing revision (verify with `alembic history`)
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Index for querying items by repair_status. JSONB GIN index would be more
    # general but a btree on the extracted text is enough — repair_status is
    # always one of {None, 'fixed', 'failed'}.
    #
    # CONCURRENTLY: builds without an exclusive lock on the table, so this
    # migration is safe to run while extractions are mid-flight. Required at
    # any non-trivial table size; cheap insurance even at our current scale.
    # Concurrent index builds can't run inside a transaction, so we set the
    # connection to AUTOCOMMIT for this statement.
    connection = op.get_bind()
    with connection.execution_options(isolation_level="AUTOCOMMIT"):
        connection.execute(sa.text("""
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_equations_repair_status
            ON equations (run_id, ((content_metadata->>'repair_status')))
            WHERE content_metadata ? 'repair_status'
        """))


def downgrade() -> None:
    connection = op.get_bind()
    with connection.execution_options(isolation_level="AUTOCOMMIT"):
        connection.execute(sa.text("DROP INDEX CONCURRENTLY IF EXISTS idx_equations_repair_status"))
```

- [ ] **Step 3: Verify the down-revision is correct**

```bash
alembic history | head -5
```
Confirm the most recent revision matches `down_revision` in the new migration. If not, edit it.

- [ ] **Step 4: Run the migration locally against your dev DB**

```bash
alembic upgrade head
```
Expected: "Running upgrade ... add repair_status index on equations content_metadata".

- [ ] **Step 5: Verify the index exists**

```bash
psql "$DATABASE_URL" -c "\\di idx_equations_repair_status"
# or via railway proxy if no local DB:
# railway ssh "psql \$DATABASE_URL -c '\\di idx_equations_repair_status'"
```
Expected: one row showing the new index.

- [ ] **Step 6: Commit**

```bash
git add pipeline/alembic/versions/*_add_repair_status_index.py
git commit -m "migrate: index equations by repair_status for fast post-hoc queries"
```

#### Task 2.2: Repair module skeleton + Flash-Lite client wrapper

**Files:**
- Create: `pipeline/src/extraction/repair.py`
- Create: `pipeline/tests/test_repair.py`

- [ ] **Step 1: Write the failing test for the client constructor**

```python
# pipeline/tests/test_repair.py
import os
import pytest
from src.extraction.repair import get_repair_model_name, RepairConfig


def test_default_repair_model_is_flash_lite(monkeypatch):
    monkeypatch.delenv("REPAIR_MODEL", raising=False)
    assert get_repair_model_name() == "gemini-3-flash-lite"


def test_repair_model_overridable_by_env(monkeypatch):
    monkeypatch.setenv("REPAIR_MODEL", "gemini-3-flash")
    assert get_repair_model_name() == "gemini-3-flash"


def test_repair_config_defaults():
    cfg = RepairConfig()
    assert cfg.timeout_seconds > 0
    # max_attempts=2 means: try once, then ONE retry on transient API error.
    # Named "attempts" to avoid the "is retries=1 the same as attempts=1?" ambiguity.
    assert cfg.max_attempts == 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_repair.py -v
```
Expected: ImportError.

- [ ] **Step 3: Create the repair module skeleton**

```python
# pipeline/src/extraction/repair.py
"""Cheap text-only repair pass for VisualContentItem objects flagged as
repairable by the validators.

The repair task is purely textual: given a broken JSON object plus the
validation rule it tripped, rearrange the fields so the content lands in
the right place. We never re-watch the video — that's what makes this cheap
(~$0.001 per call vs. ~$1 for a section reprocess). When repair fails or
the item is not repairable from text alone, the caller keeps the original
payload and stamps `repair_status='failed'` on it.
"""

from __future__ import annotations
import os
from dataclasses import dataclass


def get_repair_model_name() -> str:
    """Resolve the model used for the repair pass. Default is the cheapest
    Gemini variant capable of structured output. Set REPAIR_MODEL to override
    (e.g., "gemini-3-flash" for higher quality, or a non-Gemini model id if
    we add a different provider later)."""
    return os.environ.get("REPAIR_MODEL", "gemini-3-flash-lite")


@dataclass(frozen=True)
class RepairConfig:
    timeout_seconds: float = 30.0
    # Total Gemini calls for one item: try once, retry once on transient API error.
    # Named "attempts" not "retries" to avoid ambiguity (retries=1 can mean either
    # "1 retry after the first try" or "1 total try"). attempts=2 is unambiguous.
    max_attempts: int = 2


@dataclass(frozen=True)
class RepairOutcome:
    """Result of a repair attempt.

    status: 'fixed' | 'failed' | 'skipped'
      - 'fixed': repair returned a valid item that passes validation.
      - 'failed': we tried and the result still fails validation (or call errored).
      - 'skipped': caller decided not to attempt (e.g., issue.repairable is False).

    item: the post-repair item (may equal the input if status != 'fixed').
    detail: short human-readable string for logs/Slack.
    """
    status: str
    item: object  # VisualContentItem; typed loosely to avoid circular imports
    detail: str
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_repair.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/repair.py pipeline/tests/test_repair.py
git commit -m "feat(repair): add Flash-Lite repair module skeleton"
```

#### Task 2.3: `build_repair_prompt` — pure function that constructs the repair prompt

**Files:**
- Modify: `pipeline/src/extraction/repair.py`
- Modify: `pipeline/tests/test_repair.py`

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_repair.py — append
from src.extraction.repair import build_repair_prompt
from src.extraction.validators import ValidationIssue
from src.extraction.schemas import VisualContentItem, TextBlock


def _broken_code_item():
    return VisualContentItem(
        content_type="code",
        description="",
        discussed_start="0:10", discussed_end="0:20",
        confidence=0.9,
        latex="", code="", language="java", purpose="Hello world",
        structure=[], headers=[], rows=[], title="", caption="",
        text_blocks=[TextBlock(kind="paragraph", text="public class Hello { }", depth=0)],
    )


def test_build_repair_prompt_includes_item_json():
    issue = ValidationIssue(
        rule="code_in_text_blocks",
        message="code field empty but text_blocks has content",
        severity="error", repairable=True,
    )
    prompt = build_repair_prompt(_broken_code_item(), issue, transcript_context="public class Hello {")
    assert "public class Hello { }" in prompt  # the misplaced code
    assert "code_in_text_blocks" in prompt  # the rule name for context
    assert "transcript" in prompt.lower()


def test_build_repair_prompt_warns_against_invention():
    issue = ValidationIssue(rule="x", message="m", severity="error", repairable=True)
    prompt = build_repair_prompt(_broken_code_item(), issue, transcript_context="")
    # Critical: the prompt must NOT encourage hallucinating missing content.
    assert "do not invent" in prompt.lower() or "do not fabricate" in prompt.lower()


def test_repair_system_prompt_contains_invention_guard():
    """The system prompt is the actual constraint sent to the model — guard
    against future edits silently dropping the "do not invent" rule."""
    from src.extraction.repair import REPAIR_SYSTEM_PROMPT
    text = REPAIR_SYSTEM_PROMPT.lower()
    assert "do not invent" in text or "do not fabricate" in text
    # Also assert the partial-fix philosophy is documented for the model
    assert "return the original" in text or "unchanged" in text
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_repair.py::test_build_repair_prompt_includes_item_json -v
```
Expected: FAIL — `build_repair_prompt` not defined.

- [ ] **Step 3: Implement `build_repair_prompt`**

```python
# pipeline/src/extraction/repair.py — append
import json
from src.extraction.schemas import VisualContentItem
from src.extraction.validators import ValidationIssue


_REPAIR_SYSTEM = """You are a JSON repair tool. You receive a structured-output JSON object emitted by another model that failed validation, plus the rule it broke. You output a corrected JSON object that fits the same schema.

CRITICAL RULES:
1. Do NOT invent or fabricate content. If you cannot determine the correct value from what's already in the item or the transcript context, return the original item unchanged.
2. Move content between fields when the validation rule indicates a misplacement (e.g., 'code_in_text_blocks' means the code is in text_blocks but should be in the `code` field).
3. Preserve all timestamps, confidence, and other fields not directly affected by the rule.
4. Output JSON only, no markdown fences."""


def build_repair_prompt(
    item: VisualContentItem,
    issue: ValidationIssue,
    transcript_context: str,
) -> str:
    """Assemble the user-prompt for a single-item repair call. The system
    instruction is constant (_REPAIR_SYSTEM) and is sent separately."""
    item_json = item.model_dump_json(indent=2)
    return f"""Repair this VisualContentItem JSON object.

Validation rule violated: {issue.rule}
Validator message: {issue.message}

Broken item:
{item_json}

Transcript context (what the speaker said around the item's time window — may be empty):
{transcript_context or "(no transcript available for this window)"}

Return the corrected JSON object. Do not invent or fabricate content. If the right value is not derivable from this input, return the original item unchanged."""
```

Also export `_REPAIR_SYSTEM` so callers can use it as the system instruction:

```python
# at module top, just after RepairConfig
REPAIR_SYSTEM_PROMPT = _REPAIR_SYSTEM
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_repair.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/repair.py pipeline/tests/test_repair.py
git commit -m "feat(repair): build_repair_prompt — assemble Flash-Lite repair prompt"
```

#### Task 2.4: `repair_item` — call Flash-Lite, parse, re-validate

**Files:**
- Modify: `pipeline/src/extraction/repair.py`
- Modify: `pipeline/tests/test_repair.py`

- [ ] **Step 1: Write the failing tests (with mocks)**

```python
# pipeline/tests/test_repair.py — append
from unittest.mock import MagicMock, patch
from src.extraction.repair import repair_item, RepairOutcome


def _fake_genai_response(json_text: str):
    """Mimic google.genai's response object."""
    resp = MagicMock()
    resp.text = json_text
    return resp


def test_repair_item_returns_fixed_when_response_validates():
    item = _broken_code_item()
    issue = ValidationIssue(
        rule="code_in_text_blocks", message="m",
        severity="error", repairable=True,
    )
    fixed_json = item.model_copy(update={"code": "public class Hello { }", "text_blocks": []}).model_dump_json()
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = _fake_genai_response(fixed_json)

    outcome = repair_item(item, issue, transcript_context="", client=fake_client)

    assert outcome.status == "fixed"
    assert outcome.item.code == "public class Hello { }"
    assert outcome.item.text_blocks == []


def test_repair_item_returns_failed_when_response_still_invalid():
    item = _broken_code_item()
    issue = ValidationIssue(rule="code_in_text_blocks", message="m", severity="error", repairable=True)
    # Flash-Lite returns the same broken item — nothing was fixed.
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = _fake_genai_response(item.model_dump_json())

    outcome = repair_item(item, issue, transcript_context="", client=fake_client)
    assert outcome.status == "failed"
    assert outcome.item is item  # original returned, unchanged


def test_repair_item_returns_failed_on_api_error():
    item = _broken_code_item()
    issue = ValidationIssue(rule="x", message="m", severity="error", repairable=True)
    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError("api boom")

    outcome = repair_item(item, issue, transcript_context="", client=fake_client)
    assert outcome.status == "failed"
    assert "api boom" in outcome.detail


def test_repair_item_skips_unrepairable_issues():
    item = _broken_code_item()
    issue = ValidationIssue(rule="code_field_empty", message="m", severity="error", repairable=False)
    fake_client = MagicMock()
    outcome = repair_item(item, issue, transcript_context="", client=fake_client)
    assert outcome.status == "skipped"
    fake_client.models.generate_content.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_repair.py::test_repair_item_returns_fixed_when_response_validates -v
```
Expected: FAIL — `repair_item` not defined.

- [ ] **Step 3: Implement `repair_item`**

```python
# pipeline/src/extraction/repair.py — append
import logging
from google import genai
from google.genai import types
from src.extraction.validators import validate_item

logger = logging.getLogger("chalkboard.repair")


def _make_client():
    """Lazily construct the genai client; allows tests to inject a mock.

    Uses os.getenv to match the existing extraction client style in
    process_video_v2.py (rather than os.environ[KEY] which raises KeyError).
    If GEMINI_API_KEY is unset, genai.Client(api_key=None) errors at first call
    with a clearer message than KeyError at module-import time."""
    return genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def repair_item(
    item: VisualContentItem,
    issue: ValidationIssue,
    transcript_context: str = "",
    client=None,
    config: RepairConfig | None = None,
) -> RepairOutcome:
    """Attempt a single-shot text-only repair via the configured model.

    Returns RepairOutcome with status:
      - 'skipped': issue is not repairable; no API call made.
      - 'fixed':   API returned a JSON object that parses AND passes validate_item.
      - 'failed':  API errored, returned unparseable JSON, or the result still has issues.
    """
    if not issue.repairable:
        return RepairOutcome(status="skipped", item=item, detail=f"{issue.rule} is not repairable")

    cfg = config or RepairConfig()
    client = client or _make_client()
    model = get_repair_model_name()
    prompt = build_repair_prompt(item, issue, transcript_context)

    # Per-request timeout via the SDK's HttpOptions. Without this, a hung
    # Flash-Lite call would block the chunk worker indefinitely AND prevent
    # cancellation from progressing (the cancel checkpoint is between chunks,
    # not inside repair). 30s is generous for a text-only call on a small
    # JSON object; bump if you see legitimate timeouts in the wild.
    #
    # NOTE: verify the actual google-genai version in pipeline/pyproject.toml
    # before merging. As of google-genai 1.0+, the documented path is
    # types.HttpOptions(timeout=...) on the Client config, not per-request.
    # If the version pinned in pyproject doesn't expose per-request timeout,
    # construct a separate client with HttpOptions for repair calls only.
    http_options = types.HttpOptions(timeout=int(cfg.timeout_seconds * 1000))  # ms

    last_error: str = ""
    response = None
    for attempt in range(cfg.max_attempts):
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=REPAIR_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema=VisualContentItem,
                    http_options=http_options,  # enforce timeout
                ),
            )
            break  # success — exit retry loop
        except Exception as e:  # noqa: BLE001 — surface any failure (incl. timeout)
            last_error = str(e)
            logger.warning(f"repair API error attempt {attempt + 1}/{cfg.max_attempts} for {issue.rule}: {e}")
            if attempt + 1 == cfg.max_attempts:
                return RepairOutcome(status="failed", item=item, detail=f"api error after {cfg.max_attempts} attempts: {last_error}")

    raw = getattr(response, "text", None) if response else None
    if not raw:
        return RepairOutcome(status="failed", item=item, detail="empty repair response")

    try:
        repaired = VisualContentItem.model_validate_json(raw)
    except Exception as e:  # noqa: BLE001
        return RepairOutcome(status="failed", item=item, detail=f"unparseable repair response: {e}")

    # Accept any STRICT improvement, even if not fully clean. Rationale: an item
    # that originally had 2 errors and now has 1 is still a partial win for the
    # viewer, and reverting to the original throws away genuine progress. We
    # only reject when the repair didn't help OR made things worse.
    original_errors = [i for i in validate_item(item) if i.severity == "error"]
    remaining_errors = [i for i in validate_item(repaired) if i.severity == "error"]

    if len(remaining_errors) >= len(original_errors):
        return RepairOutcome(
            status="failed",
            item=item,  # keep original — repair didn't reduce error count
            detail=(
                f"repair returned item with {len(remaining_errors)} error(s), "
                f"originally had {len(original_errors)} — no improvement"
            ),
        )

    if remaining_errors:
        return RepairOutcome(
            status="fixed",
            item=repaired,
            detail=f"partial fix: {len(original_errors)} → {len(remaining_errors)} error(s) remaining",
        )

    return RepairOutcome(status="fixed", item=repaired, detail=f"fixed {issue.rule}")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_repair.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/repair.py pipeline/tests/test_repair.py
git commit -m "feat(repair): repair_item — Flash-Lite call with re-validation"
```

#### Task 2.5: `repair_run_items` — batch wrapper that runs validate→repair across an item list, returning a summary

**Files:**
- Modify: `pipeline/src/extraction/repair.py`
- Modify: `pipeline/tests/test_repair.py`

- [ ] **Step 1: Write the failing tests**

```python
# pipeline/tests/test_repair.py — append
from src.extraction.repair import repair_run_items, RepairSummary


def test_repair_run_items_returns_unchanged_when_all_pass():
    items = [_broken_code_item().model_copy(update={"code": "ok", "text_blocks": []})]
    summary = repair_run_items(items, transcript_context_for=lambda i: "", client=MagicMock())
    assert summary.repaired_count == 0
    assert summary.failed_count == 0
    assert summary.skipped_count == 0
    assert summary.items == items  # untouched


def test_repair_run_items_aggregates_outcomes():
    repairable = _broken_code_item()
    fixed_payload = repairable.model_copy(update={"code": "ok", "text_blocks": []}).model_dump_json()

    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = _fake_genai_response(fixed_payload)

    items = [repairable]
    summary = repair_run_items(items, transcript_context_for=lambda i: "", client=fake_client)

    assert summary.repaired_count == 1
    assert summary.failed_count == 0
    assert summary.items[0].code == "ok"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/test_repair.py::test_repair_run_items_returns_unchanged_when_all_pass -v
```
Expected: FAIL.

- [ ] **Step 3: Implement `repair_run_items`**

```python
# pipeline/src/extraction/repair.py — append
from typing import Callable


@dataclass
class RepairSummary:
    items: list[VisualContentItem]
    repaired_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    failure_details: list[str] = None

    def __post_init__(self):
        if self.failure_details is None:
            self.failure_details = []


def repair_run_items(
    items: list[VisualContentItem],
    transcript_context_for: Callable[[VisualContentItem], str],
    client=None,
    config: RepairConfig | None = None,
) -> RepairSummary:
    """Run validate → repair across a list of items. Returns a new list where
    each item is either (a) unchanged and clean, (b) the post-repair fixed
    version, or (c) the original with `repair_status='failed'` stamped into
    its content_metadata-equivalent field (we set this in the worker layer,
    not here — this function just reports outcomes)."""
    summary = RepairSummary(items=list(items))
    for idx, item in enumerate(items):
        issues = [i for i in validate_item(item) if i.severity == "error"]
        repairable_issue = next((i for i in issues if i.repairable), None)
        if not issues:
            continue
        if not repairable_issue:
            summary.failed_count += 1
            summary.failure_details.append(f"unrepairable: {issues[0].rule}")
            continue
        ctx = transcript_context_for(item)
        outcome = repair_item(item, repairable_issue, transcript_context=ctx, client=client, config=config)
        if outcome.status == "fixed":
            summary.items[idx] = outcome.item
            summary.repaired_count += 1
        elif outcome.status == "failed":
            summary.failed_count += 1
            summary.failure_details.append(f"{repairable_issue.rule}: {outcome.detail}")
        else:  # skipped
            summary.skipped_count += 1
    return summary
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_repair.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/repair.py pipeline/tests/test_repair.py
git commit -m "feat(repair): repair_run_items — batch validate→repair with summary"
```

#### Task 2.6: Wire validators + repair into `extract_visual_content_chunk` in process_video_v2

**Files:**
- Modify: `pipeline/scripts/process_video_v2.py` — `extract_visual_content_chunk` (line 283), all FOUR call sites, `process_section` closure return shape, THREE persistence sites where `EquationModel` is constructed

**Critical:** the audit found this task was previously under-spec'd in two important ways:

1. **There are FOUR call sites for `extract_visual_content_chunk`, not three.** The fourth is hidden inside a `process_section` closure inside `process_video` (line 760-779). The closure's return tuple `(idx, sents, items, section_title)` becomes a 5-tuple after this change, with downstream unpacking at line 775 and `all_visual_content[idx]` storage at line 777 also needing updates.
2. **There are THREE persistence sites where `repair_status` must be stamped**, not one: `reprocess_section` (line ~455), `reprocess_visual_content` (line ~582), and `process_video` (line ~952). Each constructs `EquationModel(...)` independently. A change to one doesn't auto-apply to the others.

We thread a transcript-context lookup through. Simplest version: pass an empty string for the first version; enrich later.

- [ ] **Step 1: Map the actual code surface before editing**

```bash
grep -n "extract_visual_content_chunk\|EquationModel\|process_section\|content_metadata=" pipeline/scripts/process_video_v2.py
```

Expected (verify against your local copy — line numbers may drift):
- `def extract_visual_content_chunk(...)` at line ~283 — function definition
- Call site #1: `reprocess_section` at line ~391
- Call site #2: `reprocess_visual_content` at line ~555
- Call site #3: `process_section` closure inside `process_video` at line ~764 — closure dispatched to `ThreadPoolExecutor` at line ~769, unpacked at line ~775, stored at line ~777
- Call site #4 (if any non-closure direct call inside `process_video`) — verify with grep
- `EquationModel(...)` construction sites at lines ~455, ~582, ~952 — three independent insertion points for `repair_status`
- Each `EquationModel` is built with `content_metadata=content_meta or None` after a call to `_build_content_meta(...)` (lines ~424, ~567, ~825-922 area)

If your file has drifted from these line numbers, adjust accordingly — but the **count** (4 callers, 3 persistence sites) is what you must preserve.

- [ ] **Step 2: Add an integration test (golden-path repair through a fake)**

```python
# pipeline/tests/test_process_video_v2_repair_integration.py (new file)
"""Integration test that calls extract_visual_content_chunk's repair path
with a mocked Gemini client. Doesn't run a real video; verifies the wiring.

NOTE: the production extraction code uses `response.parsed` (Pydantic-validated
object), NOT `response.text`. The mocks below ONLY set `parsed=` — that's the
attribute being read. Setting `text=` too would let the test pass even if the
implementation accidentally swapped to reading text; we want the test to
enforce the contract."""

import pytest
from unittest.mock import MagicMock
from src.extraction.schemas import VisualContentItem, VisualContentExtractionOutput, TextBlock


def _broken_code_item():
    """The canonical code_in_text_blocks misplacement — empty `code`, content in textBlocks."""
    return VisualContentItem(
        content_type="code", description="",
        discussed_start="0:10", discussed_end="0:20",
        confidence=0.9, latex="", code="", language="java",
        purpose="", structure=[], headers=[], rows=[], title="", caption="",
        text_blocks=[TextBlock(kind="paragraph", text="public class A {}", depth=0)],
    )


def test_repair_runs_after_extract_when_validators_flag_misplacement():
    broken = _broken_code_item()
    fake_extraction_response = MagicMock(parsed=VisualContentExtractionOutput(items=[broken]))

    fixed = broken.model_copy(update={"code": "public class A {}", "text_blocks": []})
    fake_repair_response = MagicMock(text=fixed.model_dump_json())  # repair_item reads .text

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = [fake_extraction_response, fake_repair_response]

    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=1.0,
    )
    assert len(items) == 1
    assert items[0].code == "public class A {}"
    assert items[0].text_blocks == []
    assert summary is not None
    assert summary.repaired_count == 1
    assert summary.statuses == ["fixed"]


def test_extract_visual_content_chunk_returns_tuple_on_happy_path():
    """No validator errors → no repair pass → summary is None, tuple shape preserved."""
    clean = VisualContentItem(
        content_type="equation", description="F=ma alt-text",
        discussed_start="0:00", discussed_end="0:05",
        confidence=1.0, latex="F = ma", code="", language="",
        purpose="", structure=[], headers=[], rows=[],
        title="", caption="", text_blocks=[],
    )
    fake_response = MagicMock(parsed=VisualContentExtractionOutput(items=[clean]))
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=1.0,
    )
    assert len(items) == 1
    assert summary is None


def test_extract_visual_content_chunk_returns_tuple_on_extraction_failure():
    """All 3 retries exhausted → return ([], None), not bare []."""
    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError("api boom")
    from scripts.process_video_v2 import extract_visual_content_chunk
    items, summary = extract_visual_content_chunk(
        client=fake_client, url="dummy://", start=0, end=30, context="",
        model="gemini-3-flash-preview", fps=1.0,
    )
    assert items == []
    assert summary is None
```

- [ ] **Step 3: Run the integration test to verify it fails**

```bash
python -m pytest tests/test_process_video_v2_repair_integration.py -v
```
Expected: FAIL — repair not yet wired in.

- [ ] **Step 4: Update `extract_visual_content_chunk` to return uniform tuple shape**

The function has THREE return paths today. All three must return `(list[VisualContentItem], RepairSummary | None)`:

```python
# pipeline/scripts/process_video_v2.py — at the top with other imports
from src.extraction.repair import repair_run_items, RepairSummary
from src.extraction.validators import validate_item
# logger is already defined module-level as: logger = logging.getLogger("chalkboard")
# Verify before adding (line ~96-97 in the existing file). Do NOT redeclare it.


def extract_visual_content_chunk(
    client, url: str, start: float, end: float, context: str,
    model: str = DEFAULT_MODEL, fps: float = 1.0,
) -> tuple[list, RepairSummary | None]:
    """Extract visual content for one chunk, run validate→repair, return
    (items, summary). Summary is None when no repair was needed (happy path)
    OR when extraction failed entirely after retries.

    Always returns a tuple — never bare list, never bare items, never bare [].
    """
    system = f"{VISUAL_CONTENT_SYSTEM_PROMPT}\n\n{context}"
    for attempt in range(3):
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps, start_offset=f"{int(start)}s", end_offset=f"{int(end)}s",
                ),
            )
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=VisualContentExtractionOutput,
                ),
            )
            parsed = VisualContentExtractionOutput.model_validate(response.parsed)
            items = parsed.items

            # Run validators; only enter repair pass if at least one item has an error.
            needs_repair = any(
                any(i.severity == "error" for i in validate_item(it))
                for it in items
            )
            if not needs_repair:
                return items, None

            summary = repair_run_items(
                items,
                transcript_context_for=lambda _it: "",  # TODO: thread the chunk transcript text in
                client=client,
            )
            if summary.repaired_count or summary.failed_count:
                logger.info(
                    f"    Repair: fixed={summary.repaired_count}, failed={summary.failed_count}, "
                    f"skipped={summary.skipped_count}"
                )
            return summary.items, summary

        except Exception as e:
            logger.warning(f"    Visual content chunk error: {e}, retry {attempt+1}")
            time.sleep(2)
    return [], None  # all retries exhausted — same tuple shape as the happy path
```

- [ ] **Step 5: Update all FOUR caller sites + the closure return shape**

```bash
grep -n "extract_visual_content_chunk\|process_section\|all_visual_content" pipeline/scripts/process_video_v2.py
```

**Caller #1 — `reprocess_section` (line ~391):**
```python
# before
vc_items = extract_visual_content_chunk(client, youtube_url, start_time, end_time, context, model=model, fps=fps)

# after
chunk_summaries: list[RepairSummary] = []  # add at top of reprocess_section
vc_items, chunk_summary = extract_visual_content_chunk(client, youtube_url, start_time, end_time, context, model=model, fps=fps)
if chunk_summary is not None:
    chunk_summaries.append(chunk_summary)
```

**Caller #2 — `reprocess_visual_content` (line ~555):** same pattern.

**Caller #3 — `process_section` closure inside `process_video` (line ~764):**

The closure looks roughly like:
```python
def process_section(idx, start, end, section_title, context):
    sents = extract_transcript_chunk(...)
    items = []
    if visual_content_mode:
        items = extract_visual_content_chunk(client, video_uri, start, end, context, model=model)
    return idx, sents, items, section_title
```

Update closure to return a 5-tuple `(idx, sents, items, chunk_summary, section_title)`:
```python
def process_section(idx, start, end, section_title, context):
    sents = extract_transcript_chunk(...)
    items, chunk_summary = [], None
    if visual_content_mode:
        items, chunk_summary = extract_visual_content_chunk(client, video_uri, start, end, context, model=model)
    return idx, sents, items, chunk_summary, section_title
```

Then update the unpacking at the `as_completed` site (line ~775) AND the `all_visual_content[idx]` storage (line ~777):
```python
# before
for future in as_completed(futures):
    idx, sents, items, section_title = future.result()
    all_segments[idx] = sents
    all_visual_content[idx] = (items, section_title)

# after
chunk_summaries: list[RepairSummary] = []  # add at top of process_video
for future in as_completed(futures):
    idx, sents, items, chunk_summary, section_title = future.result()
    all_segments[idx] = sents
    all_visual_content[idx] = (items, section_title)
    if chunk_summary is not None:
        chunk_summaries.append(chunk_summary)
```

**Caller #4** — verify with the grep. If there's a fourth direct call (not via closure), apply the same tuple-unpack pattern.

- [ ] **Step 6: Stamp `repair_status` at all THREE persistence sites**

Two-step approach. First, extend `RepairSummary` to expose per-index outcomes:

```python
# pipeline/src/extraction/repair.py — adjust RepairSummary
@dataclass
class RepairSummary:
    items: list[VisualContentItem]
    statuses: list[str | None] = None  # parallel to items: 'fixed' | 'failed' | None
    repaired_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    failure_details: list[str] = None

    def __post_init__(self):
        if self.statuses is None:
            self.statuses = [None] * len(self.items)
        if self.failure_details is None:
            self.failure_details = []
```

…and in `repair_run_items` set `summary.statuses[idx] = 'fixed'` or `'failed'` accordingly when each item's outcome is determined. Update test_repair.py's existing tests to assert on `statuses`.

Second, update each persistence site. The pattern at all three sites looks like:

```python
# Existing pattern (lines ~424, ~567, ~825 etc.)
content_meta = _build_content_meta(item)  # returns a camelCase dict — see Note below
db_eq = EquationModel(
    ...
    content_metadata=content_meta or None,
)
```

Add `repair_status` AFTER `_build_content_meta` returns. **Important:** `_build_content_meta` is idempotent and accepts both Pydantic and dict inputs (lines 52-98 in the existing file). It does NOT pass through unknown keys. So you must add `repair_status` to the dict it returns, not to the input:

```python
# new pattern, applied at lines ~455, ~582, ~952
content_meta = _build_content_meta(item)
status = chunk_summary.statuses[item_idx] if chunk_summary else None
if status:
    content_meta = {**(content_meta or {}), "repair_status": status}
db_eq = EquationModel(
    ...
    content_metadata=content_meta or None,
)
```

Each persistence site needs the `chunk_summary` and `item_idx` available in its local scope. For `reprocess_section` and `reprocess_visual_content`, this is straightforward (single chunk_summary per call). For `process_video`, you need the per-section summary that maps to the items being persisted — store `chunk_summary` alongside items in `all_visual_content[idx]` to make this trivial.

- [ ] **Step 7: Run the integration test to verify it passes**

```bash
python -m pytest tests/test_process_video_v2_repair_integration.py -v
```
Expected: PASS.

- [ ] **Step 8: Run the full pipeline test suite**

```bash
python -m pytest tests/ -v
```
Expected: all PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add pipeline/scripts/process_video_v2.py pipeline/src/extraction/repair.py pipeline/tests/test_process_video_v2_repair_integration.py pipeline/tests/test_repair.py
git commit -m "feat(repair): wire validators + repair into extract_visual_content_chunk; stamp repair_status at all 3 persistence sites"
```

#### Task 2.7: Slack notification for repair summary per run

**Files:**
- Modify: `pipeline/src/notifications/slack.py` — add `notify_repair_summary` using `urllib.request.urlopen` (NO `requests` dependency — match the existing module's deliberate no-deps choice noted in its docstring)
- Modify: `pipeline/scripts/process_video_v2.py` — call site at end of each of the three entry points

**Constraint:** the existing `slack.py` uses `urllib.request.urlopen` and Block Kit (`{"blocks": [...]}` payload format). Match both for consistency. `requests` is NOT in `pipeline/pyproject.toml` and adding it just for repair telemetry is wrong. The existing test patches `urllib.request.urlopen` — so should the new test.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_slack_repair.py (new file)
from unittest.mock import patch, MagicMock
from src.notifications.slack import notify_repair_summary


def test_notify_repair_summary_skips_when_nothing_to_report(monkeypatch):
    monkeypatch.setenv("CHALKBOARD_SLACK_WEBHOOK", "https://example/hook")
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=10, repaired=0, failed=0, skipped=0,
            failure_details=[],
        )
        urlopen.assert_not_called()


def test_notify_repair_summary_skips_below_threshold(monkeypatch):
    """Don't fire for the routine "3 unrepairable diagrams in 200 items" case."""
    monkeypatch.setenv("CHALKBOARD_SLACK_WEBHOOK", "https://example/hook")
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=200, repaired=0, failed=3, skipped=0,
            failure_details=["diagram_description_empty"],
        )
        urlopen.assert_not_called()


def test_notify_repair_summary_posts_when_anything_was_repaired(monkeypatch):
    monkeypatch.setenv("CHALKBOARD_SLACK_WEBHOOK", "https://example/hook")
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=10, repaired=2, failed=1, skipped=0,
            failure_details=["code_in_text_blocks: api error"],
        )
        urlopen.assert_called_once()
        # Inspect the Request object passed in
        req = urlopen.call_args.args[0]
        body = req.data.decode("utf-8")
        assert "blocks" in body  # Block Kit format, matches notify_pipeline_event
        assert '"2"' in body or "fixed=2" in body or "*2*" in body  # repaired count surfaces


def test_notify_repair_summary_posts_when_failure_rate_high(monkeypatch):
    """Fires when failures cross 5% of items even with zero repairs."""
    monkeypatch.setenv("CHALKBOARD_SLACK_WEBHOOK", "https://example/hook")
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=20, repaired=0, failed=2, skipped=0,
            failure_details=["x", "y"],
        )
        urlopen.assert_called_once()  # 2/20 = 10% >= 5% threshold


def test_notify_repair_summary_posts_when_skipped_rate_high(monkeypatch):
    """Skipped (perception failures, unrepairable) above threshold should ALSO fire.
    Otherwise a video with 30 unrepairable items but 0 repaired stays silent —
    that's a real degradation of output the user sees."""
    monkeypatch.setenv("CHALKBOARD_SLACK_WEBHOOK", "https://example/hook")
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=100, repaired=0, failed=0, skipped=10,
            failure_details=["diagram_description_empty"],
        )
        urlopen.assert_called_once()  # 10/100 = 10% skipped >= 5% threshold


def test_notify_repair_summary_silent_when_no_webhook(monkeypatch):
    """Existing module convention — no-op gracefully when webhook env is unset."""
    monkeypatch.delenv("CHALKBOARD_SLACK_WEBHOOK", raising=False)
    with patch("src.notifications.slack.urllib.request.urlopen") as urlopen:
        notify_repair_summary(
            video_title="Test", run_id="abc",
            total_items=10, repaired=5, failed=0, skipped=0,
            failure_details=[],
        )
        urlopen.assert_not_called()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_slack_repair.py -v
```
Expected: FAIL — `notify_repair_summary` not defined.

- [ ] **Step 3: Implement `notify_repair_summary`**

Use the existing module's deps and Block Kit style (no `requests`, no plain-text `{"text": "..."}`):

```python
# pipeline/src/notifications/slack.py — append after notify_pipeline_event
# (urllib.request, urllib.error, json, os already imported at module top)


SLACK_REPAIR_NOISE_THRESHOLD_ABS = 5
SLACK_REPAIR_NOISE_THRESHOLD_RATE = 0.05  # 5% of items


def notify_repair_summary(
    video_title: str,
    run_id: str,
    total_items: int,
    repaired: int,
    failed: int,
    skipped: int,
    failure_details: list[str],
) -> None:
    """One Slack message per run summarizing validator + repair outcomes.

    Fires only when there's something actionable:
      - Anything was actually repaired (positive operational signal), OR
      - Failures crossed an absolute or rate threshold (5 items, or 5%), OR
      - Skipped (unrepairable / perception-failure) crossed the same threshold.

    The skipped threshold matters because perception failures show up as
    user-visible blank items in the viewer — silence on a run with 30
    skipped items would mask real output degradation.

    Uses urllib.request to match the no-deps style of notify_pipeline_event.
    """
    if repaired == 0:
        problem_count = failed + skipped
        rate = (problem_count / total_items) if total_items else 0.0
        if (
            problem_count < SLACK_REPAIR_NOISE_THRESHOLD_ABS
            and rate < SLACK_REPAIR_NOISE_THRESHOLD_RATE
        ):
            return
    webhook = os.getenv("CHALKBOARD_SLACK_WEBHOOK")
    if not webhook:
        return

    summary_line = (
        f"items={total_items}, repaired={repaired}, "
        f"failed={failed}, skipped={skipped}"
    )
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f":wrench: Repair pass: {video_title[:120]}"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Run:* `{run_id}`"},
                {"type": "mrkdwn", "text": f"*Counts:* {summary_line}"},
            ],
        },
    ]
    if failure_details:
        bullet_text = "\n".join(f"• {d}" for d in failure_details[:10])
        if len(failure_details) > 10:
            bullet_text += f"\n…and {len(failure_details) - 10} more"
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Failures:*\n{bullet_text}"},
        })

    payload = {"blocks": blocks}
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as e:
        logger.error(f"Slack repair summary failed: HTTP {e.code}")
    except Exception as e:
        logger.error(f"Slack repair summary failed: {type(e).__name__}")
```

- [ ] **Step 4: Wire it into all three entry points at run completion**

`extract_visual_content_chunk` is called from three entry points. Each one needs its own end-of-run aggregation and Slack notification, otherwise the reprocess paths silently drop their summaries.

Add this helper near the top of `process_video_v2.py` to avoid duplicating the aggregation logic three times:

```python
# pipeline/scripts/process_video_v2.py — add near other helpers
from src.notifications.slack import notify_repair_summary

def _maybe_notify_repair(
    title: str,
    run_id: str,
    chunk_summaries: list,  # list[RepairSummary]
) -> None:
    if not chunk_summaries:
        return
    total = sum(len(s.items) for s in chunk_summaries)
    repaired = sum(s.repaired_count for s in chunk_summaries)
    failed = sum(s.failed_count for s in chunk_summaries)
    skipped = sum(s.skipped_count for s in chunk_summaries)
    failure_details = [d for s in chunk_summaries for d in s.failure_details]
    notify_repair_summary(
        video_title=title,
        run_id=run_id,
        total_items=total,
        repaired=repaired,
        failed=failed,
        skipped=skipped,
        failure_details=failure_details,
    )
```

In each of the three entry points, just before the function returns successfully, call the helper:

```python
# inside process_video, end of successful path:
_maybe_notify_repair(title=title, run_id=str(run.id), chunk_summaries=chunk_summaries)

# inside reprocess_section:
_maybe_notify_repair(title=f"{video.title} (section {section_index} reprocess)", run_id=str(run.id), chunk_summaries=chunk_summaries)

# inside reprocess_visual_content:
_maybe_notify_repair(title=f"{video.title} (visual reprocess)", run_id=str(run.id), chunk_summaries=chunk_summaries)
```

The `chunk_summaries` local list is the one initialized in Task 2.6 Step 4 inside each of the three entry points.

- [ ] **Step 5: Run tests to verify they pass**

```bash
python -m pytest tests/test_slack_repair.py tests/ -v
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/notifications/slack.py pipeline/scripts/process_video_v2.py pipeline/tests/test_slack_repair.py
git commit -m "feat(repair): Slack summary message at end of run"
```

#### Task 2.8: Surface `repair_status` counts in `inspect_run.py`

**Files:**
- Modify: `pipeline/scripts/inspect_run.py`

- [ ] **Step 1: Update the `cmd_run` query and print loop**

Open `pipeline/scripts/inspect_run.py` and find `cmd_run` (around line 116). The existing query groups by `content_type`. Add two columns counting fixed/failed repair statuses:

```python
# pipeline/scripts/inspect_run.py — replace the existing cmd_run summary query
cur.execute(
    """
    SELECT content_type,
           COUNT(*) AS n,
           SUM(CASE WHEN description IS NULL OR description = '' THEN 1 ELSE 0 END) AS empty_desc,
           SUM(CASE WHEN content_metadata->>'repair_status' = 'fixed'  THEN 1 ELSE 0 END) AS repair_fixed,
           SUM(CASE WHEN content_metadata->>'repair_status' = 'failed' THEN 1 ELSE 0 END) AS repair_failed
    FROM equations WHERE run_id=%s GROUP BY content_type ORDER BY n DESC
    """,
    (run_id,),
)
print(f"Run {run_id} — counts by content_type:")
for r in cur.fetchall():
    print(
        f"  {r['content_type']:<24} n={r['n']:<4} empty_desc={r['empty_desc']:<3} "
        f"repair_fixed={r['repair_fixed']:<3} repair_failed={r['repair_failed']}"
    )
```

- [ ] **Step 2: Smoke-test against a recent run**

```bash
cd pipeline && source .venv/bin/activate
# Pick any recent run id from `inspect_run.py --video <video_id>`
python scripts/inspect_run.py --run <recent_run_id> --db-url "$DATABASE_PUBLIC_URL"
```
Expected: the new `repair_fixed` / `repair_failed` columns appear in the summary. Pre-PR-2 runs show 0 for both (no repair_status was stamped before this PR).

- [ ] **Step 3: Commit**

```bash
git add pipeline/scripts/inspect_run.py
git commit -m "chore(inspect): show repair_status counts in --run summary"
```

#### Task 2.9: Prompt hardening — textBlocks misplacement anti-pattern

**Why this task exists:** Empirical analysis (2026-04-30) of prod's DSC30 run found 178 of 187 broken items (95%) are the same misplacement pattern: Gemini emits `content_type: "diagram_description"` (or `"other"`, `"chart_description"`) with `description=""` and rich content sitting in `textBlocks`. Validators+repair fix this *after* the fact at ~$0.0003/item via Flash-Lite. The cheaper move is to reduce the rate at the source by making the prompt explicit about field placement.

This is independent of validators/repair and can ship as part of PR 2 to maximize their effectiveness on first run. If prompt hardening alone reduces misplacement materially, the repair pass has less work to do (and the eval set in PR 3 will measure the delta).

**Files:**
- Modify: `pipeline/src/extraction/prompts.py` — `VISUAL_CONTENT_SYSTEM_PROMPT`, `VISUAL_CONTENT_USER_PROMPT`, bump `VISUAL_CONTENT_PROMPT_VERSION`

- [ ] **Step 1: Locate the prompt definitions**

```bash
grep -n "VISUAL_CONTENT_SYSTEM_PROMPT\|VISUAL_CONTENT_USER_PROMPT\|VISUAL_CONTENT_PROMPT_VERSION" pipeline/src/extraction/prompts.py
```

Expected: three constants at the module level. Note that `VISUAL_CONTENT_PROMPT_VERSION` is referenced by `eval_runner.py`'s baseline filename (`<video_id>__<prompt_version>.json`) — a bump here triggers a baseline rebuild in PR 3.

- [ ] **Step 2: Add field-placement guidance to the system prompt**

Insert a "FIELD PLACEMENT RULES" section after the existing role description in `VISUAL_CONTENT_SYSTEM_PROMPT`:

```
FIELD PLACEMENT RULES (critical — wrong placement breaks the viewer):

For each content_type, the PRIMARY content goes in EXACTLY one field. Do NOT
use textBlocks as a fallback or "rich description" container for non-text types.

  content_type='code'              → code (string). NEVER textBlocks.
  content_type='text'              → textBlocks (list). NEVER description.
  content_type='equation'          → latex (string).
  content_type='table'             → headers (list) + rows (list of lists).
  content_type='diagram_description' → description (string). NEVER textBlocks.
  content_type='chart_description'   → description (string). NEVER textBlocks.
  content_type='other'             → description (string). NEVER textBlocks.

ANTI-PATTERN (the most common bug we see): emitting a diagram_description with
description="" and putting the description in textBlocks instead. textBlocks
is ONLY for content_type='text' — it represents structured slide layouts with
multiple distinct headings/bullets/paragraphs whose hierarchy must be preserved.
A flowing description of a diagram is NOT a textBlocks structure even if it
has multiple sentences; put it in description as a single string.

If a diagram has both a flowing description AND structured labels you want to
preserve, put the prose in description and the labels in structure (a list of
strings). Do NOT smuggle prose into textBlocks.
```

- [ ] **Step 3: Add 2-3 few-shot examples to the user prompt**

After any existing instructions in `VISUAL_CONTENT_USER_PROMPT`, append:

```
EXAMPLES OF CORRECT FIELD PLACEMENT:

Example 1 — diagram with description:
{
  "content_type": "diagram_description",
  "description": "A flowchart of Java compilation: source file (DSC.java) flows through the compiler (javac) to produce bytecode (DSC.class), which then executes on the JVM.",
  "discussed_start": "12:34", "discussed_end": "13:05",
  "confidence": 0.9
}
NOT THIS (textBlocks misplacement — common bug):
{
  "content_type": "diagram_description",
  "description": "",
  "textBlocks": [{"kind": "paragraph", "text": "A flowchart of Java compilation..."}]
}

Example 2 — code item:
{
  "content_type": "code",
  "code": "for i in range(10):\n    print(i)",
  "language": "python",
  "purpose": "Iterates 0-9 and prints each value.",
  "discussed_start": "5:10", "discussed_end": "5:30",
  "confidence": 0.95
}
NOT THIS:
{
  "content_type": "code",
  "code": "",
  "textBlocks": [{"kind": "paragraph", "text": "for i in range(10): print(i)"}]
}

Example 3 — actual text slide (textBlocks IS correct here):
{
  "content_type": "text",
  "textBlocks": [
    {"kind": "heading", "text": "1.1 Practice: True / False", "depth": 0},
    {"kind": "bullet", "text": "An abstract class can have both abstract and regular methods.", "depth": 0},
    {"kind": "bullet", "text": "An interface can have both abstract and regular methods.", "depth": 0}
  ],
  "discussed_start": "3:15", "discussed_end": "4:30",
  "confidence": 0.95
}
```

- [ ] **Step 4: Bump the prompt version**

```python
# pipeline/src/extraction/prompts.py
VISUAL_CONTENT_PROMPT_VERSION = "v0.4.0"  # field-placement guidance + few-shot examples
```

PR 3 will capture fresh baselines under v0.4.0. Do not bump in this PR if you've already started PR 3 — coordinate the version bump with the baseline capture.

- [ ] **Step 5: Smoke-test on the DSC30 video**

```bash
python scripts/process_video_v2.py "https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC" --title "DSC30 prompt-v0.4.0 smoke test" --no-db
```

After completion, query the resulting demo JSON for misplacement rates. The expectation is a measurable drop (target: <50% of pre-prompt-update rate). Even if the drop is modest, the repair pass catches what's left.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/extraction/prompts.py
git commit -m "feat(prompt): textBlocks anti-pattern guidance + field-placement examples (v0.4.0)"
```

**End of PR 2.** Open as `feat(repair): visual-content validators + repair pass + worker integration + prompt hardening (PR 2/3)`. Description should note: depends on PR 1; ships the live behavior change; first reprocess after merge will produce items with `repair_status` keys; `inspect_run.py --run` now surfaces fixed/failed counts per content_type; prompt v0.4.0 reduces misplacement at the source; PR 3 (eval) measures the combined effect.

---

## PR 3: CI eval set + baselines

This PR turns prompt-version bumps from blind into measured. Builds a small, stable test set from your existing prod data, captures baselines, runs them on demand or in CI, diffs against committed baselines.

#### Task 3.1: Curate the test video list (one-time, manual SQL pick)

**Files:**
- Create: `eval/test_videos.json`

- [ ] **Step 1: Query prod for candidate videos**

```bash
railway link --project 7a7b8582-4d1f-435c-b035-214f5062a81f --environment production --service worker
railway ssh "python3 << 'PYEOF'
import psycopg2, psycopg2.extras, os, json
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute('''
SELECT v.id, v.youtube_url, v.title, v.duration,
       pr.id AS run_id,
       (SELECT array_agg(DISTINCT content_type) FROM equations e WHERE e.run_id = pr.id) AS content_types
FROM videos v
JOIN pipeline_runs pr ON pr.video_id = v.id
WHERE pr.status = 'complete'
  AND v.duration > 0
  AND v.duration < 1800  -- under 30 min keeps eval cost bounded
ORDER BY v.created_at DESC
LIMIT 40
''')
for r in cur.fetchall():
    print(json.dumps(dict(r), default=str))
PYEOF"
```

- [ ] **Step 2: Pick 20 videos covering all content_types and at least one known-bad item**

Manually inspect the output. Pick ~20 video IDs and corresponding URLs that:
- Cover each of the seven content_types at least twice across the set (use the `content_types` array)
- Include at least 3 videos that have known-bad items (the DSC30 video, the Lewin video, the be89fbd9 currency video, etc.)
- Vary in length (5/10/15/20 min — avoid all short-or-all-long bias)

Write the picks to `eval/test_videos.json`:

```json
[
  {"video_id": "77d7341f-230c-4b8e-9ddf-c7ddd06ec064", "youtube_url": "https://youtu.be/2a6wXV_Nn9U", "title": "DSC30-Final-Review", "tags": ["code", "java", "known_bad:code_in_text_blocks"]},
  {"video_id": "be89fbd9-b887-4278-8206-91e245a0a656", "youtube_url": "https://www.youtube.com/watch?v=MRqtXL2WX2M", "title": "stddev demo", "tags": ["text", "known_bad:bare_dollar_currency"]},
  ...
]
```

- [ ] **Step 3: Commit the test-set definition**

```bash
mkdir -p eval/baselines
git add eval/test_videos.json
# Also add a placeholder .gitkeep so eval/baselines/ exists in git
touch eval/baselines/.gitkeep
git add eval/baselines/.gitkeep
git commit -m "eval: curate 20 test videos for CI eval set"
```

#### Task 3.2: Refactor `process_video` to support an in-memory return shape

The eval runner needs to call `process_video_v2.process_video(...)` and read the output WITHOUT writing to the DB and without the demo-JSON-to-disk side-effect getting in the way. Today's `process_video` only emits demo JSON or persists to DB; it doesn't return its results structurally. Refactoring this is a real surgery on the main pipeline entry point — separate task with its own tests so it lands cleanly before Task 3.3 depends on it.

**Files:**
- Modify: `pipeline/scripts/process_video_v2.py` — add `ProcessResult` dataclass and `return_payload` flag to `process_video`
- Create: `pipeline/tests/test_process_video_return_payload.py`

- [ ] **Step 1: Write the failing test**

The test patches the *actual* helpers in `process_video_v2.py`. The real names (verified from the module) are `get_video_metadata` (returns `(title, duration_seconds)` tuple), `download_captions`, plus the chunked extractors. The demo-JSON path is hardcoded as `Path(__file__).resolve().parents[2] / "viewer" / "public" / "demo" / f"{file_id}.json"` — there is no `DEMO_OUTPUT_DIR` env var. We therefore intercept the on-disk write by patching `Path.open` for files matching the demo dir, OR by patching the broader `open` builtin scoped to the module. Cleanest: patch `json.dump` inside the module, since that's the only call site for the demo write.

```python
# pipeline/tests/test_process_video_return_payload.py
from unittest.mock import patch, MagicMock
import scripts.process_video_v2 as pv2
from scripts.process_video_v2 import ProcessResult, process_video


def _shared_mocks(monkeypatch):
    """Mocks just enough that process_video can run without external services."""
    fake_summary = MagicMock(items=[], repaired_count=0, failed_count=0, skipped_count=0, failure_details=[])
    monkeypatch.setattr(pv2, "get_video_metadata", lambda url: ("Test Title", 120.0))
    monkeypatch.setattr(pv2, "download_captions", lambda url, out_dir: "dummy.srt")
    # generate_topic_map signature in this codebase returns a dict with "sections" + "summary";
    # adapt the patched return to match. If the patch target name differs in your tree, grep first.
    monkeypatch.setattr(pv2, "generate_topic_map",
                        lambda *a, **kw: {"summary": "s", "sections": []})
    monkeypatch.setattr(pv2, "extract_transcript_chunk", lambda *a, **kw: [])
    monkeypatch.setattr(pv2, "extract_visual_content_chunk",
                        lambda *a, **kw: ([], fake_summary))


def test_process_video_returns_in_memory_when_return_payload_true(monkeypatch):
    _shared_mocks(monkeypatch)
    # Track whether the demo JSON write happens by intercepting json.dump
    dump_calls: list = []
    monkeypatch.setattr(pv2.json, "dump", lambda *a, **kw: dump_calls.append(a))

    result = process_video(
        source="https://youtu.be/x",
        title="t",
        db_mode=False,
        return_payload=True,
    )
    assert isinstance(result, ProcessResult)
    assert result.visual_content_items == []
    assert dump_calls == []  # return_payload skipped the demo write


def test_process_video_writes_demo_json_when_return_payload_false(monkeypatch):
    _shared_mocks(monkeypatch)
    dump_calls: list = []
    monkeypatch.setattr(pv2.json, "dump", lambda *a, **kw: dump_calls.append(a))
    # Stub Path.open used by `with open(output_path, "w") as f` so we don't actually write to disk.
    # The existing code uses bare `open(...)` — patch the module's `open` via builtins.
    monkeypatch.setattr("builtins.open", lambda *a, **kw: MagicMock(__enter__=lambda s: MagicMock(), __exit__=lambda *e: None))

    result = process_video(source="https://youtu.be/x", title="t", db_mode=False)
    assert result is None
    assert len(dump_calls) == 1  # demo JSON write happened (just intercepted)


def test_return_payload_does_not_write_demo_json(monkeypatch):
    """return_payload=True is the eval-runner path — must not call json.dump
    even though db_mode is False (the default eval path)."""
    _shared_mocks(monkeypatch)
    dump_calls: list = []
    monkeypatch.setattr(pv2.json, "dump", lambda *a, **kw: dump_calls.append(a))

    process_video(source="https://youtu.be/x", title="t", db_mode=False, return_payload=True)
    assert dump_calls == []
```

**Verify the patch targets exist before running:**

```bash
grep -nE "^(def|class) (get_video_metadata|download_captions|generate_topic_map|extract_transcript_chunk|extract_visual_content_chunk)" pipeline/scripts/process_video_v2.py pipeline/src/extraction/topic_map.py 2>/dev/null
```

If any patch target lives in a different module (e.g., `generate_topic_map` may live in `src/extraction/topic_map.py` and be imported), use the import path that `process_video_v2` actually references — that's the module attribute the patch must target.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd pipeline && source .venv/bin/activate
python -m pytest tests/test_process_video_return_payload.py -v
```
Expected: FAIL — `ProcessResult` not defined, `return_payload` parameter doesn't exist.

- [ ] **Step 3: Add `ProcessResult` and the `return_payload` parameter**

In `pipeline/scripts/process_video_v2.py`:

```python
# near the top with other imports
from dataclasses import dataclass, field


@dataclass
class ProcessResult:
    """In-memory return shape for process_video when return_payload=True.
    Used by the CI eval runner to compare outputs without writing demo JSON.

    NOTE: visual_content_items is a list of DICTS (camelCase keys, matching
    what gets persisted to DB and demo JSON), NOT a list of Pydantic
    VisualContentItem instances. process_video builds the list as dicts via
    _build_content_meta(...) at lines ~488-500, so callers should expect
    dict items with keys: id, contentType, latex, description, start, end,
    confidence, sectionTitle, plus the camelCase content fields (textBlocks,
    code, headers, rows, title, caption, purpose, structure, language).
    Any caller doing item.model_dump() will crash with AttributeError."""
    visual_content_items: list[dict] = field(default_factory=list)
    transcript_segments: list[dict] = field(default_factory=list)
    sections: list[dict] = field(default_factory=list)
    duration: float = 0.0
```

**Important constraints from the actual code:**

- The current parameter is named `db_mode` (boolean), not `write_db`. Do NOT rename it — every caller in `worker.py:253,263`, the CLI at `process_video_v2.py:1050`, and `process_video.py:162` uses the existing name. Renaming silently breaks them at runtime.
- There is no `_persist_to_db()` or `_write_demo_json()` helper. The current `process_video` (line 634) does both inline: demo JSON write at line ~922-926, DB persistence at line ~928+. Insert the early return at the right point in the existing inline body — do NOT pretend helpers exist.
- Do NOT add a keyword-only `*` separator after `title`. The CLI at line 1050 calls `process_video(args.source, args.title, db_mode=args.db, ...)` — adding `*` would silently break it (the first two args remain positional, but any future positional addition could break callers).
- `visual_content` is built as a list of dicts at lines ~813-849 (the body of `process_video` constructs them via `_build_content_meta(item)` followed by dict assembly). The dataclass field types reflect this. The eval runner consumes these dicts directly (no `.model_dump()` call).

Add `return_payload` as a regular kwarg with a default. Insert the early-return block AFTER `visual_content_items` is fully built but BEFORE the demo-JSON write block (line 922) and the DB-persistence block (line 928). The exact insertion point is right after the chunk-loop completes and the structures are ready.

```python
# pipeline/scripts/process_video_v2.py — modify process_video at line 634
# Add return_payload parameter after the existing kwargs (preserves db_mode name and ordering):

def process_video(source: str, title: str | None = None,
                  db_mode: bool = False, run_id: str | None = None,
                  visual_content_mode: bool = True, model: str = DEFAULT_MODEL,
                  video_url: str | None = None,
                  return_payload: bool = False) -> "ProcessResult | None":
    """... existing docstring ...

    Args:
        return_payload: When True, return a ProcessResult with the in-memory
            extraction output AND skip the demo-JSON disk write. Used by the
            eval runner to score outputs without polluting viewer/public/demo/.
            db_mode and return_payload are mutually exclusive in practice;
            return_payload always wins (we return BEFORE the persist block).
    """
    # ... existing body unchanged through extraction loop ...
    # ... after `demo` dict and `segments`/`topic_map`/etc are built ...

    # NEW: early return for the eval-runner path. Skip both the demo JSON
    # write at line ~924 and the DB persistence block. Goes BEFORE either of
    # those blocks so neither side-effect runs.
    #
    # In process_video the local list is named `visual_content` (line 882),
    # NOT visual_content_items. Use the local name verbatim. Same for
    # `segments` (the merged transcript) and `topic_map` (the dict from
    # generate_topic_map). The dataclass field name doesn't have to match the
    # local — that's just the public API.
    if return_payload:
        return ProcessResult(
            visual_content_items=visual_content,
            transcript_segments=segments,
            sections=topic_map.get("sections", []),
            duration=duration,
        )

    # Save demo JSON (skip in db_mode — container may not have viewer/ dir)
    if not db_mode:
        output_path = Path(__file__).resolve().parents[2] / "viewer" / "public" / "demo" / f"{file_id}.json"
        with open(output_path, "w") as f:
            json.dump(demo, f, indent=2)

    # Save to DB if in db mode (existing block, unchanged)
    if db_mode and session and run and video_record:
        # ... existing DB persistence ...
```

**Locate the insertion point precisely** before applying the edit:

```bash
grep -n "Save demo JSON\|Save to DB if in db mode" pipeline/scripts/process_video_v2.py
```
Expected output points at lines ~922 and ~928. Insert the new `if return_payload:` block immediately above the first match. If your local copy has drifted, adjust accordingly — but the rule is "after structures are built, before any disk/DB side effect."

**Caller audit (no changes needed, just verify):** The four existing callers all pass `db_mode` by keyword:

```
pipeline/scripts/process_video_v2.py:1050   process_video(args.source, args.title, db_mode=args.db, run_id=args.run_id, ...)
pipeline/scripts/worker.py:253              process_video(source=..., title=..., db_mode=True, run_id=..., model=..., video_url=...)
pipeline/scripts/worker.py:263              process_video(source=..., title=..., db_mode=True, run_id=..., model=..., video_url=...)
pipeline/scripts/process_video.py:162       process_video(args.youtube_url, args.title)        # only first two positional, rest defaulted
```

None pass `db_mode` positionally. Adding `return_payload` at the end (after `video_url`) preserves all existing call signatures.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_process_video_return_payload.py -v
python -m pytest tests/ -v  # ensure no regressions
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/scripts/process_video_v2.py pipeline/tests/test_process_video_return_payload.py
git commit -m "feat(pipeline): add ProcessResult and return_payload flag for in-memory output"
```

#### Task 3.3: `eval_runner.py` — runs current pipeline against the test set, writes outputs

**Files:**
- Create: `pipeline/scripts/eval_runner.py`

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_eval_runner.py (new file)
from pathlib import Path
import json
from scripts.eval_runner import compare_outputs


def _item(content_type, **fields):
    """Build a baseline-shaped item (camelCase keys, matching what
    process_video persists). The eval runner's _validation_errors converts
    these to snake_case before passing to validators."""
    base = dict(contentType=content_type, discussed_start="0:00", discussed_end="0:05",
                confidence=1.0, description="", latex="", code="", language="", purpose="",
                structure=[], headers=[], rows=[], title="", caption="", textBlocks=[])
    base.update(fields)
    return base


def test_compare_outputs_no_diff_when_identical(tmp_path):
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    current = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    diff = compare_outputs(baseline, current)
    assert diff.regressions == []
    assert diff.improvements == []
    assert diff.unchanged is True


def test_compare_outputs_detects_validator_regression(tmp_path):
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "Title", "depth": 0}])]}
    current = {"items": [_item("text", textBlocks=[])]}
    diff = compare_outputs(baseline, current)
    assert any("text_blocks_empty" in r for r in diff.regressions)


def test_compare_outputs_correctly_reads_camelCase_textBlocks():
    """Regression test for the camelCase bug: validator must NOT false-positive
    on text items that have textBlocks populated (camelCase) but text_blocks
    absent (snake_case). This is the dominant baseline shape."""
    populated = _item("text", textBlocks=[{"kind": "paragraph", "text": "ok", "depth": 0}])
    baseline = {"items": [populated]}
    current = {"items": [populated]}
    diff = compare_outputs(baseline, current)
    # Both sides are identical AND both have valid text content → no regressions, no improvements
    assert diff.regressions == []
    assert diff.improvements == []


def test_compare_outputs_flags_50pct_count_drop_per_content_type():
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
    """Catches the chunk-level failure mode where a prompt change causes
    Gemini to return [] for chunks that previously had content."""
    baseline = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": str(i), "depth": 0}]) for i in range(50)]}
    current = {"items": [_item("text", textBlocks=[{"kind": "heading", "text": "x", "depth": 0}])]}
    diff = compare_outputs(baseline, current)
    assert any("total items" in r for r in diff.regressions)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_eval_runner.py -v
```
Expected: FAIL.

- [ ] **Step 3: Implement `eval_runner.py`**

```python
# pipeline/scripts/eval_runner.py
"""Run the current visual-content pipeline against the eval test set and
diff against committed baselines. Prints a regression report and exits
non-zero if any regressions are detected.

Usage:
    python scripts/eval_runner.py --capture        # write fresh baselines (use after intentional prompt bumps)
    python scripts/eval_runner.py --diff           # default: compare current run output to baselines
    python scripts/eval_runner.py --videos a,b,c   # restrict to specific video_ids
"""
from __future__ import annotations
import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from src.extraction.prompts import VISUAL_CONTENT_PROMPT_VERSION
from src.extraction.schemas import VisualContentItem
from src.extraction.validators import validate_item


REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_SET = REPO_ROOT / "eval" / "test_videos.json"
BASELINES_DIR = REPO_ROOT / "eval" / "baselines"


@dataclass
class Diff:
    regressions: list[str] = field(default_factory=list)
    improvements: list[str] = field(default_factory=list)
    unchanged: bool = True


# Tunable thresholds for "this swing is too big to be Gemini non-determinism."
COUNT_DROP_THRESHOLD = 0.30  # 30%+ drop per content_type → regression
TOTAL_DROP_THRESHOLD = 0.50  # 50%+ drop in total items → regression (catches chunk-loss)


def _validation_errors(items_payload: list[dict]) -> set[str]:
    """Return the set of validation rule names hit by this items list.

    CRITICAL — camelCase awareness: baselines are saved by `process_video`'s
    demo-JSON path which serializes items via `_build_content_meta` to camelCase
    (textBlocks, not text_blocks; same for code-related fields stay flat). The
    Pydantic VisualContentItem expects snake_case field names (text_blocks).
    Naive `model_construct(**raw)` would silently set text_blocks=[] (default)
    and ignore the camelCase textBlocks key — leading to false-positive
    validator hits across every text item in the baselines.

    Two-step fix:
      1. Convert camelCase keys back to snake_case before model_construct.
      2. Convert nested textBlocks dicts to TextBlock instances since
         model_construct skips coercion."""
    rules = set()
    for raw in items_payload:
        snake = _camel_to_snake_visual_item(raw)
        try:
            item = VisualContentItem.model_construct(**snake)
        except Exception:
            rules.add("schema_parse_error")
            continue
        for issue in validate_item(item):
            if issue.severity == "error":
                rules.add(issue.rule)
    return rules


# camelCase → snake_case key map for visual content items.
# Mirror of _CONTENT_META_FIELDS in process_video_v2.py — keep in sync if that
# changes. Only multi-word fields differ; single-word fields are identical.
_CAMEL_TO_SNAKE_VC = {
    "textBlocks": "text_blocks",
    "contentType": "content_type",
    # latex, description, code, language, purpose, structure, headers, rows,
    # title, caption, confidence, discussed_start/end already match — but
    # demo JSON also uses camelCase "discussedStart"/"discussedEnd" in some
    # contexts; verify by inspecting one baseline file before relying on this.
}


def _camel_to_snake_visual_item(raw: dict) -> dict:
    """Convert known camelCase keys to snake_case so VisualContentItem.
    model_construct populates the right attributes. Unknown keys are kept
    as-is (will be ignored by Pydantic as extra). textBlocks contents stay
    as dicts — model_construct doesn't coerce them, but our validator only
    checks `b.text` which works on either dict or TextBlock thanks to
    `getattr(b, 'text', b.get('text', '')) if isinstance(b, dict) else b.text`."""
    from src.extraction.schemas import TextBlock
    out = {_CAMEL_TO_SNAKE_VC.get(k, k): v for k, v in raw.items()}
    # Coerce textBlocks list-of-dicts to list-of-TextBlock so validator's
    # `(b.text or "").strip()` works without isinstance checks.
    if isinstance(out.get("text_blocks"), list):
        coerced = []
        for b in out["text_blocks"]:
            if isinstance(b, dict):
                coerced.append(TextBlock.model_construct(**b))
            else:
                coerced.append(b)
        out["text_blocks"] = coerced
    return out


def _counts_by_type(items_payload: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for raw in items_payload:
        # Baselines use camelCase contentType; live extraction outputs both.
        ct = raw.get("contentType") or raw.get("content_type", "unknown")
        counts[ct] = counts.get(ct, 0) + 1
    return counts


def compare_outputs(baseline: dict, current: dict) -> Diff:
    """Detect regressions across three signals:
      1. New validator rules firing (misplacement / empty primary fields).
      2. Per-content_type item-count drops > 30% (a prompt change that silently
         loses half the equations is a regression even if remaining items pass
         validation).
      3. Total item count collapse > 50% (catches chunk-level failure modes
         like a future schema or prompt change causing Gemini to return [];
         this is the regression mode KI-006 documents for the rejected
         discriminated-union approach).
    """
    diff = Diff()
    base_items = baseline.get("items", [])
    cur_items = current.get("items", [])

    # Signal 1: validator rule deltas
    base_rules = _validation_errors(base_items)
    cur_rules = _validation_errors(cur_items)
    new_rules = cur_rules - base_rules
    fixed_rules = base_rules - cur_rules
    diff.regressions.extend(sorted(f"new validation hit: {r}" for r in new_rules))
    diff.improvements.extend(sorted(f"resolved validation hit: {r}" for r in fixed_rules))

    # Signal 2: per-content_type count drops
    base_counts = _counts_by_type(base_items)
    cur_counts = _counts_by_type(cur_items)
    for ct, base_n in base_counts.items():
        cur_n = cur_counts.get(ct, 0)
        if base_n > 0 and (base_n - cur_n) / base_n > COUNT_DROP_THRESHOLD:
            pct = round((base_n - cur_n) / base_n * 100)
            diff.regressions.append(f"{ct} count dropped {pct}% ({base_n} → {cur_n})")

    # Signal 3: total item count collapse (chunk-loss detector)
    base_total = len(base_items)
    cur_total = len(cur_items)
    if base_total > 0 and (base_total - cur_total) / base_total > TOTAL_DROP_THRESHOLD:
        pct = round((base_total - cur_total) / base_total * 100)
        diff.regressions.append(f"total items dropped {pct}% ({base_total} → {cur_total}) — possible chunk-level extraction failure")

    diff.unchanged = not diff.regressions and not diff.improvements
    return diff


def baseline_path(video_id: str, prompt_version: str) -> Path:
    safe = prompt_version.replace("/", "_")
    return BASELINES_DIR / f"{video_id}__{safe}.json"


def load_baseline(video_id: str, prompt_version: str) -> dict | None:
    p = baseline_path(video_id, prompt_version)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def save_baseline(video_id: str, prompt_version: str, payload: dict) -> None:
    p = baseline_path(video_id, prompt_version)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, indent=2))


def run_one_video(video: dict) -> dict:
    """Run process_video_v2's visual-content extraction on this video and
    return {'items': [...]} as a JSON-serializable dict.

    Calls process_video with db_mode=False + return_payload=True so neither
    the DB nor the demo-JSON dir is touched.

    NOTE: result.visual_content_items is already a list of dicts (camelCase
    keys, as serialized by _build_content_meta in process_video_v2.py:69).
    Do NOT call .model_dump() on these dicts — they are not Pydantic
    instances and that would AttributeError. The dicts are JSON-serializable
    as-is."""
    from scripts.process_video_v2 import process_video as _pv
    result = _pv(
        source=video["youtube_url"],
        title=video["title"],
        db_mode=False,
        return_payload=True,
    )
    return {"items": list(result.visual_content_items)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--capture", action="store_true", help="Write fresh baselines from current outputs")
    p.add_argument("--diff", action="store_true", default=True, help="Compare current outputs to baselines (default)")
    p.add_argument("--videos", default="", help="Comma-separated video_ids to restrict the run")
    args = p.parse_args()

    test_set = json.loads(TEST_SET.read_text())
    if args.videos:
        wanted = set(args.videos.split(","))
        test_set = [v for v in test_set if v["video_id"] in wanted]

    prompt_version = VISUAL_CONTENT_PROMPT_VERSION
    print(f"Eval against prompt version {prompt_version}; {len(test_set)} videos")

    any_regression = False
    for v in test_set:
        try:
            current = run_one_video(v)
        except Exception as e:
            print(f"  {v['video_id']}: ERROR running pipeline: {e}")
            any_regression = True
            continue

        if args.capture:
            save_baseline(v["video_id"], prompt_version, current)
            print(f"  {v['video_id']}: captured baseline ({len(current['items'])} items)")
            continue

        baseline = load_baseline(v["video_id"], prompt_version)
        if baseline is None:
            print(f"  {v['video_id']}: NO BASELINE — run --capture first")
            continue

        diff = compare_outputs(baseline, current)
        if diff.unchanged:
            print(f"  {v['video_id']}: ✓ unchanged")
        else:
            for r in diff.regressions:
                print(f"  {v['video_id']}: ✗ {r}")
                any_regression = True
            for i in diff.improvements:
                print(f"  {v['video_id']}: ↑ {i}")

    sys.exit(1 if any_regression else 0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run unit test to verify it passes**

```bash
python -m pytest tests/test_eval_runner.py -v
```
Expected: PASS (the diff logic is unit-testable without running real videos).

- [ ] **Step 5: Capture baselines for current prompt version**

```bash
cd pipeline && source .venv/bin/activate
python scripts/eval_runner.py --capture
```
Expected: ~20 minutes of runtime (parallel-extraction × 20 videos), writes `eval/baselines/<video_id>__v0.4.0.json` for each. (PR 2 Task 2.9 bumped the version from v0.3.6 to v0.4.0; capture under the new version so the baselines reflect the prompt-hardened behavior.)

- [ ] **Step 6: Commit the baselines**

```bash
git add eval/baselines/*.json pipeline/scripts/eval_runner.py pipeline/tests/test_eval_runner.py
git commit -m "eval: capture baselines for prompt v0.3.6 across 20 test videos"
```

#### Task 3.4: Document the eval workflow

**Files:**
- Create: `eval/README.md`
- Modify: `CLAUDE.md` to point at the new doc

- [ ] **Step 1: Write `eval/README.md`**

```markdown
# Eval test set

Twenty production videos used as a regression seatbelt for prompt-version bumps.
Each baseline is the output of `process_video_v2.py`'s visual-content extraction
for one (video, prompt_version) pair.

## Workflow

When bumping `VISUAL_CONTENT_PROMPT_VERSION`:

1. Bump the version constant in `pipeline/src/extraction/prompts.py`.
2. Run the eval against the OLD baselines:
   ```bash
   cd pipeline && source .venv/bin/activate
   python scripts/eval_runner.py
   ```
   - Exit 0: no regressions (all videos either improved or unchanged).
   - Exit 1: at least one video has a new validation rule firing that didn't fire before. Review the report; decide whether to revert the prompt or capture the new behavior as the baseline.
3. If you accept the new behavior, capture fresh baselines:
   ```bash
   python scripts/eval_runner.py --capture
   git add eval/baselines/*.json
   git commit -m "eval: capture baselines for prompt vX.Y.Z"
   ```

## What counts as a regression

Three signals fire a regression. Improvements are also tracked but never block.

1. **New validator rules firing.** A video that didn't trip `code_in_text_blocks`
   in the baseline now does. Direct catch for the misplacement bug class.

2. **Per-content_type count drops > 30%.** A prompt change that silently produces
   half as many equations on a known-good video is suspicious even if the
   surviving equations are individually clean. Threshold avoids false positives
   on Gemini's stochastic ±10–20% output drift.

3. **Total item count drops > 50%.** Catches the chunk-level failure mode
   where any future schema or prompt change causes Gemini to return `[]` for
   a chunk that previously had content. (The discriminated-union refactor
   was empirically tested 2026-04-30 and ruled out for exactly this reason —
   31% chunk loss; see KI-006.)

What the diff intentionally does NOT flag: small count swings, content-text
edits, timestamp drift, or LaTeX-string differences. Those are normal Gemini
non-determinism and would produce false-positive alarms.

If you find yourself reading "X count dropped 35%" and shrugging because it's
within Gemini noise on this specific video, capture a fresh baseline (`--capture`)
to absorb the new floor. The eval is a *moving* baseline by design.

## Cost

Each eval run extracts visual content from 20 videos, ~10 minutes average each
at 0.5 FPS. Roughly $5–10 per `--capture` pass against current Gemini pricing.
Use Gemini's [Batch API](https://ai.google.dev/gemini-api/docs/batch-api) to
halve that when running CI on every PR — see followup work in the eval
followups doc.

## Test-set maintenance

Hand-picked test videos go stale. Bug classes we haven't seen yet (e.g., a
misclassification specific to a new lecture style) won't be in the set. Two
practices to keep the eval honest:

1. **Quarterly rotation.** Swap ~5 of the 20 videos every quarter for fresh
   production picks. Bias toward videos with diverse content_types and recent
   processing dates.
2. **Bug-driven additions.** Whenever a user reports an issue, add the affected
   video to the eval set as part of the fix PR. The next prompt change will
   then test against that exact failure mode. This is the cheapest way to
   prevent regressions of bugs you've already paid to find.
```

- [ ] **Step 2: Update CLAUDE.md to point at the new doc**

Add to the `## Docs` section:

```markdown
- `eval/README.md` — CI eval workflow for prompt-version bumps. Run before merging any prompt change.
```

- [ ] **Step 3: Commit**

```bash
git add eval/README.md CLAUDE.md
git commit -m "docs(eval): document CI eval workflow"
```

**End of PR 3.** Open as `feat(eval): CI eval set for prompt-version bumps (PR 3/3)`. Description should note: ships in two parts — the runner script (code-reviewable) and the baseline JSON snapshots (machine-generated; review only the diff metric, not the contents). Captures baselines under `v0.4.0` (the prompt-hardened version from PR 2 Task 2.9) — these baselines reflect the post-prompt-update behavior, not the legacy `v0.3.6` floor.

---

## Self-review checklist

After implementing, run through:

**Architecture / scope**
- [ ] All three PRs ship independently and can be reverted independently.
- [ ] Validators are pure functions (no I/O, no global state) — confirmed by tests using only constructed inputs.
- [ ] Repair pass never re-runs the video — confirmed by `repair_item` accepting only text inputs.
- [ ] No backfill of historical data (forward-only by user policy).
- [ ] Existing viewer fallbacks remain in place — they handle pre-fix data and any post-fix data the repair pass couldn't fully clean.
- [ ] KI-006 added to `docs/known-issues.md` documenting why discriminated-union refactor was ruled out (B.0 v3 chunk-loss data).

**Wiring / call-site count**
- [ ] FOUR call sites for `extract_visual_content_chunk` updated: `reprocess_section` (~391), `reprocess_visual_content` (~555), the `process_section` closure inside `process_video` (~764), plus any direct call inside `process_video`. The closure return tuple is now 5-element `(idx, sents, items, chunk_summary, section_title)`.
- [ ] `extract_visual_content_chunk` returns `(items, summary | None)` from EVERY path (success, repair-ran, all-retries-exhausted) — uniform tuple shape, no caller surprises.
- [ ] THREE persistence sites stamped with `repair_status` from `chunk_summary.statuses[idx]`: lines ~455 (`reprocess_section`), ~582 (`reprocess_visual_content`), ~952 (`process_video`).
- [ ] `process_video` parameter name preserved as `db_mode` (not `write_db`); `return_payload` added as last kwarg with default; no `*` separator added.

**Repair correctness**
- [ ] `RepairConfig.timeout_seconds` is wired into the SDK call via `types.HttpOptions(timeout=...)` — verified against the google-genai version (1.69+) in `pipeline/pyproject.toml`.
- [ ] `_make_client` uses `os.getenv("GEMINI_API_KEY")` to match the existing extraction-client style, not `os.environ[KEY]` which raises KeyError.
- [ ] Repair accepts strict improvement (fewer errors than before), not only zero-error results — partial fixes are net wins.
- [ ] `_REPAIR_SYSTEM` content is asserted by `test_repair_system_prompt_contains_invention_guard` so future edits don't silently drop the "do not invent" rule.

**Slack / dependencies**
- [ ] `notify_repair_summary` uses `urllib.request.urlopen` and Block Kit `{"blocks": [...]}` payload — matches existing `notify_pipeline_event` style.
- [ ] No `requests` dependency added to `pipeline/pyproject.toml`.
- [ ] Slack threshold counts both `failed` and `skipped` in the noise-suppression rate — perception-failure-only runs (skipped > 0, failed = 0) still surface above threshold.

**Eval-runner correctness**
- [ ] `eval_runner._validation_errors` converts camelCase baseline keys (`textBlocks`, `contentType`) to snake_case before `model_construct` — otherwise every text item is a false-positive `text_blocks_empty`.
- [ ] `eval_runner.run_one_video` does NOT call `.model_dump()` on `result.visual_content_items` — those are already dicts (from `_build_content_meta`); calling `.model_dump()` would AttributeError.
- [ ] Eval runs do NOT pollute `viewer/public/demo/` — `process_video(return_payload=True)` returns BEFORE the demo-JSON `json.dump` call.
- [ ] Eval baselines captured under prompt version `v0.4.0` (post Task 2.9 prompt hardening), not the legacy `v0.3.6`.

**Migration safety**
- [ ] Migration uses `CREATE INDEX CONCURRENTLY` inside an AUTOCOMMIT-isolated connection — safe to run during live extraction.

**Prompt hardening**
- [ ] `VISUAL_CONTENT_SYSTEM_PROMPT` includes the FIELD PLACEMENT RULES section explicitly listing where each content_type's primary content goes.
- [ ] `VISUAL_CONTENT_USER_PROMPT` includes 2-3 few-shot examples covering the textBlocks anti-pattern.
- [ ] `VISUAL_CONTENT_PROMPT_VERSION` bumped to v0.4.0; PR 3 captures fresh baselines under that version.

## Operational notes (acknowledged tradeoffs, not bugs)

**KI-006 — Discriminated-union schema causes 31% chunk-loss rate on Gemini 3 Flash Preview (verified 2026-04-30).**

The original plan included a Half B that would refactor `VisualContentItem` into a Pydantic discriminated union with `min_length=1` constraints on primary fields, gated on a 30-min A/B verification. We ran the verification against the user-reported failure case (DSC30, https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC) across 13 × 10-min windows and found:

| Metric | Flat | Discriminated |
|---|---|---|
| Total items | 112 | 82 |
| Total broken items | 18 | 0 |
| Broken-item rate | 16.1% | 0.0% |
| **Chunks lost (chunk_survived=False)** | 0/13 | **4/13 (31%)** |

In the 9 surviving chunks, discriminated produces 82 items / 0 broken vs flat's 72 items / 7 broken — a per-item-quality win of ~17 items. But in the 4 lost chunks, discriminated produces 0 items vs flat's 40 items (8 broken, 32 useful). Net: discriminated trades +17 quality items for −32 entire-content losses. **Strict regression.**

Mechanism: Gemini doesn't emit empty strings for description; it omits the field entirely. Pydantic's `min_length=1` constraint becomes "Field required" → whole-chunk parse failure → production returns `[]` for that chunk. The strict schema isn't *causing* Gemini to behave worse; it's exposing behavior that flat silently absorbs via `Field(default="")`. Adjacent reading: §1.2 of the [structured-output reasoning analysis](#) — Tam et al. on JSON-schema-constrained reasoning degradation — explains why dispatch-style models struggle with conditional field constraints.

Empirical categorization of the prod DSC30 run (e5ac668c, run 2026-04-29) found **95.2% of broken items are misplacement** (content correctly generated but routed to `textBlocks` instead of `description`/`code`/etc.), only 4.8% are perception failures. The PR 2 text-only repair pass mechanically rewrites the dominant bug class at ~$0.0003 per item — substantially cheaper and more reliable than the schema redesign.

**If Gemini behavior changes** (model GA enables true decode-time field-routing rather than rejection), re-run `pipeline/scripts/verify_discriminated_union_v2.py` (the throwaway script from B.0; now archived for re-running). Triggers to re-evaluate: PR 2's repair rate drops below 90% for misplacement bugs, OR Gemini API release notes mention discriminated-union improvements, OR a quiet sprint with appetite for a 3-5 day schema migration.

**KI-007 — Nested-schema "describe-first-then-classify" approach as future research.**

The §1.2 reasoning-degradation literature suggests an alternative: `visual_observation: str` (free-form, no constraints) → `content_type: Literal[...]` (now reasoned-from) → `payload: Annotated[Union[...], discriminator="kind"]` (still type-constrained). Theoretically improves classification quality by giving Gemini a scratchpad. NOT in scope for this plan because:
- Output token budget concern (10-20% more tokens per item → closer to truncation; we already saw a JSON truncation failure in B.0 v3 at the 78KB mark on a 10-min chunk)
- Still suffers the "Gemini omits fields under strict constraints" failure mode at the payload level
- Significant migration cost (schema, viewer types, eval baselines)
- Cheaper alternative — Task 2.9 prompt engineering — addresses the same mechanism with a prompt update

Revisit if Task 2.9's prompt hardening + PR 2 repair don't move the bug rate below ~5% in production over 30 days.

**Cancellation latency under repair.** `_update_run_progress` is the cancellation checkpoint, called between chunks — repair runs INSIDE a chunk. A user clicking "cancel" on the dashboard waits for in-flight repairs × `RepairConfig.timeout_seconds` before the chunk returns. With the 30s default and 5 chunks in `ThreadPoolExecutor`, worst-case cancellation latency is ~150s if every chunk has in-flight repairs. Acceptable because (a) the timeout is bounded, (b) repair is a small fraction of total chunk time, (c) the user can refresh and see the cancelled state once the chunk does return. If cancellation responsiveness becomes a complaint, lower `timeout_seconds` to 15s — repair on a small JSON object should never take longer than that anyway.

**Cost claim verification.** Flash-Lite at the time of this plan: $0.10/M input + $0.40/M output. Repair prompts are bounded (~1.2K input, ~500 output) → ~$0.0003 per call. Verify against `https://ai.google.dev/pricing` before merging PR 2. Even at 5× the assumed cost, a bad-extraction lecture (50 misplacements × $0.005) stays under a dollar.

**Eval test set rotation.** Hand-picked test videos go stale. Add to `eval/README.md`: "Rotate ~5 of the 20 videos every quarter, especially after any user-reported issue lands a new failure mode. Newly-curated videos should always include the recent issue's video." The DSC30 video that triggered yesterday's user-visible failure should be the FIRST in the test set — it's our regression-prevention canary going forward.

**`worker.py` lazy-import safety.** The worker does `from scripts.process_video_v2 import process_video, reprocess_section` lazily inside its dispatch loop. This means the new `return_payload` parameter and `ProcessResult` dataclass are loaded at first job execution, not at worker startup. If you ever add a positional arg before `db_mode`, the worker will fail at runtime, not boot. The current change (kwarg added last) is safe.

**`fix_latex_escapes` not run on repair output.** `process_video_v2.py:822` runs `fix_latex_escapes(item.latex)` after extraction. The repair pass returns a new item; if a future repair rule touches `latex`, that output bypasses the escape fixer. Not relevant today (current repair rules target `code` / `description` / `textBlocks` routing, not `latex` content). Worth a `# TODO: re-run fix_latex_escapes if repair touches latex` comment in `repair_item` for the next person.

**`inspect_run.py` DB URL precedence.** The script resolves `args.db_url or os.getenv("RAILWAY_DB_URL") or os.getenv("DATABASE_URL")` at line 57 — `RAILWAY_DB_URL` wins if both are set. The migration verification command in Task 2.1 uses `$DATABASE_URL`; if you run with both env vars set, behavior may diverge. Match the inspect_run order or use the railway-ssh path documented in `docs/investigating-outputs.md`.

---

## Execution choices

Plan complete and saved to `docs/superpowers/plans/2026-04-29-validators-and-repair.md`. Three PRs, ~3.5 days of focused work with AI-assisted coding. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit for the per-task TDD discipline this plan uses.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Recommended sequencing:**
- Day 1: PR 1 (validators, ~0.5 day) — ship and merge before PR 2 starts (PR 2 imports validators).
- Day 2-3: PR 2 (repair + worker integration + DB index + Slack + inspect_run + prompt hardening). Land in one PR but commit task-by-task; the integration test in Task 2.6 catches the closure / call-site issues early.
- Day 4: PR 3 (eval set + baselines). Capture under v0.4.0 (post Task 2.9 prompt update).

**Pre-flight checklist before starting:**
- [ ] Confirm `google-genai` SDK version in `pipeline/pyproject.toml` exposes `types.HttpOptions` (1.69+ does — verified 2026-04-30)
- [ ] Confirm `gemini-3-flash-lite` model name is current (default for `REPAIR_MODEL`); if Gemini renames, update `get_repair_model_name()` default
- [ ] Confirm B.0 verification scripts (`pipeline/scripts/verify_discriminated_union.py`, `verify_discriminated_union_v2.py`, `verify_discriminated_union_v2_results.json`) are removed or moved to `pipeline/scripts/archive/` before merging — they were throwaway tools and should not ship in PR 2

**Which approach?**
