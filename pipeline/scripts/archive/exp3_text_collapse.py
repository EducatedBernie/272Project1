"""Experiment 3: collapse text content's textBlocks → body (string).

Tests whether removing the rich-structure attractor for text items
changes Gemini's misplacement patterns. text content_type uses a single
`body` string with newlines for layout; other types unchanged. Removes
text_blocks from the schema entirely — the only "list of blocks" container
is gone, so misplacement INTO it for non-text types becomes structurally
impossible.

Tradeoff: text items lose explicit heading/bullet/depth markers, replaced
with newline-delimited markdown-ish prose.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path
from typing import List

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, Field
from google import genai
from google.genai import types

from src.extraction.prompts import (
    VISUAL_CONTENT_SYSTEM_PROMPT as BASE_SYSTEM_PROMPT,
)


class VisualContentItemV3(BaseModel):
    """v0.4.0 schema with text_blocks REMOVED, body string added.

    For content_type='text', put slide content in `body` as newline-
    delimited markdown-ish prose (use leading '# ' for headings, '- ' for
    bullets, blank lines between paragraphs). For all other types, leave
    `body` empty — its purpose is exclusively for text-type content.
    """
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
    body: str = ""  # NEW — replaces text_blocks for text content_type only


class VisualContentExtractionOutputV3(BaseModel):
    items: List[VisualContentItemV3] = Field(description="List of visual content items")


# Custom prompt — base v0.4.0 system prompt (rules unchanged), but the user
# prompt's text section is rewritten for the body-string shape, and the
# whole prompt drops text_blocks references.
SYSTEM_PROMPT = BASE_SYSTEM_PROMPT.replace(
    "  content_type='text'                 → put the content in `text_blocks` (list). NEVER `description`.",
    "  content_type='text'                 → put the content in `body` (string, newline-delimited). NEVER `description`.",
).replace(
    "ANTI-PATTERN to avoid (the dominant bug — observed in 163 of 187 broken items in a recent prod run):\n\nA diagram_description, chart_description, or other item where `description` is empty and the actual prose description sits in `text_blocks` instead. `text_blocks` is ONLY for content_type='text' — it represents structured slide layouts with multiple distinct headings/bullets/paragraphs whose hierarchy must be preserved. A flowing description of a diagram is NOT a text_blocks structure even if it has multiple sentences; put it in `description` as a single string.\n\nIf a diagram has both a flowing description AND structured labels you want to preserve, the description prose still goes in `description`. Use `purpose` for one-sentence summary if the type supports it; do NOT smuggle prose into `text_blocks`.",
    "ANTI-PATTERN to avoid:\n\nFor content_type='diagram_description', 'chart_description', or 'other', put the description prose in `description` (the dedicated string field) — never in `body`. The `body` field exists ONLY for content_type='text'; it is a single newline-delimited string for slide-layout content. Other types should leave `body` empty."
)


# Custom user prompt for v3 — keeps the universal rules, drops text_blocks
# references, swaps the text section's instructions to use body.
USER_PROMPT = """Transcribe ALL visual content that is ACTIVELY being written or displayed on the board or slides in this lecture video segment.

This is for accessibility — a blind student needs to read EXACTLY what a sighted student sees. Do NOT summarize or paraphrase. Transcribe verbatim.

UNIVERSAL RULE — INLINE LATEX IS SUPPORTED IN EVERY TEXT-CARRYING FIELD.
Every field that carries natural-language text in any content type renders `$...$` as proper math via KaTeX. Whenever a variable, formula, unit, chemical formula, mathematical symbol, or equation appears inside one of these fields, wrap it in `$...$`. Do not write raw "F = ma" when you mean "$F = ma$".

LITERAL DOLLAR SIGNS (currency). Escape any literal dollar character as `\\$`.

Content types to extract:

1. **equation** — Mathematical expressions, formulas, derivations.
   → `latex` (string).
   → `description` for label/alt-text if applicable.

2. **text** — Written text on the board or slides. Bullet points, definitions, procedures, lists, titles, labels, written notes.
   → Put the slide content in `body` as a single string. Use newline-delimited markdown-ish layout:
     • `# Heading text` for a heading line
     • `- bullet text` for a top-level bullet
     • `  - sub-bullet` for a depth=1 sub-bullet
     • blank line between paragraphs
     • plain text for paragraphs (no leading marker)
   → Wrap inline math with `$...$`. Example body:
     ```
     # Warm-Up
     How would you know if any of these are true?
     - There are infinitely many primes
     - Every even $\\#>2$ is the sum of two primes
     - Your code never gets stuck in an infinite loop
     ```
   → Leave `description` empty; `body` carries the content.
   → NO markdown bold/italic. The leading-marker convention is the only structure.

3. **diagram_description** — Structural diagrams: Lewis structures, molecular diagrams, circuit diagrams, flowcharts.
   → Put the description prose in `description` (single string).
   → Begin with one sentence: "A {type} diagram of {subject}." Then list elements numbered: "Elements: (1) ... (2) ..."
   → Leave `body` empty.

4. **chart_description** — Graphs, plots, bar charts, phase diagrams.
   → Put the description prose in `description` (single string), formatted per the chart-axis rules.
   → Leave `body` empty.

5. **table** — Data tables.
   → `headers`, `rows`, `title`, `caption`. Wrap inline math/units in `$...$` across all fields.
   → Leave `body` and `description` empty.

6. **code** — Code snippets, pseudocode.
   → `code` (verbatim string), `language`, `purpose`, `structure` (ordered phrases per top-level statement).
   → Leave `body` and `description` empty.

7. **other** — Visual content that doesn't fit any other type (photographs, screenshots, maps, gestures, single symbols).
   → Put ALL content in `description` as a single string. Format: "A {media type} showing {subject}." optionally followed by "Contents: (1) ... (2) ..."
   → Leave `body`, `title`, `caption` empty.

Requirements:
- Only extract content actively being written or displayed in this segment, not earlier content still visible.
- If no visual content is presented, return EMPTY items list.
- NEVER summarize or paraphrase. Transcribe exactly what's shown.
- Confidence (0.0-1.0) reflects visual clarity: 0.9-1.0 crisp, 0.7-0.9 readable with some unclear details, 0.5-0.7 blurry/inferred, <0.5 mostly guessing.

FIELD-PLACEMENT EXAMPLES:

text item (CORRECT — body filled, description empty):
  {"content_type": "text",
   "body": "# 1.1 Practice: True / False\\nQuestion:\\n- An abstract class can have both abstract and regular methods.\\n- An interface can have both abstract and regular methods.",
   "discussed_start": "3:15", "discussed_end": "4:30", "confidence": 0.95}

diagram_description (CORRECT — description filled, body empty):
  {"content_type": "diagram_description",
   "description": "A flowchart of Java compilation: source file (DSC.java) flows through the compiler (javac) to produce bytecode (DSC.class), which then executes on the JVM.",
   "discussed_start": "12:34", "discussed_end": "13:05", "confidence": 0.9}

diagram_description (WRONG — description empty, prose smuggled into body):
  {"content_type": "diagram_description",
   "description": "",
   "body": "A flowchart of Java compilation..."}
"""


def validate_v3(item: VisualContentItemV3) -> list[tuple[str, bool]]:
    """Inline validator for v3. Misplacement bug class becomes 'body has
    content for non-text types' — Gemini still might smuggle prose there."""
    issues = []
    ct = item.content_type
    desc = (item.description or "").strip()
    code = (item.code or "").strip()
    latex = (item.latex or "").strip()
    body = (item.body or "").strip()
    title = (item.title or "").strip()
    caption = (item.caption or "").strip()
    purpose = (item.purpose or "").strip()
    has_structure = any(s.strip() for s in item.structure)

    if ct == "code" and not code:
        # Misplacement could now be into body (since text_blocks is gone)
        issues.append(("code_in_body" if body else "code_field_empty", bool(body)))
    elif ct == "text":
        if not body:
            issues.append(("text_body_empty_description_set" if desc else "text_body_empty", bool(desc)))
    elif ct == "equation" and not latex:
        issues.append(("equation_latex_empty", False))
    elif ct == "table":
        if not item.headers:
            issues.append(("table_headers_empty", False))
        if not item.rows:
            issues.append(("table_rows_empty", False))
    elif ct in ("diagram_description", "chart_description") and not desc:
        # Misplacement now possible into body for non-text types
        if body or title or caption or purpose or has_structure:
            issues.append((f"{ct}_misplaced", True))
        else:
            issues.append((f"{ct}_empty", False))
    elif ct == "other" and not desc:
        if body or title or caption:
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
            response_schema=VisualContentExtractionOutputV3,
        ),
    )
    return VisualContentExtractionOutputV3.model_validate(resp.parsed).items


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("EXP3 GEMINI_API_KEY not set"); sys.exit(1)

    print(f"[EXP3 text-collapse] body field replaces text_blocks; schema has {len(VisualContentItemV3.model_fields)} fields")
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
            non_text_with_body = 0  # Gemini misplacing into body for non-text types
            for it in items:
                if it.content_type != "text" and (it.body or "").strip():
                    non_text_with_body += 1
                for rule, repairable in validate_v3(it):
                    rule_hits[rule] = rule_hits.get(rule, 0) + 1
                    if repairable:
                        broken_repairable += 1
                    else:
                        broken_perception += 1
            print(f"[EXP3 {label}] items={len(items)} broken={broken_repairable+broken_perception} (mis={broken_repairable},perc={broken_perception}) non_text_with_body={non_text_with_body} rules={rule_hits} ({elapsed:.1f}s)")
            results.append({"window": label, "items": len(items), "broken_repairable": broken_repairable,
                            "broken_perception": broken_perception, "rule_hits": rule_hits,
                            "non_text_with_body": non_text_with_body, "ok": True})
        except Exception as e:
            print(f"[EXP3 {label}] FAILED: {type(e).__name__}: {str(e)[:200]}")
            results.append({"window": label, "items": 0, "broken_repairable": 0, "broken_perception": 0, "ok": False, "error": str(e)[:200]})

    total_items = sum(r["items"] for r in results)
    total_misplacement = sum(r["broken_repairable"] for r in results)
    total_perception = sum(r["broken_perception"] for r in results)
    total_non_text_body = sum(r.get("non_text_with_body", 0) for r in results)
    chunks_lost = sum(1 for r in results if not r["ok"])
    print("\n=== EXP3 TEXT-COLLAPSE AGGREGATE ===")
    print(f"items={total_items} (baseline v0.4.0: 99)")
    print(f"misplacement={total_misplacement}/{total_items} = {100*total_misplacement/total_items:.1f}% (baseline 7.1%)")
    print(f"perception={total_perception}")
    print(f"non_text_items_with_body={total_non_text_body} (canary: schema-redirect leakage)")
    print(f"chunks_lost={chunks_lost}/13")

    out = Path(__file__).parent / "exp3_text_collapse_results.json"
    out.write_text(json.dumps(results, indent=2, default=str))
    print(f"raw: {out}")


if __name__ == "__main__":
    main()
