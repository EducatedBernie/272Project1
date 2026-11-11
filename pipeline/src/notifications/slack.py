"""
Slack webhook notifications for pipeline events.

No external dependencies — uses urllib.request.
No-ops gracefully if CHALKBOARD_SLACK_WEBHOOK is not set.
"""
import json
import logging
import os
import urllib.parse
import urllib.request
import urllib.error
from typing import Literal

logger = logging.getLogger("chalkboard.slack")


def notify_pipeline_event(
    event: Literal["success", "failure", "worker_alert"],
    title: str,
    source: str,
    run_id: str | None = None,
    video_id: str | None = None,
    error: str | None = None,
    segment_count: int | None = None,
    equation_count: int | None = None,
    word_coverage: float | None = None,
    duration_secs: float | None = None,
    run_type: str | None = None,
):
    """Send a Slack notification for a pipeline event.

    Args:
        event: "success" or "failure"
        title: Video title
        source: YouTube URL or filename
        run_id: Pipeline run UUID
        video_id: Video UUID (for viewer link)
        error: Error message (for failures)
        segment_count: Number of transcript segments
        equation_count: Number of equations extracted
        word_coverage: Word alignment coverage as a fraction (0.0-1.0), or None if unknown
        duration_secs: Processing time in seconds
        run_type: process, reprocess, reprocess_section, reprocess_visual
    """
    webhook = os.getenv("CHALKBOARD_SLACK_WEBHOOK")
    if not webhook:
        return

    is_success = event == "success"
    is_alert = event == "worker_alert"
    emoji = ":white_check_mark:" if is_success else ":warning:" if is_alert else ":x:"
    status_text = "Complete" if is_success else "Alert" if is_alert else "Failed"

    # Build fields
    fields = []

    if source:
        fields.append({"type": "mrkdwn", "text": f"*Source:* {source}"})

    if run_type and run_type != "process":
        fields.append({"type": "mrkdwn", "text": f"*Type:* {run_type}"})

    if is_success:
        if segment_count is not None:
            fields.append({"type": "mrkdwn", "text": f"*Segments:* {segment_count}"})
        if equation_count is not None:
            fields.append({"type": "mrkdwn", "text": f"*Equations:* {equation_count}"})
        if word_coverage is not None:
            pct = word_coverage * 100
            coverage_emoji = ":white_check_mark:" if pct >= 90 else ":warning:" if pct >= 80 else ":rotating_light:"
            fields.append({"type": "mrkdwn", "text": f"*Word coverage:* {pct:.1f}% {coverage_emoji}"})
        if duration_secs is not None:
            mins = int(duration_secs // 60)
            secs = int(duration_secs % 60)
            fields.append({"type": "mrkdwn", "text": f"*Duration:* {mins}m {secs}s"})
    else:
        if error:
            # Keep the END of the traceback — that's where the exception and innermost frame are
            err_text = error[-1500:] if len(error) > 1500 else error
            # Escape backticks to prevent breaking the code fence
            err_text = err_text.replace("```", "` ` `")
            fields.append({"type": "mrkdwn", "text": f"*Error:*\n```{err_text}```"})

    # Build blocks
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{emoji} {status_text}: {title}"[:150]}
        },
    ]

    if fields:
        blocks.append({"type": "section", "fields": fields[:10]})  # Slack max 10 fields

    # Add viewer link if we have a video_id
    if video_id and is_success:
        base_url = os.getenv("CHALKBOARD_BASE_URL", "http://localhost:3000")
        safe_vid = urllib.parse.quote(str(video_id), safe="")
        viewer_url = f"{base_url}/video/{safe_vid}"
        if run_id:
            viewer_url += f"?run={urllib.parse.quote(str(run_id), safe='')}"
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"<{viewer_url}|View in Chalkboard>"}]
        })

    payload = {"blocks": blocks}

    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as e:
        logger.error(f"Slack notification failed: HTTP {e.code}")
    except Exception as e:
        logger.error(f"Slack notification failed: {type(e).__name__}")
