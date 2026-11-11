"""
Chalkboard v2 Pipeline — Topic-aware processing.

Flow:
1. Download YouTube captions (yt-dlp) OR generate via Chirp 3 for local files
2. Generate topic map + summary from captions (text-only Gemini, pennies)
3. In parallel: chunked transcript + chunked equations, both using map boundaries
4. Word-align transcript against captions
5. Merge, save

Usage:
    python scripts/process_video_v2.py <youtube-url> [--title "Title"] [--db] [--run-id UUID]
    python scripts/process_video_v2.py /path/to/lecture.mp4 --title "Title" [--video-url "https://..."]
"""

import argparse
import json
import logging
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from google import genai
from google.genai import types
from src.config import DEFAULT_GEMINI_MODEL
from src.extraction.prompts import (
    EQUATIONS_SYSTEM_PROMPT, EQUATIONS_USER_PROMPT,
    EQUATIONS_PROMPT_VERSION, TRANSCRIPT_PROMPT_VERSION,
    TRANSCRIPT_SYSTEM_PROMPT, TRANSCRIPT_USER_PROMPT,
    VISUAL_CONTENT_SYSTEM_PROMPT, VISUAL_CONTENT_USER_PROMPT,
    VISUAL_CONTENT_PROMPT_VERSION,
)
from src.extraction.schemas import EquationExtractionOutput, VisualContentExtractionOutput
from src.extraction.latex_fix import fix_latex_escapes
from src.exceptions import CancelledError, ExtractionFailedError
from src.extraction.gemini import parse_timestamp
from src.extraction.topic_map import generate_topic_map, get_chunk_boundaries
from src.processing.word_align import align_sentences_to_captions, align_sentences_to_timestamps
from src.youtube import canonicalize_youtube_url, canonicalize_youtube_url_if_possible
from dataclasses import dataclass, field

from src.notifications.slack import notify_pipeline_event


# Fields that live in the content_metadata jsonb column (DB) and get spread
# into the top-level demo JSON dict (viewer). Map (python_attr -> serialized_key)
# so multi-word Pydantic fields get camelCase names that match the TS types.
_CONTENT_META_FIELDS = (
    # (python attribute name, serialized key name)
    ("code", "code"),
    ("language", "language"),
    ("purpose", "purpose"),
    ("structure", "structure"),
    ("headers", "headers"),
    ("rows", "rows"),
    ("title", "title"),
    ("caption", "caption"),
    ("text_blocks", "textBlocks"),
    # Decode-time scratchpad from v0.5.0 — Gemini's pre-classification
    # observation. Useful on the per-video debug page for diagnosing
    # classification mistakes (e.g. observation mentions "code" but
    # content_type ended up "text"). Persisted into content_metadata
    # JSONB and spread into demo JSON via the existing **content_meta.
    ("visual_observation", "visualObservation"),
)


def _build_content_meta(src) -> dict:
    """Build content_metadata dict from a VisualContentItem (pydantic) or vc dict.

    Emits camelCase keys so the output matches the VisualContent TS interface.
    Drops empty/falsy fields so the jsonb column stays compact. Serializes
    nested pydantic models (e.g. TextBlock) to plain dicts.

    Accepts a vc dict using either the python attr name OR the camelCase key —
    round-trips cleanly when a vc dict built from a prior call is re-serialized.
    """
    is_dict = isinstance(src, dict)
    meta = {}
    for py_attr, out_key in _CONTENT_META_FIELDS:
        if is_dict:
            val = src.get(out_key)
            if val is None:
                val = src.get(py_attr)
        else:
            val = getattr(src, py_attr, None)
            # text_blocks: list[TextBlock] → list[dict] for JSON/jsonb
            if py_attr == "text_blocks" and val:
                val = [b.model_dump() for b in val]
        if val:  # empty string, [], None all falsy — skip
            meta[out_key] = val
    return meta
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("chalkboard")

DEFAULT_MODEL = DEFAULT_GEMINI_MODEL
DEFAULT_FPS = 0.5
DEFAULT_MAX_WORKERS = 5


def _pipeline_max_workers() -> int:
    try:
        return max(1, int(os.getenv("PIPELINE_MAX_WORKERS", str(DEFAULT_MAX_WORKERS))))
    except ValueError:
        logger.warning(
            "Invalid PIPELINE_MAX_WORKERS=%r; using %s",
            os.getenv("PIPELINE_MAX_WORKERS"),
            DEFAULT_MAX_WORKERS,
        )
        return DEFAULT_MAX_WORKERS


def is_local_video(source: str) -> bool:
    """Check if the source is a local file path (vs a YouTube URL)."""
    return os.path.isfile(source)


def _ytdlp_proxy_args() -> list:
    """yt-dlp --proxy args if YT_DLP_PROXY env var is set (needed from datacenter IPs)."""
    proxy = os.getenv("YT_DLP_PROXY")
    return ["--proxy", proxy] if proxy else []


def _is_resource_exhausted(error: Exception) -> bool:
    return "RESOURCE_EXHAUSTED" in str(error) or "429" in str(error)


def _is_unsupported_mime(error: Exception) -> bool:
    return "Unsupported MIME type" in str(error)


def _retry_delay_seconds(attempt: int, error: Exception) -> float:
    """Delay before the next retry. `attempt` is zero-based."""
    if _is_resource_exhausted(error):
        return min(60.0, 10.0 * (2 ** attempt)) + random.uniform(0, 2)
    return 2.0 * (attempt + 1)


def _sleep_before_retry(attempt: int, error: Exception) -> None:
    delay = _retry_delay_seconds(attempt, error)
    logger.info("    Retrying in %.1fs", delay)
    time.sleep(delay)


def _extraction_failure(kind: str, url: str, attempts: int, error: Exception) -> ExtractionFailedError:
    message = f"{kind} extraction failed after {attempts} attempts: {type(error).__name__}: {error}"
    if _is_unsupported_mime(error):
        canonical = canonicalize_youtube_url(url)
        if canonical == url:
            message += " (Gemini saw HTML even after using the canonical YouTube watch URL.)"
        elif canonical:
            message += f" (Gemini saw HTML; canonical YouTube URL would be {canonical}.)"
        else:
            message += " (Gemini saw HTML; URL could not be canonicalized as YouTube.)"
    return ExtractionFailedError(message)


NON_PUBLIC_YOUTUBE_AVAILABILITIES = frozenset({
    "unlisted",
    "private",
    "needs_auth",
    "premium_only",
    "subscriber_only",
})


def validate_youtube_availability(availability: str | None) -> None:
    """Reject visibility states Gemini's direct YouTube input cannot read."""
    normalized = (availability or "").strip().lower()
    if normalized in NON_PUBLIC_YOUTUBE_AVAILABILITIES:
        raise ValueError(
            "Only public YouTube videos are supported by Gemini; "
            f"yt-dlp reported availability '{normalized}'. "
            "Please upload the video file to Chalkboard instead."
        )


def get_video_metadata(url: str) -> tuple[str, float, str | None]:
    """Get (title, duration, availability) from a YouTube URL via yt-dlp.

    Single probe via three --print flags — one network round-trip for all
    fields. Failures return ("", 0, None) (callers treat that as "unknown"),
    but we log yt-dlp's returncode + stderr tail so the symptom becomes
    diagnosable without redeploying. See KI-003.
    """
    try:
        r = subprocess.run(
            ["yt-dlp", *_ytdlp_proxy_args(),
             "--print", "%(title)s",
             "--print", "%(duration)s",
             "--print", "%(availability)s",
             "--no-playlist",
             "--no-download", url],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0:
            lines = r.stdout.splitlines()
            if len(lines) >= 2:
                title = lines[0].strip()
                try:
                    duration = float(lines[1].strip())
                except ValueError:
                    duration = 0.0
                availability = lines[2].strip().lower() if len(lines) >= 3 else None
                return title, duration, availability
        logger.warning(
            "yt-dlp metadata probe failed for %s (rc=%d). stderr tail: %s",
            url, r.returncode, (r.stderr or "").strip()[-2000:],
        )
    except (subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
        logger.warning("yt-dlp metadata probe raised %s for %s", type(e).__name__, url, exc_info=True)
    return "", 0.0, None


def get_local_video_duration(video_path: str) -> float:
    """Get duration from a local video file via ffprobe."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0 and r.stdout.strip():
            return float(r.stdout.strip())
    except:
        pass
    return 0


def download_captions(url: str, output_dir: str) -> str:
    """Download YouTube auto-captions as SRT. Returns path.

    Uses YT_DLP_PROXY env var when set (required from datacenter IPs — YouTube
    blocks Railway/AWS/GCP ranges). Set to a residential proxy URL like
    http://user:pass@p.webshare.io:80.
    """
    output_path = os.path.join(output_dir, "captions")
    for language in ("en-orig", "en"):
        r = subprocess.run([
            "yt-dlp", *_ytdlp_proxy_args(),
            "--write-auto-sub", "--sub-lang", language, "--sub-format", "srt",
            "--skip-download", "--no-playlist", "-o", output_path, url
        ], capture_output=True, text=True, timeout=120)
        srt_path = f"{output_path}.{language}.srt"
        if os.path.exists(srt_path):
            return srt_path
    # File not produced. Log the yt-dlp returncode + stderr/stdout tails so
    # we can distinguish "no captions available" from "proxy failed" from
    # "age-restricted" etc. without a second deploy. Tails included in the
    # raised error so the dashboard's run.error surfaces the real reason
    # too, not just a bare FileNotFoundError. See KI-003.
    stderr_tail = (r.stderr or "").strip()[-2000:]
    stdout_tail = (r.stdout or "").strip()[-2000:]
    logger.error(
        "yt-dlp caption download failed for %s (rc=%d). stderr tail: %s | stdout tail: %s",
        url, r.returncode, stderr_tail, stdout_tail,
    )
    raise FileNotFoundError(
        f"Could not download captions for {url} (yt-dlp rc={r.returncode}): "
        f"{stderr_tail[-500:] or '<empty stderr>'}"
    )


def upload_to_gemini(client, video_path: str, max_retries: int = 3):
    """Upload a local video to Gemini File API. Returns the File object.

    Gemini File API: 2GB limit, files expire after 48h.
    Upload once, reference in all chunk calls via file.uri.
    """
    logger.info(f"Uploading {video_path} to Gemini File API...")
    for attempt in range(max_retries):
        try:
            file = client.files.upload(file=video_path)
            break
        except Exception as e:
            if attempt < max_retries - 1:
                wait = 5 * (attempt + 1)
                logger.warning(f"  Upload attempt {attempt + 1} failed: {e}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise
    while file.state.name == "PROCESSING":
        time.sleep(5)
        file = client.files.get(name=file.name)
    if file.state.name == "FAILED":
        raise RuntimeError(f"Gemini file upload failed: {file.state}")
    logger.info(f"  Gemini file ready: {file.uri}")
    return file


def extract_transcript_chunk(client, url: str, start: float, end: float, context: str, model: str = DEFAULT_MODEL, fps: float = DEFAULT_FPS, accumulator=None, section_index: int | None = None, call_recorder=None):
    """Extract transcript for one topic section using the full v0.3 transcript prompt."""
    system = f"{TRANSCRIPT_SYSTEM_PROMPT}\n\n{context}"

    last_error = None
    for attempt in range(3):
        response = None
        started_at = time.time()
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps,
                    start_offset=f"{int(start)}s",
                    end_offset=f"{int(end)}s",
                ),
            )
            from src.extraction.schemas import SentenceListOutput
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=TRANSCRIPT_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=SentenceListOutput,
                ),
            )
            if accumulator is not None:
                accumulator.record(response, model=model, kind="transcript", section_index=section_index)
            parsed = SentenceListOutput.model_validate(response.parsed)
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="transcript",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=TRANSCRIPT_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="SentenceListOutput",
                    system_instruction=system,
                    user_prompt=TRANSCRIPT_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": TRANSCRIPT_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "SentenceListOutput",
                    },
                    response=response,
                    parsed=parsed,
                    item_count=len(parsed.sentences),
                )
            return [fix_latex_escapes(s.text.strip()) for s in parsed.sentences if s.text.strip()]
        except Exception as e:
            last_error = e
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="transcript",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=TRANSCRIPT_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="SentenceListOutput",
                    system_instruction=system,
                    user_prompt=TRANSCRIPT_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": TRANSCRIPT_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "SentenceListOutput",
                    },
                    response=response,
                    exception=e,
                )
            logger.warning(f"    Transcript chunk error: {e}, attempt {attempt + 1}/3")
            if attempt < 2:
                _sleep_before_retry(attempt, e)
    raise _extraction_failure("Transcript", url, 3, last_error or RuntimeError("unknown error"))


def extract_equations_chunk(client, url: str, start: float, end: float, context: str, model: str = DEFAULT_MODEL, fps: float = DEFAULT_FPS, accumulator=None, section_index: int | None = None, call_recorder=None):
    """Extract equations for one topic section."""
    system = f"{EQUATIONS_SYSTEM_PROMPT}\n\n{context}"

    last_error = None
    for attempt in range(3):
        response = None
        started_at = time.time()
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps,
                    start_offset=f"{int(start)}s",
                    end_offset=f"{int(end)}s",
                ),
            )
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=EQUATIONS_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=EquationExtractionOutput,
                ),
            )
            if accumulator is not None:
                accumulator.record(response, model=model, kind="equations", section_index=section_index)
            parsed = EquationExtractionOutput.model_validate(response.parsed)
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="equations",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=EQUATIONS_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="EquationExtractionOutput",
                    system_instruction=system,
                    user_prompt=EQUATIONS_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": EQUATIONS_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "EquationExtractionOutput",
                    },
                    response=response,
                    parsed=parsed,
                    item_count=len(parsed.equations),
                )
            return parsed.equations
        except Exception as e:
            last_error = e
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="equations",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=EQUATIONS_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="EquationExtractionOutput",
                    system_instruction=system,
                    user_prompt=EQUATIONS_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": EQUATIONS_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "EquationExtractionOutput",
                    },
                    response=response,
                    exception=e,
                )
            logger.warning(f"    Equation chunk error: {e}, attempt {attempt + 1}/3")
            if attempt < 2:
                _sleep_before_retry(attempt, e)
    raise _extraction_failure("Equation", url, 3, last_error or RuntimeError("unknown error"))


def extract_visual_content_chunk(client, url: str, start: float, end: float, context: str, model: str = DEFAULT_MODEL, fps: float = DEFAULT_FPS, accumulator=None, section_index: int | None = None, call_recorder=None):
    """Extract all visual content (equations, diagrams, charts, code, tables) for one topic section.

    Returns (items, summary) where summary is a HealSummary if any items
    needed healing, otherwise None. The tuple shape is uniform across all
    return paths — callers must always unpack two values.

    Healing is deterministic and synchronous (microseconds); replaces the
    Flash-Lite repair pass after empirical validation in 2026-05-01 showed
    deterministic rules cover every misplacement pattern observed in prod.
    """
    from src.extraction.healer import heal_run_items
    from src.extraction.validators import validate_item

    system = f"{VISUAL_CONTENT_SYSTEM_PROMPT}\n\n{context}"

    last_error = None
    for attempt in range(3):
        response = None
        started_at = time.time()
        try:
            vp = types.Part(
                file_data=types.FileData(file_uri=url),
                video_metadata=types.VideoMetadata(
                    fps=fps,
                    start_offset=f"{int(start)}s",
                    end_offset=f"{int(end)}s",
                ),
            )
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=VISUAL_CONTENT_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=VisualContentExtractionOutput,
                ),
            )
            if accumulator is not None:
                accumulator.record(response, model=model, kind="visual_content", section_index=section_index)
            parsed = VisualContentExtractionOutput.model_validate(response.parsed)
            items = parsed.items
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="visual_content",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=VISUAL_CONTENT_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="VisualContentExtractionOutput",
                    system_instruction=system,
                    user_prompt=VISUAL_CONTENT_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": VISUAL_CONTENT_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "VisualContentExtractionOutput",
                    },
                    response=response,
                    parsed=parsed,
                    item_count=len(items),
                )

            # Run validators; only enter heal pass if at least one item has an error.
            needs_heal = any(
                any(i.severity == "error" for i in validate_item(it))
                for it in items
            )
            if not needs_heal:
                return items, None

            summary = heal_run_items(items)
            if summary.healed_count or summary.skipped_count:
                logger.info(
                    f"    Heal: fixed={summary.healed_count}, skipped={summary.skipped_count}"
                )
            return summary.items, summary

        except Exception as e:
            last_error = e
            if call_recorder is not None:
                call_recorder.record_attempt(
                    kind="visual_content",
                    attempt=attempt + 1,
                    model=model,
                    started_at=started_at,
                    prompt_version=VISUAL_CONTENT_PROMPT_VERSION,
                    section_index=section_index,
                    start_time=start,
                    end_time=end,
                    fps=fps,
                    schema="VisualContentExtractionOutput",
                    system_instruction=system,
                    user_prompt=VISUAL_CONTENT_USER_PROMPT,
                    contents={"file_uri": url, "user_prompt": VISUAL_CONTENT_USER_PROMPT},
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": "VisualContentExtractionOutput",
                    },
                    response=response,
                    exception=e,
                )
            logger.warning(f"    Visual content chunk error: {e}, attempt {attempt + 1}/3")
            if attempt < 2:
                _sleep_before_retry(attempt, e)
    raise _extraction_failure("Visual content", url, 3, last_error or RuntimeError("unknown error"))


def _update_run_progress(session, run, status, call_recorder=None, **extra):
    """Update run status and progress in DB.

    Also acts as the cancellation checkpoint — refreshes cancel_requested
    from the DB (the API runs in a separate session, so the ORM-cached value
    is stale) and raises CancelledError if a cancel was requested. Raising
    *before* the commit means a last-millisecond cancel wins the race even
    against the final 'complete' transition.
    """
    from src.models.pipeline_run import RunStatus

    session.refresh(run, ["cancel_requested"])
    if run.cancel_requested:
        raise CancelledError(f"Cancel requested before stage transition to '{status}'")

    run.status = RunStatus(status)
    progress = dict(run.progress or {})
    progress.update(extra)
    run.progress = progress
    if call_recorder is not None:
        run.gemini_call_logs = call_recorder.summary()
    session.commit()


def _load_auto_captions(session, video_id) -> list[dict]:
    """Return the most recent persisted auto_captions for this video.

    Reprocess flows reuse the captions from the original `process` run rather
    than re-fetching from yt-dlp/Chirp — captions are immutable per video.
    Raises if no run carries captions; the caller should surface a clear
    "full reprocess required" error rather than silently regenerating.

    Filters on `status=complete` even though `auto_captions` is currently only
    written at the very end of `process_video` (~line 1027). The filter is
    defensive: if a future change persists captions earlier in the run
    lifecycle, we still don't want to reuse captions from a run that crashed
    before reaching `complete`.
    """
    from src.models.pipeline_run import PipelineRun, RunStatus
    row = (
        session.query(PipelineRun)
        .filter(
            PipelineRun.video_id == video_id,
            PipelineRun.auto_captions.isnot(None),
            PipelineRun.status == RunStatus.complete,
        )
        .order_by(PipelineRun.created_at.desc())
        .first()
    )
    if row is None or not row.auto_captions:
        raise RuntimeError(
            f"No persisted auto_captions found for video {video_id}. "
            "Run a full reprocess (run_type='reprocess') to regenerate captions before reprocessing a section."
        )
    return row.auto_captions


def _prepare_gemini_video_uri(client, *, youtube_url: str | None, r2_key: str | None,
                               tmpdir: str) -> str:
    """Return a video URI Gemini's FileData accepts.

    For YouTube videos: pass the URL straight through (Gemini handles it).
    For R2 uploads: download the bytes locally, upload to the Gemini Files API,
    and return that URI. Files API URIs expire (~48h TTL), so we always
    re-upload on each reprocess — do not cache.

    TODO(perf): for back-to-back reprocesses of multiple sections of the same
    upload, this re-downloads from R2 + re-uploads to Gemini per call. A small
    cache keyed on (video_id, r2_key) → (gemini_uri, expires_at) would cut
    that to one round-trip per video within the 48h TTL window.
    """
    if r2_key:
        from src.storage.r2 import download_file
        local_path = os.path.join(tmpdir, os.path.basename(r2_key))
        logger.info(f"  Downloading upload from R2: {r2_key}")
        download_file(r2_key, local_path)
        gemini_file = upload_to_gemini(client, local_path)
        return gemini_file.uri
    if not youtube_url:
        raise ValueError("Neither r2_key nor youtube_url provided for Gemini video URI")
    canonical_url = canonicalize_youtube_url_if_possible(youtube_url)
    if canonical_url != youtube_url:
        logger.info("  Canonicalized YouTube URL for Gemini: %s", canonical_url)
    return canonical_url


def reprocess_section(youtube_url: str, video_id: str, run_id: str,
                      section_index: int, start_time: float, end_time: float,
                      section_title: str, context: str,
                      model: str = DEFAULT_MODEL, fps: float = DEFAULT_FPS,
                      r2_key: str | None = None):
    """Reprocess a single section — creates a new scoped run with transcript + visual content."""
    from src.models.database import SessionLocal
    from src.models.video import Video, VideoStatus
    from src.models.pipeline_run import PipelineRun, RunStatus
    from src.models.segment import TranscriptSegment
    from src.models.equation import Equation as EquationModel
    from src.processing.merge import merge_equations_to_segments

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    session = SessionLocal()

    from src.extraction.usage import UsageAccumulator
    from src.extraction.call_logs import GeminiCallRecorder
    acc = UsageAccumulator()
    call_recorder = None

    # Create scoped run. Section reprocess only re-extracts visual content;
    # equations_prompt_version stays null because the equations prompt isn't
    # run here — the stamp on the parent process run already records that.
    run = PipelineRun(
        video_id=video_id,
        status=RunStatus.queued,
        pipeline_version="v2",
        transcript_prompt_version=TRANSCRIPT_PROMPT_VERSION,
        visual_content_prompt_version=VISUAL_CONTENT_PROMPT_VERSION,
        progress={
            "scope": "section",
            "section_index": section_index,
            "start_time": start_time,
            "end_time": end_time,
            "model": model,
            "fps": fps,
        },
    )
    if run_id:
        # Copy sections from parent run
        parent_run = session.query(PipelineRun).filter_by(id=run_id).first()
        if parent_run and parent_run.sections:
            run.sections = parent_run.sections
    session.add(run)
    session.commit()
    call_recorder = GeminiCallRecorder(str(run.id))
    logger.info(f"Created section run {run.id} for section {section_index} ({section_title})")

    try:
        _update_run_progress(session, run, "downloading_captions",
                             call_recorder=call_recorder,
                             stage="Loading captions from parent run")

        with tempfile.TemporaryDirectory() as tmpdir:
            captions = _load_auto_captions(session, video_id)
            logger.info(f"  Loaded {len(captions)} persisted captions from parent run")

            video_uri = _prepare_gemini_video_uri(
                client, youtube_url=youtube_url, r2_key=r2_key, tmpdir=tmpdir,
            )

            _update_run_progress(session, run, "processing_sections",
                                 call_recorder=call_recorder,
                                 stage=f"Processing: {section_title}",
                                 sections_total=1, sections_complete=0)

            # Extract transcript + visual content for this section
            logger.info(f"  Extracting transcript ({model}, {fps} fps)...")
            sents = extract_transcript_chunk(client, video_uri, start_time, end_time, context, model=model, fps=fps, accumulator=acc, section_index=section_index, call_recorder=call_recorder)

            logger.info(f"  Extracting visual content ({model}, {fps} fps)...")
            vc_items, chunk_summary = extract_visual_content_chunk(client, video_uri, start_time, end_time, context, model=model, fps=fps, accumulator=acc, section_index=section_index, call_recorder=call_recorder)

            _update_run_progress(session, run, "word_aligning",
                                 call_recorder=call_recorder,
                                 stage="Word-aligning")

            logger.info(f"  Word-aligning {len(sents)} sentences against persisted captions...")
            result = align_sentences_to_captions(sents, captions)
            if isinstance(result, tuple) and len(result) == 3:
                ts_list, merged_sents, alignment_meta = result
            elif isinstance(result, tuple):
                ts_list, merged_sents = result
                alignment_meta = {}
            else:
                ts_list = result
                merged_sents = sents
                alignment_meta = {}

            # Build segments
            segments = [
                {"id": f"seg-{i}", "text": s, "start": round(t[0], 1), "end": round(t[1], 1)}
                for i, (s, t) in enumerate(zip(merged_sents, ts_list))
            ]

            # Build visual content
            chunk_statuses = chunk_summary.statuses if chunk_summary else [None] * len(vc_items)
            vc_repair_status: dict[str, str] = {}  # vc_id -> 'fixed'/'failed' (None values not stored)
            visual_content = []
            for idx, item in enumerate(vc_items):
                try:
                    start = parse_timestamp(item.discussed_start)
                    end = parse_timestamp(item.discussed_end)
                except:
                    continue
                content_type = item.content_type
                latex = fix_latex_escapes(item.latex) if item.latex else ""
                content_meta = _build_content_meta(item)

                vc_id = f"vc-{len(visual_content)}"
                if chunk_statuses[idx]:
                    vc_repair_status[vc_id] = chunk_statuses[idx]
                visual_content.append({
                    "id": vc_id,
                    "contentType": content_type,
                    "latex": latex,
                    "description": item.description,
                    "start": start,
                    "end": end,
                    "confidence": item.confidence,
                    "section": section_title,
                    **content_meta,
                })

            _update_run_progress(session, run, "saving",
                                 call_recorder=call_recorder,
                                 stage="Saving")

            # Insert into DB
            db_segments = []
            for seg in segments:
                db_segments.append(TranscriptSegment(
                    video_id=video_id,
                    run_id=run.id,
                    text=seg["text"],
                    timestamp_start=seg["start"],
                    timestamp_end=seg["end"],
                ))
            session.add_all(db_segments)

            db_equations = []
            for vc in visual_content:
                content_meta = _build_content_meta(vc)
                status = vc_repair_status.get(vc["id"])
                if status:
                    content_meta = {**(content_meta or {}), "repair_status": status}
                db_equations.append(EquationModel(
                    video_id=video_id,
                    run_id=run.id,
                    content_type=vc["contentType"],
                    latex_string=vc.get("latex", ""),
                    description=vc["description"],
                    timestamp_start=vc["start"],
                    timestamp_end=vc["end"],
                    confidence=vc["confidence"],
                    content_metadata=content_meta or None,
                ))
            session.add_all(db_equations)

            session.flush()
            link_count = merge_equations_to_segments(session, str(video_id), str(run.id))

            run.segment_count = len(segments)
            run.equation_count = len(visual_content)

            alignment_summary = dict(alignment_meta) if alignment_meta else {}
            _update_run_progress(session, run, "complete",
                                 call_recorder=call_recorder,
                                 stage="Complete",
                                 sections_total=1, sections_complete=1,
                                 alignment=alignment_summary,
                                 usage=acc.summary())
            session.commit()

            eq_count = sum(1 for v in visual_content if v["contentType"] == "equation")
            logger.info(f"  Section reprocess done: {len(segments)} segments, {len(visual_content)} items ({eq_count} eq)")
            notify_pipeline_event(
                event="success", title=section_title, source=youtube_url,
                run_id=str(run.id), video_id=str(video_id),
                segment_count=len(segments), equation_count=len(visual_content),
                word_coverage=alignment_meta.get("word_coverage") if alignment_meta else None,
                run_type="reprocess_section",
            )
            return str(run.id)

    except CancelledError:
        # Cancellation propagates to the worker, which marks status=failed
        # with "Cancelled by user" — skip the failure Slack alert.
        raise
    except Exception:
        import traceback
        error_tb = traceback.format_exc()
        from src.models.pipeline_run import RunStatus as RS
        run.status = RS.failed
        run.error = error_tb
        run.progress = dict(run.progress or {}, stage="Failed", usage=acc.summary())
        if call_recorder is not None:
            run.gemini_call_logs = call_recorder.summary()
        session.commit()
        notify_pipeline_event(
            event="failure", title=section_title, source=youtube_url,
            run_id=str(run.id), video_id=str(video_id), error=error_tb,
            run_type="reprocess_section",
        )
        logger.exception("Section reprocess failed")
        raise
    finally:
        session.close()


def reprocess_visual_content(youtube_url: str, video_id: str, run_id: str | None,
                              start_time: float, end_time: float,
                              section_title: str, context: str,
                              model: str = DEFAULT_MODEL, fps: float = DEFAULT_FPS,
                              scope: str = "section", item_id: str | None = None,
                              r2_key: str | None = None):
    """Reprocess just visual content for a section or single item. No transcript re-extraction."""
    from src.models.database import SessionLocal
    from src.models.pipeline_run import PipelineRun, RunStatus
    from src.models.equation import Equation as EquationModel
    from src.processing.merge import merge_equations_to_segments

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    session = SessionLocal()

    from src.extraction.usage import UsageAccumulator
    from src.extraction.call_logs import GeminiCallRecorder
    acc = UsageAccumulator()
    call_recorder = None

    # Item reprocess only re-extracts visual content; see section-reprocess
    # comment above for why equations_prompt_version stays null.
    run = PipelineRun(
        video_id=video_id,
        status=RunStatus.queued,
        pipeline_version="v2",
        visual_content_prompt_version=VISUAL_CONTENT_PROMPT_VERSION,
        progress={
            "scope": scope,
            "start_time": start_time,
            "end_time": end_time,
            "model": model,
            "fps": fps,
            "item_id": item_id,
        },
    )
    if run_id:
        parent_run = session.query(PipelineRun).filter_by(id=run_id).first()
        if parent_run and parent_run.sections:
            run.sections = parent_run.sections
    session.add(run)
    session.commit()
    call_recorder = GeminiCallRecorder(str(run.id))
    logger.info(f"Created visual content run {run.id} ({scope}: {section_title})")

    try:
        _update_run_progress(session, run, "processing_sections",
                             call_recorder=call_recorder,
                             stage=f"Extracting visual content ({model})")

        with tempfile.TemporaryDirectory() as tmpdir:
            video_uri = _prepare_gemini_video_uri(
                client, youtube_url=youtube_url, r2_key=r2_key, tmpdir=tmpdir,
            )
            vc_items, chunk_summary = extract_visual_content_chunk(client, video_uri, start_time, end_time, context, model=model, fps=fps, accumulator=acc, call_recorder=call_recorder)

        _update_run_progress(session, run, "saving",
                             call_recorder=call_recorder,
                             stage="Saving")

        chunk_statuses = chunk_summary.statuses if chunk_summary else [None] * len(vc_items)
        # reprocess_visual_content's visual_content dicts don't have stable
        # 'id' keys (no f"vc-{N}" assignment), so track repair_status by
        # parallel index — list aligns with visual_content via skip-on-error.
        visual_content = []
        visual_content_statuses: list[str | None] = []
        for idx, item in enumerate(vc_items):
            try:
                start = parse_timestamp(item.discussed_start)
                end = parse_timestamp(item.discussed_end)
            except:
                continue
            latex = fix_latex_escapes(item.latex) if item.latex else ""
            content_meta = _build_content_meta(item)

            visual_content.append({
                "contentType": item.content_type,
                "latex": latex,
                "description": item.description,
                "start": start,
                "end": end,
                "confidence": item.confidence,
                **content_meta,
            })
            visual_content_statuses.append(chunk_statuses[idx])

        db_equations = []
        for vc, status in zip(visual_content, visual_content_statuses):
            content_meta = _build_content_meta(vc)
            if status:
                content_meta = {**(content_meta or {}), "repair_status": status}
            db_equations.append(EquationModel(
                video_id=video_id,
                run_id=run.id,
                content_type=vc["contentType"],
                latex_string=vc.get("latex", ""),
                description=vc["description"],
                timestamp_start=vc["start"],
                timestamp_end=vc["end"],
                confidence=vc["confidence"],
                content_metadata=content_meta or None,
            ))
        session.add_all(db_equations)
        session.flush()

        run.equation_count = len(visual_content)
        eq_count = sum(1 for v in visual_content if v["contentType"] == "equation")
        _update_run_progress(session, run, "complete",
                             call_recorder=call_recorder,
                             stage="Complete", model=model,
                             equation_count=eq_count,
                             total_items=len(visual_content),
                             usage=acc.summary())
        session.commit()

        logger.info(f"  Visual content reprocess done: {len(visual_content)} items ({eq_count} eq)")
        notify_pipeline_event(
            event="success", title=section_title, source=youtube_url,
            run_id=str(run.id), video_id=str(video_id),
            equation_count=len(visual_content),
            run_type="reprocess_visual",
        )
        return str(run.id)

    except CancelledError:
        # Cancellation propagates to the worker; skip the failure Slack alert.
        raise
    except Exception:
        import traceback
        error_tb = traceback.format_exc()
        run.status = RunStatus.failed
        run.error = error_tb
        run.progress = dict(run.progress or {}, stage="Failed", usage=acc.summary())
        if call_recorder is not None:
            run.gemini_call_logs = call_recorder.summary()
        session.commit()
        notify_pipeline_event(
            event="failure", title=section_title, source=youtube_url,
            run_id=str(run.id), video_id=str(video_id), error=error_tb,
            run_type="reprocess_visual",
        )
        logger.exception("Visual content reprocess failed")
        raise
    finally:
        session.close()


@dataclass
class ProcessResult:
    """In-memory return shape for process_video when return_payload=True.

    Used by the CI eval runner (`pipeline/scripts/eval_runner.py`) to score
    extraction outputs without writing to the DB or polluting the
    `viewer/public/demo/` directory with fake baselines.

    visual_content_items is a list of DICTS (camelCase keys, matching what
    gets persisted to DB and demo JSON), NOT Pydantic instances —
    process_video builds the list as dicts via _build_content_meta.
    Callers should NOT call .model_dump() on these.
    """
    visual_content_items: list[dict] = field(default_factory=list)
    transcript_segments: list[dict] = field(default_factory=list)
    sections: list = field(default_factory=list)
    duration: float = 0.0


def process_video(source: str, title: str | None = None,
                  db_mode: bool = False, run_id: str | None = None,
                  visual_content_mode: bool = True, model: str = DEFAULT_MODEL,
                  video_url: str | None = None, fps: float = DEFAULT_FPS,
                  return_payload: bool = False) -> "ProcessResult | str | None":
    """Process a YouTube URL or local video file.

    Args:
        source: YouTube URL or path to a local video file.
        title: Video title. Required for local files. For YouTube URLs it's
            optional — if omitted, we probe yt-dlp for the real title (see
            get_video_metadata). URL is used as last-resort fallback.
        video_url: Public URL for playback (R2, etc). Used in demo JSON for local files.
        return_payload: When True, return a ProcessResult with the in-memory
            extraction output AND skip the demo-JSON disk write. Used by the
            eval runner. db_mode and return_payload are mutually exclusive
            in practice; return_payload always wins (we return BEFORE the
            persist block).
    """
    pipeline_start = time.time()
    local_mode = is_local_video(source)
    youtube_url = None if local_mode else canonicalize_youtube_url_if_possible(source)
    if youtube_url and youtube_url != source:
        logger.info("Canonicalized YouTube source: %s", youtube_url)
        source = youtube_url
    video_path = source if local_mode else None

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    from src.extraction.usage import UsageAccumulator
    from src.extraction.call_logs import GeminiCallRecorder
    acc = UsageAccumulator()
    call_recorder = None

    # DB setup
    session = None
    run = None
    video_record = None
    if db_mode:
        from src.models.database import SessionLocal
        from src.models.video import Video, VideoStatus
        from src.models.pipeline_run import PipelineRun, RunStatus
        from src.models.segment import TranscriptSegment
        from src.models.equation import Equation as EquationModel
        from src.processing.merge import merge_equations_to_segments

        session = SessionLocal()

        if run_id:
            run = session.query(PipelineRun).filter_by(id=run_id).first()
            if not run:
                raise ValueError(f"Run {run_id} not found")
            run.transcript_prompt_version = TRANSCRIPT_PROMPT_VERSION
            run.equations_prompt_version = EQUATIONS_PROMPT_VERSION
            run.visual_content_prompt_version = VISUAL_CONTENT_PROMPT_VERSION
            run.progress = dict(run.progress or {}, model=model, fps=fps)
            session.commit()
            call_recorder = GeminiCallRecorder(str(run.id))
            video_record = session.query(Video).filter_by(id=run.video_id).first()
            if video_record and youtube_url and video_record.youtube_url != youtube_url:
                video_record.youtube_url = youtube_url
                session.commit()
        else:
            # Find or create video record
            lookup_url = youtube_url or video_url or source
            video_record = session.query(Video).filter_by(youtube_url=lookup_url).first()
            if not video_record:
                video_record = Video(
                    title=title or lookup_url,
                    youtube_url=lookup_url,
                    duration=0.0,
                    status=VideoStatus.processing,
                )
                session.add(video_record)
                session.commit()

            run = PipelineRun(
                video_id=video_record.id,
                status=RunStatus.queued,
                pipeline_version="v2",
                transcript_prompt_version=TRANSCRIPT_PROMPT_VERSION,
                equations_prompt_version=EQUATIONS_PROMPT_VERSION,
                visual_content_prompt_version=VISUAL_CONTENT_PROMPT_VERSION,
                progress={"model": model, "fps": fps},
            )
            session.add(run)
            session.commit()
            call_recorder = GeminiCallRecorder(str(run.id))
            logger.info(f"Created run {run.id}")

    try:
        # Step 1: Get duration (and title for YouTube)
        if local_mode:
            duration = get_local_video_duration(video_path)
        else:
            yt_title, duration, availability = get_video_metadata(youtube_url)
            validate_youtube_availability(availability)
            # Use the real YouTube title as the fallback when the caller didn't
            # supply one. The downstream fallbacks at video_record.title /
            # demo JSON / Slack notifications then auto-pick this up. URL
            # remains the absolute last resort if the probe failed.
            if not title and yt_title:
                title = yt_title
                logger.info(f"Fetched YouTube title: {title}")
        logger.info(f"Video duration: {int(duration)}s ({int(duration//60)}:{int(duration%60):02d})")

        # For local files, upload to Gemini File API once
        gemini_file = None
        if local_mode:
            gemini_file = upload_to_gemini(client, video_path)
            # Use the Gemini file URI for all extraction calls
            video_uri = gemini_file.uri
        else:
            video_uri = youtube_url

        # Step 2: Get captions
        if run:
            _update_run_progress(session, run, "downloading_captions",
                                 call_recorder=call_recorder,
                                 stage="Generating captions (Chirp 3)" if local_mode else "Downloading captions")

        with tempfile.TemporaryDirectory() as tmpdir:
            if local_mode:
                logger.info("Generating captions via Chirp 3...")
                from src.extraction.chirp import generate_srt_from_video
                srt_path = generate_srt_from_video(video_path, output_dir=tmpdir)
            else:
                logger.info("Downloading YouTube captions...")
                srt_path = download_captions(youtube_url, tmpdir)
            logger.info(f"  Captions: {srt_path}")

            # Step 3: Generate topic map from YouTube captions
            if run:
                _update_run_progress(session, run, "generating_topic_map",
                                     call_recorder=call_recorder,
                                     stage="Generating topic map")
            logger.info("Generating topic map...")
            topic_map = generate_topic_map(
                srt_path,
                accumulator=acc,
                call_recorder=call_recorder,
                model=model,
            )
            chunks = get_chunk_boundaries(topic_map, duration)
            logger.info(f"  {len(chunks)} sections, summary: {topic_map.get('summary', 'N/A')[:60]}")

            # Step 4: Process transcript + equations in parallel using topic chunks
            if run:
                _update_run_progress(session, run, "processing_sections",
                                     call_recorder=call_recorder,
                                     stage="Processing sections",
                                     sections_total=len(chunks), sections_complete=0)
            logger.info(f"Processing {len(chunks)} sections (transcript + equations in parallel)...")

            all_transcript_sentences = {}
            all_visual_content = {}
            sections_complete = 0
            stop_sections = threading.Event()

            def process_section(idx, start, end, section_title, context):
                if stop_sections.is_set():
                    raise ExtractionFailedError("Skipping section because another section failed.")
                logger.info(f"  [{idx+1}/{len(chunks)}] {section_title} ({int(start)}s-{int(end)}s)")
                sents = extract_transcript_chunk(client, video_uri, start, end, context, model=model, fps=fps, accumulator=acc, section_index=idx, call_recorder=call_recorder)
                if stop_sections.is_set():
                    raise ExtractionFailedError("Stopping section before visual extraction because another section failed.")
                chunk_summary = None
                if visual_content_mode:
                    items, chunk_summary = extract_visual_content_chunk(client, video_uri, start, end, context, model=model, fps=fps, accumulator=acc, section_index=idx, call_recorder=call_recorder)
                else:
                    # Legacy equation-only path doesn't run validators/repair.
                    items = extract_equations_chunk(client, video_uri, start, end, context, model=model, fps=fps, accumulator=acc, section_index=idx, call_recorder=call_recorder)
                return idx, sents, items, chunk_summary, section_title

            max_workers = _pipeline_max_workers()
            logger.info("Processing sections with %s workers", max_workers)
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(process_section, i, s, e, t, ctx): i
                    for i, (s, e, t, ctx) in enumerate(chunks)
                }
                for future in as_completed(futures):
                    try:
                        idx, sents, items, chunk_summary, section_title = future.result()
                    except Exception:
                        stop_sections.set()
                        cancelled = sum(
                            pending.cancel()
                            for pending in futures
                            if pending is not future and not pending.done()
                        )
                        if cancelled:
                            logger.warning("Cancelled %s pending section(s) after extraction failure.", cancelled)
                        raise
                    all_transcript_sentences[idx] = sents
                    all_visual_content[idx] = (items, chunk_summary, section_title)
                    sections_complete += 1
                    if run:
                        _update_run_progress(session, run, "processing_sections",
                                             call_recorder=call_recorder,
                                             stage="Processing sections",
                                             sections_total=len(chunks),
                                             sections_complete=sections_complete,
                                             usage=acc.summary())

            # Merge transcript in order
            sentences = []
            for i in range(len(chunks)):
                sentences.extend(all_transcript_sentences[i])
            logger.info(f"  Total transcript: {len(sentences)} sentences")
            if not sentences:
                raise ExtractionFailedError(
                    "Transcript extraction produced zero sentences for the full run; "
                    "failing instead of saving an empty complete run."
                )

            # Step 5: Word-align transcript against YouTube captions
            if run:
                _update_run_progress(session, run, "word_aligning",
                                     call_recorder=call_recorder,
                                     stage="Word-aligning transcript")
            logger.info("Word-aligning transcript...")
            result = align_sentences_to_timestamps(sentences, srt_path)
            if isinstance(result, tuple) and len(result) == 3:
                ts_list, merged_sents, alignment_meta = result
            elif isinstance(result, tuple):
                ts_list, merged_sents = result
                alignment_meta = {}
            else:
                ts_list = result
                merged_sents = sentences
                alignment_meta = {}

            segments = [
                {"id": f"seg-{i}", "text": s, "start": round(t[0], 1), "end": round(t[1], 1)}
                for i, (s, t) in enumerate(zip(merged_sents, ts_list))
            ]
            logger.info(f"  Aligned: {len(segments)} segments")

            # Merge visual content in order
            vc_repair_status: dict[str, str] = {}  # vc_id -> 'fixed'/'failed'
            visual_content = []
            for i in range(len(chunks)):
                items, chunk_summary, section_title = all_visual_content[i]
                chunk_statuses = chunk_summary.statuses if chunk_summary else [None] * len(items)
                for idx, item in enumerate(items):
                    try:
                        if visual_content_mode:
                            start = parse_timestamp(item.discussed_start)
                            end = parse_timestamp(item.discussed_end)
                            content_type = item.content_type
                            latex = fix_latex_escapes(item.latex) if item.latex else ""
                            description = item.description
                            confidence = item.confidence
                            content_meta = _build_content_meta(item)
                        else:
                            # Legacy equation-only mode
                            start = parse_timestamp(item.discussed_start)
                            end = parse_timestamp(item.discussed_end)
                            content_type = "equation"
                            latex = fix_latex_escapes(item.latex)
                            description = item.description
                            confidence = item.confidence
                            content_meta = {}
                    except:
                        continue
                    vc_id = f"vc-{len(visual_content)}"
                    if chunk_statuses[idx]:
                        vc_repair_status[vc_id] = chunk_statuses[idx]
                    vc_item = {
                        "id": vc_id,
                        "contentType": content_type,
                        "latex": latex,
                        "description": description,
                        "start": start,
                        "end": end,
                        "confidence": confidence,
                        "section": section_title,
                    }
                    if content_meta:
                        vc_item.update(content_meta)
                    visual_content.append(vc_item)
            visual_content.sort(key=lambda e: e["start"])

            # Split into equations (backward compat) and full visual content
            equations = [
                {
                    "id": f"eq-{i}",
                    "latex": item["latex"],
                    "description": item["description"],
                    "start": item["start"],
                    "end": item["end"],
                    "confidence": item["confidence"],
                    "section": item["section"],
                }
                for i, item in enumerate(vc for vc in visual_content if vc["contentType"] == "equation")
            ]

            eq_count = len(equations)
            other_count = len(visual_content) - eq_count
            logger.info(f"  Visual content: {len(visual_content)} items ({eq_count} equations, {other_count} other)")

            # Step 6: Save
            if run:
                _update_run_progress(session, run, "saving",
                                     call_recorder=call_recorder,
                                     stage="Saving results")

            # Build auto-captions from SRT
            auto_captions = []
            with open(srt_path) as f:
                content = f.read()
            for block in re.split(r'\n\n+', content.strip()):
                lines = block.strip().split('\n')
                if len(lines) < 3:
                    continue
                m = re.match(r'(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)', lines[1])
                if not m:
                    continue
                g = m.groups()
                s = int(g[0])*3600 + int(g[1])*60 + int(g[2]) + int(g[3])/1000
                e = int(g[4])*3600 + int(g[5])*60 + int(g[6]) + int(g[7])/1000
                text = ' '.join(lines[2:]).strip()
                if text:
                    auto_captions.append({"start": round(s, 1), "end": round(e, 1), "text": text})

            # Build demo JSON identity fields
            if local_mode:
                file_id = uuid.uuid4().hex[:12]
                demo = {
                    "videoUrl": video_url or f"file://{os.path.abspath(video_path)}",
                    "title": title or topic_map.get("summary", source),
                    "duration": duration,
                    "segments": segments,
                    "equations": equations,
                    "visualContent": visual_content,
                    "autoCaptions": auto_captions,
                    "sections": topic_map["sections"],
                    "alignmentMeta": alignment_meta,
                }
            else:
                vid_match = re.search(r'(?:youtu\.be/|[?&]v=)([^&\s]+)', youtube_url)
                file_id = vid_match.group(1) if vid_match else "unknown"
                demo = {
                    "videoId": file_id,
                    "title": title or topic_map.get("summary", youtube_url),
                    "youtubeUrl": youtube_url,
                    "duration": duration,
                    "segments": segments,
                    "equations": equations,
                    "visualContent": visual_content,
                    "autoCaptions": auto_captions,
                    "sections": topic_map["sections"],
                    "alignmentMeta": alignment_meta,
                }

            # Eval-runner path: return in-memory payload BEFORE any disk/DB
            # side effect runs. Skips the demo write below and the DB insert
            # block. Returns a ProcessResult — the function's return type is
            # widened from `str | None` to `ProcessResult | str | None`.
            if return_payload:
                return ProcessResult(
                    visual_content_items=visual_content,
                    transcript_segments=segments,
                    sections=topic_map.get("sections", []),
                    duration=duration,
                )

            # Save demo JSON (skip in db_mode — container may not have viewer/ dir)
            if not db_mode:
                output_path = Path(__file__).resolve().parents[2] / "viewer" / "public" / "demo" / f"{file_id}.json"
                with open(output_path, "w") as f:
                    json.dump(demo, f, indent=2)

            # Save to DB if in db mode
            if db_mode and session and run and video_record:
                video_record.duration = duration
                video_record.title = title or topic_map.get("summary", source)
                video_record.status = VideoStatus.complete

                # Insert segments
                db_segments = []
                for seg in segments:
                    db_seg = TranscriptSegment(
                        video_id=video_record.id,
                        run_id=run.id,
                        text=seg["text"],
                        timestamp_start=seg["start"],
                        timestamp_end=seg["end"],
                    )
                    db_segments.append(db_seg)
                session.add_all(db_segments)

                # Insert visual content (equations + other types)
                db_equations = []
                for vc in visual_content:
                    content_meta = _build_content_meta(vc)
                    status = vc_repair_status.get(vc["id"])
                    if status:
                        content_meta = {**(content_meta or {}), "repair_status": status}

                    db_eq = EquationModel(
                        video_id=video_record.id,
                        run_id=run.id,
                        content_type=vc["contentType"],
                        latex_string=vc.get("latex", ""),
                        description=vc["description"],
                        timestamp_start=vc["start"],
                        timestamp_end=vc["end"],
                        confidence=vc["confidence"],
                        content_metadata=content_meta or None,
                    )
                    db_equations.append(db_eq)
                session.add_all(db_equations)

                session.flush()
                link_count = merge_equations_to_segments(session, str(video_record.id), str(run.id))
                logger.info(f"  Linked {link_count} segment-equation pairs")

                run.segment_count = len(segments)
                run.equation_count = len(visual_content)
                run.sections = topic_map["sections"]
                run.auto_captions = auto_captions
                alignment_summary = dict(alignment_meta) if alignment_meta else {}
                _update_run_progress(session, run, "complete",
                                     call_recorder=call_recorder,
                                     stage="Complete",
                                     sections_total=len(chunks),
                                     sections_complete=len(chunks),
                                     alignment=alignment_summary,
                                     usage=acc.summary())
                session.commit()

            logger.info(f"\n=== DONE ===")
            logger.info(f"Transcript: {len(segments)} segments (word-aligned)")
            logger.info(f"Sections: {len(topic_map['sections'])} topics")
            logger.info(f"Visual content: {len(visual_content)} ({eq_count} equations, {other_count} other)")
            if not db_mode:
                logger.info(f"Saved: {output_path}")

            notify_pipeline_event(
                event="success",
                title=title or source,
                source=source,
                run_id=str(run.id) if run else None,
                video_id=str(video_record.id) if video_record else None,
                segment_count=len(segments),
                equation_count=len(visual_content),
                word_coverage=alignment_meta.get("word_coverage") if alignment_meta else None,
                duration_secs=time.time() - pipeline_start,
            )

            return str(run.id) if run else str(output_path)

    except CancelledError:
        # Cancellation propagates to the worker; skip the failure Slack alert
        # and the video_record.status=failed transition (the run row alone
        # captures the cancellation; the video can be retried).
        raise
    except Exception:
        import traceback as tb_mod
        error_tb = tb_mod.format_exc()
        if session:
            from src.models.pipeline_run import RunStatus
            from src.models.video import VideoStatus as VS
            if run:
                run.status = RunStatus.failed
                run.error = error_tb
                run.progress = dict(run.progress or {}, stage="Failed", usage=acc.summary())
                if call_recorder is not None:
                    run.gemini_call_logs = call_recorder.summary()
            if video_record:
                video_record.status = VS.failed
            session.commit()
        notify_pipeline_event(
            event="failure",
            title=title or source,
            source=source,
            run_id=str(run.id) if run else None,
            video_id=str(video_record.id) if video_record else None,
            error=error_tb,
        )
        logger.exception("Pipeline failed")
        raise
    finally:
        if session:
            session.close()


def main():
    parser = argparse.ArgumentParser(description="Chalkboard v2 — topic-aware processing")
    parser.add_argument("source", help="YouTube video URL or path to local video file")
    parser.add_argument("--title", default=None, help="Video title (required for local files)")
    parser.add_argument("--video-url", default=None,
                        help="Public playback URL (R2, etc.) for local files. Stored in demo JSON.")
    parser.add_argument("--db", action="store_true", help="Write results to database")
    parser.add_argument("--run-id", default=None, help="Existing run ID to resume")
    parser.add_argument("--equations-only", action="store_true", help="Use equation-only extraction (legacy)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model to use (default: {DEFAULT_MODEL})")
    parser.add_argument("--fps", type=float, default=DEFAULT_FPS, help=f"Gemini video sampling FPS (default: {DEFAULT_FPS})")
    args = parser.parse_args()

    process_video(args.source, args.title, db_mode=args.db, run_id=args.run_id,
                  visual_content_mode=not args.equations_only, model=args.model,
                  video_url=args.video_url, fps=args.fps)


if __name__ == "__main__":
    main()
