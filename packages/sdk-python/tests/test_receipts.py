from __future__ import annotations

import io
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

from hue_sdk import Hue, TraceReceipt, TraceVerificationError, TraceVerificationResult
from hue_sdk.transport import SafeSession

TRACE_ID = "a" * 32
SPAN_A, SPAN_B = "b" * 16, "c" * 16
KEY = "synthetic-trace-receipt-key"


def receipt(base_url, *, matched=(), missing=(), **changes):
    return {
        "traceId": TRACE_ID,
        "spanCount": 2,
        "revision": 3,
        "fields": dict.fromkeys(("input", "output", "model", "usage", "session"), True),
        "matchedSpanIds": list(matched),
        "missingSpanIds": list(missing),
        "traceUrl": f"{base_url}/projects/synthetic/traces/{TRACE_ID}",
        **changes,
    }


def reply(receiver, data, status=200, **headers):
    receiver.reply(status, json.dumps(data).encode(), **headers)


def test_not_found_then_partial_then_received_checks_exact_expected_spans(receiver):
    reply(receiver, {"error": "Trace not found.", "code": "TRACE_NOT_FOUND"}, status=404)
    reply(receiver, receipt(receiver.url, matched=(SPAN_A,), missing=(SPAN_B,)))
    reply(receiver, receipt(receiver.url, matched=(SPAN_B, SPAN_A)))
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        result = hue.verify_trace(
            TRACE_ID,
            expected_span_ids=[SPAN_A, SPAN_B],
            required_fields=["input", "output", "model", "usage", "session"],
            timeout_millis=2_000,
        )
    assert isinstance(result, TraceVerificationResult) and result.verified
    assert isinstance(result.receipt, TraceReceipt)
    assert result.receipt.trace_id == TRACE_ID
    assert result.receipt.matched_span_ids == (SPAN_A, SPAN_B)
    assert result.receipt.missing_span_ids == ()
    assert result.receipt.fields.input and result.receipt.fields.usage
    assert len(receiver.requests) == 3
    for path, headers, body in receiver.requests:
        assert urlsplit(path).path == f"/api/v1/traces/{TRACE_ID}/receipt"
        assert parse_qs(urlsplit(path).query) == {"expectedSpanId": [SPAN_A, SPAN_B]}
        assert headers["Authorization"] == f"Bearer {KEY}"
        assert body == b""  # Verification itself never emits synthetic telemetry.


def test_receipt_url_accepts_equivalent_origin_spelling(monkeypatch):
    def get(_session, url, **_kwargs):
        assert url.startswith("https://APP.HUE.RUN:443/")
        response = requests.Response()
        response.status_code = 200
        response.raw = io.BytesIO(json.dumps(receipt("https://app.hue.run")).encode())
        return response

    monkeypatch.setattr(SafeSession, "get", get)
    with Hue("https://APP.HUE.RUN:443", KEY, capture_content=False) as hue:
        result = hue.verify_trace(TRACE_ID)
    assert result.verified
    assert result.receipt.trace_url.startswith("https://app.hue.run/")


def test_timeout_returns_latest_partial_receipt_and_does_not_flush(receiver, monkeypatch):
    partial = receipt(receiver.url, matched=(SPAN_A,), missing=(SPAN_B,))
    reply(receiver, partial)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        monkeypatch.setattr(hue, "force_flush", lambda *_args: pytest.fail("implicit flush"))
        result = hue.verify_trace(
            TRACE_ID,
            expected_span_ids=[SPAN_A, SPAN_B],
            timeout_millis=80,
        )
    assert not result.verified
    assert result.receipt is not None and result.receipt.missing_span_ids == (SPAN_B,)
    assert len(receiver.requests) == 1


def test_required_fields_wait_for_field_presence(receiver):
    fields = dict.fromkeys(("input", "output", "model", "usage", "session"), True)
    reply(receiver, receipt(receiver.url, fields={**fields, "usage": False}))
    reply(receiver, receipt(receiver.url, fields=fields))
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        result = hue.verify_trace(TRACE_ID, required_fields=["usage"], timeout_millis=1_000)
    assert result.verified and result.receipt.fields.usage
    assert len(receiver.requests) == 2


def test_timeout_without_receipt_is_unverified(receiver):
    reply(receiver, {"code": "TRACE_NOT_FOUND"}, status=404)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        result = hue.verify_trace(TRACE_ID, timeout_millis=50)
    assert result == TraceVerificationResult(False, None)


@pytest.mark.parametrize("status", [429, 503])
def test_retryable_service_error_honors_retry_after_within_deadline(receiver, status):
    receiver.reply(status, **{"Retry-After": "60"})
    reply(receiver, receipt(receiver.url))
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        started = time.monotonic()
        result = hue.verify_trace(TRACE_ID, timeout_millis=60)
        elapsed = time.monotonic() - started
    assert not result.verified and result.receipt is None
    assert elapsed < 0.3
    assert len(receiver.requests) == 1


@pytest.mark.parametrize("status", [429, 503])
def test_retryable_service_error_then_success(receiver, status):
    receiver.reply(status, **{"Retry-After": "0"})
    reply(receiver, receipt(receiver.url))
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        assert hue.verify_trace(TRACE_ID, timeout_millis=1_000).verified
    assert len(receiver.requests) == 2


@pytest.mark.parametrize("status", [401, 403, 404, 400, 500])
def test_nonretryable_errors_are_safe_actionable_and_typed(receiver, status):
    reply(receiver, {"error": f"secret {KEY}"}, status=status)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(TraceVerificationError) as failure:
            hue.verify_trace(TRACE_ID)
    assert failure.value.status_code == status
    assert failure.value.code == ("authentication" if status in (401, 403) else "http")
    if status == 404:
        assert "does not support" in str(failure.value)
    assert KEY not in str(failure.value) + repr(failure.value)
    assert len(receiver.requests) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"traceId": "d" * 32},
        {"spanCount": True},
        {"spanCount": -1},
        {"spanCount": 0},
        {"spanCount": 9_007_199_254_740_992},
        {"revision": 1.5},
        {"revision": 9_007_199_254_740_992},
        {"fields": {"input": True}},
        {"fields": dict.fromkeys(("input", "output", "model", "usage", "session"), 1)},
        {"matchedSpanIds": [SPAN_A, SPAN_A]},
        {"matchedSpanIds": [SPAN_A], "missingSpanIds": [SPAN_A]},
        {"matchedSpanIds": [], "missingSpanIds": []},
        {"matchedSpanIds": [SPAN_B]},
        {"matchedSpanIds": ["0" * 16]},
        {"traceUrl": "https://other.example/traces/receipt"},
        {"traceUrl": "https://secret@example.com/traces/receipt"},
        {"traceUrl": "http://127.0.0.1/" + "a" * 2048},
    ],
)
def test_malformed_receipts_never_verify(receiver, changes):
    reply(receiver, receipt(receiver.url, matched=(SPAN_A,), **changes))
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(TraceVerificationError, match="invalid trace receipt") as failure:
            hue.verify_trace(TRACE_ID, expected_span_ids=[SPAN_A])
    assert failure.value.code == "invalid_response"
    assert len(receiver.requests) == 1


@pytest.mark.parametrize("body", [b"not-json", b"[", b"x" * 65_537])
def test_invalid_or_oversized_response_is_rejected(receiver, body):
    receiver.reply(200, body)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(TraceVerificationError) as failure:
            hue.verify_trace(TRACE_ID)
    assert failure.value.code == "invalid_response"


def test_redirect_never_sends_key_to_redirect_target(receiver):
    receiver.reply(302, Location="http://127.0.0.1:1/key-stealer")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(TraceVerificationError) as failure:
            hue.verify_trace(TRACE_ID)
    assert failure.value.code == "transport"
    assert "redirects" in str(failure.value) and KEY not in str(failure.value)
    assert len(receiver.requests) == 1


@pytest.mark.parametrize(
    "options",
    [
        {"trace_id": "0" * 32},
        {"trace_id": "A" * 32},
        {"trace_id": "not-an-id"},
        {"expected_span_ids": [SPAN_A, SPAN_A]},
        {"expected_span_ids": ["0" * 16]},
        {"expected_span_ids": [f"{value:016x}" for value in range(1, 102)]},
        {"expected_span_ids": SPAN_A},
        {"expected_span_ids": [None]},
        {"required_fields": ["cost"]},
        {"required_fields": "input"},
        {"required_fields": ["input", "input"]},
        {"timeout_millis": 0},
        {"timeout_millis": 60_001},
        {"timeout_millis": float("inf")},
        {"timeout_millis": float("nan")},
        {"timeout_millis": True},
    ],
)
def test_invalid_request_options_fail_before_network(receiver, options):
    options = {"trace_id": TRACE_ID, **options}
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(ValueError):
            hue.verify_trace(**options)
    assert receiver.requests == []


def test_deadline_includes_delayed_response_headers(receiver):
    receiver.delay_seconds = 0.4
    reply(receiver, receipt(receiver.url))
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        started = time.monotonic()
        result = hue.verify_trace(TRACE_ID, timeout_millis=50)
        elapsed = time.monotonic() - started
    assert result == TraceVerificationResult(False, None)
    assert elapsed < 0.25


def test_deadline_includes_slow_response_body():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(receipt(f"http://127.0.0.1:{self.server.server_port}")).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                for byte in body:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.01)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with Hue(f"http://127.0.0.1:{server.server_port}", KEY, capture_content=False) as hue:
            started = time.monotonic()
            result = hue.verify_trace(TRACE_ID, timeout_millis=80)
            elapsed = time.monotonic() - started
        assert result == TraceVerificationResult(False, None)
        assert elapsed < 0.3
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=1)


def test_repeated_timeouts_do_not_accumulate_background_requests(receiver, monkeypatch):
    calls = []

    def blocked_get(*_args, **_kwargs):
        calls.append(True)
        time.sleep(0.4)  # Simulate a resolver that ignores the socket timeout.
        raise requests.ConnectionError(f"must-not-leak-{KEY}")

    monkeypatch.setattr(SafeSession, "get", blocked_get)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        for _ in range(2):
            assert hue.verify_trace(TRACE_ID, timeout_millis=40) == TraceVerificationResult(
                False, None
            )
    assert len(calls) == 1


def test_transport_errors_omit_underlying_secrets(receiver, monkeypatch):
    def failed_get(*_args, **_kwargs):
        raise requests.ConnectionError(f"must-not-leak-{KEY}")

    monkeypatch.setattr(SafeSession, "get", failed_get)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(TraceVerificationError) as failure:
            hue.verify_trace(TRACE_ID)
    assert failure.value.code == "transport"
    assert KEY not in str(failure.value)
