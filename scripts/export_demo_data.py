"""Export processed video data to static JSON for the landing page demo.

Usage:
    python scripts/export_demo_data.py <video-id> [<video-id> ...]
    python scripts/export_demo_data.py --all

Exports segments + visual content + sections to viewer/public/demo/{youtube-video-id}.json
Uses the latest complete pipeline run for each video.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from src.models import *
from src.models.database import SessionLocal
from src.models.pipeline_run import PipelineRun, RunStatus


def extract_youtube_id(url: str) -> str:
    for pattern in [r'youtu\.be/([^?&\s]+)', r'[?&]v=([^&\s]+)']:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return "unknown"


def export_video(video_id: str, output_dir: Path):
    session = SessionLocal()
    video = session.query(Video).filter_by(id=video_id).first()
    if not video:
        print(f"Video {video_id} not found")
        return

    # Get latest complete run for sections and to scope segments/equations
    latest_run = (
        session.query(PipelineRun)
        .filter_by(video_id=video.id, status=RunStatus.complete)
        .order_by(PipelineRun.created_at.desc())
        .first()
    )

    run_id = latest_run.id if latest_run else None

    # Query segments — scoped to latest run if available
    seg_query = session.query(TranscriptSegment).filter_by(video_id=video.id)
    if run_id:
        seg_query = seg_query.filter_by(run_id=run_id)
    segments = seg_query.order_by(TranscriptSegment.timestamp_start).all()

    # Query equations/visual content — scoped to latest run if available
    eq_query = session.query(Equation).filter_by(video_id=video.id)
    if run_id:
        eq_query = eq_query.filter_by(run_id=run_id)
    all_items = eq_query.order_by(Equation.timestamp_start).all()

    yt_id = extract_youtube_id(video.youtube_url)

    # Build equations list (backward compat — equation-type items only)
    equations = []
    for i, e in enumerate(item for item in all_items if item.content_type == "equation"):
        equations.append({
            "id": f"eq-{i}",
            "latex": e.latex_string,
            "description": e.description,
            "start": e.timestamp_start,
            "end": e.timestamp_end,
            "confidence": e.confidence,
        })

    # Build full visual content list
    visual_content = []
    for i, e in enumerate(all_items):
        vc = {
            "id": f"vc-{i}",
            "contentType": e.content_type,
            "latex": e.latex_string,
            "description": e.description,
            "start": e.timestamp_start,
            "end": e.timestamp_end,
            "confidence": e.confidence,
        }
        if e.content_metadata:
            if e.content_metadata.get("code"):
                vc["code"] = e.content_metadata["code"]
            if e.content_metadata.get("language"):
                vc["language"] = e.content_metadata["language"]
            if e.content_metadata.get("headers"):
                vc["headers"] = e.content_metadata["headers"]
            if e.content_metadata.get("rows"):
                vc["rows"] = e.content_metadata["rows"]
        visual_content.append(vc)

    # Sections from the pipeline run
    sections = latest_run.sections if latest_run and latest_run.sections else []

    # Alignment metadata from run progress
    alignment_meta = {}
    if latest_run and latest_run.progress and "alignment" in latest_run.progress:
        alignment_meta = latest_run.progress["alignment"]

    data = {
        "videoId": yt_id,
        "title": video.title,
        "youtubeUrl": video.youtube_url,
        "duration": video.duration,
        "segments": [
            {
                "id": f"seg-{i}",
                "text": s.text,
                "start": s.timestamp_start,
                "end": s.timestamp_end,
            }
            for i, s in enumerate(segments)
        ],
        "equations": equations,
        "visualContent": visual_content,
        "autoCaptions": [],
        "sections": sections,
        "alignmentMeta": alignment_meta,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{yt_id}.json"
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Exported {video.title[:60]}: {len(segments)} seg, {len(equations)} eq, {len(visual_content)} vc, {len(sections)} sections → {output_path.name}")
    session.close()


if __name__ == "__main__":
    output_dir = Path(__file__).resolve().parents[1] / "viewer" / "public" / "demo"

    if len(sys.argv) >= 2 and sys.argv[1] == "--all":
        session = SessionLocal()
        videos = session.query(Video).filter(Video.status == "complete").all()
        session.close()
        for v in videos:
            export_video(str(v.id), output_dir)
    elif len(sys.argv) >= 2:
        for vid in sys.argv[1:]:
            export_video(vid, output_dir)
    else:
        print("Usage: python scripts/export_demo_data.py <video-id> [<video-id> ...] | --all")
        sys.exit(1)
