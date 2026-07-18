"""A durable LangGraph checkpointer backed by Cloud Spanner (or its emulator).

Stores the full serialized checkpoint + metadata per (thread, ns, checkpoint_id)
and the per-task writes, so interrupted graph runs (e.g. pending approvals) can
resume across process restarts. Modeled on the reference SqliteSaver but using
Spanner mutations for writes and SQL for reads.
"""

from __future__ import annotations

import base64
from typing import Any, Iterator, Optional, Sequence

from google.cloud.spanner_v1 import param_types
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)


def _b64(blob: bytes) -> str:
    # Spanner client requires BYTES be base64; we store blobs as base64 STRINGs.
    return base64.b64encode(blob).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s)


def _cfg(thread_id: str, ns: str, ckpt_id: str | None) -> dict:
    c: dict[str, Any] = {"thread_id": thread_id, "checkpoint_ns": ns}
    if ckpt_id is not None:
        c["checkpoint_id"] = ckpt_id
    return {"configurable": c}


class SpannerCheckpointSaver(BaseCheckpointSaver):
    def __init__(self, database):
        super().__init__()
        self.db = database

    # ── write ─────────────────────────────────────────────────────────────────
    def put(
        self,
        config: dict,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> dict:
        conf = config["configurable"]
        thread_id = conf["thread_id"]
        ns = conf.get("checkpoint_ns", "")
        ckpt_id = checkpoint["id"]
        parent_id = conf.get("checkpoint_id")

        ctype, cblob = self.serde.dumps_typed(checkpoint)
        mtype, mblob = self.serde.dumps_typed(dict(metadata))

        with self.db.batch() as batch:
            batch.insert_or_update(
                table="checkpoints",
                columns=("thread_id", "checkpoint_ns", "checkpoint_id", "parent_checkpoint_id",
                         "ckpt_type", "checkpoint", "meta_type", "metadata"),
                values=[(thread_id, ns, ckpt_id, parent_id, ctype, _b64(cblob), mtype, _b64(mblob))],
            )
        return _cfg(thread_id, ns, ckpt_id)

    def put_writes(self, config: dict, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = "") -> None:
        conf = config["configurable"]
        thread_id = conf["thread_id"]
        ns = conf.get("checkpoint_ns", "")
        ckpt_id = conf["checkpoint_id"]
        rows = []
        for idx, (channel, value) in enumerate(writes):
            wtype, wblob = self.serde.dumps_typed(value)
            rows.append((thread_id, ns, ckpt_id, task_id, idx, channel, wtype, _b64(wblob)))
        if not rows:
            return
        with self.db.batch() as batch:
            batch.insert_or_update(
                table="checkpoint_writes",
                columns=("thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "write_idx",
                         "channel", "w_type", "value"),
                values=rows,
            )

    # ── read ──────────────────────────────────────────────────────────────────
    def _load_writes(self, thread_id: str, ns: str, ckpt_id: str) -> list[tuple[str, str, Any]]:
        sql = (
            "SELECT task_id, channel, w_type, value FROM checkpoint_writes "
            "WHERE thread_id=@t AND checkpoint_ns=@n AND checkpoint_id=@c "
            "ORDER BY task_id, write_idx"
        )
        params = {"t": thread_id, "n": ns, "c": ckpt_id}
        types = {"t": param_types.STRING, "n": param_types.STRING, "c": param_types.STRING}
        out = []
        with self.db.snapshot() as snap:
            for task_id, channel, w_type, value in snap.execute_sql(sql, params=params, param_types=types):
                out.append((task_id, channel, self.serde.loads_typed((w_type, _unb64(value)))))
        return out

    def get_tuple(self, config: dict) -> Optional[CheckpointTuple]:
        conf = config["configurable"]
        thread_id = conf["thread_id"]
        ns = conf.get("checkpoint_ns", "")
        ckpt_id = conf.get("checkpoint_id")

        if ckpt_id:
            sql = (
                "SELECT checkpoint_id, parent_checkpoint_id, ckpt_type, checkpoint, meta_type, metadata "
                "FROM checkpoints WHERE thread_id=@t AND checkpoint_ns=@n AND checkpoint_id=@c"
            )
            params = {"t": thread_id, "n": ns, "c": ckpt_id}
            types = {"t": param_types.STRING, "n": param_types.STRING, "c": param_types.STRING}
        else:
            sql = (
                "SELECT checkpoint_id, parent_checkpoint_id, ckpt_type, checkpoint, meta_type, metadata "
                "FROM checkpoints WHERE thread_id=@t AND checkpoint_ns=@n "
                "ORDER BY checkpoint_id DESC LIMIT 1"
            )
            params = {"t": thread_id, "n": ns}
            types = {"t": param_types.STRING, "n": param_types.STRING}

        row = None
        with self.db.snapshot() as snap:
            for r in snap.execute_sql(sql, params=params, param_types=types):
                row = r
                break
        if row is None:
            return None

        found_id, parent_id, ctype, cblob, mtype, mblob = row
        checkpoint = self.serde.loads_typed((ctype, _unb64(cblob)))
        metadata = self.serde.loads_typed((mtype, _unb64(mblob)))
        writes = self._load_writes(thread_id, ns, found_id)
        parent_config = _cfg(thread_id, ns, parent_id) if parent_id else None
        return CheckpointTuple(
            config=_cfg(thread_id, ns, found_id),
            checkpoint=checkpoint,
            metadata=metadata,
            parent_config=parent_config,
            pending_writes=writes,
        )

    def list(self, config: Optional[dict], *, filter=None, before=None, limit=None) -> Iterator[CheckpointTuple]:
        conf = (config or {}).get("configurable", {})
        thread_id = conf.get("thread_id")
        ns = conf.get("checkpoint_ns", "")
        clauses = ["thread_id=@t", "checkpoint_ns=@n"]
        params: dict[str, Any] = {"t": thread_id, "n": ns}
        types = {"t": param_types.STRING, "n": param_types.STRING}
        if before and before.get("configurable", {}).get("checkpoint_id"):
            clauses.append("checkpoint_id < @b")
            params["b"] = before["configurable"]["checkpoint_id"]
            types["b"] = param_types.STRING
        sql = (
            "SELECT checkpoint_id, parent_checkpoint_id, ckpt_type, checkpoint, meta_type, metadata "
            f"FROM checkpoints WHERE {' AND '.join(clauses)} ORDER BY checkpoint_id DESC"
        )
        if limit:
            sql += f" LIMIT {int(limit)}"
        rows = []
        with self.db.snapshot() as snap:
            for r in snap.execute_sql(sql, params=params, param_types=types):
                rows.append(r)
        for found_id, parent_id, ctype, cblob, mtype, mblob in rows:
            checkpoint = self.serde.loads_typed((ctype, _unb64(cblob)))
            metadata = self.serde.loads_typed((mtype, _unb64(mblob)))
            writes = self._load_writes(thread_id, ns, found_id)
            yield CheckpointTuple(
                config=_cfg(thread_id, ns, found_id),
                checkpoint=checkpoint,
                metadata=metadata,
                parent_config=_cfg(thread_id, ns, parent_id) if parent_id else None,
                pending_writes=writes,
            )
