"""
Cloudflare R2 storage operations.

Uses boto3 with S3-compatible endpoint. All env vars required at call time,
not import time — the module can be imported without R2 configured.
"""
import logging
import mimetypes
import os
import json
from urllib.parse import quote

import boto3
from botocore.config import Config

logger = logging.getLogger("chalkboard.r2")

_client = None


def _get_client():
    """Lazy-initialized S3 client configured for Cloudflare R2."""
    global _client
    if _client is not None:
        return _client

    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"R2 not configured: missing env vars {', '.join(missing)}")

    account_id = os.environ["R2_ACCOUNT_ID"]
    _client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )
    return _client


def _bucket():
    return os.environ["R2_BUCKET_NAME"]


def get_public_url(key: str) -> str:
    """Return the public URL for an R2 object."""
    base = os.environ["R2_PUBLIC_URL"].rstrip("/")
    return f"{base}/{quote(key, safe='/')}"


def upload_file(local_path: str, key: str) -> str:
    """Upload a local file to R2. Sets Content-Type from file extension.

    Returns the public URL.
    """
    client = _get_client()
    content_type, _ = mimetypes.guess_type(local_path)
    extra_args = {"ContentType": content_type or "application/octet-stream"}
    logger.info(f"Uploading {local_path} → r2://{_bucket()}/{key} ({content_type})")
    client.upload_file(local_path, _bucket(), key, ExtraArgs=extra_args)
    url = get_public_url(key)
    logger.info(f"Upload complete: {url}")
    return url


def put_json(key: str, payload: dict) -> int:
    """Upload a JSON payload to R2 and return the stored byte size."""
    client = _get_client()
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    logger.info(f"Uploading JSON → r2://{_bucket()}/{key} ({len(body)} bytes)")
    client.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=body,
        ContentType="application/json; charset=utf-8",
    )
    return len(body)


def download_file(key: str, dest_path: str) -> str:
    """Download an R2 object to a local path.

    Returns dest_path.
    """
    client = _get_client()
    logger.info(f"Downloading r2://{_bucket()}/{key} → {dest_path}")
    client.download_file(_bucket(), key, dest_path)
    logger.info(f"Download complete: {dest_path}")
    return dest_path
