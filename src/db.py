"""
Database connection and session management
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.ext.declarative import declarative_base
from contextlib import contextmanager
from typing import Generator

from src.config import config


# SQLAlchemy base for model declarations
Base = declarative_base()

# Database engine (lazy initialization)
_engine = None
_SessionLocal = None


def get_engine():
    """
    Get or create the database engine
    
    Returns:
        Engine: SQLAlchemy engine instance
    """
    global _engine
    if _engine is None:
        _engine = create_engine(
            config.get_database_url(),
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10
        )
    return _engine


def get_session_factory():
    """
    Get or create the session factory
    
    Returns:
        sessionmaker: SQLAlchemy session factory
    """
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=get_engine()
        )
    return _SessionLocal


def get_db() -> Generator[Session, None, None]:
    """
    Dependency for FastAPI to get database session
    
    Yields:
        Session: Database session
    """
    SessionLocal = get_session_factory()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_context() -> Generator[Session, None, None]:
    """
    Context manager for database session (for non-FastAPI usage)
    
    Yields:
        Session: Database session
    """
    SessionLocal = get_session_factory()
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    """
    Initialize database tables
    Creates all tables defined in models
    """
    # Import models to register them with Base
    from src import models  # noqa: F401
    Base.metadata.create_all(bind=get_engine())


def reset_db():
    """
    Reset database (drop and recreate all tables)
    WARNING: This will delete all data
    """
    from src import models  # noqa: F401
    Base.metadata.drop_all(bind=get_engine())
    Base.metadata.create_all(bind=get_engine())
