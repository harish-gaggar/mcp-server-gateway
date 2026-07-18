"""Abstract memory backend interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class MemoryBackend(ABC):
    """Stores conversation threads/messages, LLM telemetry, and provides a
    durable LangGraph checkpointer."""

    # ── schema ────────────────────────────────────────────────────────────────
    @abstractmethod
    def init_schema(self) -> None: ...

    # ── threads / messages ──────────────────────────────────────────────────
    @abstractmethod
    def upsert_thread(self, thread_id: str, title: str, user: str | None) -> None: ...

    @abstractmethod
    def list_threads(self, limit: int = 100) -> list[dict[str, Any]]: ...

    @abstractmethod
    def get_thread(self, thread_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def add_message(self, thread_id: str, role: str, content: str, meta: dict, findings: list) -> None: ...

    @abstractmethod
    def get_messages(self, thread_id: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def delete_thread(self, thread_id: str) -> None: ...

    # ── LLM telemetry / eval ─────────────────────────────────────────────────
    @abstractmethod
    def record_llm_call(self, **kwargs: Any) -> None: ...

    @abstractmethod
    def list_llm_calls(self, limit: int = 500) -> list[dict[str, Any]]: ...

    @abstractmethod
    def llm_summary(self) -> dict[str, Any]: ...

    @abstractmethod
    def record_feedback(self, run_id: str | None, thread_id: str | None, rating: int, note: str = "") -> None: ...

    @abstractmethod
    def feedback_summary(self) -> dict[str, Any]: ...

    # ── checkpointer ──────────────────────────────────────────────────────────
    @abstractmethod
    def checkpointer(self): ...

    def close(self) -> None:  # pragma: no cover - optional
        pass
