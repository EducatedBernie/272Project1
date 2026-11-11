"""
Chalkboard — Process a YouTube lecture video.

Usage:
    python scripts/process_video.py <youtube-url> [--title "Lecture Title"]
"""

import argparse
import json
import logging
import subprocess
import sys
import time
import uuid
from pathlib import Path

# Add pipeline/ to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from sqlalchemy.orm import Session

from src.extraction.gemini import extract_equations, extract_transcript, parse_timestamp
from src.extraction.latex_fix import fix_latex_escapes
from src.extraction.prompts import EQUATIONS_PROMPT_VERSION, TRANSCRIPT_PROMPT_VERSION
from src.models import Base, Video, VideoStatus, TranscriptSegment, Equation, segment_equations
from src.models.database import SessionLocal
from src.processing.merge import merge_equations_to_segments, sanity_check_equations

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("chalkboard")


def get_video_duration(youtube_url: str) -> float | None:
    """Get video duration in seconds using yt-dlp."""
    try:
        result = subprocess.run(
            ["yt-dlp", "--print", "duration", "--no-download", youtube_url],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass
    return None


def process_video(youtube_url: str, title: str | None = None) -> str:
    """Process a YouTube lecture video end-to-end.

    Returns the video UUID.
    """
    session: Session = SessionLocal()
    video = None

    try:
        # Step 1: Create video record
        video = Video(
            id=uuid.uuid4(),
            title=title or youtube_url,
            youtube_url=youtube_url,
            duration=0.0,  # updated after extraction
            status=VideoStatus.processing,
        )
        session.add(video)
        session.commit()
        logger.info(f"Created video record: {video.id}")

        # Get video duration for chunking decision
        video_duration_hint = get_video_duration(youtube_url)
        if video_duration_hint:
            logger.info(f"Video duration: {int(video_duration_hint)}s ({int(video_duration_hint//60)}:{int(video_duration_hint%60):02d})")

        # Step 2: Gemini Pass 1 — transcript extraction (chunked for long videos)
        logger.info("Pass 1: Extracting transcript...")
        transcript_output, transcript_raw = extract_transcript(youtube_url, duration=video_duration_hint)
        logger.info(f"Got {len(transcript_output.segments)} transcript segments")

        # Step 3: Gemini Pass 2 — equation extraction
        logger.info("Pass 2: Extracting equations...")
        equations_output, equations_raw = extract_equations(youtube_url)
        logger.info(f"Got {len(equations_output.equations)} equations")

        # Parse transcript segments
        segments = []
        for seg in transcript_output.segments:
            start = parse_timestamp(seg.start_time)
            end = parse_timestamp(seg.end_time)
            segments.append(
                TranscriptSegment(
                    video_id=video.id,
                    text=fix_latex_escapes(seg.text),
                    timestamp_start=start,
                    timestamp_end=end,
                )
            )

        # Parse equations
        equations = []
        for eq in equations_output.equations:
            start = parse_timestamp(eq.discussed_start)
            end = parse_timestamp(eq.discussed_end)
            equations.append(
                Equation(
                    video_id=video.id,
                    latex_string=fix_latex_escapes(eq.latex),
                    description=eq.description,
                    timestamp_start=start,
                    timestamp_end=end,
                    confidence=eq.confidence,
                )
            )

        # Estimate video duration from the latest timestamp
        all_ends = [s.timestamp_end for s in segments] + [e.timestamp_end for e in equations]
        video_duration = max(all_ends) if all_ends else 0.0

        # Step 4: Sanity-check equation timestamps
        equations = sanity_check_equations(equations, video_duration)
        logger.info(f"{len(equations)} equations passed sanity check")

        # Step 5: Write everything in a single transaction
        video.duration = video_duration
        video.raw_gemini_transcript_json = transcript_raw
        video.raw_gemini_equations_json = equations_raw
        video.transcript_prompt_version = TRANSCRIPT_PROMPT_VERSION
        video.equations_prompt_version = EQUATIONS_PROMPT_VERSION

        session.add_all(segments)
        session.add_all(equations)
        session.flush()

        # Step 6: Merge — link equations to segments by timestamp overlap
        link_count = merge_equations_to_segments(session, str(video.id))
        logger.info(f"Created {link_count} equation-segment links")

        video.status = VideoStatus.complete
        session.commit()

        logger.info(f"Done! Video ID: {video.id}")
        return str(video.id)

    except Exception:
        if video is not None:
            video.status = VideoStatus.failed
            session.commit()
        logger.exception("Pipeline failed")
        raise
    finally:
        session.close()


def main():
    parser = argparse.ArgumentParser(description="Process a YouTube lecture video through Chalkboard")
    parser.add_argument("youtube_url", help="YouTube video URL")
    parser.add_argument("--title", default=None, help="Video title (auto-detected if not provided)")
    args = parser.parse_args()

    video_id = process_video(args.youtube_url, args.title)
    print(f"\n{video_id}")


if __name__ == "__main__":
    main()
