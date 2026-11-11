import enum
import uuid
from datetime import datetime

from sqlalchemy import Float, String, Text, Enum, DateTime
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class VideoStatus(enum.Enum):
    queued = "queued"
    processing = "processing"
    complete = "complete"
    failed = "failed"


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(Text)
    youtube_url: Mapped[str] = mapped_column(Text)
    duration: Mapped[float] = mapped_column(Float)
    status: Mapped[VideoStatus] = mapped_column(Enum(VideoStatus), default=VideoStatus.queued)
    raw_gemini_transcript_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_gemini_equations_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    transcript_prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    equations_prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Upload support (Blocker #3)
    source_type: Mapped[str] = mapped_column(String(20), default="youtube", server_default="youtube")
    r2_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    r2_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    segments: Mapped[list["TranscriptSegment"]] = relationship(back_populates="video")
    equations: Mapped[list["Equation"]] = relationship(back_populates="video")
    runs: Mapped[list["PipelineRun"]] = relationship(back_populates="video")
