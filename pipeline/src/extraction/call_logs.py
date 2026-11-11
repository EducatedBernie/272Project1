"""Raw Gemini call logging for operator/debug forensics.

The heavy prompt/response blobs live in R2. The database stores only the
compact manifest returned by GeminiCallRecorder.summary().
"""

from __future__ import annotations

import json
import logging
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from src.extraction.usage import _capture_usage

logger = logging.getLogger("chalkboard.call_logs")

MANIFEST_VERSION = 1
MAX_MANIFEST_CALLS = 250


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump())
    if hasattr(value, "to_json_dict"):
        return _jsonable(value.to_json_dict())
    if hasattr(value, "__dict__"):
        data = {
            k: v for k, v in vars(value).items()
            if not k.startswith("_") and not callable(v)
        }
        if data:
            return _jsonable(data)
    return repr(value)


def _byte_len(value: Any) -> int:
    return len(json.dumps(_jsonable(value), ensure_ascii=False).encode("utf-8"))


def _safe_response_text(response: Any) -> str | None:
    try:
        text = getattr(response, "text", None)
    except Exception as e:  # Some SDK response helpers can raise.
        return f"<response.text unavailable: {type(e).__name__}: {e}>"
    return text if isinstance(text, str) else None


def _error_payload(exception: BaseException | None) -> dict | None:
    if exception is None:
        return None
    return {
        "type": type(exception).__name__,
        "message": str(exception),
        "traceback": "".join(
            traceback.format_exception(type(exception), exception, exception.__traceback__)
        ),
    }


class GeminiCallRecorder:
    """Thread-safe recorder for raw Gemini call attempts.

    R2 failures are captured in the manifest and never re-raised. The student
    output pipeline should continue even when forensic logging is impaired.
    """

    def __init__(self, run_id: str | None, max_calls: int = MAX_MANIFEST_CALLS):
        self.run_id = str(run_id) if run_id else None
        self._max = max_calls
        self._lock = threading.Lock()
        self._calls: list[dict] = []
        self._truncated = False

    @property
    def enabled(self) -> bool:
        return bool(self.run_id)

    def record_attempt(
        self,
        *,
        kind: str,
        attempt: int,
        model: str,
        started_at: float,
        prompt_version: str | None = None,
        section_index: int | None = None,
        start_time: float | None = None,
        end_time: float | None = None,
        fps: float | None = None,
        schema: str | None = None,
        system_instruction: str | None = None,
        user_prompt: str | None = None,
        contents: Any = None,
        config: dict | None = None,
        response: Any = None,
        parsed: Any = None,
        item_count: int | None = None,
        exception: BaseException | None = None,
    ) -> None:
        if not self.enabled:
            return

        ended_at = time.time()
        call_id = self._call_id(kind, section_index, attempt)
        status = "error" if exception else "success"
        response_text = _safe_response_text(response)
        parsed_json = _jsonable(parsed)
        usage = _capture_usage(
            response, model=model, kind=kind, section_index=section_index
        ) if response is not None else None
        model_version = None
        if response is not None:
            mv = getattr(response, "model_version", None)
            model_version = mv if isinstance(mv, str) else None

        blob = {
            "version": MANIFEST_VERSION,
            "call_id": call_id,
            "kind": kind,
            "section_index": section_index,
            "attempt": attempt,
            "status": status,
            "started_at": datetime.fromtimestamp(started_at, timezone.utc).isoformat(),
            "ended_at": datetime.fromtimestamp(ended_at, timezone.utc).isoformat(),
            "duration_ms": round((ended_at - started_at) * 1000),
            "model_requested": model,
            "model_version": model_version,
            "prompt_version": prompt_version,
            "video": {
                "start_time": start_time,
                "end_time": end_time,
                "fps": fps,
            },
            "request": {
                "schema": schema,
                "system_instruction": system_instruction,
                "user_prompt": user_prompt,
                "contents": _jsonable(contents),
                "config": _jsonable(config),
            },
            "response": {
                "text": response_text,
                "parsed": parsed_json,
                "usage_metadata": _jsonable(getattr(response, "usage_metadata", None))
                if response is not None else None,
            },
            "error": _error_payload(exception),
        }

        r2_key = f"debug/gemini-call-logs/{self.run_id}/{call_id}.json"
        capture_error = None
        blob_bytes = None
        try:
            from src.storage.r2 import put_json
            blob_bytes = put_json(r2_key, blob)
        except Exception as e:
            capture_error = {
                "type": type(e).__name__,
                "message": str(e),
                "at": _now_iso(),
            }
            r2_key = None
            logger.warning("Failed to persist Gemini call log %s: %s", call_id, e)

        manifest_entry = {
            "call_id": call_id,
            "kind": kind,
            "section_index": section_index,
            "attempt": attempt,
            "status": status,
            "started_at": blob["started_at"],
            "ended_at": blob["ended_at"],
            "duration_ms": blob["duration_ms"],
            "model_requested": model,
            "model_version": model_version,
            "prompt_version": prompt_version,
            "video": blob["video"],
            "schema": schema,
            "usage": usage,
            "item_count": item_count,
            "r2_key": r2_key,
            "blob_bytes": blob_bytes,
            "request_bytes": _byte_len(blob["request"]),
            "response_text_bytes": len(response_text.encode("utf-8")) if response_text else 0,
            "parsed_bytes": _byte_len(parsed_json) if parsed_json is not None else 0,
            "error": _error_payload(exception),
            "capture_error": capture_error,
        }
        self._append(manifest_entry)

    def _call_id(self, kind: str, section_index: int | None, attempt: int) -> str:
        section = "global" if section_index is None else f"section-{section_index}"
        return f"{kind}-{section}-attempt-{attempt}-{uuid.uuid4().hex[:8]}"

    def _append(self, entry: dict) -> None:
        with self._lock:
            if len(self._calls) >= self._max:
                self._truncated = True
                return
            self._calls.append(entry)

    def summary(self) -> dict:
        with self._lock:
            calls = [dict(c) for c in self._calls]
            truncated = self._truncated

        if not self.enabled:
            capture_status = "unavailable"
        elif not calls:
            capture_status = "unavailable"
        elif any(c.get("capture_error") for c in calls):
            capture_status = "failed" if all(c.get("capture_error") for c in calls) else "partial"
        else:
            capture_status = "complete"

        return {
            "version": MANIFEST_VERSION,
            "storage": "r2",
            "capture_status": capture_status,
            "truncated": truncated,
            "calls": calls,
        }
