import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, String, Text, Enum, DateTime, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class RunStatus(enum.Enum):
    queued = "queued"
    downloading_captions = "downloading_captions"
    generating_topic_map = "generating_topic_map"
    processing_sections = "processing_sections"
    word_aligning = "word_aligning"
    saving = "saving"
    complete = "complete"
    failed = "failed"


class PipelineRun(Base):
    __tablename__ = "pipeline_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    video_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("videos.id"))
    status: Mapped[RunStatus] = mapped_column(Enum(RunStatus), default=RunStatus.queued)
    progress: Mapped[dict | None] = mapped_column(JSONB, default=dict)
    pipeline_version: Mapped[str] = mapped_column(String, default="v2")
    transcript_prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    equations_prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    visual_content_prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    segment_count: Mapped[int | None] = mapped_column(nullable=True)
    equation_count: Mapped[int | None] = mapped_column(nullable=True)
    sections: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    gemini_call_logs: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # YouTube/Chirp SRT-derived captions, persisted from db_mode runs so the
    # debug page's SyncedTranscripts can render them. Only the original
    # `process` run owns this — scoped re-extraction runs leave it null and
    # the viewer falls back to the parent run via getAutoCaptions().
    auto_captions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Worker dispatch columns
    run_type: Mapped[str | None] = mapped_column(String, nullable=True, default="process")
    params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String, nullable=True)
    # Set by POST /api/runs/<id>/cancel; checked at every stage transition
    # inside _update_run_progress to raise CancelledError. See PR 2.
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    video: Mapped["Video"] = relationship(back_populates="runs")
    segments: Mapped[list["TranscriptSegment"]] = relationship(back_populates="run")
    equations: Mapped[list["Equation"]] = relationship(back_populates="run")

    __table_args__ = (
        Index("idx_runs_video_id", "video_id"),
        Index("idx_runs_queued_pickup", "status", "created_at"),
        Index("idx_notes_source_run", "video_id", text("(params->>'source_run_id')"),
              unique=True, postgresql_where=text(
                  "run_type = 'generate_notes' AND status NOT IN ('complete', 'failed')")),
    )
