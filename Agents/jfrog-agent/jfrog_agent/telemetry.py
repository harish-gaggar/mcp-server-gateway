"""LLM usage + evaluation telemetry (agent-side).

This is deliberately SEPARATE from the MCP gateway's OpenTelemetry: the gateway
never sees LLM traffic (the agent calls the LLM directly). LLM model/token/cost
and quality signals are recorded here and persisted by the active memory backend,
then surfaced on the "LLM & Evaluation" page.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any

# Rough price table (USD per 1K tokens). Override/extend as needed. Unknown
# models cost 0 (still tracked by token count).
PRICES: dict[str, tuple[float, float]] = {
    "gpt-4o": (0.0025, 0.010),
    "gpt-4o-mini": (0.00015, 0.0006),
    "gpt-4.1": (0.002, 0.008),
    "gpt-4.1-mini": (0.0004, 0.0016),
    "o4-mini": (0.0011, 0.0044),
    "claude-3-5-sonnet": (0.003, 0.015),
    "claude-3-5-haiku": (0.0008, 0.004),
}

_SINK: Any = None
_CTX: dict[str, Any] = {"run_id": None, "thread_id": None}


def set_sink(backend: Any) -> None:
    global _SINK
    _SINK = backend


def set_context(run_id: str | None = None, thread_id: str | None = None) -> None:
    if run_id is not None:
        _CTX["run_id"] = run_id
    if thread_id is not None:
        _CTX["thread_id"] = thread_id


def _tokens_from_message(msg: Any) -> tuple[int, int, int]:
    usage = getattr(msg, "usage_metadata", None) or {}
    pi = int(usage.get("input_tokens", 0) or 0)
    po = int(usage.get("output_tokens", 0) or 0)
    tot = int(usage.get("total_tokens", pi + po) or (pi + po))
    return pi, po, tot


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    key = (model or "").lower()
    price = PRICES.get(key)
    if not price:
        # try prefix match (e.g. "gpt-4o-mini-2024-..." )
        for k, v in PRICES.items():
            if key.startswith(k):
                price = v
                break
    if not price:
        return 0.0
    return (prompt_tokens / 1000.0) * price[0] + (completion_tokens / 1000.0) * price[1]


def record_llm_call(purpose: str, provider: str, model: str, message: Any, latency_ms: float, ok: bool = True) -> None:
    pi, po, tot = _tokens_from_message(message)
    cost = estimate_cost(model, pi, po)
    if _SINK is None:
        return
    try:
        _SINK.record_llm_call(
            run_id=_CTX.get("run_id"),
            thread_id=_CTX.get("thread_id"),
            purpose=purpose,
            provider=provider,
            model=model,
            prompt_tokens=pi,
            completion_tokens=po,
            total_tokens=tot,
            latency_ms=latency_ms,
            ok=ok,
            cost=cost,
        )
    except Exception:
        pass


@contextmanager
def timed():
    start = time.perf_counter()
    yield lambda: (time.perf_counter() - start) * 1000.0
