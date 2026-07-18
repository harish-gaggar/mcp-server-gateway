"""Spanner memory backend (works against the Cloud Spanner emulator).

Set SPANNER_EMULATOR_HOST (e.g. localhost:9010) to target the local emulator.
Creates the instance/database/schema on first use.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any

from ..settings import Settings, settings as default_settings
from .backend import MemoryBackend

_DDL = [
    """CREATE TABLE threads (
        thread_id STRING(MAX) NOT NULL,
        title STRING(MAX),
        user_name STRING(MAX),
        created_at FLOAT64,
        updated_at FLOAT64,
    ) PRIMARY KEY(thread_id)""",
    """CREATE TABLE messages (
        thread_id STRING(MAX) NOT NULL,
        msg_id STRING(36) NOT NULL,
        role STRING(MAX),
        content STRING(MAX),
        meta STRING(MAX),
        findings STRING(MAX),
        ts FLOAT64,
    ) PRIMARY KEY(thread_id, msg_id)""",
    """CREATE TABLE llm_calls (
        call_id STRING(36) NOT NULL,
        run_id STRING(MAX),
        thread_id STRING(MAX),
        purpose STRING(MAX),
        provider STRING(MAX),
        model STRING(MAX),
        prompt_tokens INT64,
        completion_tokens INT64,
        total_tokens INT64,
        latency_ms FLOAT64,
        ok BOOL,
        cost FLOAT64,
        ts FLOAT64,
    ) PRIMARY KEY(call_id)""",
    """CREATE TABLE llm_feedback (
        fb_id STRING(36) NOT NULL,
        run_id STRING(MAX),
        thread_id STRING(MAX),
        rating INT64,
        note STRING(MAX),
        ts FLOAT64,
    ) PRIMARY KEY(fb_id)""",
    """CREATE TABLE checkpoints (
        thread_id STRING(MAX) NOT NULL,
        checkpoint_ns STRING(MAX) NOT NULL,
        checkpoint_id STRING(MAX) NOT NULL,
        parent_checkpoint_id STRING(MAX),
        ckpt_type STRING(MAX),
        checkpoint STRING(MAX),
        meta_type STRING(MAX),
        metadata STRING(MAX),
    ) PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)""",
    """CREATE TABLE checkpoint_writes (
        thread_id STRING(MAX) NOT NULL,
        checkpoint_ns STRING(MAX) NOT NULL,
        checkpoint_id STRING(MAX) NOT NULL,
        task_id STRING(MAX) NOT NULL,
        write_idx INT64 NOT NULL,
        channel STRING(MAX),
        w_type STRING(MAX),
        value STRING(MAX),
    ) PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx)""",
]


class SpannerBackend(MemoryBackend):
    def __init__(self, settings: Settings = default_settings):
        self.s = settings
        if settings.spanner_emulator_host:
            os.environ.setdefault("SPANNER_EMULATOR_HOST", settings.spanner_emulator_host)
        self._db = None
        self._ckpt = None
        self.init_schema()

    # ── connection / schema ───────────────────────────────────────────────────
    def _client(self):
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import spanner

        if os.environ.get("SPANNER_EMULATOR_HOST"):
            return spanner.Client(project=self.s.spanner_project, credentials=AnonymousCredentials())
        return spanner.Client(project=self.s.spanner_project)

    def database(self):
        if self._db is None:
            client = self._client()
            instance = client.instance(self.s.spanner_instance)
            if not instance.exists():
                config_name = f"projects/{self.s.spanner_project}/instanceConfigs/emulator-config"
                instance = client.instance(self.s.spanner_instance, configuration_name=config_name, node_count=1)
                instance.create().result(120)
            db = instance.database(self.s.spanner_database)
            if not db.exists():
                db = instance.database(self.s.spanner_database, ddl_statements=_DDL)
                db.create().result(120)
            self._db = db
        return self._db

    def init_schema(self) -> None:
        self.database()

    # ── helpers ────────────────────────────────────────────────────────────────
    def _dml(self, sql: str, params: dict, types: dict):
        def _run(txn):
            txn.execute_update(sql, params=params, param_types=types)
        self.database().run_in_transaction(_run)

    def _query(self, sql: str, params: dict | None = None, types: dict | None = None) -> list[tuple]:
        with self.database().snapshot() as snap:
            return list(snap.execute_sql(sql, params=params or None, param_types=types or None))

    # ── threads / messages ──────────────────────────────────────────────────
    def upsert_thread(self, thread_id: str, title: str, user: str | None) -> None:
        now = time.time()
        existing = self._query(
            "SELECT thread_id FROM threads WHERE thread_id=@t",
            {"t": thread_id}, {"t": _t.STRING},
        )
        with self.database().batch() as batch:
            if existing:
                batch.update("threads", ("thread_id", "updated_at"), [(thread_id, now)])
            else:
                batch.insert(
                    "threads",
                    ("thread_id", "title", "user_name", "created_at", "updated_at"),
                    [(thread_id, title, user, now, now)],
                )

    def list_threads(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT t.thread_id, t.title, t.user_name, t.created_at, t.updated_at, "
            "(SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.thread_id) "
            f"FROM threads t ORDER BY t.updated_at DESC LIMIT {int(limit)}"
        )
        return [
            {"thread_id": r[0], "title": r[1], "user": r[2], "created_at": r[3], "updated_at": r[4], "msg_count": r[5]}
            for r in rows
        ]

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT thread_id, title, user_name, created_at, updated_at FROM threads WHERE thread_id=@t",
            {"t": thread_id}, {"t": _t.STRING},
        )
        if not rows:
            return None
        r = rows[0]
        return {"thread_id": r[0], "title": r[1], "user": r[2], "created_at": r[3], "updated_at": r[4]}

    def add_message(self, thread_id: str, role: str, content: str, meta: dict, findings: list) -> None:
        import json
        with self.database().batch() as batch:
            batch.insert(
                "messages",
                ("thread_id", "msg_id", "role", "content", "meta", "findings", "ts"),
                [(thread_id, uuid.uuid4().hex, role, content, json.dumps(meta, default=str), json.dumps(findings, default=str), time.time())],
            )

    def get_messages(self, thread_id: str) -> list[dict[str, Any]]:
        import json
        rows = self._query(
            "SELECT role, content, meta, findings, ts FROM messages WHERE thread_id=@t ORDER BY ts",
            {"t": thread_id}, {"t": _t.STRING},
        )
        out = []
        for role, content, meta, findings, ts in rows:
            out.append({
                "role": role, "content": content,
                "meta": json.loads(meta or "{}"), "findings": json.loads(findings or "[]"), "ts": ts,
            })
        return out

    def delete_thread(self, thread_id: str) -> None:
        self._dml("DELETE FROM messages WHERE thread_id=@t", {"t": thread_id}, {"t": _t.STRING})
        self._dml("DELETE FROM threads WHERE thread_id=@t", {"t": thread_id}, {"t": _t.STRING})

    # ── LLM telemetry / eval ─────────────────────────────────────────────────
    def record_llm_call(self, **kw: Any) -> None:
        with self.database().batch() as batch:
            batch.insert(
                "llm_calls",
                ("call_id", "run_id", "thread_id", "purpose", "provider", "model",
                 "prompt_tokens", "completion_tokens", "total_tokens", "latency_ms", "ok", "cost", "ts"),
                [(
                    uuid.uuid4().hex, kw.get("run_id"), kw.get("thread_id"), kw.get("purpose"),
                    kw.get("provider"), kw.get("model"), int(kw.get("prompt_tokens", 0)),
                    int(kw.get("completion_tokens", 0)), int(kw.get("total_tokens", 0)),
                    float(kw.get("latency_ms", 0.0)), bool(kw.get("ok", True)), float(kw.get("cost", 0.0)), time.time(),
                )],
            )

    def list_llm_calls(self, limit: int = 500) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT run_id, thread_id, purpose, provider, model, prompt_tokens, completion_tokens, "
            f"total_tokens, latency_ms, ok, cost, ts FROM llm_calls ORDER BY ts DESC LIMIT {int(limit)}"
        )
        cols = ["run_id", "thread_id", "purpose", "provider", "model", "prompt_tokens",
                "completion_tokens", "total_tokens", "latency_ms", "ok", "cost", "ts"]
        return [dict(zip(cols, r)) for r in rows]

    def llm_summary(self) -> dict[str, Any]:
        total = self._query(
            "SELECT COUNT(*), IFNULL(SUM(total_tokens),0), IFNULL(SUM(cost),0), IFNULL(AVG(latency_ms),0) FROM llm_calls"
        )[0]
        by_model = self._query(
            "SELECT model, COUNT(*), IFNULL(SUM(total_tokens),0), IFNULL(SUM(cost),0), IFNULL(AVG(latency_ms),0) "
            "FROM llm_calls GROUP BY model ORDER BY 3 DESC"
        )
        return {
            "calls": total[0], "tokens": total[1], "cost": total[2], "avg_latency_ms": total[3],
            "by_model": [
                {"model": r[0], "calls": r[1], "tokens": r[2], "cost": r[3], "avg_latency_ms": r[4]}
                for r in by_model
            ],
        }

    def record_feedback(self, run_id, thread_id, rating: int, note: str = "") -> None:
        with self.database().batch() as batch:
            batch.insert(
                "llm_feedback",
                ("fb_id", "run_id", "thread_id", "rating", "note", "ts"),
                [(uuid.uuid4().hex, run_id, thread_id, int(rating), note, time.time())],
            )

    def feedback_summary(self) -> dict[str, Any]:
        r = self._query(
            "SELECT COUNT(*), IFNULL(SUM(CASE WHEN rating>0 THEN 1 ELSE 0 END),0), "
            "IFNULL(SUM(CASE WHEN rating<0 THEN 1 ELSE 0 END),0) FROM llm_feedback"
        )[0]
        return {"total": r[0], "up": r[1], "down": r[2]}

    # ── checkpointer ──────────────────────────────────────────────────────────
    def checkpointer(self):
        if self._ckpt is None:
            from .spanner_checkpointer import SpannerCheckpointSaver

            self._ckpt = SpannerCheckpointSaver(self.database())
        return self._ckpt


# param_types shortcut
from google.cloud.spanner_v1 import param_types as _t  # noqa: E402
