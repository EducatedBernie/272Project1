from sqlalchemy import Column, Integer, ForeignKey, Index, Table
from sqlalchemy.dialects.postgresql import UUID

from .database import Base

segment_equations = Table(
    "segment_equations",
    Base.metadata,
    Column("segment_id", UUID(as_uuid=True), ForeignKey("transcript_segments.id", ondelete="CASCADE"), primary_key=True),
    Column("equation_id", UUID(as_uuid=True), ForeignKey("equations.id", ondelete="CASCADE"), primary_key=True),
    Column("position", Integer, nullable=True),
    Index("idx_seg_eq_equation_id", "equation_id"),
)
