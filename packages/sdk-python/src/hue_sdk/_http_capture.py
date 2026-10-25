"""Instance-owned outbound HTTP observation. Optional clients are patched only when imported."""

from __future__ import annotations

import functools
import importlib.abc
import importlib.machinery
import json
import sys
import weakref
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from email.message import Message
from http.client import HTTPSConnection
from threading import RLock
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from ._http_streams import install_stream, uninstall_stream_hooks
from ._limits import MAX_CONTENT_BYTES, TRUNCATED_KEY
from ._otel_compat import instrumentation_suppressed
from ._records import truncated_marker, with_truncated_keys
from ._tool_definitions import (
    REDACTED,
    _is_credential_key,
    _scrub_credential_text_unbounded,
    scrub_credential_text,
)

if TYPE_CHECKING:
    from .client import Hue

# A Hue scope selects its own client even when another client was initialized later.
client_scope: ContextVar[Hue | None] = ContextVar("hue_http_client", default=None)
_aio_decode: ContextVar[bool] = ContextVar("hue_aiohttp_decode", default=True)
_exchange: ContextVar[Exchange | None] = ContextVar("hue_http_exchange", default=None)
_lock = RLock()
_clients: list[weakref.ReferenceType[Hue]] = []
_patches: list[tuple[Any, str, Any, Any]] = []
_pending: weakref.WeakSet[Exchange] = weakref.WeakSet()
_BEHAVIOR_HEADERS = frozenset({"notion-version"})
# Continuation tokens route to another page; they do not authenticate the caller.
_CONTINUATION_KEYS = frozenset(
    {
        "pagetoken",
        "nextpagetoken",
        "previouspagetoken",
        "prevpagetoken",
        "continuationtoken",
        "nexttoken",
        "previoustoken",
        "resumetoken",
        "deltatoken",
        "cursortoken",
    }
)
_TARGETS = {
    "requests.adapters": [("HTTPAdapter", "send", "requests", False)],
    "httpx._client": [
        ("Client", "_send_single_request", "httpx", False),
        ("AsyncClient", "_send_single_request", "httpx", True),
    ],
    "httpx2._client": [
        ("Client", "_send_single_request", "httpx", False),
        ("AsyncClient", "_send_single_request", "httpx", True),
    ],
    "urllib.request": [("AbstractHTTPHandler", "do_open", "urllib", False)],
    "aiohttp.client": [("ClientSession", "_request", "aiohttp_session", True)],
    "aiohttp.client_reqrep": [("ClientRequest", "send", "aiohttp", True)],
    "httplib2": [("Http", "_conn_request", "httplib2", False)],
    "urllib3.connectionpool": [("HTTPConnectionPool", "_make_request", "urllib3", False)],
}
_ABSENT = object()


def _headers(value: Any) -> dict[str, str]:
    return {str(key).lower(): str(item) for key, item in (value or {}).items()}


def _query(text: str, encoding: str = "utf-8") -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in parse_qsl(text, keep_blank_values=True, encoding=encoding):
        if key not in result:
            result[key] = value
        elif isinstance(result[key], list):
            result[key].append(value)
        else:
            result[key] = [result[key], value]
    return result


def _identity(raw: str, method: str) -> tuple[dict[str, Any], str]:
    url = urlsplit(raw)
    if url.scheme not in {"http", "https"} or not url.hostname:
        raise ValueError("HTTP URL has no origin")
    host = url.hostname
    port = url.port or (443 if url.scheme == "https" else 80)
    netloc = f"[{host}]" if ":" in host else host
    if url.port is not None:
        netloc += f":{url.port}"
    clean = urlunsplit((url.scheme, netloc, url.path or "/", "", ""))
    return {
        "http.request.method": method.upper(),
        "url.full": clean,
        "url.scheme": url.scheme,
        "server.address": host,
        "server.port": port,
    }, url.query


def _text_type(mime: str) -> bool:
    mime = mime.partition(";")[0].strip().lower()
    return (
        mime.startswith("text/")
        or mime in {"application/json", "application/xml", "application/x-www-form-urlencoded"}
        or mime.endswith(("+json", "+xml"))
    )


def _byte_size(text: str) -> int:
    return sum(
        len(text[start : start + 8192].encode("utf-8")) for start in range(0, len(text), 8192)
    )


def _parse(data: bytes, mime: str) -> Any:
    content_type = Message()
    content_type["content-type"] = mime
    encoding = content_type.get_content_charset() or "utf-8"
    try:
        text = data.decode(encoding)
    except (UnicodeError, LookupError):
        return _ABSENT
    base = mime.partition(";")[0].strip().lower()
    if base == "application/json" or base.endswith("+json"):
        try:
            return json.loads(text)
        except (ValueError, RecursionError):
            return text
    if base == "application/x-www-form-urlencoded":
        return _query(text, encoding)
    return text


def _scrub(value: Any, depth: int = 0) -> Any:
    # The shared credential names deliberately preserve identifiers such as user_id and team_id.
    if depth > 32:
        raise ValueError("HTTP content exceeds its nesting limit")
    if isinstance(value, dict):
        result = {}
        header_name = value.get("name")
        sensitive_header = isinstance(header_name, str) and _credential_key(header_name)
        for key, item in value.items():
            result[_scrub_credential_text_unbounded(key)] = (
                REDACTED
                if _credential_key(key) or (key == "value" and sensitive_header)
                else _scrub(item, depth + 1)
            )
        return result
    if isinstance(value, list):
        return [_scrub(item, depth + 1) for item in value]
    if isinstance(value, str):
        return _scrub_credential_text_unbounded(value)
    return value


def _credential_key(key: str) -> bool:
    normalized = key.lower().replace("-", "").replace("_", "")
    if normalized == "headers" or normalized in _CONTINUATION_KEYS:
        return False
    return normalized in {"cookie", "setcookie", "proxyauthorization"} or _is_credential_key(key)


@dataclass
class Request:
    url: str
    method: str
    headers: dict[str, str]
    body: Any = None


def _argument(
    args: tuple[Any, ...], kwargs: dict[str, Any], index: int, name: str, default: Any = None
) -> Any:
    return args[index] if len(args) > index else kwargs.get(name, default)


def _request(kind: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Request:
    owner = args[0]
    if kind in {"requests", "httpx"}:
        request = _argument(args, kwargs, 1, "request")
        headers = _headers(request.headers)
        # Access cached bytes only. HTTPX raises RequestNotRead for a streaming request.
        body = (
            getattr(request, "body", None)
            if kind == "requests"
            else request.__dict__.get("_content", _ABSENT)
        )
        return Request(str(request.url), request.method, headers, body)
    if kind == "urllib":
        request = _argument(args, kwargs, 2, "req")
        return Request(
            request.full_url,
            request.get_method(),
            _headers(dict(request.header_items())),
            request.data,
        )
    if kind == "aiohttp":
        # ClientRequest owns the bytes already serialized by the application's session.
        payload = owner.body
        body = None if payload is None else getattr(payload, "_value", _ABSENT)
        if payload is not None and body is None:
            body = _ABSENT
        return Request(str(owner.url), owner.method, _headers(owner.headers), body)
    connection = _argument(args, kwargs, 1, "conn")
    if kind == "httplib2":
        method = _argument(args, kwargs, 3, "method", "GET")
        url = str(_argument(args, kwargs, 2, "request_uri"))
        scheme = "https" if isinstance(connection, HTTPSConnection) else "http"
        host, port = connection.host, connection.port
    else:
        method = _argument(args, kwargs, 2, "method", "GET")
        url = str(_argument(args, kwargs, 3, "url"))
        scheme, host, port = owner.scheme, owner.host, owner.port
    if not urlsplit(url).scheme:
        netloc = f"[{host}]" if ":" in host else host
        if port is not None:
            netloc += f":{port}"
        url = f"{scheme}://{netloc}{url}"
    headers = _headers(_argument(args, kwargs, 5, "headers"))
    return Request(url, method, headers, _argument(args, kwargs, 4, "body"))


class Exchange:
    def __init__(self, client: Hue, request: Request, *, model: bool = False) -> None:
        self.client = client
        self._finish_lock = RLock()
        self.cap = min(MAX_CONTENT_BYTES, client._limits.current.value_bytes)
        self.done = False
        self.size = 0
        self.buffer = bytearray()
        self.headers: dict[str, str] = {}
        self.status = 0
        self.encoded = False
        self.bodies = (
            client.capture_content
            and client.capture_http_bodies
            and not client._setup_key
            and not model
        )
        attributes, query = _identity(request.url, request.method)
        self.url = attributes["url.full"]
        self.method = attributes["http.request.method"]
        current = trace.get_current_span()
        local = client._http_parent.get()
        context = None
        if (
            client._owns_provider
            and local is not None
            and local.get_span_context().is_valid
            and current.get_span_context().trace_id != local.get_span_context().trace_id
        ):
            # Another provider may temporarily be active inside an owned Hue helper.
            context = trace.set_span_in_context(local)
        existing = getattr(current, "attributes", None) or {}
        same = (
            (
                context is None
                and current.is_recording()
                and getattr(current, "kind", None) == SpanKind.CLIENT
                and existing.get("http.request.method", existing.get("http.method")) == self.method
                and _identity(
                    str(existing.get("url.full", existing.get("http.url", ""))), self.method
                )[0]["url.full"]
                == self.url
            )
            if existing.get("url.full", existing.get("http.url"))
            else False
        )
        self.owned = not same
        self.span = (
            current
            if same
            else client.tracer.start_span(
                self.method, kind=SpanKind.CLIENT, attributes=attributes, context=context
            )
        )
        # Preserve the other provider's application context when selecting Hue's parent.
        self.scope_span = current if context is not None else self.span
        self.bodies = self.bodies and self.span.is_recording()
        with _lock:
            _pending.add(self)
        if self.bodies:
            for key, value in request.headers.items():
                if key in _BEHAVIOR_HEADERS:
                    clean = client._text_content(
                        "http.request.header." + key.replace("-", "_"), scrub_credential_text(value)
                    )
                    if clean is not None:
                        self.span.set_attribute(
                            "http.request.header." + key.replace("-", "_"), clean
                        )
            client._instrument(lambda: self._input(request, query))

    def _value(self, key: str, value: Any, *, cut: bool = False) -> None:
        def record() -> None:
            # Scrub before the callback; scrub its result again before any processor sees it.
            clean = _scrub(value)
            encoded, truncated = self.client._bounded_content(key, clean, bound=self.cap)
            if truncated:
                self._marker(key, len(encoded.encode("utf-8")))
                return
            if len(encoded.encode("utf-8")) > self.cap:
                self._marker(key, len(encoded.encode("utf-8")))
                return
            if cut:
                # A callback cannot turn an incomplete exchange into complete app state.
                if encoded == "null":
                    self._list_cut(key)
                    return
                encoded = json.dumps(value, separators=(",", ":"))
            encoded = json.dumps(
                _scrub(json.loads(encoded)), ensure_ascii=False, separators=(",", ":")
            )
            if len(encoded.encode("utf-8")) > self.cap:
                self._marker(key, len(encoded.encode("utf-8")))
                return
            self.span.set_attribute(key, encoded)
            if cut:
                self._list_cut(key)

        self.client._instrument(record)

    def _list_cut(self, key: str) -> None:
        listed = (getattr(self.span, "attributes", None) or {}).get(TRUNCATED_KEY)
        self.span.set_attribute(TRUNCATED_KEY, with_truncated_keys(listed, [key]))

    def _marker(self, key: str, size: int) -> None:
        # The Hue processor promotes this explicit cut to a structured OTLP placeholder.
        self.span.set_attribute(key, json.dumps(truncated_marker(size), separators=(",", ":")))
        self._list_cut(key)

    def _input(self, request: Request, query: str) -> None:
        mime = request.headers.get("content-type", "")
        body = request.body
        if type(body) is str:
            size = _byte_size(body)
            self.span.set_attribute("http.request.body.size", size)
            if size > self.cap:
                self._value("input.value", truncated_marker(size), cut=True)
                return
            body = body.encode("utf-8")
        if isinstance(body, (bytes, bytearray, memoryview)):
            self.span.set_attribute("http.request.body.size", len(body))
        if len(query) > self.cap:
            self._value("input.value", truncated_marker(_byte_size(query)), cut=True)
            return
        value = _query(query)
        if body is None or (isinstance(body, (bytes, bytearray, memoryview)) and len(body) == 0):
            self._value("input.value", value)
        elif isinstance(body, (bytes, bytearray, memoryview)) and _text_type(mime):
            if len(body) > self.cap:
                self._value("input.value", truncated_marker(len(body)), cut=True)
                return
            parsed = _parse(bytes(body), mime)
            if parsed is _ABSENT:
                return
            if isinstance(parsed, dict):
                value.update(parsed)
            else:
                value["body"] = parsed
            self._value("input.value", value)
        # Unknown streaming/binary request bodies stay missing, never misrepresented as empty.
        if mime and "input.value" in (getattr(self.span, "attributes", None) or {}):
            self.span.set_attribute("input.mime_type", mime)

    def response(self, status: int, headers: Any) -> None:
        self.status = status
        self.headers = _headers(headers)
        self.encoded = self.encoded and self.headers.get("content-encoding", "").lower() not in {
            "",
            "identity",
        }
        self.span.set_attribute("http.response.status_code", status)
        if status >= 500:
            self.span.set_status(Status(StatusCode.ERROR))
            self.span.set_attribute("error.type", str(status))
        if self.bodies:
            for key in _BEHAVIOR_HEADERS:
                if key in self.headers:
                    name = "http.response.header." + key.replace("-", "_")
                    clean = self.client._text_content(
                        name, scrub_credential_text(self.headers[key])
                    )
                    if clean is not None:
                        self.span.set_attribute(name, clean)

    def observe(self, data: bytes | memoryview) -> None:
        with self._finish_lock:
            if self.done:
                return
            self.size += len(data)
            if (
                self.bodies
                and _text_type(self.headers.get("content-type", ""))
                and self.size <= self.cap
            ):
                self.buffer.extend(data)
            elif self.size > self.cap:
                self.buffer.clear()

    def finish(self, complete: bool = False) -> None:
        with self._finish_lock:
            if self.done:
                return
            self.done = True
        try:
            if self.size or complete:
                self.span.set_attribute("http.response.body.size", self.size)
            if (
                self.bodies
                and not self.encoded
                and _text_type(self.headers.get("content-type", ""))
            ):
                mime = self.headers["content-type"]
                if self.size > self.cap or (not complete and self.size):
                    self._value("output.value", truncated_marker(self.size), cut=True)
                elif complete:
                    body = _parse(bytes(self.buffer), mime)
                    if body is not _ABSENT:
                        self._value("output.value", body)
                if self.size or complete:
                    self.span.set_attribute("output.mime_type", mime)
        except Exception:
            self.client._record_issue()
        finally:
            self.buffer.clear()
            with _lock:
                _pending.discard(self)
            if self.owned:
                try:
                    self.span.end()
                except Exception:
                    self.client._record_issue()

    def fail(self, error: BaseException) -> None:
        try:
            self.span.set_attribute("error.type", type(error).__name__)
            self.span.set_status(Status(StatusCode.ERROR))
        except Exception:
            self.client._record_issue()
        finally:
            self.finish()


def _client() -> Hue | None:
    active = client_scope.get()
    if active is not None:
        return active if active._active and active.capture_http else None
    with _lock:
        candidates = [reference() for reference in reversed(_clients)]
    return next(
        (
            client
            for client in candidates
            if client is not None and client._active and client.capture_http
        ),
        None,
    )


def _begin(kind: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Exchange | None:
    if instrumentation_suppressed():
        return None
    client = _client()
    if client is None:
        return None
    try:
        current = trace.get_current_span()
        attributes = getattr(current, "attributes", None) or {}
        operation = attributes.get("gen_ai.operation.name")
        local_model = client._http_model_scope.get()
        model = (
            local_model
            if local_model is not None
            else (
                operation
                in {
                    "chat",
                    "text_completion",
                    "generate_content",
                    "embeddings",
                    "image_generation",
                    "speech",
                    "transcription",
                }
                or attributes.get("openinference.span.kind") == "LLM"
            )
        )
        request = _request(kind, args, kwargs)
        parent = _exchange.get()
        identity, _ = _identity(request.url, request.method)
        base = urlsplit(client.base_url)
        if (
            identity["url.scheme"] == base.scheme
            and identity["server.address"] == base.hostname
            and identity["server.port"] == (base.port or (443 if base.scheme == "https" else 80))
        ):
            return None
        if (
            parent is not None
            and parent.method == identity["http.request.method"]
            and parent.url == identity["url.full"]
        ):
            return None
        return Exchange(client, request, model=model)
    except Exception:
        client._record_issue()
        return None


def _received(kind: str, response: Any, exchange: Exchange) -> None:
    if kind == "aiohttp" and not response.status:
        # aiohttp starts the response after ClientRequest.send returns, without reading its body.
        original = response.start

        @functools.wraps(original)
        async def start(*args: Any, **kwargs: Any) -> Any:
            try:
                result = await original(*args, **kwargs)
            except BaseException as error:
                exchange.fail(error)
                raise
            try:
                _received(kind, response, exchange)
            except Exception:
                exchange.client._record_issue()
                exchange.finish()
            return result

        response.start = start
        return
    if kind == "httplib2":
        headers, body = response
        exchange.response(int(headers.status), headers)
        exchange.observe(body)
        exchange.finish(complete=True)
        return
    status = (
        getattr(response, "status_code", None) or getattr(response, "status", None) or response.code
    )
    exchange.response(int(status), response.headers)
    if kind == "requests" and response.__dict__.get("_content_consumed"):
        exchange.observe(response.__dict__["_content"])
        exchange.finish(complete=True)
    elif kind == "httpx" and "_content" in response.__dict__:
        exchange.observe(response.__dict__["_content"])
        exchange.finish(complete=True)
    elif kind == "urllib3" and isinstance(response.__dict__.get("_body"), bytes):
        exchange.observe(response.__dict__["_body"])
        exchange.finish(complete=True)
    else:
        install_stream(response, exchange, kind)


def _wrap(original: Callable[..., Any], kind: str, asynchronous: bool) -> Callable[..., Any]:
    def receive(response: Any, exchange: Exchange) -> None:
        try:
            _received(kind, response, exchange)
        except Exception:
            exchange.client._record_issue()
            exchange.finish()

    if asynchronous:

        @functools.wraps(original)
        async def async_send(*args: Any, **kwargs: Any) -> Any:
            if kind == "aiohttp_session":
                configured = kwargs.get("auto_decompress")
                decode = args[0]._auto_decompress if configured is None else configured
                decoding = _aio_decode.set(decode)
                try:
                    return await original(*args, **kwargs)
                finally:
                    _aio_decode.reset(decoding)
            exchange = _begin(kind, args, kwargs)
            if exchange is None:
                return await original(*args, **kwargs)
            if kind == "aiohttp":
                exchange.encoded = not _aio_decode.get()
            token = _exchange.set(exchange)
            scope = trace.use_span(
                exchange.scope_span,
                end_on_exit=False,
                record_exception=False,
                set_status_on_exception=False,
            )
            try:
                with scope:
                    response = await original(*args, **kwargs)
            except BaseException as error:
                exchange.fail(error)
                raise
            finally:
                _exchange.reset(token)
            receive(response, exchange)
            return response

        return async_send

    @functools.wraps(original)
    def send(*args: Any, **kwargs: Any) -> Any:
        exchange = _begin(kind, args, kwargs)
        if exchange is None:
            return original(*args, **kwargs)
        token = _exchange.set(exchange)
        scope = trace.use_span(
            exchange.scope_span,
            end_on_exit=False,
            record_exception=False,
            set_status_on_exception=False,
        )
        try:
            with scope:
                response = original(*args, **kwargs)
        except BaseException as error:
            exchange.fail(error)
            raise
        finally:
            _exchange.reset(token)
        receive(response, exchange)
        return response

    return send


def _patch(module: Any) -> None:
    with _lock:
        if not _clients:
            return
        for class_name, name, kind, asynchronous in _TARGETS.get(module.__name__, []):
            owner = getattr(module, class_name, None)
            if owner is None or any(item[0] is owner and item[1] == name for item in _patches):
                continue
            original = getattr(owner, name)
            wrapped = _wrap(original, kind, asynchronous)
            setattr(owner, name, wrapped)
            _patches.append((owner, name, original, wrapped))


class _Loader(importlib.abc.Loader):
    def __init__(self, original: Any) -> None:
        self.original = original

    def create_module(self, spec: Any) -> Any:
        return (
            self.original.create_module(spec) if hasattr(self.original, "create_module") else None
        )

    def exec_module(self, module: Any) -> None:
        self.original.exec_module(module)
        _patch(module)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.original, name)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname not in _TARGETS:
            return None
        # Delegate in the existing finder order, including application-defined importers.
        finders = list(sys.meta_path)
        if self not in finders:
            return None
        for finder in finders[finders.index(self) + 1 :]:
            find = getattr(finder, "find_spec", None)
            spec = find(fullname, path, target) if find is not None else None
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = _Loader(spec.loader)
                return spec
        return None


_finder = _Finder()


def register(client: Hue) -> None:
    with _lock:
        _clients.append(weakref.ref(client))
        if _finder not in sys.meta_path:
            sys.meta_path.insert(0, _finder)
        for name in _TARGETS:
            module = sys.modules.get(name)
            if module is not None:
                _patch(module)


def unregister(client: Hue) -> None:
    # End unfinished exchanges before the client's processor stops admitting records.
    with _lock:
        pending = list(_pending)
    for exchange in pending:
        if exchange.client is client:
            exchange.finish()
    with _lock:
        _clients[:] = [
            reference
            for reference in _clients
            if reference() is not None and reference() is not client
        ]
        if _clients:
            return
        if _finder in sys.meta_path:
            sys.meta_path.remove(_finder)
        for owner, name, original, wrapped in reversed(_patches):
            # A later application instrumentor owns its wrapper; leave its chain intact.
            if getattr(owner, name) is wrapped:
                setattr(owner, name, original)
        _patches.clear()
        uninstall_stream_hooks()
