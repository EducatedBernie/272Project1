"""add cancel_requested to pipeline_runs

Revision ID: d9a72b1e4c01
Revises: c8e4f1a72b3d
Create Date: 2026-04-17 02:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd9a72b1e4c01'
down_revision: Union[str, None] = 'c8e4f1a72b3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pipeline_runs',
        sa.Column('cancel_requested', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('pipeline_runs', 'cancel_requested')
