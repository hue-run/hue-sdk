"""Observe bytes the application consumes, without reading or replacing its streams."""

from __future__ import annotations

import functools
import inspect
import weakref
from collections.abc import AsyncIterator, Callable, Iterator
from contextvars import ContextVar
from threading import RLock
from typing import Any

# A read can delegate to another patched read. Count only its outermost return value.
_reading: ContextVar[frozenset[int]] = ContextVar("hue_http_reads", default=frozenset())
_lock = RLock()
_aio_streams: dict[int, Any] = {}
_aio_patches: list[tuple[type, str, Any, Any]] = []


def _safe(exchange: Any, action: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    try:
        action(*args, **kwargs)
    except Exception:
        exchange.client._record_issue()


def _complete(stream: Any) -> bool:
    """Inspect buffer state only. Never probe EOF with a read."""
    if hasattr(stream, "length_remaining"):
        buffered = getattr(stream, "_decoded_buffer", ())
        decoder = getattr(stream, "_decoder", None)
        if len(buffered) or (decoder and getattr(decoder, "has_unconsumed_tail", False)):
            return False
        remaining = stream.length_remaining
    else:
        remaining = stream.length
    # http.client can close a short response without raising on bounded reads.
    return remaining == 0 if remaining is not None else stream.isclosed()


def _finish_if_complete(stream: Any, exchange: Any) -> None:
    try:
        if _complete(stream):
            exchange.finish(complete=True)
    except Exception:
        exchange.client._record_issue()


def _mark_encoded(
    stream: Any, exchange: Any, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]
) -> None:
    headers = getattr(stream, "headers", {})
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return
    if name in {"iter_bytes", "aiter_bytes"}:
        return
    if name in {"iter_raw", "aiter_raw"}:
        exchange.encoded = True
        return
    # urllib never decodes. urllib3/requests decode only when the caller asks them to.
    decode = getattr(stream, "decode_content", False)
    if name in {"read", "read1", "stream", "read_chunked"}:
        requested = kwargs.get("decode_content", args[1] if len(args) > 1 else None)
        if requested is not None:
            decode = requested
    if not decode:
        exchange.encoded = True


def _read(stream: Any, exchange: Any, original: Callable[..., Any], name: str) -> Any:
    @functools.wraps(original)
    def observed(*args: Any, **kwargs: Any) -> Any:
        key = id(stream)
        nested = key in _reading.get()
        token = _reading.set(_reading.get() | {key})
        try:
            result = original(*args, **kwargs)
        except BaseException as error:
            if not nested:
                _safe(exchange, exchange.fail, error)
            raise
        finally:
            _reading.reset(token)
        if not nested:
            if result:
                _safe(exchange, _mark_encoded, stream, exchange, name, args, kwargs)
            if name in {"readinto", "readinto1"}:
                if result:
                    _safe(
                        exchange,
                        exchange.observe,
                        memoryview(args[0] if args else kwargs["b"])[:result],
                    )
            elif isinstance(result, (bytes, bytearray, memoryview)):
                _safe(exchange, exchange.observe, result)
            elif isinstance(result, list):
                for chunk in result:
                    _safe(exchange, exchange.observe, chunk)
            _finish_if_complete(stream, exchange)
        return result

    return observed


def _iterator(
    stream: Any,
    exchange: Any,
    original: Callable[..., Any],
    name: str,
    *,
    asynchronous: bool = False,
) -> Any:
    key = id(stream)

    @functools.wraps(original)
    def observed(*args: Any, **kwargs: Any) -> Iterator[bytes]:
        iterator = iter(original(*args, **kwargs))
        nested = key in _reading.get()
        try:
            while True:
                token = _reading.set(_reading.get() | {key})
                try:
                    chunk = next(iterator)
                except StopIteration:
                    if not nested and (not args or args[0] != 0) and kwargs.get("amt") != 0:
                        _safe(exchange, exchange.finish, complete=True)
                    return
                except BaseException as error:
                    if not nested:
                        _safe(exchange, exchange.fail, error)
                    raise
                finally:
                    _reading.reset(token)
                if not nested:
                    if chunk:
                        _safe(exchange, _mark_encoded, stream, exchange, name, args, kwargs)
                    _safe(exchange, exchange.observe, chunk)
                yield chunk
        finally:
            # Propagate a consumer's generator close just as the original generator would.
            close = getattr(iterator, "close", None)
            if close is not None:
                close()

    @functools.wraps(original)
    async def async_observed(*args: Any, **kwargs: Any) -> AsyncIterator[bytes]:
        iterator = original(*args, **kwargs).__aiter__()
        nested = key in _reading.get()
        try:
            while True:
                token = _reading.set(_reading.get() | {key})
                try:
                    chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    if not nested:
                        _safe(exchange, exchange.finish, complete=True)
                    return
                except BaseException as error:
                    if not nested:
                        _safe(exchange, exchange.fail, error)
                    raise
                finally:
                    _reading.reset(token)
                if not nested:
                    if chunk:
                        _safe(exchange, _mark_encoded, stream, exchange, name, args, kwargs)
                    _safe(exchange, exchange.observe, chunk)
                yield chunk
        finally:
            close = getattr(iterator, "aclose", None)
            if close is not None:
                await close()

    return async_observed if asynchronous else observed


def _close(response: Any, stream: Any, exchange: Any, name: str) -> None:
    original = getattr(response, name, None)
    if original is None:
        return

    @functools.wraps(original)
    def observed(*args: Any, **kwargs: Any) -> Any:
        try:
            return original(*args, **kwargs)
        finally:
            if id(stream) not in _reading.get():
                _safe(exchange, exchange.finish, complete=False)

    @functools.wraps(original)
    async def async_observed(*args: Any, **kwargs: Any) -> Any:
        try:
            return await original(*args, **kwargs)
        finally:
            if id(stream) not in _reading.get():
                _safe(exchange, exchange.finish, complete=False)

    setattr(response, name, async_observed if inspect.iscoroutinefunction(original) else observed)


def _drop_aio(key: int, exchange: Any) -> None:
    with _lock:
        if _aio_streams.get(key) is exchange:
            _aio_streams.pop(key, None)
    _safe(exchange, exchange.finish, complete=False)


def _aio_chunk(original: Callable[..., Any]) -> Any:
    @functools.wraps(original)
    def observed(stream: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(stream, *args, **kwargs)
        exchange = _aio_streams.get(id(stream))
        if exchange is not None:
            _safe(exchange, exchange.observe, result)
        return result

    return observed


def _aio_eof(original: Callable[..., Any]) -> Any:
    def finish(stream: Any, exchange: Any) -> None:
        if stream.at_eof():
            _safe(exchange, exchange.finish, complete=True)

    @functools.wraps(original)
    def observed(stream: Any, *args: Any, **kwargs: Any) -> Any:
        exchange = _aio_streams.get(id(stream))
        try:
            result = original(stream, *args, **kwargs)
        except BaseException as error:
            if exchange is not None:
                _safe(exchange, exchange.fail, error)
            raise
        if exchange is not None:
            _safe(exchange, finish, stream, exchange)
        return result

    @functools.wraps(original)
    async def async_observed(stream: Any, *args: Any, **kwargs: Any) -> Any:
        exchange = _aio_streams.get(id(stream))
        try:
            result = await original(stream, *args, **kwargs)
        except BaseException as error:
            if exchange is not None:
                _safe(exchange, exchange.fail, error)
            raise
        if exchange is not None:
            _safe(exchange, finish, stream, exchange)
        return result

    return async_observed if inspect.iscoroutinefunction(original) else observed


def _install_aio(response: Any, exchange: Any) -> None:
    stream = response.content
    with _lock:
        cls = type(stream)
        if not callable(getattr(cls, "_read_nowait_chunk", None)):
            raise TypeError("Unsupported aiohttp response stream")
        if not any(patch[0] is cls for patch in _aio_patches):
            # StreamReader has slots, so patch its methods only for registered response streams.
            for name in (
                "_read_nowait_chunk",
                "read",
                "readany",
                "readchunk",
                "read_nowait",
                "readexactly",
                "readuntil",
                "readline",
            ):
                original = getattr(cls, name, None)
                if original is None:
                    continue
                wrapper = (
                    _aio_chunk(original) if name == "_read_nowait_chunk" else _aio_eof(original)
                )
                setattr(cls, name, wrapper)
                _aio_patches.append((cls, name, original, wrapper))
        _aio_streams[id(stream)] = exchange
    weakref.finalize(response, _drop_aio, id(stream), exchange)
    for name in ("close", "release"):
        _close(response, stream, exchange, name)


def install_stream(response: Any, exchange: Any, kind: str) -> None:
    """Observe an existing response. Installation failures must be caught by the caller."""
    if kind == "aiohttp":
        _install_aio(response, exchange)
        return
    stream = response.raw if kind == "requests" else response
    if kind == "httpx":
        for name in ("iter_bytes", "iter_raw", "aiter_bytes", "aiter_raw"):
            original = getattr(response, name)
            setattr(
                response,
                name,
                _iterator(response, exchange, original, name, asynchronous=name.startswith("a")),
            )
        for name in ("close", "aclose"):
            _close(response, stream, exchange, name)
    else:
        for name in ("read", "read1", "readinto", "readinto1", "readline", "readlines"):
            original = getattr(stream, name, None)
            if original is not None:
                setattr(stream, name, _read(stream, exchange, original, name))
        for name in ("stream", "read_chunked"):
            original = getattr(stream, name, None)
            if original is not None:
                setattr(stream, name, _iterator(stream, exchange, original, name))
        _close(stream, stream, exchange, "close")
        if response is not stream:
            _close(response, stream, exchange, "close")
    weakref.finalize(response, _safe, exchange, exchange.finish, complete=False)


def uninstall_stream_hooks() -> None:
    """Restore only methods Hue still owns; other instrumentors may wrap them later."""
    with _lock:
        for cls, name, original, wrapper in reversed(_aio_patches):
            if getattr(cls, name, None) is wrapper:
                setattr(cls, name, original)
        _aio_patches.clear()
        _aio_streams.clear()
