"""add unique constraint on videos.youtube_url

Revision ID: c8e4f1a72b3d
Revises: b3f7a2c91d4e
Create Date: 2026-04-15
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c8e4f1a72b3d'
down_revision: Union[str, None] = 'b3f7a2c91d4e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Deduplicate any existing rows first (keep the oldest)
    op.execute("""
        DELETE FROM videos a USING videos b
        WHERE a.id > b.id AND a.youtube_url = b.youtube_url
    """)
    op.create_unique_constraint('uq_videos_youtube_url', 'videos', ['youtube_url'])


def downgrade() -> None:
    op.drop_constraint('uq_videos_youtube_url', 'videos', type_='unique')
