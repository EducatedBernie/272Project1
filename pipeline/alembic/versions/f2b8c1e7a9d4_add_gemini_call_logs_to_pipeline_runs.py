"""add gemini_call_logs to pipeline_runs

Revision ID: f2b8c1e7a9d4
Revises: e2c9d50f4187
Create Date: 2026-05-06 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy.dialects import postgresql
import sqlalchemy as sa


revision: str = "f2b8c1e7a9d4"
down_revision: Union[str, None] = "e2c9d50f4187"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pipeline_runs",
        sa.Column("gemini_call_logs", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pipeline_runs", "gemini_call_logs")
