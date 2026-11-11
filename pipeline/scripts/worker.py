"""
Chalkboard pipeline worker.

Polls Postgres for queued pipeline_runs, dispatches to existing pipeline functions.
Single-process, single-job-at-a-time. Designed for Railway deployment.

Usage:
    python scripts/worker.py
"""
import logging
import os
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import UUID

# Ensure pipeline src is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from sqlalchemy import text
from src.config import DEFAULT_GEMINI_MODEL
from src.exceptions import CancelledError
from src.models.database import SessionLocal
from src.models.pipeline_run import PipelineRun, RunStatus
from src.notifications.slack import notify_pipeline_event

# Lazy imports — only loaded when dispatch needs them
_process_video = None
_reprocess_section = None
_reprocess_visual_content = None

logger = logging.getLogger("chalkboard.worker")

POLL_INTERVAL = int(os.getenv("WORKER_POLL_INTERVAL", "5"))
HEARTBEAT_INTERVAL = int(os.getenv("WORKER_HEARTBEAT_INTERVAL", "60"))
STALE_THRESHOLD_MINUTES = int(os.getenv("WORKER_STALE_THRESHOLD_MINUTES", "5"))
STUCK_ALERT_MINUTES = int(os.getenv("WORKER_STUCK_ALERT_MINUTES", "30"))
WORKER_ID = f"{socket.gethostname()}-{os.getpid()}"

# Shutdown flag — set by SIGTERM handler
_shutdown = threading.Event()
# Track the currently running run ID so SIGTERM can mark it failed
_current_run_id = None


def _lazy_import_pipeline():
    """Import pipeline functions on first use (they pull in heavy deps like google-genai)."""
    global _process_video, _reprocess_section, _reprocess_visual_content
    if _process_video is None:
        from scripts.process_video_v2 import (
            process_video as pv,
            reprocess_section as rs,
            reprocess_visual_content as rvc,
        )
        _process_video = pv
        _reprocess_section = rs
        _reprocess_visual_content = rvc


def process_video(**kwargs):
    _lazy_import_pipeline()
    return _process_video(**kwargs)


def reprocess_section(**kwargs):
    _lazy_import_pipeline()
    return _reprocess_section(**kwargs)


def reprocess_visual_content(**kwargs):
    _lazy_import_pipeline()
    return _reprocess_visual_content(**kwargs)


def generate_notes(**kwargs):
    from src.extraction.study_notes import generate_notes as generate
    return generate(**kwargs)


# ─── Required params per run_type (for up-front validation) ───

REQUIRED_PARAMS = {
    "process": ["source"],
    "reprocess": ["source"],
    "reprocess_section": ["youtube_url", "video_id", "section_index", "start_time", "end_time"],
    "reprocess_visual": ["youtube_url", "video_id", "start_time", "end_time"],
    "generate_notes": ["source_run_id"],
}


def _requested_model(params: dict) -> str:
    """Return an explicit run override or the shared production default."""
    return params.get("model", DEFAULT_GEMINI_MODEL)


# ─── Core worker functions ───


def recover_stale_runs(session, stale_minutes=None):
    """Mark abandoned runs as failed. Called on startup before polling begins.

    Uses DB server time (NOW()) for both sides of the comparison to avoid
    clock skew between worker host and DB host.
    """
    if stale_minutes is None:
        stale_minutes = STALE_THRESHOLD_MINUTES
    terminal = [s.value for s in (RunStatus.queued, RunStatus.complete, RunStatus.failed)]

    result = session.execute(
        text("""
            UPDATE pipeline_runs
            SET status = 'failed',
                error = 'Worker crashed or was restarted (stale heartbeat). Previous worker: ' || COALESCE(worker_id, 'unknown')
            WHERE status NOT IN :terminal
              AND (
                  heartbeat_at < NOW() - MAKE_INTERVAL(mins => :threshold)
                  OR (heartbeat_at IS NULL AND started_at < NOW() - MAKE_INTERVAL(mins => :threshold))
              )
        """),
        {"terminal": tuple(terminal), "threshold": stale_minutes},
    )
    count = result.rowcount
    if count:
        session.commit()
        logger.warning(f"Recovered {count} stale run(s)")
    return count


def claim_next_run(session, run_type=None):
    """Claim the oldest queued run using FOR UPDATE SKIP LOCKED.

    Transitions status to 'downloading_captions' to prevent double-pickup.
    (Slightly misleading for reprocess jobs that don't download captions,
    but the pipeline function overwrites it with the correct stage immediately.)

    Returns the claimed PipelineRun, or None if the queue is empty.
    """
    result = session.execute(
        text("""
            SELECT id FROM pipeline_runs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        """)
    ).fetchone()

    if result is None:
        return None

    run_id = result[0]
    # Set status to non-queued + DB time for started_at/heartbeat_at
    session.execute(
        text("""
            UPDATE pipeline_runs
            SET status = 'downloading_captions',
                started_at = NOW(), heartbeat_at = NOW(), worker_id = :wid
            WHERE id = :rid
        """),
        {"wid": WORKER_ID, "rid": str(run_id)},
    )
    session.commit()

    return session.get(PipelineRun, run_id)


def start_heartbeat(run_id, interval=None):
    """Start a daemon thread that updates heartbeat_at periodically.

    Uses its own session (not the main thread's) to avoid thread-safety issues
    with SQLAlchemy Sessions.

    Returns a threading.Event that stops the thread when set.
    """
    if interval is None:
        interval = HEARTBEAT_INTERVAL
    stop_event = threading.Event()

    def _beat():
        hb_session = SessionLocal()
        try:
            while not stop_event.is_set():
                try:
                    hb_session.execute(
                        text("UPDATE pipeline_runs SET heartbeat_at = NOW() WHERE id = :rid"),
                        {"rid": str(run_id)},
                    )
                    hb_session.commit()
                except Exception:
                    logger.exception("Heartbeat update failed")
                    try:
                        hb_session.rollback()
                    except Exception:
                        pass
                stop_event.wait(interval)
        finally:
            hb_session.close()

    t = threading.Thread(target=_beat, daemon=True)
    t.start()
    return stop_event


def stop_heartbeat(stop_event):
    """Signal the heartbeat thread to stop."""
    stop_event.set()


def _validate_params(run_type, params):
    """Validate that required params are present for the given run_type.

    Returns None if valid, or an error message string if invalid.
    """
    required = REQUIRED_PARAMS.get(run_type)
    if required is None:
        return f"Unknown run_type: {run_type}"
    missing = [k for k in required if k not in params]
    if missing:
        return f"Invalid params for {run_type}: missing {', '.join(missing)}"
    if run_type == "generate_notes":
        if set(params) != {"source_run_id"}:
            return "Invalid params for generate_notes: expected source_run_id only"
        try:
            UUID(params["source_run_id"])
        except (ValueError, TypeError, AttributeError):
            return "Invalid params for generate_notes: source_run_id must be a UUID"
    return None


def _r2_key_from_public_url(source):
    """Extract an uploads/... R2 object key from a public playback URL."""
    if not isinstance(source, str) or not source.startswith(("http://", "https://")):
        return None
    path = unquote(urlparse(source).path).lstrip("/")
    return path if path.startswith("uploads/") else None


def dispatch(run, session):
    """Call the appropriate pipeline function based on run.run_type.

    Validates params up front. On validation failure, marks the run as failed
    with a specific message. On pipeline exceptions, lets them propagate to
    the caller (poll_once) which marks the run failed with the full traceback.
    """
    params = run.params or {}
    run_type = run.run_type or "process"

    # Up-front params validation — distinguishes bad API input from pipeline failures
    error = _validate_params(run_type, params)
    if error:
        run.status = RunStatus.failed
        run.error = error
        session.commit()
        return

    # If source is an R2 key (not a URL or local path), download to temp first
    source = params.get("source", "")
    video_url = params.get("video_url")
    tmpdir = None

    public_r2_key = _r2_key_from_public_url(source)
    if run_type in ("process", "reprocess") and public_r2_key:
        logger.warning(
            "Run %s received public R2 URL as source; using object key %s",
            run.id, public_r2_key,
        )
        video_url = video_url or source
        source = public_r2_key

    if run_type in ("process", "reprocess") and source.startswith("uploads/"):
        from src.storage.r2 import download_file
        tmpdir = tempfile.mkdtemp(prefix="chalkboard-r2-")
        filename = os.path.basename(source)
        local_path = os.path.join(tmpdir, filename)
        download_file(source, local_path)
        source = local_path

    try:
        if run_type == "generate_notes":
            generate_notes(run_id=str(run.id))

        elif run_type == "process":
            process_video(
                source=source,
                title=params.get("title"),
                db_mode=True,
                run_id=str(run.id),
                model=_requested_model(params),
                video_url=video_url,
                fps=params.get("fps", 0.5),
            )

        elif run_type == "reprocess":
            process_video(
                source=source,
                title=params.get("title"),
                db_mode=True,
                run_id=str(run.id),
                model=_requested_model(params),
                video_url=video_url,
                fps=params.get("fps", 0.5),
            )

        elif run_type == "reprocess_section":
            reprocess_section(
                youtube_url=params["youtube_url"],
                video_id=params["video_id"],
                run_id=str(run.id),
                section_index=params["section_index"],
                start_time=params["start_time"],
                end_time=params["end_time"],
                section_title=params.get("section_title", "Section"),
                context=params.get("context", ""),
                model=_requested_model(params),
                fps=params.get("fps", 0.5),
                r2_key=params.get("r2_key"),
            )

        elif run_type == "reprocess_visual":
            reprocess_visual_content(
                youtube_url=params["youtube_url"],
                video_id=params["video_id"],
                run_id=params.get("run_id"),
                start_time=params["start_time"],
                end_time=params["end_time"],
                section_title=params.get("section_title", "Section"),
                context=params.get("context", ""),
                model=_requested_model(params),
                fps=params.get("fps", 0.5),
                scope=params.get("scope", "section"),
                r2_key=params.get("r2_key"),
            )
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _mark_run_failed(run_id, error_msg, force=False):
    """Mark a run as failed using a fresh session. Safe to call from any context.

    Skips runs that are already `complete` unconditionally — a successful
    result is the most expensive thing we can lose, and there's no reason
    to ever overwrite it. For runs already in `failed`, default behavior is
    also to skip (a background "you crashed" sweep can't stomp on a real
    failure reason). `force=True` overrides that one case: when the user
    clicks Cancel, the cancel message must reach the error column even if
    an earlier code path already wrote a traceback there. See d660283c.
    """
    try:
        s = SessionLocal()
        run = s.get(PipelineRun, run_id)
        if run and run.status != RunStatus.complete:
            if force or run.status != RunStatus.failed:
                run.status = RunStatus.failed
                run.error = error_msg
                s.commit()
        s.close()
    except Exception:
        logger.exception(f"Failed to mark run {run_id} as failed")


def poll_once(session):
    """Single iteration of the poll loop.

    Returns True if a job was processed, False if idle.
    """
    global _current_run_id

    run = claim_next_run(session)
    if run is None:
        return False

    _current_run_id = run.id
    logger.info(f"Claimed run {run.id} (type={run.run_type})")
    hb_stop = start_heartbeat(run.id)

    try:
        dispatch(run, session)
    except CancelledError as e:
        # User cancellation — clean exit, no traceback, no Slack failure alert.
        # `force=True` so the message wins even if process_video's generic
        # `except Exception` already wrote a traceback (see d660283c).
        logger.info(f"Run {run.id} cancelled: {e}")
        _mark_run_failed(run.id, "Cancelled by user", force=True)
    except Exception:
        # Pipeline or dispatch raised — mark run failed with full traceback
        tb = traceback.format_exc()
        logger.exception(f"Run {run.id} failed")
        _mark_run_failed(run.id, tb)
    finally:
        stop_heartbeat(hb_stop)
        _current_run_id = None

    return True


# ─── Main loop ───


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    # Validate timing constants
    stale_seconds = STALE_THRESHOLD_MINUTES * 60
    assert stale_seconds > HEARTBEAT_INTERVAL * 3, (
        f"STALE_THRESHOLD ({stale_seconds}s) must be > 3x HEARTBEAT_INTERVAL ({HEARTBEAT_INTERVAL}s). "
        f"Current ratio: {stale_seconds / HEARTBEAT_INTERVAL:.1f}x. "
        f"Fix: increase WORKER_STALE_THRESHOLD_MINUTES or decrease WORKER_HEARTBEAT_INTERVAL."
    )

    logger.info(f"Worker starting (id={WORKER_ID}, poll={POLL_INTERVAL}s, heartbeat={HEARTBEAT_INTERVAL}s)")

    # SIGTERM handler — Railway sends this on deploy
    def _handle_sigterm(signum, frame):
        logger.info("Received SIGTERM, shutting down gracefully...")
        _shutdown.set()
        if _current_run_id:
            _mark_run_failed(_current_run_id, "Worker received SIGTERM (deploy/restart)")
            logger.info(f"Marked in-flight run {_current_run_id} as failed")

    signal.signal(signal.SIGTERM, _handle_sigterm)

    # Decode GCP credentials if provided as base64 env var
    creds_b64 = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if creds_b64:
        import base64
        key_path = "/tmp/gcp-key.json"
        with open(key_path, "wb") as f:
            f.write(base64.b64decode(creds_b64))
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key_path
        logger.info("Decoded GCP credentials to /tmp/gcp-key.json")

    # Fresh session per startup. recover_stale_runs uses it, then we create
    # a fresh one per poll_once iteration.
    startup_session = SessionLocal()
    recovered = recover_stale_runs(startup_session)
    if recovered:
        logger.info(f"Recovered {recovered} stale run(s)")
    startup_session.close()

    # Poll loop — fresh session per iteration
    queue_stuck_alerted = False

    while not _shutdown.is_set():
        try:
            session = SessionLocal()
            try:
                processed = poll_once(session)

                # Stuck queue detection — DB-backed completion time, not local timer.
                # Checks every cycle to catch both "worker idle" and "every job fails fast".
                if not queue_stuck_alerted:
                    queued_count = session.execute(
                        text("SELECT count(*) FROM pipeline_runs WHERE status = 'queued'")
                    ).scalar() or 0
                    if queued_count > 0:
                        idle_minutes = session.execute(
                            text("""
                                SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
                                    (SELECT MAX(heartbeat_at) FROM pipeline_runs WHERE status = 'complete'),
                                    (SELECT MIN(created_at) FROM pipeline_runs WHERE status = 'queued')
                                ))) / 60
                            """)
                        ).scalar() or 0
                        if idle_minutes > STUCK_ALERT_MINUTES:
                            queue_stuck_alerted = True
                            idle_min = int(idle_minutes)
                            logger.warning(f"Queue stuck: {queued_count} queued job(s), no completions in {idle_min} min")
                            notify_pipeline_event(
                                event="worker_alert",
                                title=f"Worker: {queued_count} queued, no completions in {idle_min} min",
                                source="worker",
                                error=f"No jobs completed in {idle_min} minutes with {queued_count} "
                                      f"jobs waiting. Worker may be stuck, failing all jobs, "
                                      f"or dependencies unreachable.",
                                run_type="worker",
                            )
                else:
                    # Clear alert once a job actually completes
                    last_complete_age = session.execute(
                        text("""
                            SELECT EXTRACT(EPOCH FROM (NOW() - MAX(heartbeat_at))) / 60
                            FROM pipeline_runs WHERE status = 'complete'
                        """)
                    ).scalar()
                    if last_complete_age is not None and last_complete_age < STUCK_ALERT_MINUTES:
                        queue_stuck_alerted = False
            finally:
                session.close()

            if not processed:
                _shutdown.wait(POLL_INTERVAL)
        except KeyboardInterrupt:
            logger.info("Shutting down (KeyboardInterrupt)")
            break
        except Exception:
            logger.exception("Poll loop error")
            _shutdown.wait(POLL_INTERVAL)

    logger.info("Worker stopped")


if __name__ == "__main__":
    main()
