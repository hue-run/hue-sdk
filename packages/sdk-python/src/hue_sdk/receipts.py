"""Read-only confirmation that Hue has received a particular application trace."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from threading import Event, Lock, Thread
from time import monotonic
from typing import Any, Literal
from urllib.parse import urlsplit

import requests

from .transport import SafeSession

TraceReceiptField = Literal["input", "output", "model", "usage", "session"]
_FIELDS = ("input", "output", "model", "usage", "session")
_MAX_BODY_BYTES = 65_536
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class TraceVerificationError(RuntimeError):
    """A safe verification failure. Receiver response bodies and credentials are omitted."""

    def __init__(self, message: str, *, code: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class TraceReceiptFields:
    """Presence of received fields, without exposing their captured values."""

    input: bool
    output: bool
    model: bool
    usage: bool
    session: bool


@dataclass(frozen=True)
class TraceReceipt:
    trace_id: str
    span_count: int
    revision: int
    fields: TraceReceiptFields
    matched_span_ids: tuple[str, ...]
    missing_span_ids: tuple[str, ...]
    trace_url: str


@dataclass(frozen=True)
class TraceVerificationResult:
    verified: bool
    receipt: TraceReceipt | None


def _valid_id(value: Any, length: int) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is not None
        and value != "0" * length
    )


def _invalid_response() -> TraceVerificationError:
    return TraceVerificationError(
        "Hue returned an invalid trace receipt. Check SDK/server compatibility and retry.",
        code="invalid_response",
    )


def _parse_receipt(
    data: Any, trace_id: str, expected: tuple[str, ...], base_url: str
) -> TraceReceipt:
    if not isinstance(data, dict) or data.get("traceId") != trace_id:
        raise _invalid_response()
    if any(
        type(data.get(key)) is not int or not 0 <= data[key] <= _MAX_SAFE_INTEGER
        for key in ("spanCount", "revision")
    ):
        raise _invalid_response()
    fields = data.get("fields")
    if not isinstance(fields, dict) or any(type(fields.get(key)) is not bool for key in _FIELDS):
        raise _invalid_response()
    matched, missing = data.get("matchedSpanIds"), data.get("missingSpanIds")
    for ids in (matched, missing):
        if (
            not isinstance(ids, list)
            or len(ids) > 100
            or any(not _valid_id(value, 16) for value in ids)
            or len(set(ids)) != len(ids)
        ):
            raise _invalid_response()
    if set(matched) & set(missing) or set(matched) | set(missing) != set(expected):
        raise _invalid_response()
    if len(matched) > data["spanCount"]:
        raise _invalid_response()
    if not isinstance(data.get("traceUrl"), str) or not 0 < len(data["traceUrl"]) <= 2048:
        raise _invalid_response()
    try:
        url = urlsplit(data["traceUrl"])
        origin = urlsplit(base_url)
        if (
            (
                url.scheme,
                url.hostname,
                url.port if url.port is not None else (443 if url.scheme == "https" else 80),
            )
            != (
                origin.scheme,
                origin.hostname,
                origin.port
                if origin.port is not None
                else (443 if origin.scheme == "https" else 80),
            )
            or url.username is not None
            or url.password is not None
            or "\\" in data["traceUrl"]
            or any(char.isspace() for char in data["traceUrl"])
        ):
            raise _invalid_response()
    except ValueError:
        raise _invalid_response() from None
    return TraceReceipt(
        trace_id=trace_id,
        span_count=data["spanCount"],
        revision=data["revision"],
        fields=TraceReceiptFields(**{key: fields[key] for key in _FIELDS}),
        matched_span_ids=tuple(value for value in expected if value in matched),
        missing_span_ids=tuple(value for value in expected if value in missing),
        trace_url=data["traceUrl"],
    )


def _read_json(response: requests.Response, deadline: float, cancelled: Event) -> Any:
    content_length = response.headers.get("Content-Length")
    if (
        content_length
        and content_length.isdecimal()
        and (len(content_length) > 20 or int(content_length) > _MAX_BODY_BYTES)
    ):
        raise _invalid_response()
    body = bytearray()
    # Small streaming reads check the wall-clock deadline even when a peer
    # continuously trickles bytes faster than requests' inactivity timeout.
    for chunk in response.iter_content(chunk_size=1):
        if cancelled.is_set() or monotonic() >= deadline:
            raise TimeoutError
        body.extend(chunk)
        if len(body) > _MAX_BODY_BYTES:
            raise _invalid_response()
    if cancelled.is_set() or monotonic() >= deadline:
        raise TimeoutError
    try:
        return json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise _invalid_response() from None


def _retry_delay(value: str | None, backoff: float) -> float:
    if value is None:
        return backoff
    try:
        seconds = float(value)
        if math.isfinite(seconds) and seconds >= 0:
            return max(backoff, seconds)
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        return max(backoff, (retry_at - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError, OverflowError):
        return backoff


def verify_trace(
    base_url: str,
    headers: Mapping[str, str],
    trace_id: str,
    *,
    expected_span_ids: Sequence[str] | None,
    required_fields: Sequence[TraceReceiptField] | None,
    timeout_millis: float,
    request_timeout: float,
    poll_lock: Lock,
) -> TraceVerificationResult:
    if not _valid_id(trace_id, 32):
        raise ValueError("trace_id must be a nonzero 32-character lowercase hexadecimal ID.")
    if (
        isinstance(timeout_millis, bool)
        or not isinstance(timeout_millis, (int, float))
        or not 0 < timeout_millis <= 60_000
        or not math.isfinite(timeout_millis)
    ):
        raise ValueError("timeout_millis must be finite, positive, and at most 60000.")
    if expected_span_ids is not None and (
        isinstance(expected_span_ids, (str, bytes)) or not isinstance(expected_span_ids, Sequence)
    ):
        raise ValueError("expected_span_ids must be a sequence of at most 100 unique span IDs.")
    expected = tuple(expected_span_ids) if expected_span_ids is not None else ()
    if (
        len(expected) > 100
        or any(not _valid_id(value, 16) for value in expected)
        or len(set(expected)) != len(expected)
    ):
        raise ValueError(
            "expected_span_ids must contain at most 100 unique nonzero "
            "16-character lowercase hexadecimal IDs."
        )
    if required_fields is not None and (
        isinstance(required_fields, (str, bytes)) or not isinstance(required_fields, Sequence)
    ):
        raise ValueError(
            "required_fields must be a sequence of input, output, model, usage, session."
        )
    required = tuple(required_fields) if required_fields is not None else ()
    if any(value not in _FIELDS for value in required):
        raise ValueError("required_fields may contain only input, output, model, usage, session.")
    if len(set(required)) != len(required):
        raise ValueError("required_fields must not contain duplicates.")

    deadline = monotonic() + timeout_millis / 1000
    # Repeated calls after a timed-out DNS/header read must not accumulate
    # background workers. One client owns at most one verification worker.
    if not poll_lock.acquire(timeout=max(0, deadline - monotonic())):
        return TraceVerificationResult(False, None)
    done, cancelled, lock = Event(), Event(), Lock()
    latest: TraceReceipt | None = None
    result: TraceVerificationResult | None = None
    error: TraceVerificationError | None = None

    def poll() -> None:
        nonlocal latest, result, error
        backoff = 0.25
        try:
            with SafeSession() as session:
                while not cancelled.is_set() and monotonic() < deadline:
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        break
                    with session.get(
                        f"{base_url}/api/v1/traces/{trace_id}/receipt",
                        headers=dict(headers),
                        params=[("expectedSpanId", value) for value in expected],
                        timeout=min(remaining, request_timeout),
                        stream=True,
                    ) as response:
                        status = response.status_code
                        delay = backoff
                        if status == 200:
                            receipt = _parse_receipt(
                                _read_json(response, deadline, cancelled),
                                trace_id,
                                expected,
                                base_url,
                            )
                            with lock:
                                if cancelled.is_set() or monotonic() >= deadline:
                                    break
                                latest = receipt
                                if not receipt.missing_span_ids and all(
                                    getattr(receipt.fields, field) for field in required
                                ):
                                    result = TraceVerificationResult(True, receipt)
                                    return
                        elif status == 404:
                            data = _read_json(response, deadline, cancelled)
                            if not isinstance(data, dict) or data.get("code") != "TRACE_NOT_FOUND":
                                raise TraceVerificationError(
                                    "This Hue deployment does not support trace receipts. "
                                    "Check the endpoint or update the server.",
                                    code="http",
                                    status_code=status,
                                )
                        elif status in (429, 503):
                            delay = _retry_delay(response.headers.get("Retry-After"), backoff)
                        elif status in (401, 403):
                            raise TraceVerificationError(
                                "Hue rejected trace verification. Check the project service key "
                                "and its project access.",
                                code="authentication",
                                status_code=status,
                            )
                        else:
                            raise TraceVerificationError(
                                f"Hue trace verification failed (HTTP {status}). "
                                "Check server availability and SDK/server compatibility.",
                                code="http",
                                status_code=status,
                            )
                    remaining = deadline - monotonic()
                    if remaining <= 0 or cancelled.wait(min(delay, remaining)):
                        break
                    # A truncated backoff exhausts this call even if the wait wakes early.
                    if delay >= remaining:
                        break
                    backoff = min(backoff * 2, 1)
        except TimeoutError:
            pass
        except Exception as failure:
            with lock:
                if not cancelled.is_set() and monotonic() < deadline:
                    error = (
                        failure
                        if isinstance(failure, TraceVerificationError)
                        else (
                            TraceVerificationError(
                                "Hue trace verification request failed. Check connectivity and "
                                "the configured Hue origin; redirects are not supported.",
                                code="transport",
                            )
                        )
                    )
        finally:
            poll_lock.release()
            done.set()

    # requests' timeouts measure socket inactivity, not the entire response.
    # Bound the caller's complete operation, including DNS, headers and body.
    try:
        Thread(target=poll, name="hue-verify-trace", daemon=True).start()
    except RuntimeError:
        poll_lock.release()
        raise TraceVerificationError(
            "Hue could not start trace verification. Retry when local resources are available.",
            code="transport",
        ) from None
    done.wait(max(0, deadline - monotonic()))
    with lock:
        cancelled.set()
        if error is not None:
            raise error from None
        return result or TraceVerificationResult(False, latest)
