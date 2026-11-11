"""B.0 v2: Run flat vs discriminated on DSC30 full video, score BOTH outputs
against the same validators. Verdict = does discriminated produce fewer broken
items? Item count matters too (lost content = regression even if cleaner)."""
from __future__ import annotations
import json, os, sys, time
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


def validate_misplacement(item) -> list[str]:
    """Inline validators. `item` may be a VisualContentItem (flat) or a strict
    sub-model (discriminated) — both expose the same attribute surface for what
    we check, but strict sub-models won't have empty primary fields by
    construction, so they should always return [] here."""
    rules = []
    ct = getattr(item, 'content_type', None)
    code = getattr(item, 'code', '') or ''
    latex = getattr(item, 'latex', '') or ''
    desc = getattr(item, 'description', '') or ''
    text_blocks = getattr(item, 'text_blocks', None) or []
    headers = getattr(item, 'headers', None) or []
    rows = getattr(item, 'rows', None) or []
    title = getattr(item, 'title', '') or ''
    caption = getattr(item, 'caption', '') or ''

    if ct == 'code':
        if not code.strip():
            has_tb = any((b.text or '').strip() for b in text_blocks)
            rules.append('code_in_text_blocks' if has_tb else 'code_field_empty')
    elif ct == 'text':
        has_tb = any((b.text or '').strip() for b in text_blocks)
        if not has_tb:
            rules.append('text_blocks_empty_description_set' if desc.strip() else 'text_blocks_empty')
    elif ct == 'equation':
        if not latex.strip():
            rules.append('equation_latex_empty')
    elif ct == 'table':
        if not headers: rules.append('table_headers_empty')
        if not rows: rules.append('table_rows_empty')
    elif ct in ('diagram_description', 'chart_description'):
        if not desc.strip():
            rules.append(f'{ct}_empty')
    elif ct == 'other':
        if not desc.strip():
            rules.append('other_content_in_title_caption' if (title.strip() or caption.strip()) else 'other_description_empty')
    return rules


class _Base(BaseModel):
    discussed_start: str
    discussed_end: str
    confidence: float
    description: str = ''


class _CodeStrict(_Base):
    content_type: Literal['code']
    code: str = Field(..., min_length=1)
    language: str = ''
    purpose: str = ''
    structure: List[str] = []


class _TextStrict(_Base):
    content_type: Literal['text']
    text_blocks: List[TextBlock] = Field(..., min_length=1)


class _EquationStrict(_Base):
    content_type: Literal['equation']
    latex: str = Field(..., min_length=1)


class _TableStrict(_Base):
    content_type: Literal['table']
    headers: List[str] = Field(..., min_length=1)
    rows: List[List[str]] = Field(..., min_length=1)
    title: str = ''
    caption: str = ''


class _DiagramStrict(_Base):
    content_type: Literal['diagram_description']
    description: str = Field(..., min_length=1)  # type: ignore[assignment]


class _ChartStrict(_Base):
    content_type: Literal['chart_description']
    description: str = Field(..., min_length=1)  # type: ignore[assignment]


class _OtherStrict(_Base):
    content_type: Literal['other']
    description: str = Field(..., min_length=1)  # type: ignore[assignment]


_VariantItem = Annotated[
    Union[_CodeStrict, _TextStrict, _EquationStrict, _TableStrict,
          _DiagramStrict, _ChartStrict, _OtherStrict],
    Field(discriminator='content_type'),
]


class _DiscriminatedOutput(BaseModel):
    items: List[_VariantItem]


def _gemini_call(client, url, start_s, end_s, response_schema=None, response_json_schema=None):
    vp = types.Part(
        file_data=types.FileData(file_uri=url),
        video_metadata=types.VideoMetadata(
            fps=0.5,
            start_offset=f'{start_s}s',
            end_offset=f'{end_s}s',
        ),
    )
    cfg = {
        'system_instruction': VISUAL_CONTENT_SYSTEM_PROMPT,
        'response_mime_type': 'application/json',
    }
    if response_schema is not None:
        cfg['response_schema'] = response_schema
    if response_json_schema is not None:
        cfg['response_json_schema'] = response_json_schema
    response = client.models.generate_content(
        model='gemini-3-flash-preview',
        contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
        config=types.GenerateContentConfig(**cfg),
    )
    return response.text


def score_flat_output(raw_json: str) -> dict:
    parsed = VisualContentExtractionOutput.model_validate_json(raw_json)
    rule_hits: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for it in parsed.items:
        type_counts[it.content_type] = type_counts.get(it.content_type, 0) + 1
        for r in validate_misplacement(it):
            rule_hits[r] = rule_hits.get(r, 0) + 1
    return {
        'items': len(parsed.items),
        'broken_items': sum(rule_hits.values()),
        'rule_hits': rule_hits,
        'type_counts': type_counts,
        'chunk_survived': True,
    }


def score_discriminated_output(raw_json: str) -> dict:
    """Try to parse the whole response as the strict union. If it fails, that's
    chunk loss — production would return [] for this chunk. Otherwise, validate
    each item (should yield 0 broken since min_length=1 enforced)."""
    try:
        parsed = _DiscriminatedOutput.model_validate_json(raw_json)
    except ValidationError as e:
        return {
            'items': 0,
            'broken_items': -1,
            'chunk_survived': False,
            'chunk_error': str(e)[:400],
        }

    rule_hits: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for it in parsed.items:
        type_counts[it.content_type] = type_counts.get(it.content_type, 0) + 1
        for r in validate_misplacement(it):
            rule_hits[r] = rule_hits.get(r, 0) + 1
    return {
        'items': len(parsed.items),
        'broken_items': sum(rule_hits.values()),
        'rule_hits': rule_hits,
        'type_counts': type_counts,
        'chunk_survived': True,
    }


WINDOWS = [(start, start + 600, f'{start//60:02d}:00-{(start+600)//60:02d}:00')
           for start in range(0, 7800, 600)]  # 13 × 10-min windows up to 130 min

VIDEO_URL = 'https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC'  # DSC30, the user's prod failure


def main():
    if not os.environ.get('GEMINI_API_KEY'):
        print('GEMINI_API_KEY not set'); sys.exit(1)

    client = genai.Client(api_key=os.environ['GEMINI_API_KEY'])
    all_results = []

    print(f'Video: {VIDEO_URL}')
    print(f'Prod baseline (run e5ac668c): 319 items, 277 broken (87% bug rate)\n')

    for start_s, end_s, label in WINDOWS:
        print(f'\n=== Window {label} ===')
        window_result = {'window': label, 'start_s': start_s, 'end_s': end_s}

        print('  flat schema...')
        try:
            t0 = time.time()
            raw_a = _gemini_call(client, VIDEO_URL, start_s, end_s,
                                 response_schema=VisualContentExtractionOutput)
            sa = score_flat_output(raw_a)
            print(f"    items={sa['items']} broken={sa['broken_items']} types={sa['type_counts']} ({time.time()-t0:.1f}s)")
            print(f"    rule hits: {sa['rule_hits']}")
        except Exception as e:
            print(f'    FAILED: {type(e).__name__}: {str(e)[:200]}')
            sa = {'items': 0, 'broken_items': -1, 'error': f'{type(e).__name__}: {str(e)[:200]}'}
        window_result['flat'] = sa

        print('  discriminated schema...')
        try:
            t0 = time.time()
            raw_b = _gemini_call(client, VIDEO_URL, start_s, end_s,
                                 response_json_schema=_DiscriminatedOutput.model_json_schema())
            sb = score_discriminated_output(raw_b)
            survived = sb.get('chunk_survived', False)
            print(f"    items={sb['items']} broken={sb['broken_items']} survived={survived} ({time.time()-t0:.1f}s)")
            if survived:
                print(f"    types: {sb.get('type_counts', {})}")
                print(f"    rule hits: {sb.get('rule_hits', {})}")
            else:
                print(f"    ! CHUNK LOST — production would return [] here")
                print(f"    {sb.get('chunk_error', '')[:300]}")
        except Exception as e:
            print(f'    FAILED: {type(e).__name__}: {str(e)[:200]}')
            sb = {'items': 0, 'broken_items': -1, 'error': f'{type(e).__name__}: {str(e)[:200]}', 'chunk_survived': False}
        window_result['discriminated'] = sb

        all_results.append(window_result)

    # Aggregate
    flat_total_items = sum(r['flat'].get('items', 0) for r in all_results)
    flat_total_broken = sum(max(0, r['flat'].get('broken_items', 0)) for r in all_results)
    disc_total_items = sum(r['discriminated'].get('items', 0) for r in all_results)
    disc_total_broken = sum(max(0, r['discriminated'].get('broken_items', 0)) for r in all_results)
    chunks_lost = sum(1 for r in all_results if not r['discriminated'].get('chunk_survived', True))

    print(f'\n\n=== Aggregate (DSC30 full video, {len(WINDOWS)} × 10-min windows) ===')
    print(f"{'metric':<30} {'flat':>10} {'discriminated':>15}")
    print('-' * 60)
    print(f"{'total items':<30} {flat_total_items:>10} {disc_total_items:>15}")
    print(f"{'total broken items':<30} {flat_total_broken:>10} {disc_total_broken:>15}")
    if flat_total_items:
        print(f"{'broken-item rate':<30} {flat_total_broken/flat_total_items*100:>9.1f}% {('-' if not disc_total_items else f'{disc_total_broken/disc_total_items*100:.1f}%'):>15}")
    print(f"{'chunks lost (chunk_survived=False)':<35} {chunks_lost}/{len(WINDOWS)}")

    print('\n=== Verdict ===')
    if chunks_lost > 0:
        print(f"⚠ {chunks_lost} of {len(WINDOWS)} chunks failed strict validation.")
        print("  Production with discriminated schema would have lost content for those chunks.")
        print("  Need to compare item-count loss vs broken-item reduction to decide.")
    if flat_total_broken > 0 and disc_total_broken == 0:
        print("✓ Discriminated produced ZERO broken items where flat had", flat_total_broken)
        if disc_total_items < flat_total_items * 0.7:
            print(f"  BUT discriminated lost {round((1 - disc_total_items/flat_total_items)*100)}% of items — content cost.")
        else:
            print("  Item count is comparable — clean win.")
    elif disc_total_broken > 0:
        print(f"⚠ Discriminated still has {disc_total_broken} broken items.")
        print("  This means strict schema is post-hoc only — Gemini emits broken JSON, schema validates.")
        print("  Half B has no preventive value here over the flat-schema validators.")

    out = Path(__file__).parent / 'verify_discriminated_union_v2_results.json'
    out.write_text(json.dumps(all_results, indent=2, default=str))
    print(f'\nRaw results: {out}')


if __name__ == '__main__':
    main()
