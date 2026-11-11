"""Keep completed notes while allowing a new run for the same extraction."""

import sqlalchemy as sa

from alembic import op

revision = "c317bf4e9a20"
down_revision = "7ad831e4bc20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("idx_notes_source_run", table_name="pipeline_runs")
    op.create_index(
        "idx_notes_source_run", "pipeline_runs", ["video_id", sa.text("(params->>'source_run_id')")],
        unique=True, postgresql_where=sa.text(
            "run_type = 'generate_notes' AND status NOT IN ('complete', 'failed')"),
    )


def downgrade() -> None:
    op.drop_index("idx_notes_source_run", table_name="pipeline_runs")
    op.create_index(
        "idx_notes_source_run", "pipeline_runs", ["video_id", sa.text("(params->>'source_run_id')")],
        unique=True, postgresql_where=sa.text("run_type = 'generate_notes' AND status != 'failed'"),
    )
