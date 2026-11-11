import uuid
from datetime import datetime

from sqlalchemy import Float, String, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Equation(Base):
    __tablename__ = "equations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    video_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("videos.id"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("pipeline_runs.id"), nullable=True)
    content_type: Mapped[str] = mapped_column(String, default="equation", server_default="equation")
    latex_string: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    timestamp_start: Mapped[float] = mapped_column(Float)
    timestamp_end: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    content_metadata: Mapped[dict | None] = mapped_column("content_metadata", JSONB, nullable=True)
    frame_snapshot_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    video: Mapped["Video"] = relationship(back_populates="equations")
    run: Mapped["PipelineRun | None"] = relationship(back_populates="equations")
    segments: Mapped[list["TranscriptSegment"]] = relationship(
        secondary="segment_equations", back_populates="equations"
    )

    __table_args__ = (
        Index("idx_equations_video_id", "video_id"),
        Index("idx_equations_video_timestamps", "video_id", "timestamp_start", "timestamp_end"),
        Index("idx_equations_content_type", "video_id", "content_type"),
    )
