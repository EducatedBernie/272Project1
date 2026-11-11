# Describe-first prompt + deterministic healer

**Goal:** Reduce visual-content misplacement from the current ~7% (under prompt v0.4.0) to <1% by combining a schema-level reasoning lever (`visual_observation` emitted before `content_type`) with a deterministic post-extraction healer. Replaces the Flash-Lite repair pass that shipped in PR 2 of the validators-and-repair plan.

## Empirical grounding (verified 2026-05-01 on DSC30)

| Variant | Misplacement rate | Items | Notes |
|---|---|---|---|
| Production v0.3.6 (prompt before hardening) | 16.1% | 112 | The KI-006 baseline |
| Production v0.4.0 (FIELD PLACEMENT RULES + few-shot) | 7.1% | 99 | Currently shipped |
| EXP1 — rename `textBlocks` → `boardWriting` | 9.2% | 76 | Negative result; field-name doesn't drive the prior |
| EXP2 — describe-first (`visual_observation` field) | **4.4%** | 91 | **38% reduction; the lever** |
| EXP3 — text-content collapse to `body: str` | 18.5% | 92 | Strict regression; bug just relocates |

EXP2 is the only architectural change that empirically helps. The remaining ~4% misplacement is exclusively `diagram_description_misplaced` and `other_content_in_other_fields` — both deterministically rewritable without an LLM call.

The Flash-Lite repair pass currently shipped solves the same problem at much higher cost: ~$0.0003 per item × thousands of items, plus latency, plus retry/timeout/JSON-parse failure modes, plus ~800 LOC of mocking infrastructure. Deterministic healer does it in ~30 LOC with zero new failure modes.

## What we keep (already shipped, working)

- `pipeline/src/extraction/validators.py` + tests — telemetry layer, useful regardless of repair strategy
- `pipeline/src/extraction/prompts.py` v0.4.0 — the FIELD PLACEMENT RULES + few-shot examples did real work (16.1% → 7.1%)
- `pipeline/scripts/eval_runner.py` + `eval/` — regression seatbelt for prompt-version bumps; this plan's PR 1 will trigger a baseline recapture
- `pipeline/scripts/inspect_run.py` — `repair_status` columns work for both LLM-repair and deterministic-healer; field name is generic enough

## What this plan deletes

- `pipeline/src/extraction/repair.py` and `pipeline/tests/test_repair.py` — the LLM repair pass
- `notify_repair_summary` in `pipeline/src/notifications/slack.py` and `pipeline/tests/test_slack_repair.py` — the threshold-suppression logic was for a per-item-API-call cost model that doesn't apply to deterministic healing
- `pipeline/scripts/exp[123]_*.py` and their result JSONs — move to `pipeline/scripts/archive/` like the verify_discriminated_union scripts
- `_maybe_notify_repair` helper and the three call sites in `process_video_v2.py`
- The `idx_equations_repair_status` index migration — premature for the table size; healer doesn't need it. **Note**: leaving the index in place is also fine; dropping is optional cleanup.

## What stays the same about the wiring

The existing `extract_visual_content_chunk → (items, summary | None)` tuple shape stays. The existing `repair_status` stamp at the three persistence sites stays. We're swapping the engine that produces the summary, not the integration shape.

This means the wiring work in the previous plan's PR 2 (Task 2.6) is reused. The healer slots in where `repair_run_items` was called.

---

## PR 1: describe-first prompt + healer

### Add `visual_observation` field to the schema

`pipeline/src/extraction/schemas.py`:

```python
class VisualContentItem(BaseModel):
    visual_observation: str = Field(
        default="",
        description=(
            "1-2 sentence raw description of what is visible BEFORE classifying. "
            "Just describe: handwriting? printed text? a table grid? a diagram with "
            "arrows? raw symbols? Do NOT classify yet. If you can't see clearly, "
            "say so. This field exists to force reasoning before commitment to "
            "content_type."
        ),
    )
    content_type: str = Field(...)
    # ...rest of fields unchanged...
```

Pydantic field declaration order = JSON emission order under structured-output, so `visual_observation` lands first in Gemini's output. That's the whole mechanism.

`default=""` keeps backwards compatibility for old data that lacks the field.

### Bump prompt to v0.5.0

`pipeline/src/extraction/prompts.py`:

- Add a "REASONING ORDER (NEW)" section to `VISUAL_CONTENT_SYSTEM_PROMPT` after the existing `FIELD PLACEMENT RULES`. Content adapted from [exp2_describe_first.py](pipeline/scripts/exp2_describe_first.py)'s system prompt.
- Add a "REMINDER ON FIELD ORDER" tail to `VISUAL_CONTENT_USER_PROMPT` instructing Gemini to emit `visual_observation` first.
- Update `VISUAL_CONTENT_PROMPT_VERSION = "v0.5.0"`.
- Update the prompt-version contract test to expect `v0.5`.

### Add deterministic healer

`pipeline/src/extraction/healer.py` (new, ~30 LOC):

```python
"""Deterministic post-extraction healer for known misplacement patterns.

95%+ of broken items in prod are content-routed to the wrong field — not
truly missing. The fix is mechanical: take the content from where Gemini
put it, move it to where it belongs. No LLM call needed.

Replaces the Flash-Lite repair pass after empirical validation showed
deterministic rules handle every misplacement pattern observed in prod
(DSC30 run e5ac668c) and in the v0.4.0 + EXP2 measurements.
"""
from src.extraction.schemas import VisualContentItem


def heal(item: VisualContentItem) -> tuple[VisualContentItem, str | None]:
    """Returns (item, status) where status is 'fixed' or None.

    Mirrors the validate_* rule names so post-heal validation can confirm
    each rule's content was successfully moved.
    """
    ct = item.content_type

    # code_in_text_blocks: code in textBlocks → code field
    if ct == "code" and not item.code.strip():
        text = "\n".join(b.text for b in item.text_blocks if (b.text or "").strip())
        if text:
            return item.model_copy(update={"code": text, "text_blocks": []}), "fixed"

    # diagram_description / chart_description / other: prose in textBlocks/title/
    # caption/purpose/structure → description field
    if ct in ("diagram_description", "chart_description", "other") and not item.description.strip():
        # Try textBlocks first (most common pattern in prod, 163/178 cases)
        tb_text = " ".join(b.text for b in item.text_blocks if (b.text or "").strip())
        if tb_text:
            return item.model_copy(update={"description": tb_text, "text_blocks": []}), "fixed"
        # Then title/caption (the other-misplacement pattern)
        tc_text = " ".join(t for t in [item.title, item.caption] if (t or "").strip())
        if tc_text:
            return item.model_copy(update={"description": tc_text, "title": "", "caption": ""}), "fixed"
        # Then purpose/structure (rare for diagram_description)
        if ct == "diagram_description":
            ps = item.purpose or " ".join(item.structure)
            if ps.strip():
                return item.model_copy(update={"description": ps}), "fixed"

    # text item with description set but text_blocks empty: rare under v0.5.0
    # but possible. Move description into a single paragraph block.
    if ct == "text" and not any((b.text or "").strip() for b in item.text_blocks):
        if item.description.strip():
            from src.extraction.schemas import TextBlock
            return item.model_copy(update={
                "text_blocks": [TextBlock(kind="paragraph", text=item.description, depth=0)],
                "description": "",
            }), "fixed"

    return item, None
```

`pipeline/tests/test_healer.py` (~50 LOC): pure-function tests covering each healed pattern + the no-op case. No mocking, no fixtures — just `assert heal(broken_item)[0].description == "expected"`.

### Add `heal_run_items` batch wrapper

Inline in `healer.py` or as a separate function. Returns the same `RepairSummary`-shape we already use, so the wiring at the three persistence sites stays unchanged:

```python
@dataclass
class HealSummary:
    items: list[VisualContentItem]
    statuses: list[str | None] = field(default_factory=list)
    healed_count: int = 0
    skipped_count: int = 0  # items with errors no rule handles (perception failures)

    def __post_init__(self):
        if not self.statuses:
            self.statuses = [None] * len(self.items)


def heal_run_items(items: list[VisualContentItem]) -> HealSummary:
    summary = HealSummary(items=list(items), statuses=[None] * len(items))
    from src.extraction.validators import validate_item
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
```

### Swap the engine inside `extract_visual_content_chunk`

In `pipeline/scripts/process_video_v2.py:283`, replace the `repair_run_items` call with `heal_run_items`. Drop the transcript-context lookup (deterministic healer doesn't use it). Update the import.

```python
from src.extraction.healer import heal_run_items, HealSummary

def extract_visual_content_chunk(...) -> tuple[list, HealSummary | None]:
    # ... extraction unchanged ...
    items = parsed.items
    needs_heal = any(any(i.severity == "error" for i in validate_item(it)) for it in items)
    if not needs_heal:
        return items, None
    summary = heal_run_items(items)
    if summary.healed_count or summary.skipped_count:
        logger.info(f"    Heal: fixed={summary.healed_count}, skipped={summary.skipped_count}")
    return summary.items, summary
```

The three call sites and three persistence sites need NO changes — they already unpack `(items, summary)` and read `summary.statuses[idx]` for content_metadata stamping. The summary object's shape is compatible.

### Verify

1. `pytest tests/` — should pass everything except `test_repair.py` and `test_slack_repair.py` (deleted in PR 2).
2. Smoke test: `python scripts/process_video_v2.py "https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC" --title "smoke v0.5" --no-db` — inspect the resulting demo JSON; spot-check that diagram_description items have non-empty descriptions.
3. Re-measure: adapt [scripts/measure_v040_misplacement.py](pipeline/scripts/measure_v040_misplacement.py) to load the current prompt (now v0.5.0) and run on DSC30. Expected: misplacement rate drops from 7.1% → ~3-4% at parse, then healer drops it to ~0%. Save results.

### Commit

`feat(prompt): describe-first reasoning + deterministic healer (v0.5.0)`

Single commit covering schema field, prompt update, healer module, healer tests, wiring swap, smoke-test results documented in commit message.

---

## PR 2: rip out the LLM repair scaffolding

Pure deletion. Nothing functional changes for the user — just removes dead code.

### Delete

- `pipeline/src/extraction/repair.py`
- `pipeline/tests/test_repair.py`
- `pipeline/tests/test_process_video_v2_repair_integration.py` (the LLM-mocked integration test; replaced by smoke test in PR 1)
- `pipeline/tests/test_slack_repair.py`
- `notify_repair_summary` + `SLACK_REPAIR_NOISE_THRESHOLD_*` constants from `pipeline/src/notifications/slack.py`
- `_maybe_notify_repair` helper from `pipeline/scripts/process_video_v2.py`
- The three `_maybe_notify_repair(...)` call sites in `process_video_v2.py`

### Move to archive

- `pipeline/scripts/exp1_rename_boardwriting.py`, `exp2_describe_first.py`, `exp3_text_collapse.py` and their result JSONs → `pipeline/scripts/archive/` (alongside the verify_discriminated_union scripts)
- Add a brief note to the existing `pipeline/scripts/archive/README.md` cataloguing what each tested

### Optional deletions (decide during execution)

- The `idx_equations_repair_status` index migration: harmless; deletion is housekeeping. Skip unless you want a fully clean slate. If kept, the column it indexes (`content_metadata->>'repair_status'`) is still populated by the healer, so it remains useful.

### Replace `repair_status` stamping with `heal_status`?

Optional. The current code writes `'fixed'` / `'failed'` into `content_metadata.repair_status`. The healer only ever produces `'fixed'` or `'skipped'`. The semantics shift slightly:

- **Keep `repair_status`** — backwards-compatible with the existing index and inspect_run.py columns. Just write `'fixed'` or `'skipped'` instead of `'failed'`.
- **Rename to `heal_status`** — slightly cleaner semantics, but requires updating `inspect_run.py`'s SUM(...) queries and the migration's index.

Recommendation: keep `repair_status`. Cosmetic rename isn't worth the migration churn.

### Update KI-006

Add a closing note to KI-006 in `docs/known-issues.md`:

> **2026-05-01 update:** v0.5.0 prompt + describe-first + deterministic healer replaced the Flash-Lite repair pass. Re-measurement showed deterministic rules handle every observed misplacement pattern, and the LLM-repair architecture is no longer in the codebase. The discriminated-union experiment ruling stands; the rejection reasoning still applies if a future engineer reaches for that approach.

### Commit

`refactor: remove LLM repair pass in favor of deterministic healer`

---

## PR 3 (optional): re-capture eval baselines under v0.5.0

If `eval/test_videos.json` is populated with real videos:

```bash
cd pipeline && python scripts/eval_runner.py --capture
git add eval/baselines/*v0.5.0.json
git commit -m "eval: capture baselines for prompt v0.5.0"
```

If `eval/test_videos.json` still has just the DSC30 stub, defer until a real test set is curated.

---

## Self-review checklist

- [ ] `visual_observation` is the FIRST field in `VisualContentItem` declaration order — verify by inspecting the generated JSON schema.
- [ ] Prompt v0.5.0 instructs Gemini to emit `visual_observation` before `content_type` — call this out in two places (system prompt's REASONING ORDER section, user prompt's REMINDER ON FIELD ORDER tail).
- [ ] Healer is pure (no I/O, no LLM, no global state) — confirmed by tests.
- [ ] Healer accepts ANY strict improvement, not just full fix — partial heals (item went from 2 issues to 1) count as "fixed". Mirrors the original repair pass's behavior.
- [ ] Three persistence sites still stamp `repair_status` from `summary.statuses[idx]` — they read the field generically; no change needed.
- [ ] `notify_repair_summary` and the noise-threshold constants are gone from slack.py.
- [ ] Re-measurement on DSC30 shows <1% post-healer misplacement — captured in the PR 1 commit message or a small results-summary doc.
- [ ] No new dependencies added or removed in `pipeline/pyproject.toml`.
- [ ] All existing tests pass except those explicitly deleted in PR 2.

## Operational notes

**Cancellation latency.** Heal is synchronous and runs in microseconds — chunk completion time is no longer dominated by repair. Cancellation responsiveness improves vs. the LLM repair path.

**Output token cost.** `visual_observation` adds ~70-120 chars per item = ~25-30 output tokens. At Gemini Flash pricing ($2.50/M output), that's <$0.01 per chunk. Negligible.

**Truncation risk.** The `visual_observation` field adds output tokens but only ~3% of total response size in observed runs. Truncation risk on long chunks is unchanged in practice.

**What if a future bug class needs LLM judgment?** Add it to the healer as a new rule, OR consult the archive at [pipeline/scripts/archive/](pipeline/scripts/archive/) for the pattern of bringing back an LLM-repair-style helper. The deletion in PR 2 is reversible from git history.

**Future research (deferred):** the §1.2 reasoning literature suggests there might be additional value in *nested* describe-first (where the type-specific payload is itself a discriminated union under `payload`). Not worth doing now — KI-006 showed strict discriminated unions cause chunk loss, and the flat schema with leading `visual_observation` already captures most of the §1.2 mechanism.

---

## Execution choices

Two PRs, ~1 day of focused work. Recommended order: **PR 1 first** (additive, builds the new path), **PR 2 second** (deletion, breaks nothing once PR 1 is live).

Inline execution is fine for this size — no subagent needed. Total LOC delta: roughly +200 added (healer + tests + prompt + schema field), -800 deleted (repair.py + tests + slack threshold). Net **−600 LOC** while improving misplacement rate from ~7% post-heal to <1% post-heal.
