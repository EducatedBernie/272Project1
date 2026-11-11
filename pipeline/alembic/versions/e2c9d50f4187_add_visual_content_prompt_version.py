"""add visual_content_prompt_version to pipeline_runs

Revision ID: e2c9d50f4187
Revises: 8d76fcbbe6f3
Create Date: 2026-05-02 13:00:00.000000

The visual content extraction prompt was split off from the equations
prompt during the v0.5.0 describe-first work, but the schema still only
tracked `equations_prompt_version`. Scoped re-extraction runs (section /
item) were misusing that column to stamp the visual content version,
which produced misleading run labels in the viewer (e.g. a Run 5 showing
"eq v0.5.0" when the equations prompt was actually still on v0.4).

This adds a dedicated column. The follow-up code change stops the
misuse and starts stamping the correct version on every run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e2c9d50f4187'
down_revision: Union[str, None] = '8d76fcbbe6f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pipeline_runs',
        sa.Column('visual_content_prompt_version', sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('pipeline_runs', 'visual_content_prompt_version')
