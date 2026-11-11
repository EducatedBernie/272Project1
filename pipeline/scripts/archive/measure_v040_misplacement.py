"""Measure misplacement rate on DSC30 under prompt v0.4.0.

Compares against KI-006 baseline (16.1% broken-item rate measured under
v0.3.6 on 13 × 10-min windows of DSC30). If v0.4.0 drops the rate
significantly, the repair pass may be solving a problem that prompt
hardening already addresses.

Usage:
    python scripts/measure_v040_misplacement.py
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


VIDEO_URL = "https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC"
WINDOWS = [(start, start + 600, f"{start//60:02d}:00-{(start+600)//60:02d}:00")
           for start in range(0, 7800, 600)]  # 13 × 10-min windows


def extract_chunk(client, start_s: int, end_s: int):
    """Single Gemini extraction call. Uses the current code's flat schema
    + current prompt version (v0.4.0 after Task 2.9)."""
    vp = types.Part(
        file_data=types.FileData(file_uri=VIDEO_URL),
        video_metadata=types.VideoMetadata(
            fps=0.5,
            start_offset=f"{start_s}s",
            end_offset=f"{end_s}s",
        ),
    )
    response = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
        config=types.GenerateContentConfig(
            system_instruction=VISUAL_CONTENT_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=VisualContentExtractionOutput,
        ),
    )
    parsed = VisualContentExtractionOutput.model_validate(response.parsed)
    return parsed.items


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("GEMINI_API_KEY not set")
        sys.exit(1)

    print(f"Prompt version: {VISUAL_CONTENT_PROMPT_VERSION}")
    print(f"Video: {VIDEO_URL}")
    print(f"Windows: {len(WINDOWS)} × 10 min each\n")
    print("KI-006 baseline (under v0.3.6): 112 items, 18 broken (16.1% rate), 0 chunks lost.\n")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    results = []

    for start_s, end_s, label in WINDOWS:
        print(f"=== {label} ===")
        try:
            t0 = time.time()
            items = extract_chunk(client, start_s, end_s)
            elapsed = time.time() - t0

            type_counts: dict[str, int] = {}
            rule_hits: dict[str, int] = {}
            broken_repairable = 0
            broken_perception = 0
            for it in items:
                type_counts[it.content_type] = type_counts.get(it.content_type, 0) + 1
                for issue in validate_item(it):
                    if issue.severity != "error":
                        continue
                    rule_hits[issue.rule] = rule_hits.get(issue.rule, 0) + 1
                    if issue.repairable:
                        broken_repairable += 1
                    else:
                        broken_perception += 1

            broken_total = broken_repairable + broken_perception
            print(f"  items={len(items)} broken={broken_total} "
                  f"(misplacement={broken_repairable}, perception={broken_perception}) "
                  f"types={type_counts} ({elapsed:.1f}s)")
            if rule_hits:
                print(f"  rule hits: {rule_hits}")

            results.append({
                "window": label,
                "items": len(items),
                "broken_total": broken_total,
                "broken_repairable": broken_repairable,
                "broken_perception": broken_perception,
                "rule_hits": rule_hits,
                "type_counts": type_counts,
                "chunk_survived": True,
            })
        except Exception as e:
            print(f"  FAILED: {type(e).__name__}: {str(e)[:300]}")
            results.append({
                "window": label,
                "items": 0,
                "broken_total": 0,
                "broken_repairable": 0,
                "broken_perception": 0,
                "rule_hits": {},
                "chunk_survived": False,
                "error": f"{type(e).__name__}: {str(e)[:300]}",
            })

    total_items = sum(r["items"] for r in results)
    total_broken = sum(r["broken_total"] for r in results)
    total_repairable = sum(r["broken_repairable"] for r in results)
    total_perception = sum(r["broken_perception"] for r in results)
    chunks_lost = sum(1 for r in results if not r.get("chunk_survived", True))

    print(f"\n\n=== Aggregate (v{VISUAL_CONTENT_PROMPT_VERSION}, DSC30 full video) ===")
    print(f"{'metric':<30} {'value':>15}    vs v0.3.6 baseline")
    print("-" * 70)
    print(f"{'total items':<30} {total_items:>15}    (was 112)")
    print(f"{'total broken items':<30} {total_broken:>15}    (was 18)")
    print(f"{'  - misplacement (repairable)':<30} {total_repairable:>15}")
    print(f"{'  - perception (unrepairable)':<30} {total_perception:>15}")
    if total_items:
        rate = total_broken / total_items * 100
        baseline_delta = rate - 16.1
        sign = "+" if baseline_delta >= 0 else ""
        print(f"{'broken-item rate':<30} {rate:>14.1f}%    (was 16.1%, {sign}{baseline_delta:.1f}pp)")
    print(f"{'chunks lost':<30} {chunks_lost:>15}    (was 0/13)")

    print("\n=== Verdict ===")
    if total_items == 0:
        print("⚠ All chunks failed — can't compare.")
    else:
        rate = total_broken / total_items * 100
        misplacement_rate = total_repairable / total_items * 100 if total_items else 0
        if misplacement_rate < 5:
            print(f"✓ Misplacement rate {misplacement_rate:.1f}% (was ~14% under v0.3.6).")
            print("  Prompt v0.4.0 carries the load. Repair pass solves a near-vanished problem —")
            print("  a deterministic healer + validators-as-telemetry would be sufficient.")
        elif misplacement_rate < 10:
            print(f"~ Misplacement rate {misplacement_rate:.1f}% — meaningfully reduced from ~14% but not gone.")
            print("  Repair pass still earns its keep; deterministic healer would handle most cases.")
        else:
            print(f"✗ Misplacement rate {misplacement_rate:.1f}% — prompt fix didn't move the needle much.")
            print("  Repair pass is doing real work. Keep as-is.")

    out_path = Path(__file__).parent / "measure_v040_misplacement_results.json"
    out_path.write_text(json.dumps(results, indent=2, default=str))
    print(f"\nRaw results: {out_path}")


if __name__ == "__main__":
    main()
