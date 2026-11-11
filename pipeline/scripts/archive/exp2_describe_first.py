"""Experiment 2: describe-first schema (visual_observation precedes content_type).

Tests §1.2's reasoning-before-commitment hypothesis: by emitting a free-form
1-2 sentence observation BEFORE committing to content_type, Gemini gets a
"scratchpad" pass that should improve dispatch and reduce misplacement.

Same flat schema otherwise; same prompt extended with instructions for the
new visual_observation field. Pydantic field declaration order forces
visual_observation to emit first.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path
from typing import List, Literal

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, Field
from google import genai
from google.genai import types

from src.extraction.prompts import (
    VISUAL_CONTENT_SYSTEM_PROMPT as BASE_SYSTEM_PROMPT,
    VISUAL_CONTENT_USER_PROMPT as BASE_USER_PROMPT,
)


class TextBlock(BaseModel):
    kind: Literal["heading", "paragraph", "bullet"]
    text: str
    depth: int = 0


class VisualContentItemV2(BaseModel):
    """v0.4.0 schema with a leading visual_observation field for chain-of-thought."""
    # NEW: emit FIRST so Gemini reasons before committing to type
    visual_observation: str = Field(
        description="Describe in 1-2 sentences what you literally see in this region BEFORE classifying it. Just describe: handwriting? printed text? a table grid? a diagram with arrows? raw symbols? Do NOT classify yet. If you can't see it clearly, say so."
    )
    # Original v0.4.0 fields below (declaration order = JSON emission order)
    content_type: str
    description: str = ""
    discussed_start: str
    discussed_end: str
    confidence: float
    latex: str = ""
    code: str = ""
    language: str = ""
    purpose: str = ""
    structure: List[str] = []
    headers: List[str] = []
    rows: List[List[str]] = []
    title: str = ""
    caption: str = ""
    text_blocks: List[TextBlock] = []


class VisualContentExtractionOutputV2(BaseModel):
    items: List[VisualContentItemV2] = Field(description="List of visual content items")


SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + """

REASONING ORDER (NEW):
For each item, you must emit `visual_observation` FIRST, BEFORE classifying. This is your scratchpad — describe what you literally see in 1-2 sentences without committing to a content_type. Examples of good observations:
  - "Handwritten Java code on whiteboard, multiple lines, with a question comment about method count."
  - "A flowchart with three boxes connected by arrows, labels reference Java compilation."
  - "Slide showing a numbered list of true/false practice questions about abstract classes."
  - "A line plot with X axis labeled time in seconds, Y axis labeled velocity in m/s."

ONLY AFTER you've written the observation should you pick `content_type` based on what you described. Then fill the type-specific fields per the rules below."""

USER_PROMPT = BASE_USER_PROMPT + """

REMINDER ON FIELD ORDER:
For every item, emit fields in this order:
  1. visual_observation — 1-2 sentence raw description (do NOT classify here)
  2. content_type — chosen based on the observation above
  3. type-specific fields per the rules above"""


def validate_v2(item: VisualContentItemV2) -> list[tuple[str, bool]]:
    issues = []
    ct = item.content_type
    desc = (item.description or "").strip()
    code = (item.code or "").strip()
    latex = (item.latex or "").strip()
    tb_text = any((b.text or "").strip() for b in item.text_blocks)
    title = (item.title or "").strip()
    caption = (item.caption or "").strip()
    purpose = (item.purpose or "").strip()
    has_structure = any(s.strip() for s in item.structure)

    if ct == "code" and not code:
        issues.append(("code_in_text_blocks" if tb_text else "code_field_empty", tb_text))
    elif ct == "text":
        if not tb_text:
            issues.append(("text_blocks_empty_description_set" if desc else "text_blocks_empty", bool(desc)))
    elif ct == "equation" and not latex:
        issues.append(("equation_latex_empty", False))
    elif ct == "table":
        if not item.headers:
            issues.append(("table_headers_empty", False))
        if not item.rows:
            issues.append(("table_rows_empty", False))
    elif ct in ("diagram_description", "chart_description") and not desc:
        if tb_text or title or caption or purpose or has_structure:
            issues.append((f"{ct}_misplaced", True))
        else:
            issues.append((f"{ct}_empty", False))
    elif ct == "other" and not desc:
        if tb_text or title or caption:
            issues.append(("other_content_in_other_fields", True))
        else:
            issues.append(("other_description_empty", False))
    return issues


VIDEO_URL = "https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC"
WINDOWS = [(s, s + 600, f"{s//60:02d}:00-{(s+600)//60:02d}:00") for s in range(0, 7800, 600)]


def extract(client, start_s, end_s):
    vp = types.Part(
        file_data=types.FileData(file_uri=VIDEO_URL),
        video_metadata=types.VideoMetadata(fps=0.5, start_offset=f"{start_s}s", end_offset=f"{end_s}s"),
    )
    resp = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=types.Content(parts=[vp, types.Part(text=USER_PROMPT)]),
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=VisualContentExtractionOutputV2,
        ),
    )
    return VisualContentExtractionOutputV2.model_validate(resp.parsed).items


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("EXP2 GEMINI_API_KEY not set"); sys.exit(1)

    print(f"[EXP2 describe-first] visual_observation field added; system prompt extended ({len(SYSTEM_PROMPT)} chars)")
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    results = []

    for start_s, end_s, label in WINDOWS:
        try:
            t0 = time.time()
            items = extract(client, start_s, end_s)
            elapsed = time.time() - t0
            broken_repairable = 0
            broken_perception = 0
            rule_hits = {}
            obs_lengths = []
            for it in items:
                obs_lengths.append(len(it.visual_observation or ""))
                for rule, repairable in validate_v2(it):
                    rule_hits[rule] = rule_hits.get(rule, 0) + 1
                    if repairable:
                        broken_repairable += 1
                    else:
                        broken_perception += 1
            avg_obs = (sum(obs_lengths) // len(obs_lengths)) if obs_lengths else 0
            print(f"[EXP2 {label}] items={len(items)} broken={broken_repairable+broken_perception} (mis={broken_repairable},perc={broken_perception}) avg_obs_chars={avg_obs} rules={rule_hits} ({elapsed:.1f}s)")
            results.append({"window": label, "items": len(items), "broken_repairable": broken_repairable,
                            "broken_perception": broken_perception, "rule_hits": rule_hits,
                            "avg_obs_chars": avg_obs, "ok": True})
        except Exception as e:
            print(f"[EXP2 {label}] FAILED: {type(e).__name__}: {str(e)[:200]}")
            results.append({"window": label, "items": 0, "broken_repairable": 0, "broken_perception": 0, "ok": False, "error": str(e)[:200]})

    total_items = sum(r["items"] for r in results)
    total_misplacement = sum(r["broken_repairable"] for r in results)
    total_perception = sum(r["broken_perception"] for r in results)
    chunks_lost = sum(1 for r in results if not r["ok"])
    print("\n=== EXP2 DESCRIBE-FIRST AGGREGATE ===")
    print(f"items={total_items} (baseline v0.4.0: 99)")
    print(f"misplacement={total_misplacement}/{total_items} = {100*total_misplacement/total_items:.1f}% (baseline 7.1%)")
    print(f"perception={total_perception}")
    print(f"chunks_lost={chunks_lost}/13")

    out = Path(__file__).parent / "exp2_describe_first_results.json"
    out.write_text(json.dumps(results, indent=2, default=str))
    print(f"raw: {out}")


if __name__ == "__main__":
    main()
