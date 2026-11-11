"""Merge step: link equations to transcript segments by discussed-timestamp overlap."""

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.models.equation import Equation

logger = logging.getLogger(__name__)


def sanity_check_equations(equations: list[Equation], video_duration: float) -> list[Equation]:
    """Filter out equations with suspicious timestamps.

    Rejects equations where:
    - timestamp_start < 0
    - timestamp_end > video_duration
    - duration < 1 second (suspiciously short)
    - duration > 50% of video length (suspiciously wide)
    """
    valid = []
    for eq in equations:
        duration = eq.timestamp_end - eq.timestamp_start

        if eq.timestamp_start < 0:
            logger.warning(f"Rejected equation (start < 0): {eq.latex_string[:50]}... start={eq.timestamp_start}")
            continue
        if eq.timestamp_end > video_duration:
            logger.warning(f"Rejected equation (end > duration): {eq.latex_string[:50]}... end={eq.timestamp_end} > {video_duration}")
            continue
        if duration < 1.0:
            logger.warning(f"Rejected equation (too short): {eq.latex_string[:50]}... duration={duration:.1f}s")
            continue
        if duration > video_duration * 0.5:
            logger.warning(f"Rejected equation (too wide): {eq.latex_string[:50]}... duration={duration:.1f}s > 50% of video")
            continue

        valid.append(eq)

    rejected = len(equations) - len(valid)
    if rejected:
        logger.info(f"Sanity check: {rejected}/{len(equations)} equations rejected")

    return valid


def merge_equations_to_segments(session: Session, video_id: str, run_id: str | None = None) -> int:
    """Link equations to transcript segments by discussed-timestamp overlap.

    If run_id is provided, only links segments and equations from that run.
    Returns the number of links created.
    """
    if run_id:
        result = session.execute(
            text("""
                INSERT INTO segment_equations (segment_id, equation_id)
                SELECT s.id, e.id
                FROM transcript_segments s
                JOIN equations e ON e.video_id = s.video_id
                  AND e.run_id = s.run_id
                  AND e.timestamp_start < s.timestamp_end
                  AND e.timestamp_end > s.timestamp_start
                WHERE s.video_id = :video_id AND s.run_id = :run_id
                ON CONFLICT DO NOTHING
            """),
            {"video_id": video_id, "run_id": run_id},
        )
    else:
        result = session.execute(
            text("""
                INSERT INTO segment_equations (segment_id, equation_id)
                SELECT s.id, e.id
                FROM transcript_segments s
                JOIN equations e ON e.video_id = s.video_id
                  AND e.timestamp_start < s.timestamp_end
                  AND e.timestamp_end > s.timestamp_start
                WHERE s.video_id = :video_id
                ON CONFLICT DO NOTHING
            """),
            {"video_id": video_id},
        )
    return result.rowcount
