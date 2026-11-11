"""
Tests for the worker architecture (Blocker #1).

Tests run against a real Postgres test database.
No mocks for DB operations; pipeline functions are mocked.
"""
import uuid
import time
import threading
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from src.models.pipeline_run import PipelineRun, RunStatus
from src.models.video import Video, VideoStatus


# ─── claim_next_run tests ───


class TestClaimNextRun:
    """The worker claims queued runs with FOR UPDATE SKIP LOCKED."""

    def test_claims_oldest_queued_run(self, session, make_run):
        from scripts.worker import claim_next_run

        run1 = make_run(status=RunStatus.queued)
        run2 = make_run(status=RunStatus.queued)
        session.commit()

        claimed = claim_next_run(session)
        assert claimed is not None
        assert claimed.id == run1.id  # FIFO by created_at

    def test_returns_none_when_no_queued_runs(self, session):
        from scripts.worker import claim_next_run

        claimed = claim_next_run(session)
        assert claimed is None

    def test_skips_non_queued_runs(self, session, make_run):
        from scripts.worker import claim_next_run

        make_run(status=RunStatus.complete)
        make_run(status=RunStatus.failed)
        run = make_run(status=RunStatus.processing_sections)
        session.flush()
        # Set stale timestamps via DB time so claim doesn't pick these up
        session.execute(text("""
            UPDATE pipeline_runs
            SET started_at = NOW() - INTERVAL '10 minutes',
                heartbeat_at = NOW() - INTERVAL '10 minutes'
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        claimed = claim_next_run(session)
        assert claimed is None

    def test_sets_started_at_and_worker_id_on_claim(self, session, make_run):
        from scripts.worker import claim_next_run

        make_run(status=RunStatus.queued)
        session.commit()
        claimed = claim_next_run(session)

        assert claimed.started_at is not None
        assert claimed.worker_id is not None
        assert len(claimed.worker_id) > 0

    def test_transitions_status_out_of_queued(self, session, make_run):
        """Status must leave queued on claim to prevent double-pickup."""
        from scripts.worker import claim_next_run

        make_run(status=RunStatus.queued)
        session.commit()
        claimed = claim_next_run(session)
        assert claimed.status != RunStatus.queued

    def test_skip_locked_two_workers_cannot_claim_same_run(self, engine):
        """The crown jewel: two concurrent workers race for one queued run.
        FOR UPDATE SKIP LOCKED ensures exactly one wins.

        We use a barrier to force both threads to start their SELECT simultaneously,
        creating a real race condition rather than serial execution.
        """
        from scripts.worker import claim_next_run

        Session = sessionmaker(bind=engine)
        setup = Session()
        vid = uuid.uuid4()
        video = Video(
            id=vid, title="Concurrency test",
            youtube_url=f"https://youtube.com/watch?v=conc-{uuid.uuid4().hex[:8]}",
            duration=60.0, status=VideoStatus.queued,
        )
        setup.add(video)
        setup.flush()
        run = PipelineRun(
            id=uuid.uuid4(), video_id=vid, status=RunStatus.queued,
            run_type="process", params={"source": "test"},
            pipeline_version="v2", progress={},
        )
        setup.add(run)
        setup.commit()
        setup.close()

        barrier = threading.Barrier(2, timeout=5)
        results = []
        errors = []

        def worker_thread():
            s = Session()
            try:
                barrier.wait()  # Both threads start at the same moment
                claimed = claim_next_run(s)
                results.append(claimed.id if claimed else None)
            except Exception as e:
                errors.append(e)
            finally:
                s.close()

        t1 = threading.Thread(target=worker_thread)
        t2 = threading.Thread(target=worker_thread)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        assert not errors, f"Worker threads raised: {errors}"
        claimed = [r for r in results if r is not None]
        assert len(claimed) == 1, f"Expected exactly 1 claim, got {len(claimed)}"

        # Clean up
        cleanup = Session()
        cleanup.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(vid)})
        cleanup.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(vid)})
        cleanup.commit()
        cleanup.close()


# ─── recover_stale_runs tests ───


class TestRecoverStaleRuns:
    """On startup, mark abandoned runs as failed."""

    def test_marks_stale_processing_run_as_failed(self, session, make_run):
        from scripts.worker import recover_stale_runs

        run = make_run(status=RunStatus.processing_sections)
        # Use DB time via raw SQL to avoid clock mismatch
        session.execute(text("""
            UPDATE pipeline_runs
            SET heartbeat_at = NOW() - INTERVAL '10 minutes',
                started_at = NOW() - INTERVAL '10 minutes'
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        count = recover_stale_runs(session)
        assert count == 1
        session.refresh(run)
        assert run.status == RunStatus.failed
        assert "stale" in run.error.lower() or "crash" in run.error.lower()

    def test_ignores_queued_runs(self, session, make_run):
        """Queued runs should never be marked stale, even with old timestamps."""
        from scripts.worker import recover_stale_runs

        run = make_run(status=RunStatus.queued)
        # Set a stale started_at to prove status check is what saves it
        session.execute(text("""
            UPDATE pipeline_runs SET started_at = NOW() - INTERVAL '10 minutes'
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        count = recover_stale_runs(session)
        assert count == 0

    def test_ignores_completed_runs(self, session, make_run):
        from scripts.worker import recover_stale_runs

        make_run(status=RunStatus.complete)
        session.commit()
        count = recover_stale_runs(session)
        assert count == 0

    def test_ignores_failed_runs(self, session, make_run):
        from scripts.worker import recover_stale_runs

        make_run(status=RunStatus.failed)
        session.commit()
        count = recover_stale_runs(session)
        assert count == 0

    def test_ignores_fresh_heartbeat(self, session, make_run):
        from scripts.worker import recover_stale_runs

        run = make_run(status=RunStatus.processing_sections)
        session.execute(text("""
            UPDATE pipeline_runs
            SET heartbeat_at = NOW(), started_at = NOW()
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        count = recover_stale_runs(session)
        assert count == 0

    def test_recovers_run_with_null_heartbeat_and_old_started_at(self, session, make_run):
        """Worker crashed before first heartbeat."""
        from scripts.worker import recover_stale_runs

        run = make_run(status=RunStatus.downloading_captions)
        session.execute(text("""
            UPDATE pipeline_runs
            SET started_at = NOW() - INTERVAL '10 minutes', heartbeat_at = NULL
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        count = recover_stale_runs(session)
        assert count == 1
        session.refresh(run)
        assert run.status == RunStatus.failed

    def test_recovers_multiple_stale_runs(self, session, make_run):
        from scripts.worker import recover_stale_runs

        for status in [RunStatus.downloading_captions, RunStatus.processing_sections,
                       RunStatus.word_aligning, RunStatus.saving]:
            run = make_run(status=status)
            session.execute(text("""
                UPDATE pipeline_runs
                SET heartbeat_at = NOW() - INTERVAL '10 minutes',
                    started_at = NOW() - INTERVAL '10 minutes'
                WHERE id = :rid
            """), {"rid": str(run.id)})
        session.commit()

        count = recover_stale_runs(session)
        assert count == 4


# ─── Params validation tests ───


class TestValidateParams:
    """Up-front params validation catches bad API input."""

    def test_valid_process_params(self):
        from scripts.worker import _validate_params
        assert _validate_params("process", {"source": "https://youtube.com/watch?v=x"}) is None

    def test_missing_source_for_process(self):
        from scripts.worker import _validate_params
        error = _validate_params("process", {"title": "no source"})
        assert error is not None
        assert "source" in error

    def test_valid_reprocess_section_params(self):
        from scripts.worker import _validate_params
        params = {"youtube_url": "x", "video_id": "y", "section_index": 0,
                  "start_time": 0, "end_time": 300}
        assert _validate_params("reprocess_section", params) is None

    def test_missing_keys_for_reprocess_section(self):
        from scripts.worker import _validate_params
        error = _validate_params("reprocess_section", {"youtube_url": "x"})
        assert "video_id" in error

    def test_unknown_run_type(self):
        from scripts.worker import _validate_params
        error = _validate_params("bogus_type", {})
        assert "Unknown" in error

    def test_extracts_r2_key_from_public_upload_url(self):
        from scripts.worker import _r2_key_from_public_url

        source = "https://pub.example.r2.dev/uploads/abc/Media%20Gallery.mp4"
        assert _r2_key_from_public_url(source) == "uploads/abc/Media Gallery.mp4"

    def test_ignores_non_upload_http_urls(self):
        from scripts.worker import _r2_key_from_public_url

        assert _r2_key_from_public_url("https://www.youtube.com/watch?v=abc") is None


# ─── dispatch tests (mock the pipeline functions) ───


class TestDispatch:
    """Dispatch calls the right pipeline function based on run_type."""

    @patch("scripts.worker.process_video")
    def test_dispatch_process(self, mock_pv, session, make_run):
        from scripts.worker import dispatch

        params = {"source": "https://youtube.com/watch?v=abc", "title": "Test"}
        run = make_run(run_type="process", params=params)

        dispatch(run, session)
        mock_pv.assert_called_once()
        call_kwargs = mock_pv.call_args
        assert call_kwargs[1]["source"] == "https://youtube.com/watch?v=abc"
        assert call_kwargs[1]["db_mode"] is True

    @patch("scripts.worker.process_video")
    def test_dispatch_reprocess(self, mock_pv, session, make_run):
        from scripts.worker import dispatch

        params = {"source": "https://youtube.com/watch?v=abc", "title": "Test"}
        run = make_run(run_type="reprocess", params=params)

        dispatch(run, session)
        mock_pv.assert_called_once()
        call_kwargs = mock_pv.call_args
        assert call_kwargs[1]["run_id"] == str(run.id)

    @patch("scripts.worker.shutil.rmtree")
    @patch("src.storage.r2.download_file")
    @patch("scripts.worker.process_video")
    def test_dispatch_reprocess_converts_public_r2_url_source(
        self, mock_pv, mock_download, mock_rmtree, session, make_run
    ):
        from scripts.worker import dispatch

        source = "https://pub.example.r2.dev/uploads/abc/lecture.mp4"
        params = {"source": source, "title": "Upload"}
        run = make_run(run_type="reprocess", params=params)

        dispatch(run, session)

        mock_download.assert_called_once()
        assert mock_download.call_args.args[0] == "uploads/abc/lecture.mp4"
        mock_pv.assert_called_once()
        call_kwargs = mock_pv.call_args.kwargs
        assert call_kwargs["source"].endswith("/lecture.mp4")
        assert call_kwargs["video_url"] == source
        mock_rmtree.assert_called_once()

    @patch("scripts.worker.reprocess_section")
    def test_dispatch_reprocess_section(self, mock_rs, session, make_run):
        from scripts.worker import dispatch

        params = {
            "youtube_url": "https://youtube.com/watch?v=abc",
            "video_id": str(uuid.uuid4()),
            "section_index": 2,
            "start_time": 120.0,
            "end_time": 360.0,
            "section_title": "Conservation Laws",
            "context": "some context",
        }
        run = make_run(run_type="reprocess_section", params=params)

        dispatch(run, session)
        mock_rs.assert_called_once()
        # r2_key defaults to None for YouTube reprocesses — passed explicitly
        # so the pipeline can branch on it instead of guessing from the URL.
        assert mock_rs.call_args.kwargs["r2_key"] is None

    @patch("scripts.worker.reprocess_section")
    def test_dispatch_reprocess_section_threads_r2_key_for_uploads(self, mock_rs, session, make_run):
        """Uploads must reach reprocess_section with r2_key set; dropping it
        sends the pipeline back to the yt-dlp-on-R2-URL bug path.
        """
        from scripts.worker import dispatch

        params = {
            "youtube_url": "https://pub-abc.r2.dev/uploads/xyz/lecture.mp4",
            "r2_key": "uploads/xyz/lecture.mp4",
            "video_id": str(uuid.uuid4()),
            "section_index": 2,
            "start_time": 120.0,
            "end_time": 360.0,
            "section_title": "Section",
            "context": "",
        }
        run = make_run(run_type="reprocess_section", params=params)

        dispatch(run, session)
        assert mock_rs.call_args.kwargs["r2_key"] == "uploads/xyz/lecture.mp4"

    @patch("scripts.worker.reprocess_visual_content")
    def test_dispatch_reprocess_visual(self, mock_rvc, session, make_run):
        from scripts.worker import dispatch

        params = {
            "youtube_url": "https://youtube.com/watch?v=abc",
            "video_id": str(uuid.uuid4()),
            "start_time": 120.0,
            "end_time": 360.0,
            "section_title": "Conservation Laws",
            "context": "some context",
            "scope": "item",
        }
        run = make_run(run_type="reprocess_visual", params=params)

        dispatch(run, session)
        mock_rvc.assert_called_once()
        assert mock_rvc.call_args.kwargs["r2_key"] is None

    @patch("scripts.worker.reprocess_visual_content")
    def test_dispatch_reprocess_visual_threads_r2_key_for_uploads(self, mock_rvc, session, make_run):
        from scripts.worker import dispatch

        params = {
            "youtube_url": "https://pub-abc.r2.dev/uploads/xyz/lecture.mp4",
            "r2_key": "uploads/xyz/lecture.mp4",
            "video_id": str(uuid.uuid4()),
            "start_time": 120.0,
            "end_time": 360.0,
            "section_title": "Section",
            "context": "",
            "scope": "section",
        }
        run = make_run(run_type="reprocess_visual", params=params)

        dispatch(run, session)
        assert mock_rvc.call_args.kwargs["r2_key"] == "uploads/xyz/lecture.mp4"

    @patch("scripts.worker.process_video", side_effect=Exception("Gemini 500"))
    def test_dispatch_raises_on_pipeline_exception(self, mock_pv, session, make_run):
        """Dispatch no longer catches exceptions — they propagate to poll_once."""
        from scripts.worker import dispatch

        run = make_run(run_type="process", params={"source": "https://youtube.com/watch?v=x"})

        with pytest.raises(Exception, match="Gemini 500"):
            dispatch(run, session)

    def test_dispatch_invalid_params_marks_failed(self, session, make_run):
        """Missing required params => failed with specific message, no exception."""
        from scripts.worker import dispatch

        run = make_run(run_type="process", params={"title": "no source key"})
        dispatch(run, session)

        session.refresh(run)
        assert run.status == RunStatus.failed
        assert "missing source" in run.error

    def test_dispatch_unknown_run_type_marks_failed(self, session, make_run):
        from scripts.worker import dispatch

        run = make_run(run_type="unknown_type", params={})
        dispatch(run, session)

        session.refresh(run)
        assert run.status == RunStatus.failed
        assert "Unknown" in run.error


# ─── Heartbeat tests ───


class TestHeartbeat:
    """The heartbeat thread updates heartbeat_at using its own session."""

    def test_heartbeat_updates_timestamp(self, engine, session, make_run):
        from scripts.worker import start_heartbeat, stop_heartbeat

        run = make_run(status=RunStatus.processing_sections)
        # Use DB time to avoid tz-aware/naive mismatch
        session.execute(text("""
            UPDATE pipeline_runs
            SET heartbeat_at = NOW() - INTERVAL '5 minutes'
            WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        # Read back the DB-set value (naive datetime from TIMESTAMP WITHOUT TIME ZONE)
        session.expire(run)
        session.refresh(run)
        old_hb = run.heartbeat_at

        stop_event = start_heartbeat(run.id, interval=0.1)
        time.sleep(0.3)
        stop_heartbeat(stop_event)
        time.sleep(0.15)  # Let the thread finish its last iteration

        session.expire(run)
        session.refresh(run)
        assert run.heartbeat_at > old_hb

    def test_heartbeat_stops_when_signaled(self, session, make_run):
        from scripts.worker import start_heartbeat, stop_heartbeat

        run = make_run(status=RunStatus.processing_sections)
        session.execute(text("""
            UPDATE pipeline_runs SET heartbeat_at = NOW() WHERE id = :rid
        """), {"rid": str(run.id)})
        session.commit()

        stop_event = start_heartbeat(run.id, interval=0.1)
        stop_heartbeat(stop_event)
        time.sleep(0.2)

        session.expire(run)
        session.refresh(run)
        ts_after_stop = run.heartbeat_at
        time.sleep(0.3)
        session.expire(run)
        session.refresh(run)
        assert run.heartbeat_at == ts_after_stop


# ─── poll_once integration tests ───


class TestPollOnce:
    """The poll loop picks up jobs and handles failures."""

    @patch("scripts.worker.process_video")
    def test_processes_one_job(self, mock_pv, session, make_run):
        from scripts.worker import poll_once

        params = {"source": "https://youtube.com/watch?v=abc", "title": "Test"}
        run = make_run(run_type="process", params=params)
        session.commit()

        processed = poll_once(session)
        assert processed is True
        mock_pv.assert_called_once()

    @patch("scripts.worker.process_video")
    def test_returns_false_when_idle(self, mock_pv, session):
        from scripts.worker import poll_once

        processed = poll_once(session)
        assert processed is False
        mock_pv.assert_not_called()

    @patch("scripts.worker.process_video", side_effect=Exception("Gemini exploded"))
    def test_marks_run_failed_on_exception(self, mock_pv, engine):
        """poll_once catches dispatch exceptions and marks the run failed."""
        from scripts.worker import poll_once

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="Test", youtube_url=f"https://youtube.com/watch?v=err-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.queued,
                run_type="process", params={"source": "https://youtube.com/watch?v=x"},
                pipeline_version="v2", progress={},
            )
            session.add(run)
            session.commit()

            run_id = run.id
            poll_once(session)

            session.expire_all()
            refreshed = session.get(PipelineRun, run_id)
            assert refreshed.status == RunStatus.failed
            assert "Gemini exploded" in refreshed.error
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()


# ─── Timing validation ───


class TestTimingValidation:
    """Startup rejects misconfigured timing constants."""

    def test_bad_timing_raises(self):
        """stale_threshold must be > 3x heartbeat_interval."""
        import scripts.worker as w
        old_stale = w.STALE_THRESHOLD_MINUTES
        old_hb = w.HEARTBEAT_INTERVAL
        try:
            w.STALE_THRESHOLD_MINUTES = 1  # 60s
            w.HEARTBEAT_INTERVAL = 90      # 90s — stale < heartbeat*3
            with pytest.raises(AssertionError):
                w.main()
        finally:
            w.STALE_THRESHOLD_MINUTES = old_stale
            w.HEARTBEAT_INTERVAL = old_hb


# ─── SIGTERM handler tests ───


class TestSigterm:
    """SIGTERM marks the in-flight run as failed."""

    def test_mark_run_failed_helper(self, engine):
        from scripts.worker import _mark_run_failed

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="SIGTERM test",
                youtube_url=f"https://youtube.com/watch?v=sig-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.processing_sections,
                run_type="process", params={"source": "test"},
                pipeline_version="v2", progress={},
            )
            session.add(run)
            session.commit()

            _mark_run_failed(run.id, "Worker received SIGTERM (deploy/restart)")

            session.expire_all()
            refreshed = session.get(PipelineRun, run.id)
            assert refreshed.status == RunStatus.failed
            assert "SIGTERM" in refreshed.error
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()

    def test_mark_run_failed_noop_on_already_failed(self, engine):
        from scripts.worker import _mark_run_failed

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="Already failed",
                youtube_url=f"https://youtube.com/watch?v=af-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.failed,
                run_type="process", params={"source": "test"},
                pipeline_version="v2", progress={}, error="Original error",
            )
            session.add(run)
            session.commit()

            _mark_run_failed(run.id, "Should not overwrite")

            session.expire_all()
            refreshed = session.get(PipelineRun, run.id)
            assert refreshed.error == "Original error"  # Not overwritten
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()

    def test_mark_run_failed_force_overwrites_terminal(self, engine):
        """`force=True` lets a cancel handler reach the error column even when
        a previous code path (process_video's generic except, SIGTERM marker)
        already marked the run failed with a traceback. Regression for
        d660283c, where the UI showed 'Unknown error' because the user's
        cancel intent never replaced the traceback that was already there.
        """
        from scripts.worker import _mark_run_failed

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="Cancel-after-fail",
                youtube_url=f"https://youtube.com/watch?v=cf-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.failed,
                run_type="process", params={"source": "test"},
                pipeline_version="v2", progress={},
                error="Traceback (most recent call last):\n  ...\nCancelledError: foo\n",
            )
            session.add(run)
            session.commit()

            _mark_run_failed(run.id, "Cancelled by user", force=True)

            session.expire_all()
            refreshed = session.get(PipelineRun, run.id)
            assert refreshed.error == "Cancelled by user"
            assert refreshed.status == RunStatus.failed
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()


# ─── Cancellation tests ───


class TestCancellation:
    """`cancel_requested` flips runs into 'failed' with the user-friendly
    'Cancelled by user' message, without firing failure Slack alerts.

    These tests target the cancellation contract directly: the
    `_update_run_progress` helper MUST raise `CancelledError` if
    `cancel_requested=true` is set in the DB at the time of any stage
    transition (including the final 'complete' write), and `poll_once` MUST
    catch it and route to the user-friendly failure path.
    """

    def test_update_run_progress_raises_when_cancel_requested(self, session, make_run):
        """The cancellation checkpoint inside _update_run_progress."""
        from scripts.process_video_v2 import _update_run_progress
        from scripts.worker import CancelledError

        run = make_run(status=RunStatus.processing_sections)
        # Simulate a cancel API call landing while the pipeline is mid-stage
        # by writing through raw SQL (mirrors the separate-session DB write
        # the API performs).
        session.execute(
            text("UPDATE pipeline_runs SET cancel_requested = true WHERE id = :rid"),
            {"rid": str(run.id)},
        )
        session.commit()

        with pytest.raises(CancelledError, match="Cancel requested"):
            _update_run_progress(session, run, "saving", stage="Saving")

        # Status must NOT have advanced — the raise happens before the
        # status assignment + commit.
        session.expire(run)
        session.refresh(run)
        assert run.status == RunStatus.processing_sections

    def test_update_run_progress_proceeds_when_not_cancelled(self, session, make_run):
        """Sanity: the checkpoint is a no-op for the common (non-cancelled) case."""
        from scripts.process_video_v2 import _update_run_progress

        run = make_run(status=RunStatus.processing_sections)
        session.commit()

        _update_run_progress(session, run, "saving", stage="Saving")
        session.expire(run)
        session.refresh(run)
        assert run.status == RunStatus.saving
        assert run.cancel_requested is False

    def test_cancel_wins_race_against_complete(self, session, make_run):
        """Last-millisecond cancel overrides the final 'complete' transition.

        The pipeline's last act is a `_update_run_progress(..., "complete")`
        call. If the user cancels at exactly that moment, the run must end
        up `failed` (with 'Cancelled by user'), not `complete`.
        """
        from scripts.process_video_v2 import _update_run_progress
        from scripts.worker import CancelledError

        run = make_run(status=RunStatus.saving)
        session.execute(
            text("UPDATE pipeline_runs SET cancel_requested = true WHERE id = :rid"),
            {"rid": str(run.id)},
        )
        session.commit()

        with pytest.raises(CancelledError):
            _update_run_progress(session, run, "complete", stage="Complete")

        session.expire(run)
        session.refresh(run)
        assert run.status == RunStatus.saving  # still pre-complete
        assert run.status != RunStatus.complete

    def test_poll_once_routes_cancelled_to_user_friendly_failure(self, engine):
        """End-to-end: dispatch raises CancelledError → poll_once marks the
        run failed with 'Cancelled by user' (not a traceback)."""
        from scripts.worker import poll_once, CancelledError

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="Cancel test",
                youtube_url=f"https://youtube.com/watch?v=can-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.queued,
                run_type="process", params={"source": "https://youtube.com/watch?v=x"},
                pipeline_version="v2", progress={},
            )
            session.add(run)
            session.commit()
            run_id = run.id

            # Patch process_video to simulate the pipeline raising CancelledError
            # mid-flight (which is what _update_run_progress would do).
            with patch("scripts.worker.process_video", side_effect=CancelledError("Cancel requested before stage transition to 'word_aligning'")):
                poll_once(session)

            session.expire_all()
            refreshed = session.get(PipelineRun, run_id)
            assert refreshed.status == RunStatus.failed
            assert refreshed.error == "Cancelled by user"
            # Critical: no traceback in the error field — keeps Slack noise down
            assert "Traceback" not in refreshed.error
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()

    def test_cancelled_error_is_a_single_class_object(self):
        """Regression for d660283c. worker.py is launched as a script
        (`python scripts/worker.py`) which makes its module `__main__`. If
        CancelledError is defined at the top of worker.py and another file
        imports it via `from scripts.worker import CancelledError`, Python
        produces TWO class objects (one as `__main__.CancelledError`, one
        as `scripts.worker.CancelledError`). worker.py's own
        `except CancelledError:` is bound to the first; the pipeline raises
        the second; the catch silently misses; cancellations get logged as
        tracebacks. The fix is to host the class in a third module that
        both files import from. This test fails the moment anyone restores
        the local class definition.
        """
        from src.exceptions import CancelledError as Canonical
        from scripts.worker import CancelledError as FromWorker
        from scripts.process_video_v2 import CancelledError as FromPipeline
        assert Canonical is FromWorker, "worker.py must import CancelledError from src.exceptions"
        assert Canonical is FromPipeline, "process_video_v2 must import CancelledError from src.exceptions"

    def test_poll_once_catches_canonical_cancelled_error(self, engine):
        """Regression for d660283c. poll_once must catch CancelledError when
        it's raised with the canonical (`src.exceptions`) class — which is
        what process_video_v2 raises. Before the dual-module fix, worker.py
        defined its own class and missed the canonical one in production.
        The previous test patches `scripts.worker.process_video` with
        `scripts.worker.CancelledError`, which would still work even with
        the old dual-class layout — this test specifically exercises the
        cross-module raise path.
        """
        from src.exceptions import CancelledError
        from scripts.worker import poll_once

        Session = sessionmaker(bind=engine)
        session = Session()

        try:
            video = Video(
                id=uuid.uuid4(), title="Cross-module cancel",
                youtube_url=f"https://youtube.com/watch?v=xm-{uuid.uuid4().hex[:8]}",
                duration=60.0, status=VideoStatus.queued,
            )
            session.add(video)
            session.flush()

            run = PipelineRun(
                id=uuid.uuid4(), video_id=video.id, status=RunStatus.queued,
                run_type="process", params={"source": "https://youtube.com/watch?v=y"},
                pipeline_version="v2", progress={},
            )
            session.add(run)
            session.commit()
            run_id = run.id

            with patch(
                "scripts.worker.process_video",
                side_effect=CancelledError("Cancel requested before stage transition to 'downloading_captions'"),
            ):
                poll_once(session)

            session.expire_all()
            refreshed = session.get(PipelineRun, run_id)
            assert refreshed.status == RunStatus.failed
            assert refreshed.error == "Cancelled by user"
            assert "Traceback" not in refreshed.error
        finally:
            session.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(video.id)})
            session.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(video.id)})
            session.commit()
            session.close()
