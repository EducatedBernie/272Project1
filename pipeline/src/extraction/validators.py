"""Per-content-type validators for VisualContentItem.

Validators are pure functions that take a parsed item and return a list of
ValidationIssue objects. They never raise during normal pipeline parsing —
the worker calls them after Gemini's structural validation succeeds, then
routes repairable issues to the repair pass.

Layer 2 of the validate→repair→viewer-fallback defense stack. The dominant
bug class observed in prod (95% of broken items) is misplacement: Gemini
emits items with content_type='diagram_description' (or 'code', 'other')
but puts the description content in textBlocks instead of description (or
the code text in textBlocks instead of the code field). validate_* functions
detect these patterns and mark them repairable=True so the repair pass can
move the content to the right field via a cheap Flash-Lite call.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Literal

from src.extraction.schemas import VisualContentItem


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


def validate_code(item: VisualContentItem) -> list[ValidationIssue]:
    """code items must have non-empty `code`. Repairable iff content lives
    elsewhere on the item (text_blocks) — Gemini's known misplacement pattern."""
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


def validate_text(item: VisualContentItem) -> list[ValidationIssue]:
    """text items must have non-empty text_blocks. Repairable iff description
    is set instead (Gemini misplaced text content into description)."""
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


def validate_equation(item: VisualContentItem) -> list[ValidationIssue]:
    """equation items must have non-empty latex. No fallback in our schema —
    if latex is empty, it's a perception/extraction failure."""
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


def validate_table(item: VisualContentItem) -> list[ValidationIssue]:
    """table items must have both headers and rows. Empty either way is a
    perception failure — table cells can't be reconstructed from text."""
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


def validate_diagram_or_chart(item: VisualContentItem) -> list[ValidationIssue]:
    """diagram_description / chart_description items must have a non-empty
    description. Misplacement into text_blocks/title/caption/purpose/structure
    is the dominant bug class in prod (~163/187 broken items in DSC30); those
    cases are flagged repairable=True so the repair pass can move content."""
    if item.content_type not in ("diagram_description", "chart_description"):
        return []
    if item.description.strip():
        return []

    has_textblock_content = any((b.text or "").strip() for b in item.text_blocks)
    has_title_or_caption = bool((item.title or "").strip() or (item.caption or "").strip())
    has_purpose = bool((item.purpose or "").strip())
    has_structure = any(s.strip() for s in item.structure)

    if has_textblock_content or has_title_or_caption or has_purpose or has_structure:
        return [ValidationIssue(
            rule=f"{item.content_type}_misplaced",
            message=f"content_type='{item.content_type}' has empty description but content lives in text_blocks/title/caption/purpose/structure — Gemini misplaced the description",
            severity="error",
            repairable=True,
        )]
    return [ValidationIssue(
        rule=f"{item.content_type}_empty",
        message=f"content_type='{item.content_type}' has empty description — likely perception failure (Gemini didn't see the content clearly)",
        severity="error",
        repairable=False,
    )]


def validate_other(item: VisualContentItem) -> list[ValidationIssue]:
    """other items must have a non-empty description. Misplacement into
    text_blocks/title/caption is repairable; full emptiness is a perception
    failure."""
    if item.content_type != "other":
        return []
    if item.description.strip():
        return []

    has_textblock_content = any((b.text or "").strip() for b in item.text_blocks)
    has_title_or_caption = bool((item.title or "").strip() or (item.caption or "").strip())

    if has_textblock_content or has_title_or_caption:
        return [ValidationIssue(
            rule="other_content_in_other_fields",
            message="content_type='other' has empty description but content lives in text_blocks/title/caption — Gemini misplaced the description",
            severity="error",
            repairable=True,
        )]
    return [ValidationIssue(
        rule="other_description_empty",
        message="content_type='other' has fully empty description, text_blocks, title, and caption",
        severity="error",
        repairable=False,
    )]


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
