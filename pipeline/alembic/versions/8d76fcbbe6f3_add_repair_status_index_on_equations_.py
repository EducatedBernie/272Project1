"""add repair_status index on equations content_metadata

Revision ID: 8d76fcbbe6f3
Revises: d9a72b1e4c01
Create Date: 2026-05-01 10:10:05.879126

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8d76fcbbe6f3'
down_revision: Union[str, None] = 'd9a72b1e4c01'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Index for querying items by repair_status. JSONB GIN index would be
    # more general but a btree on the extracted text is enough — under the
    # deterministic healer (commit 0f21885), repair_status is one of
    # {NULL, 'fixed', 'skipped'}. Older LLM-repair-era rows may have
    # 'failed' too; the index covers all of them via WHERE ? predicate.
    #
    # CONCURRENTLY: builds without an exclusive lock on the table, so this
    # migration is safe to run while extractions are mid-flight. Cheap
    # insurance even at our current scale. CONCURRENTLY can't run inside a
    # transaction, so we use Alembic's autocommit_block — the canonical
    # idiom that explicitly switches the connection to AUTOCOMMIT and
    # exits the alembic-managed transaction wrapper.
    with op.get_context().autocommit_block():
        op.execute(sa.text("""
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_equations_repair_status
            ON equations (run_id, ((content_metadata->>'repair_status')))
            WHERE content_metadata ? 'repair_status'
        """))


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(sa.text("DROP INDEX CONCURRENTLY IF EXISTS idx_equations_repair_status"))
