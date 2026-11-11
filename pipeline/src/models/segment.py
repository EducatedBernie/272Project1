import uuid
from datetime import datetime

from sqlalchemy import Float, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    video_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("videos.id"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("pipeline_runs.id"), nullable=True)
    text: Mapped[str] = mapped_column(Text)
    timestamp_start: Mapped[float] = mapped_column(Float)
    timestamp_end: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    video: Mapped["Video"] = relationship(back_populates="segments")
    run: Mapped["PipelineRun | None"] = relationship(back_populates="segments")
    equations: Mapped[list["Equation"]] = relationship(
        secondary="segment_equations", back_populates="segments"
    )

    __table_args__ = (
        Index("idx_segments_video_id", "video_id"),
        Index("idx_segments_video_timestamps", "video_id", "timestamp_start", "timestamp_end"),
    )
