"""Add notes results and deduplicate active/successful jobs per source extraction."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "7ad831e4bc20"
down_revision = "f2b8c1e7a9d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pipeline_runs", sa.Column("notes", postgresql.JSONB(), nullable=True))
    op.create_index(
        "idx_notes_source_run", "pipeline_runs", ["video_id", sa.text("(params->>'source_run_id')")],
        unique=True, postgresql_where=sa.text("run_type = 'generate_notes' AND status != 'failed'"),
    )


def downgrade() -> None:
    op.drop_index("idx_notes_source_run", table_name="pipeline_runs")
    op.drop_column("pipeline_runs", "notes")
