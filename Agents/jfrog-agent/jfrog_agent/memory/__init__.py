"""Durable agent memory: conversation threads, messages, LLM metrics/feedback,
and LangGraph checkpoints. Pluggable backend (SQLite default, Spanner optional).
"""

from __future__ import annotations

from ..settings import Settings, settings as default_settings
from .backend import MemoryBackend


def get_backend(settings: Settings = default_settings) -> MemoryBackend:
    if settings.memory_backend == "spanner":
        from .spanner_backend import SpannerBackend

        return SpannerBackend(settings)
    from .sqlite_backend import SqliteBackend

    return SqliteBackend(settings)


__all__ = ["MemoryBackend", "get_backend"]
