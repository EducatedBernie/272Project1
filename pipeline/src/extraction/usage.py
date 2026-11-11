"""Thread-safe accumulator for Gemini API token usage.

Each Gemini call site records its `response.usage_metadata` (and a few
identifying fields) into a shared `UsageAccumulator` for the run. The
accumulator's `summary()` is merged into `pipeline_runs.progress` JSONB
so per-run cost is queryable from the DB.

No pricing math here — pricing changes; persist raw counts and compute
cost at read time.
"""

from __future__ import annotations

import threading
from typing import Any

# Hard cap on per-call entries to keep JSONB tight and protect against
# pathological retry storms or future per-frame call patterns. A typical
# 90-min lecture with verification produces ~30 entries; 200 leaves
# headroom without bloating the row.
MAX_CALLS = 200


def _coerce_int(v: Any) -> int | None:
    """Return v if it's a real int, else None.

    Critical for tests that mock `response` with `unittest.mock.MagicMock` —
    `getattr(mock.usage_metadata, "prompt_token_count", None)` returns
    another MagicMock (not None), which would silently pass through
    naive `or 0` arithmetic and produce garbage totals.
    """
    return v if isinstance(v, int) else None


def _coerce_str(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _capture_usage(
    response: Any,
    *,
    model: str,
    kind: str,
    section_index: int | None,
) -> dict | None:
    """Extract a flat usage dict from a Gemini response.

    Returns None when the response carries no usable numeric usage data
    (real None, MagicMock, or all fields missing). Callers should skip
    appending None entries.
    """
    um = getattr(response, "usage_metadata", None)
    if um is None:
        return None

    prompt = _coerce_int(getattr(um, "prompt_token_count", None))
    candidates = _coerce_int(getattr(um, "candidates_token_count", None))
    total = _coerce_int(getattr(um, "total_token_count", None))
    cached = _coerce_int(getattr(um, "cached_content_token_count", None))
    thoughts = _coerce_int(getattr(um, "thoughts_token_count", None))

    # Bail if every numeric field is None — covers MagicMock pollution
    # and any future SDK shape change that drops these fields.
    if prompt is None and candidates is None and total is None:
        return None

    return {
        "kind": kind,
        "section_index": section_index,
        "model_requested": model,
        "model_version": _coerce_str(getattr(response, "model_version", None)),
        "prompt_token_count": prompt,
        "candidates_token_count": candidates,
        "total_token_count": total,
        "cached_content_token_count": cached,
        "thoughts_token_count": thoughts,
    }


class UsageAccumulator:
    """Thread-safe accumulator for per-call Gemini usage metadata.

    Instantiate once per pipeline run, pass to every Gemini-calling
    function as an optional kwarg. Default-None on the kwargs keeps
    existing callers (eval, ad-hoc scripts, v1 pipeline) working
    unchanged — the record() call becomes a no-op.

    Concurrency: v2's process_video uses ThreadPoolExecutor(max_workers=5)
    for parallel section processing. record() takes a Lock; summary()
    snapshots the call list under the lock and builds aggregates outside
    to minimize lock-hold time.
    """

    def __init__(self, max_calls: int = MAX_CALLS):
        self._lock = threading.Lock()
        self._calls: list[dict] = []
        self._max = max_calls
        self._truncated = False

    def record(
        self,
        response: Any,
        *,
        model: str,
        kind: str,
        section_index: int | None = None,
    ) -> None:
        """Capture usage from a Gemini response. No-op if response carries
        no usable data (MagicMock test fakes, missing usage_metadata, etc.).
        """
        entry = _capture_usage(
            response, model=model, kind=kind, section_index=section_index
        )
        if entry is None:
            return
        with self._lock:
            if len(self._calls) >= self._max:
                self._truncated = True
                return
            self._calls.append(entry)

    def summary(self) -> dict:
        """Build totals + by_model_version + by_kind + per-call list.

        Returns a freshly-built dict each call (not a reference into
        internal state) — safe to merge into a SQLAlchemy JSONB column
        even if the accumulator is concurrently being mutated by other
        threads.
        """
        with self._lock:
            calls = [dict(c) for c in self._calls]
            truncated = self._truncated

        totals = {
            "calls": len(calls),
            "prompt_tokens": 0,
            "candidates_tokens": 0,
            "cached_tokens": 0,
            "thoughts_tokens": 0,
            "total_tokens": 0,
        }
        by_model: dict[str, dict] = {}
        by_kind: dict[str, int] = {}

        for c in calls:
            prompt = c.get("prompt_token_count") or 0
            candidates = c.get("candidates_token_count") or 0
            cached = c.get("cached_content_token_count") or 0
            thoughts = c.get("thoughts_token_count") or 0
            total = c.get("total_token_count") or 0

            totals["prompt_tokens"] += prompt
            totals["candidates_tokens"] += candidates
            totals["cached_tokens"] += cached
            totals["thoughts_tokens"] += thoughts
            totals["total_tokens"] += total

            mv = c.get("model_version") or c.get("model_requested") or "unknown"
            bucket = by_model.setdefault(
                mv,
                {
                    "calls": 0,
                    "prompt_tokens": 0,
                    "candidates_tokens": 0,
                    "cached_tokens": 0,
                    "thoughts_tokens": 0,
                    "total_tokens": 0,
                },
            )
            bucket["calls"] += 1
            bucket["prompt_tokens"] += prompt
            bucket["candidates_tokens"] += candidates
            bucket["cached_tokens"] += cached
            bucket["thoughts_tokens"] += thoughts
            bucket["total_tokens"] += total

            by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1

        return {
            "totals": totals,
            "by_model_version": by_model,
            "by_kind": by_kind,
            "calls": calls,
            "truncated": truncated,
        }
