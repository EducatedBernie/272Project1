"""Throwaway: A/B verify discriminated-union schema vs flat on Gemini structured output.

Validation logic is INLINED (PR 1 hasn't shipped) so this script is standalone."""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path
from typing import Annotated, List, Literal, Union

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, Field, ValidationError
from google import genai
from google.genai import types

from src.extraction.schemas import VisualContentItem, VisualContentExtractionOutput, TextBlock
from src.extraction.prompts import VISUAL_CONTENT_SYSTEM_PROMPT, VISUAL_CONTENT_USER_PROMPT


def validate_misplacement(item: VisualContentItem) -> list[str]:
    """Inline minimal validators — PR 1 hasn't shipped yet."""
    rules = []
    ct = item.content_type
    if ct == "code":
        if not item.code.strip():
            if any((b.text or "").strip() for b in item.text_blocks):
                rules.append("code_in_text_blocks")
            else:
                rules.append("code_field_empty")
    elif ct == "text":
        if not any((b.text or "").strip() for b in item.text_blocks):
            if (item.description or "").strip():
                rules.append("text_blocks_empty_description_set")
            else:
                rules.append("text_blocks_empty")
    elif ct == "equation":
        if not item.latex.strip():
            rules.append("equation_latex_empty")
    elif ct == "table":
        if not item.headers:
            rules.append("table_headers_empty")
        if not item.rows:
            rules.append("table_rows_empty")
    elif ct in ("diagram_description", "chart_description"):
        if not item.description.strip():
            rules.append(f"{ct}_empty")
    elif ct == "other":
        if not item.description.strip():
            if (item.title or "").strip() or (item.caption or "").strip():
                rules.append("other_content_in_title_caption")
            else:
                rules.append("other_description_empty")
    return rules


class _Base(BaseModel):
    discussed_start: str
    discussed_end: str
    confidence: float
    description: str = ""


class _CodeStrict(_Base):
    content_type: Literal["code"]
    code: str = Field(..., min_length=1)
    language: str = ""
    purpose: str = ""
    structure: List[str] = []


class _TextStrict(_Base):
    content_type: Literal["text"]
    text_blocks: List[TextBlock] = Field(..., min_length=1)


class _EquationStrict(_Base):
    content_type: Literal["equation"]
    latex: str = Field(..., min_length=1)


class _TableStrict(_Base):
    content_type: Literal["table"]
    headers: List[str] = Field(..., min_length=1)
    rows: List[List[str]] = Field(..., min_length=1)
    title: str = ""
    caption: str = ""


class _DiagramStrict(_Base):
    content_type: Literal["diagram_description"]


class _ChartStrict(_Base):
    content_type: Literal["chart_description"]


class _OtherStrict(_Base):
    content_type: Literal["other"]


_VariantItem = Annotated[
    Union[_CodeStrict, _TextStrict, _EquationStrict, _TableStrict,
          _DiagramStrict, _ChartStrict, _OtherStrict],
    Field(discriminator="content_type"),
]


class _DiscriminatedOutput(BaseModel):
    items: List[_VariantItem]


TEST_VIDEOS: list[dict] = [
    {"url": "https://youtu.be/2a6wXV_Nn9U", "label": "DSC30 (code, KNOWN_BAD)"},
    {"url": "https://www.youtube.com/watch?v=0JUN9aDxVmI", "label": "AdvAlgo (code+diagram+eq)"},
    {"url": "https://www.youtube.com/watch?v=qyP1xZCB62E", "label": "Lewin (table+other+eq)"},
    {"url": "https://www.youtube.com/watch?v=nkePsdYOzwg", "label": "DiscreteMath (text+eq)"},
    {"url": "https://www.youtube.com/watch?v=kd0xTfdt6qw", "label": "Feynman (variety)"},
]


def _gemini_call(client, url, response_schema=None, response_json_schema=None):
    vp = types.Part(
        file_data=types.FileData(file_uri=url),
        video_metadata=types.VideoMetadata(
            fps=0.5, start_offset="0s", end_offset="300s",
        ),
    )
    cfg_kwargs = {
        "system_instruction": VISUAL_CONTENT_SYSTEM_PROMPT,
        "response_mime_type": "application/json",
    }
    if response_schema is not None:
        cfg_kwargs["response_schema"] = response_schema
    if response_json_schema is not None:
        cfg_kwargs["response_json_schema"] = response_json_schema
    response = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
        config=types.GenerateContentConfig(**cfg_kwargs),
    )
    return response.text


def score_flat(raw_json):
    parsed = VisualContentExtractionOutput.model_validate_json(raw_json)
    counts: dict[str, int] = {}
    for it in parsed.items:
        for rule in validate_misplacement(it):
            counts[rule] = counts.get(rule, 0) + 1
    return {
        "items": len(parsed.items),
        "errors_per_rule": counts,
        "total_errors": sum(counts.values()),
    }


def score_discriminated(raw_json, raw_flat_count):
    out: dict = {"items": 0, "accepted": 0, "rejections_per_type": {}, "total_errors": 0}
    try:
        validated = _DiscriminatedOutput.model_validate_json(raw_json)
        out["chunk_survived"] = True
        out["items"] = len(validated.items)
        out["accepted"] = len(validated.items)
        out["count_vs_flat_pct"] = (
            round(len(validated.items) / raw_flat_count * 100) if raw_flat_count else None
        )
        return out
    except ValidationError as e:
        out["chunk_survived"] = False
        out["chunk_error"] = str(e)[:300]

    payload = json.loads(raw_json)
    items_raw = payload.get("items", [])
    out["items"] = len(items_raw)
    rejections: dict[str, int] = {}
    accepted = 0
    for raw_item in items_raw:
        try:
            _DiscriminatedOutput.model_validate({"items": [raw_item]})
            accepted += 1
        except ValidationError:
            ct = raw_item.get("content_type", "?")
            rejections[f"{ct}_rejected"] = rejections.get(f"{ct}_rejected", 0) + 1
    out["accepted"] = accepted
    out["rejections_per_type"] = rejections
    out["total_errors"] = sum(rejections.values())
    out["count_vs_flat_pct"] = (
        round(accepted / raw_flat_count * 100) if raw_flat_count else None
    )
    return out


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("GEMINI_API_KEY not set")
        sys.exit(1)

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    results = []

    for v in TEST_VIDEOS:
        print(f"\n=== {v['label']} ===")
        print(f"  URL: {v['url']}")

        print("  flat schema...")
        try:
            t0 = time.time()
            raw_a = _gemini_call(client, v["url"], response_schema=VisualContentExtractionOutput)
            sa = score_flat(raw_a)
            print(f"    items={sa['items']} total_errors={sa['total_errors']} per_rule={sa['errors_per_rule']} ({time.time()-t0:.1f}s)")
        except Exception as e:
            print(f"    FAILED: {type(e).__name__}: {e}")
            sa = {"items": 0, "total_errors": -1, "error": f"{type(e).__name__}: {e}"[:300]}

        print("  discriminated schema...")
        try:
            t0 = time.time()
            raw_b = _gemini_call(
                client, v["url"],
                response_json_schema=_DiscriminatedOutput.model_json_schema(),
            )
            sb = score_discriminated(raw_b, raw_flat_count=sa.get("items", 0))
            survived = sb.get("chunk_survived", False)
            print(f"    chunk_survived={survived} items={sb['items']} accepted={sb['accepted']} "
                  f"rejections={sb['rejections_per_type']} count_vs_flat={sb.get('count_vs_flat_pct')}% "
                  f"({time.time()-t0:.1f}s)")
            if not survived:
                print(f"    ! CHUNK FAILED — production would return [] here.")
                print(f"    Error excerpt: {sb.get('chunk_error', '')[:200]}")
        except Exception as e:
            print(f"    FAILED: {type(e).__name__}: {e}")
            print(f"    (if 'response_json_schema'/'anyOf'/'oneOf' is in the error, the SDK or model rejects discriminated unions)")
            sb = {"items": 0, "total_errors": -1, "error": f"{type(e).__name__}: {e}"[:300], "chunk_survived": False}

        results.append({"video": v["label"], "url": v["url"], "flat": sa, "discriminated": sb})

    print("\n\n=== Summary ===")
    print(f"{'video':<40} {'flat err':>10} {'disc err':>10} {'survived':>10}  {'verdict'}")
    print("-" * 112)
    for r in results:
        a = r["flat"].get("total_errors", -1)
        b = r["discriminated"].get("total_errors", -1)
        survived = r["discriminated"].get("chunk_survived", False)
        if a < 0:
            verdict = "FLAT API FAILED"
        elif b < 0:
            verdict = "DISCRIMINATED API ERROR"
        elif not survived:
            verdict = "DISC. CHUNK LOSS — regression risk"
        elif b < a:
            verdict = "discriminated wins"
        elif b == a:
            verdict = "tie (post-hoc validation)"
        else:
            verdict = "flat wins (?!)"
        print(f"{r['video'][:38]:<40} {a:>10} {b:>10} {str(survived):>10}  {verdict}")

    out_path = Path(__file__).parent / "verify_discriminated_union_results.json"
    out_path.write_text(json.dumps(results, indent=2, default=str))
    print(f"\nRaw results: {out_path}")


if __name__ == "__main__":
    main()
