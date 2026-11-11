# Prompt Determinism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten all Gemini prompts for structural determinism — same video, same prompt, same output shape across runs. Fix pipeline drift where v2 isn't using the full transcript prompt.

**Architecture:** Hybrid approach. Schema changes for `table`, `code`, `text` (bake determinism into type system). Prompt rules + templates + examples for `equation`, `diagram_description`, `chart_description`, `other` (prose). Viewer renders new schema fields as semantic HTML with fallback to `description` for old JSONs.

**Tech Stack:** Python 3.12, Pydantic 2, pytest; TypeScript, Next.js 15, React 19; Gemini 3 Flash Preview via `google-genai` SDK.

**Spec:** [`docs/superpowers/specs/2026-04-23-prompt-determinism-design.md`](../specs/2026-04-23-prompt-determinism-design.md)

**Deployment note:** This project auto-deploys to Railway on `git push origin main`. Tasks are ordered so the viewer ships forward-compat BEFORE the pipeline starts producing new-shape output. No intermediate broken state for in-flight renders.

---

## File Structure

**Pipeline (Python)** — one responsibility per file, matches existing pattern:
- `pipeline/src/extraction/schemas.py` — Pydantic models. Adds `TextBlock`, expands `VisualContentItem`.
- `pipeline/src/extraction/prompts.py` — all prompt strings + version constants. Adds `TOPIC_MAP_PROMPT`, rewrites `EQUATIONS_USER_PROMPT` + `VISUAL_CONTENT_USER_PROMPT`.
- `pipeline/src/extraction/topic_map.py` — imports prompt from `prompts.py` instead of inlining.
- `pipeline/scripts/process_video_v2.py` — imports and uses `TRANSCRIPT_SYSTEM_PROMPT`/`TRANSCRIPT_USER_PROMPT`.
- `pipeline/tests/test_schemas.py` — NEW test file for schema validation.
- `pipeline/tests/test_prompts.py` — NEW test file for prompt smoke checks.

**Viewer (TypeScript)**:
- `viewer/lib/types.ts` — add `TextBlock` interface, expand `VisualContent`.
- `viewer/components/TextBlocks.tsx` — NEW component rendering structured text blocks.
- `viewer/components/GroupedEquations.tsx` — update `code`/`table` branches, add `other` and `text` rendering.

**Docs:**
- `docs/decisions.md` — append validation note after 3-run test.

---

## Task 1: Schema Changes — `TextBlock` + `VisualContentItem` fields

**Files:**
- Create: `pipeline/tests/test_schemas.py`
- Modify: `pipeline/src/extraction/schemas.py`

- [ ] **Step 1: Write failing tests for new schema fields**

Create `pipeline/tests/test_schemas.py`:

```python
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
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd pipeline && python -m pytest tests/test_schemas.py -v`
Expected: FAIL — `TextBlock` not importable, `VisualContentItem` missing new fields.

- [ ] **Step 3: Update `pipeline/src/extraction/schemas.py`**

Add imports and `TextBlock` class, expand `VisualContentItem`:

```python
"""Pydantic models for Gemini structured output."""

from typing import Literal
from pydantic import BaseModel, Field


class TopicSection(BaseModel):
    start_time: str = Field(description="Start timestamp in MM:SS format")
    end_time: str = Field(description="End timestamp in MM:SS format")
    title: str = Field(description="Short title for this section")
    description: str = Field(description="One sentence description of this section")


class TopicMapOutput(BaseModel):
    summary: str = Field(description="One-line description of what the lecture covers")
    sections: list[TopicSection] = Field(description="Ordered list of topic sections covering the entire lecture")


class TranscriptSegmentOutput(BaseModel):
    text: str = Field(description="The transcribed speech for this segment")
    start_time: str = Field(description="Start timestamp in MM:SS format")
    end_time: str = Field(description="End timestamp in MM:SS format")


class TranscriptExtractionOutput(BaseModel):
    segments: list[TranscriptSegmentOutput] = Field(
        description="Ordered list of transcript segments with timestamps"
    )


class SentenceOutput(BaseModel):
    text: str = Field(description="One transcribed sentence with inline LaTeX where applicable")


class SentenceListOutput(BaseModel):
    sentences: list[SentenceOutput] = Field(
        description="Ordered list of transcribed sentences"
    )


class EquationOutput(BaseModel):
    latex: str = Field(description="LaTeX representation of the equation")
    description: str = Field(
        description="Natural language description of the equation for accessibility alt-text"
    )
    discussed_start: str = Field(
        description="Start timestamp (MM:SS) when this equation is actively being written or discussed"
    )
    discussed_end: str = Field(
        description="End timestamp (MM:SS) when discussion of this equation ends"
    )
    confidence: float = Field(
        description="Confidence score from 0.0 to 1.0 for the accuracy of the LaTeX extraction"
    )


class EquationExtractionOutput(BaseModel):
    equations: list[EquationOutput] = Field(
        description="List of equations extracted from the video"
    )


class TextBlock(BaseModel):
    kind: Literal["heading", "paragraph", "bullet"] = Field(
        description="Block kind: heading (title on the slide), paragraph (running text), bullet (list item)"
    )
    text: str = Field(description="The text content, with inline $...$ for math")
    depth: int = Field(
        default=0,
        description="Nesting depth for bullets. 0 = top-level bullet, 1 = sub-bullet. Always 0 for heading/paragraph."
    )


class VisualContentItem(BaseModel):
    content_type: str = Field(
        description="Type of visual content: equation, code, table, chart_description, diagram_description, text, or other"
    )
    description: str = Field(
        default="",
        description="Natural language description for accessibility. Primary content for equation (as alt-text), diagram_description, chart_description, and other. Leave empty for text, table, code — their dedicated fields carry the content."
    )
    discussed_start: str = Field(
        description="Start timestamp (MM:SS) when this content is actively being written or displayed"
    )
    discussed_end: str = Field(
        description="End timestamp (MM:SS) when this content stops being actively presented"
    )
    confidence: float = Field(
        description="Confidence score from 0.0 to 1.0 for the accuracy of the extraction"
    )
    latex: str = Field(default="", description="LaTeX representation. Only for content_type 'equation'")
    code: str = Field(default="", description="The code text, verbatim. Only for content_type 'code'")
    language: str = Field(default="", description="Programming language (lowercase). Only for content_type 'code'")
    purpose: str = Field(default="", description="ONE sentence stating what the code does. Only for content_type 'code'")
    structure: list[str] = Field(default_factory=list, description="Ordered list of high-level code blocks. Only for content_type 'code'")
    headers: list[str] = Field(default_factory=list, description="Column headers. Only for content_type 'table'")
    rows: list[list[str]] = Field(default_factory=list, description="Table data rows. Only for content_type 'table'")
    title: str = Field(default="", description="Table title/heading as written. Only for content_type 'table'")
    caption: str = Field(default="", description="ONE sentence stating what the table shows. Only for content_type 'table'")
    text_blocks: list[TextBlock] = Field(default_factory=list, description="Structured text blocks. Only for content_type 'text'")


class VisualContentExtractionOutput(BaseModel):
    items: list[VisualContentItem] = Field(
        description="List of visual content items extracted from the video"
    )
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd pipeline && python -m pytest tests/test_schemas.py -v`
Expected: all 10 tests PASS.

- [ ] **Step 5: Verify old schema consumers still work**

Run: `cd pipeline && python -c "from src.extraction.schemas import VisualContentExtractionOutput, EquationOutput; print('ok')"`
Expected: `ok`

Run: `cd pipeline && python -m pytest tests/ -v`
Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/extraction/schemas.py pipeline/tests/test_schemas.py
git commit -m "feat(schemas): add TextBlock + title/caption/purpose/structure/text_blocks to VisualContentItem"
```

---

## Task 2: Add Granularity Rule to `EQUATIONS_USER_PROMPT`

**Files:**
- Modify: `pipeline/src/extraction/prompts.py`
- Create: `pipeline/tests/test_prompts.py`

- [ ] **Step 1: Write failing test for prompt version + granularity keyword**

Create `pipeline/tests/test_prompts.py`:

```python
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
    assert prompts.VISUAL_CONTENT_PROMPT_VERSION == "v0.3"


def test_visual_content_prompt_includes_seven_types():
    text = prompts.VISUAL_CONTENT_USER_PROMPT
    for t in ["equation", "text", "diagram_description", "chart_description", "table", "code", "other"]:
        assert t in text, f"content type '{t}' missing from VISUAL_CONTENT_USER_PROMPT"


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
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd pipeline && python -m pytest tests/test_prompts.py -v`
Expected: FAIL — version is v0.3 not v0.4, granularity keywords missing, seven types missing `other`, text_blocks missing, TOPIC_MAP_PROMPT missing.

- [ ] **Step 3: Update `EQUATIONS_PROMPT_VERSION` and add granularity rule to `EQUATIONS_USER_PROMPT`**

In `pipeline/src/extraction/prompts.py`, change:

```python
EQUATIONS_PROMPT_VERSION = "v0.3"
```

to:

```python
EQUATIONS_PROMPT_VERSION = "v0.4"
```

And replace the last bullet of `EQUATIONS_USER_PROMPT` (the one ending `"If the professor erases and rewrites, capture the new content as a new entry"`) with that bullet PLUS a new granularity section. The final prompt should end:

```python
EQUATIONS_USER_PROMPT = """Transcribe mathematical expressions that are ACTIVELY being written on the board in this lecture video segment.

This is for accessibility — a blind student needs to know what the professor is writing RIGHT NOW.

Requirements:
- Only extract equations that are being ACTIVELY WRITTEN by the speaker in this segment
- Do NOT extract equations that are merely visible on the board from earlier in the lecture. Old work left on the board is not relevant
- If the professor is not writing any equations in this segment (e.g. doing a demonstration, telling a story, taking questions), return an EMPTY list. Zero equations is a valid answer
- Transcribe every line of an active derivation — including intermediate steps, substitutions, and partial work
- Do NOT skip steps in an active derivation. If the professor writes 5 lines, extract all 5
- Convert each line to LaTeX notation
- For each entry, provide the timestamp range when it is being actively written
- Provide a natural language description for screen reader alt-text
- Confidence scores (0.0-1.0) must reflect how clearly you can SEE the content, not how confident you are in your interpretation:
  → 0.9-1.0: content is crisp and fully legible
  → 0.7-0.9: readable but some details unclear (small text, slight blur)
  → 0.5-0.7: blurry, partially obscured, or inferred from context
  → Below 0.5: mostly guessing
  If the video is old, low-resolution, or the board is hard to read, your confidence MUST reflect that
- If the professor erases and rewrites, capture the new content as a new entry

GRANULARITY: one written line = one entry.
If the professor writes $F = ma$, substitutes to get $F = 5 \\cdot 2$, then simplifies to $F = 10$, that is THREE entries — never one. Never combine multiple lines into a compound `latex` string. Each entry's `latex` field contains exactly what was on ONE line of the board. The `discussed_start` / `discussed_end` timestamps are for that one line.

Good: three entries, latex = "F = ma", latex = "F = 5 \\cdot 2", latex = "F = 10".
Bad: one entry, latex = "F = ma = 5 \\cdot 2 = 10"."""
```

- [ ] **Step 4: Run the equations-related tests, confirm they pass**

Run: `cd pipeline && python -m pytest tests/test_prompts.py::test_equations_prompt_version_bumped tests/test_prompts.py::test_equations_prompt_includes_granularity_rule -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/prompts.py pipeline/tests/test_prompts.py
git commit -m "feat(prompts): add granularity rule to equations prompt (v0.4)"
```

---

## Task 3: Rewrite `VISUAL_CONTENT_USER_PROMPT` — 7 types, templates, examples

**Files:**
- Modify: `pipeline/src/extraction/prompts.py`

- [ ] **Step 1: Bump `VISUAL_CONTENT_PROMPT_VERSION`**

Change `VISUAL_CONTENT_PROMPT_VERSION = "v0.2"` to `VISUAL_CONTENT_PROMPT_VERSION = "v0.3"`.

- [ ] **Step 2: Replace `VISUAL_CONTENT_USER_PROMPT` wholesale**

Replace the entire `VISUAL_CONTENT_USER_PROMPT = """..."""` block with:

```python
VISUAL_CONTENT_USER_PROMPT = """Transcribe ALL visual content that is ACTIVELY being written or displayed on the board or slides in this lecture video segment.

This is for accessibility — a blind student needs to read EXACTLY what a sighted student sees. Do NOT summarize or paraphrase. Transcribe verbatim.

Content types to extract:

1. **equation** — Mathematical expressions, formulas, derivations being actively written.
   → Provide accurate LaTeX in the `latex` field.
   → GRANULARITY: one written line = one entry. If the professor writes $F = ma$, substitutes to $F = 5 \\cdot 2$, simplifies to $F = 10$, that is THREE entries — never one. Never combine lines into a compound latex string like "F = ma = 5 \\cdot 2 = 10".
   → Fill `description` with a one-sentence alt-text for screen readers.
   → Leave other type-specific fields empty.

2. **text** — Written text on the board or slides that is NOT a standalone equation, diagram, chart, table, or code. Bullet points, definitions, procedures, lists, titles, labels, written notes.
   → Fill `text_blocks` with one block per visually distinct unit:
     • titles → kind="heading"
     • running sentences → kind="paragraph"
     • bulleted items → kind="bullet" (use depth=1 for sub-bullets, 0 for top-level)
   → Transcribe every word VERBATIM inside each block's `text`.
   → Inline math: wrap in $...$ within the block's text. Example: "the formal charge $FC = V - L - B/2$".
   → Leave `description` empty — `text_blocks` is the content.
   → NO markdown in `text` (no **bold**, no *italic*, no # headings). The block `kind` carries structure.

   Example for a whiteboard showing "Warm-Up" title + question + three bullets:
   text_blocks = [
     {"kind": "heading", "text": "Warm-Up", "depth": 0},
     {"kind": "paragraph", "text": "How would you know if any of these are true?", "depth": 0},
     {"kind": "bullet", "text": "There are infinitely many primes", "depth": 0},
     {"kind": "bullet", "text": "Every even $\\#>2$ is the sum of two primes", "depth": 0},
     {"kind": "bullet", "text": "Your code never gets stuck in an infinite loop", "depth": 0}
   ]

3. **diagram_description** — Structural diagrams: Lewis structures, molecular diagrams, circuit diagrams, flowcharts, geometric constructions.
   → Begin the `description` with one sentence identifying the diagram: "A {type} diagram of {subject}."
   → Then list elements in numbered form: "Elements: (1) {element} — {position/relationship}. (2) {element} — {position/relationship}. ..."
   → List every labeled element, bond, arrow, and annotation.
   → Use inline $...$ for symbols and labels: "Elements: (1) Central carbon $C$ with four bonds. (2) Hydrogen $H$ above."
   → Do NOT render the diagram as LaTeX. The `description` field IS the content.

4. **chart_description** — Graphs, plots, bar charts, phase diagrams, data visualizations.
   → Format `description` in this FIXED ORDER: "A {chart type} showing {subject}. X-axis: {label} in {unit}, range {min} to {max}. Y-axis: {label} in {unit}, range {min} to {max}. Data: {trend or key values}."
   → If ranges aren't visible, write "range not labeled". Never invent values.
   → Use inline $...$ for units and variable names: "X-axis: temperature $T$ in Kelvin, range $0$ to $500$."

5. **table** — Data tables being drawn or displayed.
   → Fill `title` with the heading as written above the table, or "" if no title.
   → Fill `headers` with exact column labels, in order.
   → Fill `rows` with exact cell values, one list per row, in written order.
   → Fill `caption` with ONE sentence stating what the table shows. Format: "{Type} of {subject} across {categories}." Examples: "Comparison of boiling points across three solvents." "Truth table for the XOR operation on two inputs."
   → Leave `description` empty.
   → Do NOT editorialize, summarize trends, or explain meaning in the caption — that belongs in the transcript.

6. **code** — Code snippets, pseudocode, or algorithms being written or shown.
   → Fill `code` with the snippet VERBATIM. Preserve every space, tab, newline, and symbol. Include every line, even for long snippets (50+ lines).
   → Fill `language` with the language name in lowercase: python, javascript, c, cpp, java, pseudocode, etc.
   → Fill `purpose` with ONE sentence stating what the code does. Format: "{Verb}s {object} using {method}." Examples: "Computes the factorial of n using recursion." "Iterates through a list and returns the first element greater than threshold."
   → Fill `structure` with an ordered list of imperative phrases, one per top-level block, in order of appearance. Example for a 30-line function:
     ["Function signature taking n and threshold",
      "Input validation raising ValueError if n < 0",
      "For loop iterating over range(n)",
      "If-statement comparing element to threshold",
      "Return statement for matched element",
      "Return None fallback"]
   → Leave `description` empty.

7. **other** — Visual content that genuinely does NOT fit any of the six types above. Examples: photographs (lab setup, historical artifact), screenshots, maps, timelines, physical models, demonstration apparatus held up to the camera.
   → Use this ONLY when no other type fits. Do NOT use as a catch-all for ambiguous content — pick the closest primary type first. If a whiteboard sketch has math, it's `equation` or `diagram_description`. If a slide has bullet points, it's `text`. `other` is reserved for non-board content.
   → Fill `description` with this format: "A {media type} showing {subject}. Contents: (1) {element}. (2) {element}. ..."
   → Example: "A photograph showing a laboratory setup for measuring heat capacity. Contents: (1) Calorimeter on the bench. (2) Thermometer inserted in the lid. (3) Hot plate to the left."

Requirements:
- Only extract content that is being ACTIVELY WRITTEN or DISPLAYED in this segment
- Do NOT extract content that is merely visible on the board from earlier in the lecture
- If the professor is not presenting any visual content (e.g. speaking without writing, doing a physical demonstration, taking questions), return an EMPTY list
- NEVER summarize or paraphrase. Transcribe exactly what is shown
- Confidence scores (0.0-1.0) must reflect how clearly you can SEE the content, not how confident you are in your interpretation:
  → 0.9-1.0: content is crisp and fully legible
  → 0.7-0.9: content is readable but some details are unclear (small text, slight blur)
  → 0.5-0.7: content is blurry, partially obscured, or you are inferring from context rather than reading directly
  → Below 0.5: you are mostly guessing
  If the video is old, low-resolution, or the board is hard to read, your confidence MUST reflect that
- If the professor erases and rewrites, capture the new content as a new entry"""
```

- [ ] **Step 3: Run the visual-content-related tests, confirm they pass**

Run: `cd pipeline && python -m pytest tests/test_prompts.py::test_visual_content_prompt_version_bumped tests/test_prompts.py::test_visual_content_prompt_includes_seven_types tests/test_prompts.py::test_visual_content_prompt_has_text_blocks_guidance tests/test_prompts.py::test_visual_content_prompt_has_table_fields tests/test_prompts.py::test_visual_content_prompt_has_code_fields -v`
Expected: all 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add pipeline/src/extraction/prompts.py
git commit -m "feat(prompts): rewrite VISUAL_CONTENT prompt with 7 types, templates, examples (v0.3)"
```

---

## Task 4: Extract `TOPIC_MAP_PROMPT` to `prompts.py` and tighten

**Files:**
- Modify: `pipeline/src/extraction/prompts.py`
- Modify: `pipeline/src/extraction/topic_map.py`

- [ ] **Step 1: Add `TOPIC_MAP_PROMPT` + version to `prompts.py`**

Append to the end of `pipeline/src/extraction/prompts.py`:

```python


TOPIC_MAP_PROMPT_VERSION = "v0.2"

TOPIC_MAP_PROMPT = """Here is a timestamped transcript of a STEM lecture ({duration_mins} minutes long).

Analyze it and produce:
1. A one-line summary of what the lecture covers
2. A list of topic sections with boundaries

Rules for sections:
- Each section should be between 3 and 10 minutes long
- If a topic runs longer than 10 minutes, split it into sub-sections
- Every minute of the lecture must belong to exactly one section
- Sections must cover the entire lecture with no gaps
- Each section needs: start_time (MM:SS), end_time (MM:SS), title, description

Style rules:
- Title: Title Case, no trailing period, ≤ 50 characters. Do NOT use phrases like "Introduction to" or "Overview of" — just the topic.
- Description: exactly one sentence, ≤ 20 words. Declarative, not a question.

Output as JSON:
{{
  "summary": "One-line lecture description",
  "sections": [
    {{
      "start_time": "0:00",
      "end_time": "5:30",
      "title": "Section title",
      "description": "One sentence description"
    }}
  ]
}}

Transcript:
{transcript}"""
```

(Note: double-braces `{{` and `}}` preserve the literal JSON braces when the `.format(...)` call substitutes `duration_mins` and `transcript`.)

- [ ] **Step 2: Update `topic_map.py` to import and use `TOPIC_MAP_PROMPT`**

In `pipeline/src/extraction/topic_map.py`, add the import near the top:

```python
from src.extraction.prompts import TOPIC_MAP_PROMPT
```

Then replace the inline `prompt = f"""..."""` block (currently lines 78-105) with:

```python
    prompt = TOPIC_MAP_PROMPT.format(
        duration_mins=duration_mins,
        transcript=transcript,
    )
```

- [ ] **Step 3: Run topic-map prompt tests, confirm they pass**

Run: `cd pipeline && python -m pytest tests/test_prompts.py::test_topic_map_prompt_exists_and_versioned tests/test_prompts.py::test_topic_map_prompt_has_title_style_rule -v`
Expected: both PASS.

- [ ] **Step 4: Smoke-check the format call doesn't break**

Run: `cd pipeline && python -c "from src.extraction.prompts import TOPIC_MAP_PROMPT; print(TOPIC_MAP_PROMPT.format(duration_mins=60, transcript='[0:00] hello')[:200])"`
Expected: prints the first 200 chars of a formatted prompt with `60` and `hello` substituted.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/extraction/prompts.py pipeline/src/extraction/topic_map.py
git commit -m "refactor(topic_map): move prompt to prompts.py, add title/description style rules (v0.2)"
```

---

## Task 5: Fix v2 Transcript Drift

**Files:**
- Modify: `pipeline/scripts/process_video_v2.py`

- [ ] **Step 1: Write failing test for imports**

Append to `pipeline/tests/test_prompts.py`:

```python
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
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `cd pipeline && python -m pytest tests/test_prompts.py::test_process_video_v2_imports_real_transcript_prompts -v`
Expected: FAIL — imports not present.

- [ ] **Step 3: Update imports in `process_video_v2.py`**

At `pipeline/scripts/process_video_v2.py:36-41`, change:

```python
from src.extraction.prompts import (
    EQUATIONS_SYSTEM_PROMPT, EQUATIONS_USER_PROMPT,
    EQUATIONS_PROMPT_VERSION, TRANSCRIPT_PROMPT_VERSION,
    VISUAL_CONTENT_SYSTEM_PROMPT, VISUAL_CONTENT_USER_PROMPT,
    VISUAL_CONTENT_PROMPT_VERSION,
)
```

to:

```python
from src.extraction.prompts import (
    EQUATIONS_SYSTEM_PROMPT, EQUATIONS_USER_PROMPT,
    EQUATIONS_PROMPT_VERSION, TRANSCRIPT_PROMPT_VERSION,
    TRANSCRIPT_SYSTEM_PROMPT, TRANSCRIPT_USER_PROMPT,
    VISUAL_CONTENT_SYSTEM_PROMPT, VISUAL_CONTENT_USER_PROMPT,
    VISUAL_CONTENT_PROMPT_VERSION,
)
```

- [ ] **Step 4: Replace `extract_transcript_chunk` body**

At `pipeline/scripts/process_video_v2.py:170-206`, replace:

```python
def extract_transcript_chunk(client, url: str, start: float, end: float, context: str, model: str = DEFAULT_MODEL, fps: float = 1.0):
    """Extract transcript for one topic section."""
    prompt = f"""{context}

Transcribe everything spoken in this video segment into sentences.
When the speaker references a mathematical expression, render it as LaTeX wrapped in dollar signs.
Do NOT include timestamps — timestamps will be added separately.
Do NOT skip any spoken content. Do NOT add words that were not spoken.
Do NOT include any analysis, commentary, speaker identification, or topic labels — ONLY the spoken words.
Use the visual content on the board to inform the correct LaTeX representation."""

    for attempt in range(3):
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps,
                    start_offset=f"{int(start)}s",
                    end_offset=f"{int(end)}s",
                ),
            )
            from src.extraction.schemas import SentenceListOutput
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=prompt)]),
                config=types.GenerateContentConfig(
                    system_instruction="You are a precise speech transcription system for STEM lectures.",
                    response_mime_type="application/json",
                    response_schema=SentenceListOutput,
                ),
            )
            parsed = SentenceListOutput.model_validate(response.parsed)
            return [fix_latex_escapes(s.text.strip()) for s in parsed.sentences if s.text.strip()]
        except Exception as e:
            logger.warning(f"    Transcript chunk error: {e}, retry {attempt+1}")
            time.sleep(2)
    return []
```

with:

```python
def extract_transcript_chunk(client, url: str, start: float, end: float, context: str, model: str = DEFAULT_MODEL, fps: float = 1.0):
    """Extract transcript for one topic section using the full v0.3 transcript prompt."""
    system = f"{TRANSCRIPT_SYSTEM_PROMPT}\n\n{context}"

    for attempt in range(3):
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps,
                    start_offset=f"{int(start)}s",
                    end_offset=f"{int(end)}s",
                ),
            )
            from src.extraction.schemas import SentenceListOutput
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=TRANSCRIPT_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=SentenceListOutput,
                ),
            )
            parsed = SentenceListOutput.model_validate(response.parsed)
            return [fix_latex_escapes(s.text.strip()) for s in parsed.sentences if s.text.strip()]
        except Exception as e:
            logger.warning(f"    Transcript chunk error: {e}, retry {attempt+1}")
            time.sleep(2)
    return []
```

- [ ] **Step 5: Run tests, confirm pass**

Run: `cd pipeline && python -m pytest tests/test_prompts.py -v`
Expected: all PASS (including the new `test_process_video_v2_imports_real_transcript_prompts`).

- [ ] **Step 6: Syntax check the script**

Run: `cd pipeline && python -c "import ast; ast.parse(open('scripts/process_video_v2.py').read()); print('ok')"`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add pipeline/scripts/process_video_v2.py pipeline/tests/test_prompts.py
git commit -m "fix(v2): wire up TRANSCRIPT_SYSTEM_PROMPT + TRANSCRIPT_USER_PROMPT, drop inline drift"
```

---

## Task 6: Viewer — Expand `VisualContent` Type + Add `TextBlock`

**Files:**
- Modify: `viewer/lib/types.ts`

- [ ] **Step 1: Add `TextBlock` interface and expand `VisualContent`**

In `viewer/lib/types.ts`, replace the existing `VisualContent` interface (and add `TextBlock` above it):

```typescript
export interface TextBlock {
  kind: "heading" | "paragraph" | "bullet";
  text: string;
  depth: number; // 0 = top-level, 1 = sub-bullet
}

export interface VisualContent {
  id: string;
  contentType: string;
  description: string;
  confidence: number;
  start: number;
  end: number;
  latex?: string;
  code?: string;
  language?: string;
  purpose?: string;
  structure?: string[];
  headers?: string[];
  rows?: string[][];
  title?: string;
  caption?: string;
  textBlocks?: TextBlock[];
  section?: string;
}
```

Keep `Equation`, `Segment`, `AnchoredSegment`, etc. unchanged.

- [ ] **Step 2: Verify TS compilation**

Run: `cd viewer && npx tsc --noEmit`
Expected: no new errors (pre-existing errors, if any, are unchanged).

- [ ] **Step 3: Commit**

```bash
git add viewer/lib/types.ts
git commit -m "feat(viewer/types): add TextBlock + purpose/structure/title/caption/textBlocks to VisualContent"
```

---

## Task 7: Viewer — `TextBlocks` Component

**Files:**
- Create: `viewer/components/TextBlocks.tsx`

- [ ] **Step 1: Create `TextBlocks.tsx`**

Create `viewer/components/TextBlocks.tsx`:

```tsx
import type { TextBlock } from "@/lib/types";
import RichText from "@/components/RichText";

/**
 * Renders structured text blocks from VisualContent (content_type='text') as
 * semantic HTML. Consecutive 'bullet' blocks are grouped into a single <ul>,
 * with nested <ul> for depth > 0. Accessible navigation for screen readers.
 */
export default function TextBlocks({ blocks }: { blocks: TextBlock[] }) {
  if (!blocks || blocks.length === 0) return null;

  const rendered: React.ReactNode[] = [];
  let bulletBuffer: TextBlock[] = [];

  const flushBullets = (key: string) => {
    if (bulletBuffer.length === 0) return;
    rendered.push(renderBulletList(bulletBuffer, key));
    bulletBuffer = [];
  };

  blocks.forEach((b, i) => {
    if (b.kind === "bullet") {
      bulletBuffer.push(b);
      return;
    }
    flushBullets(`ul-${i}`);
    if (b.kind === "heading") {
      rendered.push(
        <h3 key={`h-${i}`} className="text-base font-semibold mt-2 mb-1" style={{ color: "var(--foreground)" }}>
          <RichText text={b.text} />
        </h3>
      );
    } else {
      // paragraph
      rendered.push(
        <p key={`p-${i}`} className="text-sm leading-relaxed my-1" style={{ color: "var(--foreground)" }}>
          <RichText text={b.text} />
        </p>
      );
    }
  });
  flushBullets(`ul-end`);

  return <div>{rendered}</div>;
}

function renderBulletList(bullets: TextBlock[], key: string): React.ReactNode {
  // Split into groups by depth. Simple approach: render as nested <ul>
  // where each depth increase opens a new nested list.
  //
  // For the common case (all depth=0 or a single level of nesting), this
  // produces a clean <ul><li>...<ul><li>...</li></ul>...</li></ul>.
  const items: React.ReactNode[] = [];
  let i = 0;
  while (i < bullets.length) {
    const b = bullets[i];
    if (b.depth === 0) {
      // Collect subsequent deeper bullets as children
      const children: TextBlock[] = [];
      let j = i + 1;
      while (j < bullets.length && bullets[j].depth > 0) {
        children.push(bullets[j]);
        j++;
      }
      items.push(
        <li key={`li-${i}`} className="text-sm leading-relaxed">
          <RichText text={b.text} />
          {children.length > 0 ? renderBulletList(children.map(c => ({ ...c, depth: c.depth - 1 })), `ul-${i}-nest`) : null}
        </li>
      );
      i = j;
    } else {
      // Stray deep bullet with no parent — render at current level
      items.push(
        <li key={`li-${i}`} className="text-sm leading-relaxed">
          <RichText text={b.text} />
        </li>
      );
      i++;
    }
  }
  return (
    <ul key={key} className="list-disc pl-5 my-1" style={{ color: "var(--foreground)" }}>
      {items}
    </ul>
  );
}
```

- [ ] **Step 2: Verify TS compilation**

Run: `cd viewer && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add viewer/components/TextBlocks.tsx
git commit -m "feat(viewer): add TextBlocks component for structured text rendering"
```

---

## Task 8: Viewer — Update `GroupedEquations.tsx` Branches

**Files:**
- Modify: `viewer/components/GroupedEquations.tsx`

- [ ] **Step 1: Read the current structure**

Open `viewer/components/GroupedEquations.tsx` and locate the render branches near line 119 (code), line 130 (table), line 155 (else / default). These are inside a larger conditional chain.

- [ ] **Step 2: Add import for `TextBlocks`**

Near the top of the file, add:

```tsx
import TextBlocks from "@/components/TextBlocks";
```

- [ ] **Step 3: Update the `code` branch**

Find the current `code` branch starting at `item.contentType === "code" && item.code ? (` and replace with:

```tsx
) : item.contentType === "code" && item.code ? (
  <div>
    {item.language && (
      <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--muted-fg)" }}>
        {item.language}
      </span>
    )}
    {item.purpose && (
      <p className="text-xs italic mt-1" style={{ color: "var(--muted-fg)" }}>{item.purpose}</p>
    )}
    <pre className="mt-1 text-sm font-mono overflow-x-auto whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>
      <code>{item.code}</code>
    </pre>
    {item.structure && item.structure.length > 0 ? (
      <details className="mt-1">
        <summary className="text-xs cursor-pointer" style={{ color: "var(--muted-fg)" }}>Structure ({item.structure.length} blocks)</summary>
        <ol className="list-decimal ml-5 text-xs mt-1" style={{ color: "var(--muted-fg)" }}>
          {item.structure.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </details>
    ) : null}
  </div>
```

- [ ] **Step 4: Update the `table` branch**

Find the current `table` branch starting at `item.contentType === "table" && item.headers && item.rows ? (` and replace with:

```tsx
) : item.contentType === "table" && item.headers && item.rows ? (
  <div className="overflow-x-auto">
    {item.title && (
      <h4 className="text-sm font-semibold mb-1" style={{ color: "var(--foreground)" }}>{item.title}</h4>
    )}
    <table className="min-w-full text-sm">
      <thead>
        <tr>
          {item.headers.map((h, i) => (
            <th key={i} className="px-2 py-1 text-left text-xs font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {item.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} className="px-2 py-1 text-xs" style={{ borderBottom: "1px solid var(--border)" }}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    <p className="text-xs mt-1" style={{ color: "var(--muted-fg)" }}>{item.caption || item.description}</p>
  </div>
```

- [ ] **Step 5: Add `text` branch BEFORE the default fallback**

Find the final else branch that renders `<RichText text={item.description} />` (around line 155-160). Insert a new branch BEFORE it:

```tsx
) : item.contentType === "text" && item.textBlocks && item.textBlocks.length > 0 ? (
  <div>
    <TextBlocks blocks={item.textBlocks} />
  </div>
```

This means the branch order becomes: `equation (has latex)` → `code (has code)` → `table (has headers+rows)` → `text (has textBlocks)` → default (description).

The default fallback handles `text` items from old JSONs (no `textBlocks`), plus `diagram_description`, `chart_description`, and `other` (all of which use `description` as primary content).

- [ ] **Step 6: Verify TS compilation and build**

Run: `cd viewer && npx tsc --noEmit`
Expected: no new errors.

Run: `cd viewer && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Visual smoke check**

Run: `cd viewer && npm run dev` in a background terminal. Open `http://localhost:3000/video/iw72Yj_pJGs` (or any demo video). Confirm:
- Old demo JSONs still render (tables show with description as caption fallback, code shows without purpose/structure).
- No console errors.

Stop the dev server with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add viewer/components/GroupedEquations.tsx
git commit -m "feat(viewer): render code purpose/structure, table title/caption, text_blocks"
```

---

## Task 9: End-to-End Validation + Docs Note

**Files:**
- Modify: `docs/decisions.md`

- [ ] **Step 1: Run pipeline 3 times on reference video**

Pick `iw72Yj_pJGs` (L'Hopital's lecture, 112 min — known variance case per CLAUDE.md). For each run, use a distinct output path to compare:

```bash
cd pipeline
source .venv/bin/activate  # or however the venv is activated
python scripts/process_video_v2.py "https://www.youtube.com/watch?v=iw72Yj_pJGs" --output-path ../viewer/public/demo/_determinism_run1.json
python scripts/process_video_v2.py "https://www.youtube.com/watch?v=iw72Yj_pJGs" --output-path ../viewer/public/demo/_determinism_run2.json
python scripts/process_video_v2.py "https://www.youtube.com/watch?v=iw72Yj_pJGs" --output-path ../viewer/public/demo/_determinism_run3.json
```

If the script doesn't accept `--output-path`, check the actual flag with `python scripts/process_video_v2.py --help` and adjust. If outputs go to a fixed path, rename after each run:

```bash
python scripts/process_video_v2.py "https://www.youtube.com/watch?v=iw72Yj_pJGs"
mv ../viewer/public/demo/iw72Yj_pJGs.json ../viewer/public/demo/_determinism_run1.json
# repeat for runs 2 and 3
```

Expected: 3 JSON files produced, each ~5-10 min of wall time.

- [ ] **Step 2: Compare the three outputs**

Use `jq` to extract structural stats. Run for each file:

```bash
for f in ../viewer/public/demo/_determinism_run*.json; do
  echo "=== $f ==="
  jq '{
    sections: (.sections | length),
    equations: (.equations | length),
    visual: (.visualContent | length),
    tables_with_title: ([.visualContent[] | select(.contentType=="table" and .title != "")] | length),
    tables_with_caption: ([.visualContent[] | select(.contentType=="table" and .caption != "")] | length),
    code_with_purpose: ([.visualContent[] | select(.contentType=="code" and .purpose != "")] | length),
    code_with_structure: ([.visualContent[] | select(.contentType=="code" and (.structure | length > 0))] | length),
    text_with_blocks: ([.visualContent[] | select(.contentType=="text" and (.textBlocks | length > 0))] | length),
    equations_multi_step_latex: ([.equations[] | select(.latex | test("=.*=.*="))] | length)
  }' "$f"
done
```

Record the output. Expected:
- `sections`: identical across all 3 runs (topic map is low-variance text-only call).
- `equations`: within ±10% of median.
- `equations_multi_step_latex`: ≤ 1 per run (rule should catch these).
- Every `table` has `title` and `caption` non-empty → `tables_with_title` and `tables_with_caption` both equal total table count.
- Every `code` has `purpose` and `structure` non-empty → same relationship.
- Every `text` has `textBlocks` non-empty.

- [ ] **Step 3: If any run fails the ship gate, iterate**

**Ship gate conditions:**
- Equation count variance > ±10%: granularity rule isn't landing. Strengthen the rule with more examples.
- Multi-step latex appears: add a bad-example counter-pattern to the prompt.
- Missing `title`/`caption`/`purpose`/`structure`/`textBlocks` fills: prompt isn't being followed. Check if the model is hitting the field, or returning empty.

Iterate on the prompt, re-run just the one failing case, re-check. Don't merge until gate passes.

- [ ] **Step 4: Clean up temp files**

```bash
rm ../viewer/public/demo/_determinism_run*.json
```

- [ ] **Step 5: Append validation note to `docs/decisions.md`**

Append to `docs/decisions.md`:

```markdown

## Prompt determinism v2 — before/after variance (2026-04-23)

**Context:** Same video (iw72Yj_pJGs, L'Hopital's lecture) run 3x with the v0.4 equations prompt and v0.3 visual content prompt.

**Before (v0.3 equations, v0.2 visual):** <fill in counts from a recent run of the old prompts, if available, or note "baseline not measured">

**After (v0.4 / v0.3):**
- Sections: <n> (identical across all 3 runs)
- Equations: <n>, <n>, <n> (variance: <%>)
- Equations with multi-step latex (anti-pattern): <n>, <n>, <n>
- Tables: <n> — all populated title + caption
- Code: <n> — all populated purpose + structure
- Text items: <n> — all populated textBlocks

**Verdict:** <ship / needs iteration>
```

Fill in the actual numbers from Step 2.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions.md
git commit -m "docs: record prompt determinism v2 validation results"
```

---

## Task 10: Final Push to Main

**Files:** none

- [ ] **Step 1: Re-run the full pipeline test suite one more time**

Run: `cd pipeline && python -m pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 2: Re-run viewer typecheck + build**

Run: `cd viewer && npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 3: Verify git state is clean and branch is main**

Run: `git status && git branch --show-current`
Expected: working tree clean, on `main`.

- [ ] **Step 4: Push**

```bash
git push origin main
```

Expected: Railway auto-deploy triggers for both web and worker services.

- [ ] **Step 5: Smoke-test production after deploy settles**

Wait ~3-5 min for Railway build. Then run:

```bash
python pipeline/scripts/smoke_test.py --base-url <railway-url> --password $PASS
```

Expected: quick-mode smoke test passes (env, connectivity, enqueue, worker claims within 30s).

---

## Self-Review

**Spec coverage:**
- Schema: `TextBlock` class + 6 new fields on `VisualContentItem` → Task 1 ✓
- Equations granularity rule → Task 2 ✓
- Visual content 7-type rewrite → Task 3 ✓
- Topic map move + tightening → Task 4 ✓
- v2 transcript drift fix → Task 5 ✓
- Viewer types + TextBlock interface → Task 6 ✓
- Viewer TextBlocks component → Task 7 ✓
- Viewer GroupedEquations updates (code, table, text, fallbacks for diagram/chart/other) → Task 8 ✓
- Validation (3-run + docs note) → Task 9 ✓
- Version bumps (v0.4 equations, v0.3 visual, v0.2 topic map, transcript unchanged) → Tasks 2, 3, 4 ✓

**Placeholder scan:** None. Every step has exact code, exact commands, expected outputs.

**Type consistency:**
- Python: `TextBlock.kind` is `Literal["heading", "paragraph", "bullet"]` in Task 1 and referenced consistently in Task 3 prompt.
- TypeScript: `TextBlock.kind` is `"heading" | "paragraph" | "bullet"` in Task 6 — matches Python.
- Field names: `text_blocks` (Python) ↔ `textBlocks` (TypeScript, camelCase) — this mapping is the existing pattern (`content_type` ↔ `contentType`). Consistent.
- `purpose`, `structure`, `title`, `caption` — same name in Python and TS (already camelCase-compatible).
- `depth` field on `TextBlock` is `int` in Python, `number` in TS. Consistent.

**Gaps:** None identified.
