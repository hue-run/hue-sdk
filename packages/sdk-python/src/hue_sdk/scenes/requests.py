"""Requests adapter: raw response bytes are observed only as the caller consumes them."""

from __future__ import annotations

from io import BytesIO

import requests
from requests.adapters import HTTPAdapter
from requests.structures import CaseInsensitiveDict

from .client import Capture, Scenes
from .http import ResponseCapture, decoded_http_body, http_arguments, owned_binding
from .types import SnapshotMissError


def _decoded_payload(result):
    if not isinstance(result, dict) or result.get("kind") != "http":
        raise SnapshotMissError("nonportable")
    headers = dict(result["headers"])
    content = decoded_http_body(result["body"], headers) if result["body"] else b""
    if content != result["body"]:
        headers.pop("content-encoding", None)
        headers.pop("content-length", None)
    return {**result, "headers": headers, "body": content}


def _response(result, request):
    try:
        result = _decoded_payload(result)
        response = requests.Response()
        response.status_code = result["status"]
        response.headers = CaseInsensitiveDict(result["headers"])
        content = result["body"]
        response._content = content
        response._content_consumed = True
        response.raw = BytesIO(content)
        response.request = request
        response.url = result.get("url", request.url)
        response.reason = result.get("statusText", "")
        response.encoding = requests.utils.get_encoding_from_headers(response.headers)
        return response
    except Exception:
        raise SnapshotMissError("nonportable") from None


class _RawTee:
    def __init__(self, raw, capture):
        self.raw, self.capture = raw, capture

    def __getattr__(self, key):
        return getattr(self.raw, key)

    def stream(self, amt=65536, decode_content=None):
        try:
            for chunk in self.raw.stream(amt, decode_content=decode_content):
                self.capture.append(chunk)
                yield chunk
        except GeneratorExit:
            self.capture.finish(incomplete=True)
            raise
        except BaseException as error:
            self.capture.finish(error=error)
            raise
        else:
            self.capture.finish(decoded=bool(decode_content))

    def read(self, amt=None, decode_content=None, **kwargs):
        try:
            data = self.raw.read(amt, decode_content=decode_content, **kwargs)
        except BaseException as error:
            self.capture.finish(error=error)
            raise
        self.capture.append(data)
        if amt is None or data == b"":
            self.capture.finish(decoded=bool(decode_content))
        return data

    def close(self):
        try:
            self.raw.close()
        finally:
            self.capture.finish(incomplete=True)


class SceneAdapter(HTTPAdapter):
    def __init__(self, scenes: Scenes, **kwargs):
        self.scenes = scenes
        super().__init__(**kwargs)

    def send(self, request, **kwargs):
        active, binding = owned_binding(self.scenes, request.url)
        if binding is None:
            return super().send(request, **kwargs)
        body = request.body
        if body is None:
            body = b""
        if isinstance(body, str):
            body = body.encode("utf-8")
        if not isinstance(body, bytes):
            body = None

        def arguments():
            return http_arguments(binding, request.method, request.url, request.headers, body)

        if not isinstance(active, Capture):
            return active.dispatch(
                binding["id"],
                "http",
                arguments,
                result_decoder=lambda result: _response(result, request),
            )
        call = active.start(binding["id"], "http", arguments)
        try:
            response = super().send(request, **kwargs)
        except BaseException as error:
            call.finish(error=error)
            raise
        capture = ResponseCapture(
            call,
            response.status_code,
            response.headers,
            request.url,
            response.reason or "",
            request_method=request.method,
        )
        response.raw = _RawTee(response.raw, capture)
        return response
