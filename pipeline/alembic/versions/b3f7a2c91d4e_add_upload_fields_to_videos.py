"""add upload fields to videos

Revision ID: b3f7a2c91d4e
Revises: a112b9a03a1e
Create Date: 2026-04-15
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b3f7a2c91d4e'
down_revision: Union[str, None] = 'a112b9a03a1e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('videos', sa.Column('source_type', sa.String(20), server_default='youtube', nullable=False))
    op.add_column('videos', sa.Column('r2_key', sa.Text(), nullable=True))
    op.add_column('videos', sa.Column('r2_url', sa.Text(), nullable=True))

    # Backfill existing rows
    op.execute("""
        UPDATE videos SET source_type = CASE
            WHEN youtube_url LIKE '%youtube.com%' OR youtube_url LIKE '%youtu.be%' THEN 'youtube'
            ELSE 'upload'
        END
    """)


def downgrade() -> None:
    op.drop_column('videos', 'r2_url')
    op.drop_column('videos', 'r2_key')
    op.drop_column('videos', 'source_type')
