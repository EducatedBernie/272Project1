"""
Test fixtures for worker tests. Uses a real Postgres test database.
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Point at the test database — never the real one
TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql://chalkboard:localdev@localhost:5432/chalkboard_test",
)

# Patch the module-level DATABASE_URL before any model imports
os.environ["DATABASE_URL"] = TEST_DATABASE_URL


from src.models.database import Base  # noqa: E402
from src.models.video import Video, VideoStatus  # noqa: E402
from src.models.pipeline_run import PipelineRun, RunStatus  # noqa: E402


@pytest.fixture(scope="session")
def engine():
    """Create engine once per test session, create all tables."""
    eng = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    """Per-test session. Cleans up any data it created via DELETE."""
    Session = sessionmaker(bind=engine)
    sess = Session()
    # Track video IDs created during the test for cleanup
    sess._test_video_ids = []
    yield sess
    # Clean up test data
    for vid in sess._test_video_ids:
        sess.execute(text("DELETE FROM pipeline_runs WHERE video_id = :vid"), {"vid": str(vid)})
        sess.execute(text("DELETE FROM videos WHERE id = :vid"), {"vid": str(vid)})
    sess.commit()
    sess.close()


@pytest.fixture
def make_video(session):
    """Factory to create a test video record."""
    def _make(title="Test Lecture", youtube_url=None):
        if youtube_url is None:
            youtube_url = f"https://youtube.com/watch?v=test-{uuid.uuid4().hex[:8]}"
        video = Video(
            id=uuid.uuid4(),
            title=title,
            youtube_url=youtube_url,
            duration=600.0,
            status=VideoStatus.queued,
        )
        session.add(video)
        session.flush()
        session._test_video_ids.append(video.id)
        return video
    return _make


@pytest.fixture
def make_run(session, make_video):
    """Factory to create a test pipeline run."""
    def _make(status=RunStatus.queued, video=None, run_type="process", params=None, **kwargs):
        if video is None:
            video = make_video()
        run = PipelineRun(
            id=uuid.uuid4(),
            video_id=video.id,
            status=status,
            run_type=run_type,
            params=params or {"source": video.youtube_url},
            pipeline_version="v2",
            progress={},
            **kwargs,
        )
        session.add(run)
        session.flush()
        return run
    return _make
