"""YouTube URL helpers shared by the worker and extraction pipeline."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse


_YOUTUBE_HOST_RE = re.compile(r"(^|\.)youtube\.com$", re.IGNORECASE)
_YOUTUBE_NOCOOKIE_HOST_RE = re.compile(r"(^|\.)youtube-nocookie\.com$", re.IGNORECASE)
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _clean_video_id(value: str | None) -> str | None:
    if not value:
        return None
    video_id = re.split(r"[?&#/]", value.strip(), maxsplit=1)[0]
    return video_id if _VIDEO_ID_RE.match(video_id) else None


def extract_youtube_id(value: str | None) -> str | None:
    if not value:
        return None

    parsed = urlparse(value)
    host = parsed.hostname or ""

    if host.lower() == "youtu.be":
        return _clean_video_id(next((p for p in parsed.path.split("/") if p), None))

    if _YOUTUBE_HOST_RE.search(host) or _YOUTUBE_NOCOOKIE_HOST_RE.search(host):
        if parsed.path == "/watch":
            return _clean_video_id(parse_qs(parsed.query).get("v", [None])[0])

        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in {"embed", "shorts", "live", "v"}:
            return _clean_video_id(parts[1])

    if parsed.scheme and host:
        return None

    patterns = (
        r"(?:^|https?://)(?:www\.)?youtu\.be/([^?&#/\s]+)",
        r"(?:^|https?://)(?:[A-Za-z0-9-]+\.)*youtube(?:-nocookie)?\.com/watch\?(?:[^#\s&]*&)*v=([^?&#/\s]+)",
        r"(?:^|https?://)(?:[A-Za-z0-9-]+\.)*youtube(?:-nocookie)?\.com/(?:embed|shorts|live|v)/([^?&#/\s]+)",
    )
    for pattern in patterns:
        match = re.search(pattern, value, re.IGNORECASE)
        video_id = _clean_video_id(match.group(1) if match else None)
        if video_id:
            return video_id
    return None


def canonicalize_youtube_url(value: str | None) -> str | None:
    video_id = extract_youtube_id(value)
    return f"https://www.youtube.com/watch?v={video_id}" if video_id else None


def canonicalize_youtube_url_if_possible(value: str) -> str:
    return canonicalize_youtube_url(value) or value
