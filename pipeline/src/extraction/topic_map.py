"""
Generate a topic map from YouTube captions.

Produces a structured list of lecture sections with timestamps,
titles, descriptions, and a lecture summary. Used to intelligently
chunk both transcript and equation extraction passes.
"""

import json
import os
import re
import logging
import time

from google import genai
from google.genai import types

from src.config import DEFAULT_GEMINI_MODEL
from src.extraction.prompts import TOPIC_MAP_PROMPT, TOPIC_MAP_PROMPT_VERSION

logger = logging.getLogger("chalkboard")


def parse_srt_to_text(srt_path: str) -> list[tuple[float, str]]:
    """Parse SRT into timestamped text blocks."""
    with open(srt_path) as f:
        content = f.read()
    blocks = re.split(r'\n\n+', content.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue
        time_match = re.match(r'(\d+):(\d+):(\d+),(\d+)', lines[1])
        if not time_match:
            continue
        g = time_match.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2])
        text = ' '.join(lines[2:]).strip()
        if text:
            entries.append((start, text))
    return entries


TOPIC_MAP_MODEL = DEFAULT_GEMINI_MODEL


def generate_topic_map(
    srt_path: str,
    accumulator=None,
    call_recorder=None,
    model: str = DEFAULT_GEMINI_MODEL,
) -> dict:
    """Generate topic map + summary from YouTube captions.

    Args:
        srt_path: Path to YouTube auto-caption SRT file.
        accumulator: Optional UsageAccumulator (from src.extraction.usage)
            to record token usage for this call. None = no-op.

    Returns:
        {
            "summary": "One-line lecture description",
            "sections": [
                {
                    "start_time": "MM:SS",
                    "end_time": "MM:SS",
                    "title": "Section title",
                    "description": "One sentence description"
                },
                ...
            ]
        }
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    client = genai.Client(api_key=api_key)

    entries = parse_srt_to_text(srt_path)
    if not entries:
        raise ValueError(f"No captions found in {srt_path}")

    # Build timestamped transcript for the prompt
    lines = []
    for start, text in entries:
        mins = start // 60
        secs = start % 60
        lines.append(f"[{mins}:{secs:02d}] {text}")

    transcript = '\n'.join(lines)
    video_duration = entries[-1][0] if entries else 0
    duration_mins = video_duration // 60

    prompt = TOPIC_MAP_PROMPT.format(
        duration_mins=duration_mins,
        transcript=transcript,
    )

    from src.extraction.schemas import TopicMapOutput

    response = None
    started_at = time.time()
    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type='application/json',
                response_schema=TopicMapOutput,
            ),
        )

        if accumulator is not None:
            accumulator.record(response, model=model, kind="topic_map")

        parsed = TopicMapOutput.model_validate(response.parsed)
        if call_recorder is not None:
            call_recorder.record_attempt(
                kind="topic_map",
                attempt=1,
                model=model,
                started_at=started_at,
                prompt_version=TOPIC_MAP_PROMPT_VERSION,
                schema="TopicMapOutput",
                user_prompt=prompt,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "response_schema": "TopicMapOutput",
                },
                response=response,
                parsed=parsed,
                item_count=len(parsed.sections),
            )
    except Exception as e:
        if call_recorder is not None:
            call_recorder.record_attempt(
                kind="topic_map",
                attempt=1,
                model=model,
                started_at=started_at,
                prompt_version=TOPIC_MAP_PROMPT_VERSION,
                schema="TopicMapOutput",
                user_prompt=prompt,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "response_schema": "TopicMapOutput",
                },
                response=response,
                exception=e,
            )
        raise
    result = {"summary": parsed.summary, "sections": [s.model_dump() for s in parsed.sections]}

    # Validate and fix sections
    sections = result.get("sections", [])

    # Guard: split any section longer than 12 minutes
    fixed_sections = []
    for sec in sections:
        start = _parse_ts(sec["start_time"])
        end = _parse_ts(sec.get("end_time", sec["start_time"]))
        duration = end - start

        if duration > 720:  # > 12 minutes
            mid = start + duration // 2
            fixed_sections.append({
                "start_time": sec["start_time"],
                "end_time": _format_ts(mid),
                "title": sec["title"] + " (Part 1)",
                "description": sec["description"],
            })
            fixed_sections.append({
                "start_time": _format_ts(mid),
                "end_time": sec.get("end_time", _format_ts(end)),
                "title": sec["title"] + " (Part 2)",
                "description": sec["description"],
            })
        else:
            fixed_sections.append(sec)

    result["sections"] = fixed_sections

    logger.info(
        f"  Topic map: {len(fixed_sections)} sections, "
        f"summary: {result.get('summary', 'N/A')[:60]}"
    )

    return result


def get_chunk_boundaries(topic_map: dict, video_duration: float) -> list[tuple[float, float, str, str]]:
    """Convert topic map sections into chunk boundaries.

    Returns list of (start_seconds, end_seconds, title, context_prompt).
    Each chunk gets a context prompt with the lecture summary and
    surrounding section info.
    """
    sections = topic_map["sections"]
    summary = topic_map.get("summary", "STEM lecture")
    chunks = []

    for i, sec in enumerate(sections):
        start = _parse_ts(sec["start_time"])
        if "end_time" in sec:
            end = _parse_ts(sec["end_time"])
        elif i + 1 < len(sections):
            end = _parse_ts(sections[i + 1]["start_time"])
        else:
            end = video_duration

        # Build context for this chunk
        prev_title = sections[i - 1]["title"] if i > 0 else "Start of lecture"
        next_title = sections[i + 1]["title"] if i + 1 < len(sections) else "End of lecture"

        context = (
            f'Lecture: "{summary}"\n'
            f'Current section: "{sec["title"]}" — {sec.get("description", "")}\n'
            f'Previous section: "{prev_title}"\n'
            f'Next section: "{next_title}"'
        )

        chunks.append((start, end, sec["title"], context))

    return chunks


def _parse_ts(ts: str) -> float:
    """Parse MM:SS or HH:MM:SS to seconds."""
    parts = ts.strip().split(":")
    parts = [re.sub(r'[^0-9]', '', p) for p in parts]
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    return 0


def _format_ts(seconds: float) -> str:
    """Format seconds as MM:SS."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"
