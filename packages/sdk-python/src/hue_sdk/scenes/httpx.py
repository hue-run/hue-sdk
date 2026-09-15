"""HTTPX transports. Import this module only when the optional HTTPX extra is installed."""

from __future__ import annotations

import asyncio

import httpx

from .client import Capture, Scenes
from .http import ResponseCapture, decoded_http_body, http_arguments, owned_binding
from .types import SnapshotMissError


def _body(request: httpx.Request):
    try:
        return request.content
    except httpx.RequestNotRead:
        return None


def _response(result, request):
    try:
        if not isinstance(result, dict) or result.get("kind") != "http":
            raise ValueError()
        if result["body"]:
            # Validate codecs and their bounded expansion before HTTPX can decode while
            # constructing the response. Keep raw headers/body for HTTPX's normal semantics.
            decoded_http_body(result["body"], result["headers"])
        return httpx.Response(
            result["status"], headers=result["headers"], content=result["body"], request=request
        )
    except Exception:
        raise SnapshotMissError("nonportable") from None


class _SyncTee(httpx.SyncByteStream):
    def __init__(self, stream, capture):
        self.stream, self.capture = stream, capture

    def __iter__(self):
        try:
            for chunk in self.stream:
                self.capture.append(chunk)
                yield chunk
        except GeneratorExit:
            self.capture.finish(incomplete=True)
            raise
        except BaseException as error:
            self.capture.finish(error=error)
            raise
        else:
            self.capture.finish()

    def close(self):
        try:
            self.stream.close()
        finally:
            self.capture.finish(incomplete=True)


class _AsyncTee(httpx.AsyncByteStream):
    def __init__(self, stream, capture):
        self.stream, self.capture = stream, capture

    async def __aiter__(self):
        try:
            async for chunk in self.stream:
                self.capture.append(chunk)
                yield chunk
        except GeneratorExit:
            self.capture.finish(incomplete=True)
            raise
        except BaseException as error:
            self.capture.finish(error=error)
            raise
        else:
            self.capture.finish()

    async def aclose(self):
        try:
            await self.stream.aclose()
        finally:
            self.capture.finish(incomplete=True)


class SceneTransport(httpx.BaseTransport):
    def __init__(self, scenes: Scenes, transport: httpx.BaseTransport | None = None):
        self.scenes, self.transport = scenes, transport or httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        active, binding = owned_binding(self.scenes, str(request.url))
        if binding is None:
            return self.transport.handle_request(request)

        def arguments():
            return http_arguments(
                binding, request.method, str(request.url), request.headers, _body(request)
            )

        if not isinstance(active, Capture):
            return active.dispatch(
                binding["id"],
                "http",
                arguments,
                result_decoder=lambda result: _response(result, request),
            )
        call = active.start(binding["id"], "http", arguments)
        try:
            response = self.transport.handle_request(request)
        except BaseException as error:
            call.finish(error=error)
            raise
        capture = ResponseCapture(
            call,
            response.status_code,
            response.headers,
            str(request.url),
            response.reason_phrase,
            request_method=request.method,
        )
        response.stream = _SyncTee(response.stream, capture)
        return response

    def close(self):
        self.transport.close()


class AsyncSceneTransport(httpx.AsyncBaseTransport):
    def __init__(self, scenes: Scenes, transport: httpx.AsyncBaseTransport | None = None):
        self.scenes, self.transport = scenes, transport or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        active, binding = owned_binding(self.scenes, str(request.url))
        if binding is None:
            return await self.transport.handle_async_request(request)

        def arguments():
            return http_arguments(
                binding, request.method, str(request.url), request.headers, _body(request)
            )

        if not isinstance(active, Capture):
            return await asyncio.to_thread(
                active.dispatch,
                binding["id"],
                "http",
                arguments,
                result_decoder=lambda result: _response(result, request),
            )
        call = active.start(binding["id"], "http", arguments)
        try:
            response = await self.transport.handle_async_request(request)
        except BaseException as error:
            call.finish(error=error)
            raise
        capture = ResponseCapture(
            call,
            response.status_code,
            response.headers,
            str(request.url),
            response.reason_phrase,
            request_method=request.method,
        )
        response.stream = _AsyncTee(response.stream, capture)
        return response

    async def aclose(self):
        await self.transport.aclose()
