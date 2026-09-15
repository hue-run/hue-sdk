"""Authenticated, bounded metadata and verified artifact transfers."""

from __future__ import annotations

import json
from threading import BoundedSemaphore
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import requests

from hue_sdk.transport import normalize_base_url

from ._json import canonical_json, sha256
from ._payload import Blob
from .types import MAX_ARTIFACT_BYTES, MAX_METADATA_BYTES, SceneTransportError


def identifier(value: str) -> str:
    return quote(value, safe="")


class API:
    def __init__(self, base_url: str, api_key: str, timeout: float = 10) -> None:
        self.base_url = normalize_base_url(base_url)
        if not api_key or any(char.isspace() for char in api_key):
            raise ValueError("A project service key is required.")
        if not 0 < timeout <= 300:
            raise ValueError("Request timeout must be between zero and 300 seconds.")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self.timeout = timeout
        self._uploads = BoundedSemaphore(2)

    def request(
        self, method: str, path: str, body: Any = None, *, limit: int = MAX_METADATA_BYTES
    ) -> Any:
        data = canonical_json(body) if body is not None else None
        if data is not None and len(data) > MAX_METADATA_BYTES:
            raise SceneTransportError()
        raw = self._read(
            method,
            self.base_url + "/api/v1" + path,
            headers={**self._headers, "Content-Type": "application/json"},
            data=data,
            limit=limit,
        )
        try:
            value = json.loads(raw)
            canonical_json(value)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise SceneTransportError() from None

    def _read(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        data: bytes | None = None,
        limit: int = MAX_METADATA_BYTES,
    ) -> bytes:
        try:
            # A fresh ordinary session keeps source interceptors and credentials separate.
            with requests.Session() as session:
                session.trust_env = False
                with session.request(
                    method,
                    url,
                    headers=headers,
                    data=data,
                    allow_redirects=False,
                    timeout=self.timeout,
                    stream=True,
                ) as response:
                    if not 200 <= response.status_code < 300:
                        raise SceneTransportError(response.status_code)
                    result = bytearray()
                    for chunk in response.iter_content(64 * 1024):
                        if len(result) + len(chunk) > limit:
                            raise SceneTransportError()
                        result.extend(chunk)
                    return bytes(result)
        except requests.RequestException:
            raise SceneTransportError() from None

    def upload(self, blob: Blob, *, idempotency_key: str | None = None) -> dict[str, Any]:
        if len(blob.data) > MAX_ARTIFACT_BYTES:
            raise SceneTransportError()
        digest = sha256(blob.data)
        with self._uploads:
            artifact = self.request(
                "POST",
                "/artifacts",
                {
                    "idempotencyKey": idempotency_key or str(uuid4()),
                    "filename": blob.filename,
                    "contentType": blob.mime_type,
                    "byteSize": len(blob.data),
                    "sha256": digest,
                    "purpose": blob.purpose,
                },
            )
            artifact_id = artifact.get("id")
            if not isinstance(artifact_id, str) or not artifact_id:
                raise SceneTransportError()
            path = "/artifacts/" + identifier(artifact_id)
            upload = self.request("POST", path + "/upload", {})
            try:
                parsed = urlsplit(upload["uploadUrl"])
                origin = f"{parsed.scheme}://{parsed.netloc}"
                normalize_base_url(origin)
                if parsed.username or parsed.password or upload["method"] != "PUT":
                    raise ValueError()
                headers = upload["headers"]
                if not isinstance(headers, dict) or any(
                    not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()
                ):
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise SceneTransportError() from None
            self._read("PUT", upload["uploadUrl"], headers=headers, data=blob.data)
            completed = self.request("POST", path + "/complete", {})
            if (
                completed.get("state") != "ready"
                or completed.get("verifiedBytes") != len(blob.data)
                or completed.get("verifiedSha256") != digest
            ):
                raise SceneTransportError()
        return {
            "artifactId": artifact_id,
            "sha256": digest,
            "byteSize": len(blob.data),
            "mimeType": blob.mime_type,
            "encoding": blob.encoding,
        }

    def download(self, ref: dict[str, Any]) -> bytes:
        expected_size = ref["byteSize"]
        if not 0 <= expected_size <= MAX_ARTIFACT_BYTES:
            raise SceneTransportError()
        data = self._read(
            "GET",
            self.base_url + "/api/v1/artifacts/" + identifier(ref["artifactId"]) + "/download",
            headers=self._headers,
            limit=expected_size,
        )
        if len(data) != expected_size or sha256(data) != ref["sha256"]:
            from .types import SnapshotMissError

            raise SnapshotMissError("integrity")
        return data
