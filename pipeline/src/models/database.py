import logging
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("CHALKBOARD_ENV") == "production":
        raise RuntimeError("DATABASE_URL must be set in production")
    DATABASE_URL = "postgresql://chalkboard:localdev@localhost:5432/chalkboard"
    logging.getLogger("chalkboard.db").warning("DATABASE_URL not set, using localhost default")

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=1800)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass
