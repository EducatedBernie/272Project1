"""CI eval runner for prompt-version regression testing.

Runs the current visual-content pipeline against a curated test set and
diffs against committed baselines. Prints a regression report and exits
non-zero if any regressions are detected.

Usage:
    python scripts/eval_runner.py --capture        # write fresh baselines (use after intentional prompt bumps)
    python scripts/eval_runner.py                  # default: compare current outputs to baselines
    python scripts/eval_runner.py --videos a,b,c   # restrict to specific video_ids

Test set lives at `eval/test_videos.json`. Baselines at
`eval/baselines/<video_id>__<prompt_version>.json`.

Three regression signals:
  1. New validator rules firing (misplacement / empty primary fields)
  2. Per-content_type item-count drops > 30%
  3. Total item count collapse > 50% (catches chunk-level extraction failures)
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
from src.extraction.schemas import VisualContentItem, TextBlock
from src.extraction.validators import validate_item


REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_SET = REPO_ROOT / "eval" / "test_videos.json"
BASELINES_DIR = REPO_ROOT / "eval" / "baselines"


# Tunable thresholds for "this swing is too big to be Gemini non-determinism."
COUNT_DROP_THRESHOLD = 0.30  # 30%+ drop per content_type → regression
TOTAL_DROP_THRESHOLD = 0.50  # 50%+ drop in total items → regression (catches chunk loss)


@dataclass
class Diff:
    regressions: list[str] = field(default_factory=list)
    improvements: list[str] = field(default_factory=list)
    unchanged: bool = True


# camelCase → snake_case key mapping for visual content items.
# Mirrors _CONTENT_META_FIELDS in process_video_v2.py — keep in sync.
# Baselines persist camelCase (textBlocks, contentType) but the Pydantic
# schema expects snake_case (text_blocks, content_type). Without this
# conversion, model_construct(**raw) silently sets text_blocks=[] and
# every text item in the baselines becomes a false-positive validator hit.
_CAMEL_TO_SNAKE_VC = {
    "textBlocks": "text_blocks",
    "contentType": "content_type",
}


def _camel_to_snake_visual_item(raw: dict) -> dict:
    """Convert known camelCase keys to snake_case so VisualContentItem.
    model_construct populates the right attributes. Coerces textBlocks
    contents to TextBlock instances since model_construct skips coercion."""
    out = {_CAMEL_TO_SNAKE_VC.get(k, k): v for k, v in raw.items()}
    if isinstance(out.get("text_blocks"), list):
        coerced = []
        for b in out["text_blocks"]:
            if isinstance(b, dict):
                coerced.append(TextBlock.model_construct(**b))
            else:
                coerced.append(b)
        out["text_blocks"] = coerced
    return out


def _validation_errors(items_payload: list[dict]) -> set[str]:
    """Return the set of validator rule names hit by this items list.

    Uses model_construct (skips Pydantic validation) so this works even on
    items that have empty primary fields (which is exactly what we want to
    detect — the validators see them and flag them)."""
    rules = set()
    for raw in items_payload:
        snake = _camel_to_snake_visual_item(raw)
        try:
            item = VisualContentItem.model_construct(**snake)
        except Exception:
            rules.add("schema_construct_error")
            continue
        for issue in validate_item(item):
            if issue.severity == "error":
                rules.add(issue.rule)
    return rules


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
      2. Per-content_type item-count drops > 30% (a prompt change that
         silently loses half the equations is a regression even if the
         items that DO come out are individually clean).
      3. Total item count collapse > 50% (catches chunk-level failure modes
         like a future schema or prompt change causing Gemini to return [];
         see KI-006 for the discriminated-union case study).
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

    # Signal 3: total item count collapse
    base_total = len(base_items)
    cur_total = len(cur_items)
    if base_total > 0 and (base_total - cur_total) / base_total > TOTAL_DROP_THRESHOLD:
        pct = round((base_total - cur_total) / base_total * 100)
        diff.regressions.append(
            f"total items dropped {pct}% ({base_total} → {cur_total}) — possible chunk-level extraction failure"
        )

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
    Do NOT call .model_dump() on these — they are not Pydantic instances."""
    from scripts.process_video_v2 import process_video as _pv
    result = _pv(
        source=video["youtube_url"],
        title=video.get("title"),
        db_mode=False,
        return_payload=True,
    )
    if result is None:
        return {"items": []}
    return {"items": list(result.visual_content_items)}


def main():
    p = argparse.ArgumentParser(description="CI eval runner for prompt-version regression testing")
    p.add_argument("--capture", action="store_true", help="Write fresh baselines from current outputs")
    p.add_argument("--videos", default="", help="Comma-separated video_ids to restrict the run")
    args = p.parse_args()

    if not TEST_SET.exists():
        sys.exit(
            f"❌ {TEST_SET} not found.\n"
            f"Curate a test set first: pick ~20 videos from your prod DB and write\n"
            f"a JSON list with entries shaped like:\n"
            f'  {{"video_id": "...", "youtube_url": "...", "title": "...", "tags": [...]}}'
        )

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
            print(f"  {v['video_id']}: ERROR running pipeline: {type(e).__name__}: {e}")
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
