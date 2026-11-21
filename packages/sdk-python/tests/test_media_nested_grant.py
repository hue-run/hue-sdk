"""A grant or error body nested past the JSON parser must be ``MediaFetchError``.

``MediaClient.fetch`` reads an answer of up to 64 KiB and parses it with ``json.loads``.
CPython raises ``RecursionError`` for an array nested past its recursion budget, and that
budget is reached by a body still under 64 KiB: about a thousand arrays on 3.10, about ten
thousand on 3.12. ``_answer`` catches ``ValueError`` and ``UnicodeError`` only, and
``fetch`` does not catch ``RecursionError``, so the exception leaves the public API.

These tests fail while that happens. They pass once the parse becomes ``MediaFetchError``:
``failed`` for a grant, ``not_found`` for a 404 whose body is not a missing-file object, the
same outcomes as any other body that is not JSON. A body this size is accepted by the 64 KiB
cap, so lowering nothing but a check that still lets this body through does not pass.

On CPython 3.14 the same body parses, and ``fetch`` already raises ``MediaFetchError``. Run
the file on 3.10 or 3.12 to see it fail.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any
from urllib.parse import urlsplit

from hue_sdk.evals import EvaluationClient, MediaFetchError

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SNAPSHOT_ID = "12345678-1234-1234-1234-123456789abc"
DIGEST = "ab" * 32
# 12_000 arrays is 24_000 bytes: under the 64 KiB cap, past 3.10's and 3.12's recursion budget.
NESTED = b"[" * 12_000 + b"]" * 12_000
assert len(NESTED) <= 64 * 1024
KEY = "synthetic-media-key"


class _Origin:
    def __init__(self, answers: dict[str, tuple[int, bytes]]) -> None:
        self.seen: list[str] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                path = urlsplit(self.path).path
                owner.seen.append(path)
                status, body = answers.get(path, (404, b"{}"))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.01})
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)


def _fetch_error(call: Any) -> MediaFetchError:
    try:
        call()
    except MediaFetchError as error:
        return error
    except RecursionError as error:
        error.__traceback__ = None
        raise AssertionError(
            "MediaClient.fetch raised RecursionError instead of MediaFetchError"
        ) from None
    raise AssertionError("MediaClient.fetch returned a file")


def _client(origin: _Origin) -> EvaluationClient:
    return EvaluationClient(origin.url, KEY, timeout_seconds=2)


def test_a_nested_grant_for_a_trace_is_media_fetch_error() -> None:
    path = f"/api/v1/traces/{TRACE_ID}/blobs/{DIGEST}"
    origin = _Origin({path: (200, NESTED)})
    try:
        error = _fetch_error(lambda: _client(origin).media.fetch(trace_id=TRACE_ID, sha256=DIGEST))
    finally:
        origin.close()
    assert (error.reason, error.status) == ("failed", None)
    assert str(error) == "The media request failed."
    assert origin.seen == [path]


def test_a_nested_grant_for_a_snapshot_is_media_fetch_error() -> None:
    path = f"/api/v1/trace-snapshots/{SNAPSHOT_ID}/blobs/{DIGEST}"
    origin = _Origin({path: (200, NESTED)})
    try:
        error = _fetch_error(
            lambda: _client(origin).media.fetch(snapshot_id=SNAPSHOT_ID, sha256=DIGEST)
        )
    finally:
        origin.close()
    assert (error.reason, error.status) == ("failed", None)
    assert origin.seen == [path]


def test_a_nested_error_body_is_media_fetch_error() -> None:
    path = f"/api/v1/traces/{TRACE_ID}/blobs/{DIGEST}"
    origin = _Origin({path: (404, NESTED)})
    try:
        error = _fetch_error(lambda: _client(origin).media.fetch(trace_id=TRACE_ID, sha256=DIGEST))
    finally:
        origin.close()
    assert (error.reason, error.status) == ("not_found", 404)
    assert str(error) == "Hue holds no file with this digest for the trace or snapshot."
    assert origin.seen == [path]
