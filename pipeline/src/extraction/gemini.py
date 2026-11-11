"""Gemini Video API extraction for transcripts and equations."""

import os
import re

from google import genai
from google.genai import types

from src.config import DEFAULT_GEMINI_MODEL

from .prompts import (
    EQUATIONS_SYSTEM_PROMPT,
    EQUATIONS_USER_PROMPT,
    TRANSCRIPT_SYSTEM_PROMPT,
    TRANSCRIPT_USER_PROMPT,
)
from .schemas import EquationExtractionOutput, TranscriptExtractionOutput

MODEL = DEFAULT_GEMINI_MODEL
FPS = 0.5


def _get_client() -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    return genai.Client(api_key=api_key)


def _make_video_part(
    youtube_url: str,
    start_offset: str | None = None,
    end_offset: str | None = None,
) -> types.Part:
    """Create a video Part from a YouTube URL with optional time clipping."""
    video_metadata = types.VideoMetadata(fps=FPS)
    if start_offset is not None:
        video_metadata.start_offset = start_offset
    if end_offset is not None:
        video_metadata.end_offset = end_offset

    return types.Part(
        file_data=types.FileData(file_uri=youtube_url),
        video_metadata=video_metadata,
    )


CHUNK_DURATION = 600  # 10 minutes per chunk


def extract_transcript(youtube_url: str, duration: float | None = None) -> tuple[TranscriptExtractionOutput, dict]:
    """Extract transcript segments from a YouTube lecture video.

    For videos longer than CHUNK_DURATION, processes in chunks and merges.
    Pass 1 is chunked for completeness; Pass 2 (equations) still uses full video
    for cross-lecture comprehension.

    Returns:
        Tuple of (parsed output, raw API response dict)
    """
    if duration and duration > CHUNK_DURATION:
        return _extract_transcript_chunked(youtube_url, duration)
    return _extract_transcript_single(youtube_url)


def _extract_transcript_single(
    youtube_url: str,
    start_offset: str | None = None,
    end_offset: str | None = None,
) -> tuple[TranscriptExtractionOutput, dict]:
    """Extract transcript from a single video or chunk."""
    client = _get_client()
    video_part = _make_video_part(youtube_url, start_offset, end_offset)

    response = client.models.generate_content(
        model=MODEL,
        contents=types.Content(
            parts=[video_part, types.Part(text=TRANSCRIPT_USER_PROMPT)]
        ),
        config=types.GenerateContentConfig(
            system_instruction=TRANSCRIPT_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=TranscriptExtractionOutput,
        ),
    )

    if response.text is None:
        raise RuntimeError(
            "Gemini returned empty response for transcript extraction. "
            "This may be due to output token limit exceeded."
        )

    raw = {"text": response.text, "usage": _extract_usage(response)}
    parsed = TranscriptExtractionOutput.model_validate(response.parsed)
    return parsed, raw


def _extract_transcript_chunked(
    youtube_url: str, duration: float
) -> tuple[TranscriptExtractionOutput, dict]:
    """Extract transcript in chunks for long videos, then merge.

    Chunks are processed concurrently for speed. Timestamps in Gemini's
    output may be relative to the chunk start, so we detect and offset
    them back to absolute video time.
    """
    import logging
    from concurrent.futures import ThreadPoolExecutor, as_completed
    logger = logging.getLogger("chalkboard")

    # Build chunk list
    chunks = []
    chunk_start = 0
    while chunk_start < duration:
        chunk_end = min(chunk_start + CHUNK_DURATION, duration)
        chunks.append((chunk_start, chunk_end))
        chunk_start = chunk_end

    logger.info(f"  Splitting into {len(chunks)} chunks ({CHUNK_DURATION}s each)")

    # Process chunks concurrently
    results: dict[int, tuple] = {}

    def process_chunk(idx: int, start: float, end: float):
        logger.info(
            f"  Chunk {idx+1}/{len(chunks)}: {int(start)}s - {int(end)}s "
            f"({int(start//60)}:{int(start%60):02d} - {int(end//60)}:{int(end%60):02d})"
        )
        parsed, raw = _extract_transcript_single(
            youtube_url,
            start_offset=f"{int(start)}s",
            end_offset=f"{int(end)}s",
        )

        # Offset timestamps if they're relative to chunk start
        if parsed.segments:
            first_ts = parse_timestamp(parsed.segments[0].start_time)
            if first_ts < start - 60:
                for seg in parsed.segments:
                    start_secs = parse_timestamp(seg.start_time) + start
                    end_secs = parse_timestamp(seg.end_time) + start
                    seg.start_time = f"{int(start_secs // 60)}:{int(start_secs % 60):02d}"
                    seg.end_time = f"{int(end_secs // 60)}:{int(end_secs % 60):02d}"

        return idx, parsed, raw

    with ThreadPoolExecutor(max_workers=min(len(chunks), 5)) as executor:
        futures = {
            executor.submit(process_chunk, i, start, end): i
            for i, (start, end) in enumerate(chunks)
        }
        for future in as_completed(futures):
            idx, parsed, raw = future.result()
            results[idx] = (parsed, raw)

    # Merge in order
    all_segments = []
    all_raw = []
    for i in range(len(chunks)):
        parsed, raw = results[i]
        all_segments.extend(parsed.segments)
        all_raw.append(raw)

    logger.info(f"  Total: {len(all_segments)} segments from {len(chunks)} chunks")

    merged = TranscriptExtractionOutput(segments=all_segments)
    merged_raw = {"chunks": all_raw, "chunk_count": len(all_raw)}
    return merged, merged_raw


def extract_equations(youtube_url: str) -> tuple[EquationExtractionOutput, dict]:
    """Extract equations from a YouTube lecture video.

    Returns:
        Tuple of (parsed output, raw API response dict)
    """
    client = _get_client()
    video_part = _make_video_part(youtube_url)

    response = client.models.generate_content(
        model=MODEL,
        contents=types.Content(
            parts=[video_part, types.Part(text=EQUATIONS_USER_PROMPT)]
        ),
        config=types.GenerateContentConfig(
            system_instruction=EQUATIONS_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=EquationExtractionOutput,
        ),
    )

    if response.text is None:
        raise RuntimeError(
            "Gemini returned empty response for equation extraction. "
            "This may be due to output token limit exceeded."
        )

    raw = {"text": response.text, "usage": _extract_usage(response)}
    parsed = EquationExtractionOutput.model_validate(response.parsed)
    return parsed, raw


def _extract_usage(response) -> dict:
    """Pull usage metadata from the response if available."""
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        um = response.usage_metadata
        return {
            "prompt_token_count": getattr(um, "prompt_token_count", None),
            "candidates_token_count": getattr(um, "candidates_token_count", None),
            "total_token_count": getattr(um, "total_token_count", None),
        }
    return {}


def parse_timestamp(ts: str) -> float:
    """Convert MM:SS or HH:MM:SS timestamp string to seconds.

    Handles formats: "5:30", "05:30", "1:05:30"
    Also strips non-numeric suffixes (e.g., "410L" → "410")
    """
    # Strip any non-digit characters from each part
    clean = re.sub(r'[^0-9:]', '', ts.strip())
    parts = clean.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    elif len(parts) == 1 and parts[0]:
        # Plain seconds
        return float(parts[0])
    else:
        raise ValueError(f"Cannot parse timestamp: {ts}")
