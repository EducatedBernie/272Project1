"""Experiment 1: rename textBlocks → boardWriting.

Tests whether a more semantically-loaded field name pushes Gemini's prior
away from "dump description prose here." Same schema otherwise; same
prompt structure with field-name substitution.

Same 13 × 10-min windows on DSC30 as the v0.4.0 baseline (8.1% broken,
7.1% misplacement, 99 items).
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


class VisualContentItemV1(BaseModel):
    """v0.4.0 schema with textBlocks renamed to boardWriting."""
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
    board_writing: List[TextBlock] = []  # was: text_blocks


class VisualContentExtractionOutputV1(BaseModel):
    items: List[VisualContentItemV1] = Field(description="List of visual content items")


SYSTEM_PROMPT = BASE_SYSTEM_PROMPT.replace("text_blocks", "board_writing").replace("textBlocks", "boardWriting")
USER_PROMPT = BASE_USER_PROMPT.replace("text_blocks", "board_writing").replace("textBlocks", "boardWriting")


def validate_v1(item: VisualContentItemV1) -> list[tuple[str, bool]]:
    """Inline validator returning [(rule, repairable), ...]."""
    issues = []
    ct = item.content_type
    desc = (item.description or "").strip()
    code = (item.code or "").strip()
    latex = (item.latex or "").strip()
    bw_text = any((b.text or "").strip() for b in item.board_writing)
    title = (item.title or "").strip()
    caption = (item.caption or "").strip()
    purpose = (item.purpose or "").strip()
    has_structure = any(s.strip() for s in item.structure)

    if ct == "code" and not code:
        issues.append(("code_in_board_writing" if bw_text else "code_field_empty", bw_text))
    elif ct == "text":
        if not bw_text:
            issues.append(("text_blocks_empty_description_set" if desc else "text_blocks_empty", bool(desc)))
    elif ct == "equation" and not latex:
        issues.append(("equation_latex_empty", False))
    elif ct == "table":
        if not item.headers:
            issues.append(("table_headers_empty", False))
        if not item.rows:
            issues.append(("table_rows_empty", False))
    elif ct in ("diagram_description", "chart_description") and not desc:
        if bw_text or title or caption or purpose or has_structure:
            issues.append((f"{ct}_misplaced", True))
        else:
            issues.append((f"{ct}_empty", False))
    elif ct == "other" and not desc:
        if bw_text or title or caption:
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
            response_schema=VisualContentExtractionOutputV1,
        ),
    )
    return VisualContentExtractionOutputV1.model_validate(resp.parsed).items


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("EXP1 GEMINI_API_KEY not set"); sys.exit(1)

    print(f"[EXP1 rename] Prompt has 'boardWriting' refs: {USER_PROMPT.count('boardWriting')}, 'textBlocks' refs: {USER_PROMPT.count('textBlocks')}")
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
            for it in items:
                for rule, repairable in validate_v1(it):
                    rule_hits[rule] = rule_hits.get(rule, 0) + 1
                    if repairable:
                        broken_repairable += 1
                    else:
                        broken_perception += 1
            print(f"[EXP1 {label}] items={len(items)} broken={broken_repairable+broken_perception} (mis={broken_repairable},perc={broken_perception}) rules={rule_hits} ({elapsed:.1f}s)")
            results.append({"window": label, "items": len(items), "broken_repairable": broken_repairable,
                            "broken_perception": broken_perception, "rule_hits": rule_hits, "ok": True})
        except Exception as e:
            print(f"[EXP1 {label}] FAILED: {type(e).__name__}: {str(e)[:200]}")
            results.append({"window": label, "items": 0, "broken_repairable": 0, "broken_perception": 0, "ok": False, "error": str(e)[:200]})

    total_items = sum(r["items"] for r in results)
    total_misplacement = sum(r["broken_repairable"] for r in results)
    total_perception = sum(r["broken_perception"] for r in results)
    chunks_lost = sum(1 for r in results if not r["ok"])
    print("\n=== EXP1 RENAME boardWriting AGGREGATE ===")
    print(f"items={total_items} (baseline v0.4.0: 99)")
    print(f"misplacement={total_misplacement}/{total_items} = {100*total_misplacement/total_items:.1f}% (baseline 7.1%)")
    print(f"perception={total_perception}")
    print(f"chunks_lost={chunks_lost}/13")

    out = Path(__file__).parent / "exp1_rename_boardwriting_results.json"
    out.write_text(json.dumps(results, indent=2, default=str))
    print(f"raw: {out}")


if __name__ == "__main__":
    main()
