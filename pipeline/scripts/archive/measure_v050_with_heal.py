"""End-to-end measurement of v0.5.0 prompt + describe-first + healer.

Reports two rates:
  pre-heal:  misplacement straight off Gemini's response (does v0.5.0
             reasoning lever help vs v0.4.0?)
  post-heal: misplacement after the deterministic healer runs (does the
             healer catch the residual?)

Same 13 × 10-min DSC30 windows as the prior baselines so numbers compare:
  - v0.3.6 (KI-006):     16.1% pre-heal (no heal)
  - v0.4.0 (post-prompt): 7.1% pre-heal (no heal)
  - EXP2 (describe-first only, isolated): 4.4% pre-heal (no heal)
  - v0.5.0 (this run):     ?% pre-heal, ?% post-heal — the full pipeline
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from google import genai
from google.genai import types

from src.extraction.schemas import VisualContentExtractionOutput
from src.extraction.prompts import (
    VISUAL_CONTENT_SYSTEM_PROMPT,
    VISUAL_CONTENT_USER_PROMPT,
    VISUAL_CONTENT_PROMPT_VERSION,
)
from src.extraction.validators import validate_item
from src.extraction.healer import heal_run_items


VIDEO_URL = "https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC"
WINDOWS = [(s, s + 600, f"{s//60:02d}:00-{(s+600)//60:02d}:00") for s in range(0, 7800, 600)]


def extract(client, start_s, end_s):
    vp = types.Part(
        file_data=types.FileData(file_uri=VIDEO_URL),
        video_metadata=types.VideoMetadata(
            fps=0.5, start_offset=f"{start_s}s", end_offset=f"{end_s}s",
        ),
    )
    resp = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
        config=types.GenerateContentConfig(
            system_instruction=VISUAL_CONTENT_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=VisualContentExtractionOutput,
        ),
    )
    return VisualContentExtractionOutput.model_validate(resp.parsed).items


def count_broken(items):
    """Returns (misplacement_count, perception_count, rule_hits_dict)."""
    misplacement = 0
    perception = 0
    rule_hits = {}
    for it in items:
        for issue in validate_item(it):
            if issue.severity != "error":
                continue
            rule_hits[issue.rule] = rule_hits.get(issue.rule, 0) + 1
            if issue.repairable:
                misplacement += 1
            else:
                perception += 1
    return misplacement, perception, rule_hits


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("GEMINI_API_KEY not set"); sys.exit(1)

    print(f"Prompt: {VISUAL_CONTENT_PROMPT_VERSION}")
    print(f"Video: {VIDEO_URL}")
    print(f"Pipeline: extract → validate (pre-heal) → heal_run_items → validate (post-heal)")
    print(f"Comparison: v0.3.6=16.1%, v0.4.0=7.1%, EXP2 isolated=4.4%\n")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    results = []

    for start_s, end_s, label in WINDOWS:
        print(f"=== {label} ===")
        try:
            t0 = time.time()
            items = extract(client, start_s, end_s)
            elapsed = time.time() - t0

            pre_mis, pre_perc, pre_rules = count_broken(items)

            heal_summary = heal_run_items(items)
            healed_items = heal_summary.items

            post_mis, post_perc, post_rules = count_broken(healed_items)

            healed_count = heal_summary.healed_count
            print(f"  items={len(items)} pre_heal=(mis={pre_mis},perc={pre_perc}) "
                  f"healed={healed_count} post_heal=(mis={post_mis},perc={post_perc}) "
                  f"({elapsed:.1f}s)")
            if pre_rules:
                print(f"  pre-heal rules: {pre_rules}")
            if post_rules:
                print(f"  post-heal rules: {post_rules}")

            results.append({
                "window": label,
                "items": len(items),
                "pre_heal": {"misplacement": pre_mis, "perception": pre_perc, "rules": pre_rules},
                "post_heal": {"misplacement": post_mis, "perception": post_perc, "rules": post_rules},
                "healed_count": healed_count,
                "ok": True,
            })
        except Exception as e:
            print(f"  FAILED: {type(e).__name__}: {str(e)[:200]}")
            results.append({"window": label, "items": 0, "ok": False, "error": str(e)[:200]})

    total_items = sum(r.get("items", 0) for r in results)
    pre_mis_total = sum(r.get("pre_heal", {}).get("misplacement", 0) for r in results)
    pre_perc_total = sum(r.get("pre_heal", {}).get("perception", 0) for r in results)
    post_mis_total = sum(r.get("post_heal", {}).get("misplacement", 0) for r in results)
    post_perc_total = sum(r.get("post_heal", {}).get("perception", 0) for r in results)
    healed_total = sum(r.get("healed_count", 0) for r in results)
    chunks_lost = sum(1 for r in results if not r.get("ok"))

    print(f"\n\n=== Aggregate (v{VISUAL_CONTENT_PROMPT_VERSION} + healer, DSC30 full video) ===")
    if not total_items:
        print("All chunks failed — no data.")
        return

    pre_rate = 100 * pre_mis_total / total_items
    post_rate = 100 * post_mis_total / total_items
    print(f"items: {total_items}")
    print(f"healed by deterministic rules: {healed_total}")
    print()
    print(f"PRE-HEAL  misplacement={pre_mis_total} ({pre_rate:.1f}%)  perception={pre_perc_total}")
    print(f"POST-HEAL misplacement={post_mis_total} ({post_rate:.1f}%)  perception={post_perc_total}")
    print(f"chunks_lost={chunks_lost}/13")
    print()
    print("Comparison:")
    print(f"  v0.3.6 baseline (no prompt fix, no heal):   16.1% misplacement")
    print(f"  v0.4.0 baseline (prompt fix, no heal):       7.1% misplacement")
    print(f"  EXP2 isolated (describe-first, no heal):     4.4% misplacement")
    print(f"  v0.5.0 + healer (THIS RUN, pre-heal):       {pre_rate:.1f}% misplacement")
    print(f"  v0.5.0 + healer (THIS RUN, post-heal):      {post_rate:.1f}% misplacement")

    print("\n=== Verdict ===")
    if post_rate < 1:
        print(f"✓ Post-heal rate {post_rate:.1f}% — full pipeline reduces misplacement to near-zero.")
    elif post_rate < 3:
        print(f"~ Post-heal rate {post_rate:.1f}% — most bugs caught. Residual is edge-case patterns.")
    else:
        print(f"⚠ Post-heal rate {post_rate:.1f}% — healer missed cases. Inspect rule hits to add new heal rules.")

    out = Path(__file__).parent / "measure_v050_with_heal_results.json"
    out.write_text(json.dumps(results, indent=2, default=str))
    print(f"\nRaw results: {out}")


if __name__ == "__main__":
    main()
