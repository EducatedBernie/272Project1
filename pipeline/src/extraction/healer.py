"""Deterministic post-extraction healer for known misplacement patterns.

95%+ of broken items in prod are content-routed to the wrong field — not
truly missing. The fix is mechanical: take the content from where Gemini
put it, move it to where it belongs. No LLM call needed.

Replaces the Flash-Lite repair pass (src.extraction.repair, deleted in
PR 2) after empirical validation showed deterministic rules handle every
misplacement pattern observed in prod (DSC30 run e5ac668c) and in the
v0.5.0 measurements.

Healer rules MUST mirror validator rules — every error-severity rule
flagged repairable by validators.py has a corresponding heal action here.
The validator/healer coverage test in test_healer.py enforces this
contract; if you add a new repairable validator rule, add a matching heal
branch or that test fails.
"""
from __future__ import annotations
from dataclasses import dataclass, field

from src.extraction.schemas import TextBlock, VisualContentItem
from src.extraction.validators import validate_item


def heal(item: VisualContentItem) -> tuple[VisualContentItem, str | None]:
    """Apply a deterministic heal rule based on content_type and which fields
    are populated. Returns (item, status) where status is 'fixed' (rule
    applied) or None (no applicable rule — perception failure or already
    clean). Never raises; never makes network calls.
    """
    ct = item.content_type

    # code_in_text_blocks: source code routed to text_blocks instead of `code`.
    if ct == "code" and not item.code.strip():
        text = "\n".join(b.text for b in item.text_blocks if (b.text or "").strip())
        if text:
            return item.model_copy(update={"code": text, "text_blocks": []}), "fixed"
        return item, None  # perception failure (code_field_empty)

    # text_blocks_empty_description_set: text item where Gemini put the
    # content into description instead of text_blocks. Note: this collapses
    # to a single paragraph — heading/bullet structure is lost if Gemini
    # intended one. Acceptable tradeoff under v0.5.0 because describe-first
    # reduces this case to near-zero in practice.
    if ct == "text" and not any((b.text or "").strip() for b in item.text_blocks):
        if (item.description or "").strip():
            return item.model_copy(update={
                "text_blocks": [TextBlock(kind="paragraph", text=item.description, depth=0)],
                "description": "",
            }), "fixed"
        return item, None  # perception failure (text_blocks_empty)

    # {diagram,chart}_description_misplaced: prose routed to text_blocks /
    # title+caption / purpose+structure. Probe in priority order matching
    # the prod-observed frequency (text_blocks dominates at 163/178 cases).
    if ct in ("diagram_description", "chart_description") and not item.description.strip():
        tb_text = " ".join(b.text for b in item.text_blocks if (b.text or "").strip())
        if tb_text:
            return item.model_copy(update={"description": tb_text, "text_blocks": []}), "fixed"
        tc_text = " ".join(t for t in (item.title, item.caption) if (t or "").strip())
        if tc_text:
            return item.model_copy(
                update={"description": tc_text, "title": "", "caption": ""}
            ), "fixed"
        ps_parts: list[str] = []
        if (item.purpose or "").strip():
            ps_parts.append(item.purpose)
        ps_parts.extend(s for s in item.structure if s.strip())
        if ps_parts:
            return item.model_copy(update={
                "description": " ".join(ps_parts),
                "purpose": "",
                "structure": [],
            }), "fixed"
        return item, None  # perception failure ({chart,diagram}_description_empty)

    # other_content_in_other_fields: validator only flags text_blocks /
    # title / caption for `other` (purpose/structure are code-only on this
    # path). Mirror that scope here.
    if ct == "other" and not item.description.strip():
        tb_text = " ".join(b.text for b in item.text_blocks if (b.text or "").strip())
        if tb_text:
            return item.model_copy(update={"description": tb_text, "text_blocks": []}), "fixed"
        tc_text = " ".join(t for t in (item.title, item.caption) if (t or "").strip())
        if tc_text:
            return item.model_copy(
                update={"description": tc_text, "title": "", "caption": ""}
            ), "fixed"
        return item, None  # perception failure (other_description_empty)

    # No applicable heal rule: equation/table perception failures aren't
    # repairable from text alone (latex/headers/rows can't be reconstructed),
    # and clean items pass through unchanged.
    return item, None


@dataclass
class HealSummary:
    """Result of a batch heal pass over a list of items.

    items:    new list (parallel index to original); each entry is either
              the original item (no heal attempted, or no rule matched) or
              the healed item (status='fixed').
    statuses: parallel to items; values are 'fixed' / 'skipped' / None.
              'fixed' means a rule applied; 'skipped' means an error was
              flagged but no heal rule matched (perception failure); None
              means the item was already clean.
              Used by persistence sites to stamp content_metadata.repair_status.
    """
    items: list[VisualContentItem]
    statuses: list[str | None] = field(default_factory=list)
    healed_count: int = 0
    skipped_count: int = 0

    def __post_init__(self):
        if not self.statuses:
            self.statuses = [None] * len(self.items)


def heal_run_items(items: list[VisualContentItem]) -> HealSummary:
    """Run validate→heal across a list of items. Returns a HealSummary
    where summary.items[idx] is either the original item (clean or no
    rule matched) or the healed item, with summary.statuses[idx] set to
    'fixed' / 'skipped' / None accordingly.

    Synchronous, deterministic, runs in microseconds — no client, no
    transcript context, no network call.
    """
    summary = HealSummary(items=list(items), statuses=[None] * len(items))
    for idx, item in enumerate(items):
        errors = [i for i in validate_item(item) if i.severity == "error"]
        if not errors:
            continue
        healed, status = heal(item)
        if status == "fixed":
            summary.items[idx] = healed
            summary.statuses[idx] = "fixed"
            summary.healed_count += 1
        else:
            summary.statuses[idx] = "skipped"
            summary.skipped_count += 1
    return summary
