"""Values over Hue's inline limit, uploaded apart from their span to a loopback Hue that implements
the large-value contract: reservations answered ``exists`` or a presigned PUT to its own store,
the store checking each PUT as S3 checks a presigned one, and completions. Also run against the
wheel."""

from __future__ import annotations

import base64
import gc
import gzip
import hashlib
import json
import os
import sys
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from typing import Any

import pytest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from hue_sdk import Hue

KEY = "synthetic-blob-key"
KIB = 1024
MIB = 1024 * KIB


class Store:
    """The synthetic Hue: OTLP records, reservations, PUTs, completions and stored objects."""

    def __init__(self) -> None:
        self.url = ""
        self.lock = Lock()
        self.spans: list[Any] = []
        self.logs: list[Any] = []
        self.reservations: list[dict[str, Any]] = []
        self.puts: list[dict[str, Any]] = []
        self.completions: list[dict[str, Any]] = []
        # Objects by ``<trace>/<sha256>``: their bytes and content type.
        self.objects: dict[str, tuple[bytes, str]] = {}
        # The reservation route's answer for the n-th reservation (1-based): a status, headers
        # and whether the body is Hue's JSON error (or the body itself); ``None`` answers as Hue
        # does.
        self.reserve: Callable[[int], tuple[int, dict[str, str], bool | bytes] | None] = lambda _: (
            None
        )
        # The store's status for the n-th PUT: 200 stores, "hang" never answers, "expired"
        # answers S3's expired-URL refusal, "trickle" answers 200 a byte at a time.
        self.put: Callable[[int], int | str] = lambda _: 200
        self.hang = Event()
        # Trace requests are answered once ``release_traces`` is set; ``traces_received`` is set
        # when one arrives.
        self.release_traces = Event()
        self.release_traces.set()
        self.traces_received = Event()

    def span(self, name: str) -> Any:
        with self.lock:
            (span,) = [span for span in self.spans if span.name == name]
        return span


def attrs(span: Any) -> dict[str, Any]:
    return {attribute.key: attribute.value for attribute in span.attributes}


def listed(span: Any) -> list[str]:
    value = attrs(span).get("hue.truncated")
    return [item.string_value for item in value.array_value.values] if value else []


def blobs(span: Any) -> list[dict[str, Any]]:
    value = attrs(span).get("hue.blobs")
    return [json.loads(item.string_value) for item in value.array_value.values] if value else []


def sha256(value: bytes | str) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def message_with_image(data: bytes) -> str:
    return json.dumps(
        [
            {
                "role": "user",
                "parts": [
                    {"type": "text", "content": "Describe this image."},
                    {
                        "type": "blob",
                        "modality": "image",
                        "mime_type": "image/png",
                        "content": base64.b64encode(data).decode(),
                    },
                ],
            }
        ]
    )


@pytest.fixture
def hue_store() -> Iterator[Store]:
    store = Store()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.respond()

        def do_PUT(self) -> None:
            self.respond()

        def reply(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None):
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def json(self, status: int, value: Any, headers: dict[str, str] | None = None) -> None:
            self.reply(
                status,
                json.dumps(value).encode(),
                {"Content-Type": "application/json", **(headers or {})},
            )

        def respond(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            headers = {name.lower(): value for name, value in self.headers.items()}
            path = self.path.split("?")[0]
            if path.startswith("/store/"):
                object_key = path[len("/store/") :]
                with store.lock:
                    behavior = store.put(len(store.puts) + 1)
                    put = {"headers": headers, "bytes": len(body), "status": behavior}
                    store.puts.append(put)
                if behavior == "hang":
                    store.hang.wait(30)
                    return
                if behavior == "trickle":
                    self.send_response(200)
                    self.send_header("Content-Length", "1000")
                    self.end_headers()
                    for _ in range(1000):
                        if store.hang.is_set():
                            return
                        try:
                            self.wfile.write(b" ")
                            self.wfile.flush()
                        except OSError:
                            return
                        time.sleep(0.1)
                    return
                if behavior == "expired":
                    put["status"] = 403
                    self.reply(
                        403,
                        b"<Error><Code>AccessDenied</Code><Message>Request has expired</Message>"
                        b"</Error>",
                    )
                    return
                if behavior != 200:
                    self.reply(int(behavior), b"<Error><Code>InternalError</Code></Error>")
                    return
                # S3 refuses a presigned PUT sent chunked: its length is signed.
                if "transfer-encoding" in headers:
                    put["status"] = 501
                    self.reply(501, b"<Error><Code>NotImplemented</Code></Error>")
                    return
                checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
                if (
                    "authorization" in headers
                    or headers.get("if-none-match") != "*"
                    or headers.get("x-amz-checksum-sha256") != checksum
                    or object_key.split("/")[1] != hashlib.sha256(body).hexdigest()
                    or int(headers.get("content-length", "-1")) != len(body)
                ):
                    put["status"] = 400
                    self.reply(400, b"<Error><Code>BadDigest</Code></Error>")
                    return
                with store.lock:
                    if object_key in store.objects:
                        put["status"] = 412
                        exists = True
                    else:
                        store.objects[object_key] = (body, headers.get("content-type", ""))
                        exists = False
                self.reply(412 if exists else 200)
                return
            assert headers.get("authorization", "").startswith("Bearer ")
            if path == "/api/v1/otlp/blobs":
                request = json.loads(body)
                with store.lock:
                    store.reservations.append(request)
                    answer = store.reserve(len(store.reservations))
                if answer is not None:
                    status, reply_headers, is_json = answer
                    if isinstance(is_json, bytes):
                        self.reply(status, is_json, reply_headers)
                    elif is_json:
                        self.json(status, {"error": "Synthetic refusal."}, reply_headers)
                    else:
                        self.reply(status, b"Not Found", reply_headers)
                    return
                object_key = f"{request['traceId']}/{request['sha256']}"
                ref = {
                    "key": request["key"],
                    "sha256": request["sha256"],
                    "size": request["byteSize"],
                    "content_type": request["contentType"],
                }
                with store.lock:
                    exists = object_key in store.objects
                if exists:
                    self.json(200, {"status": "exists", "ref": ref})
                    return
                expires = time.strftime(
                    "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 15 * 60)
                )
                self.json(
                    200,
                    {
                        "status": "upload",
                        "url": f"{store.url}/store/{object_key}?X-Amz-Signature=synthetic",
                        "method": "PUT",
                        "headers": {
                            "Content-Length": str(request["byteSize"]),
                            "Content-Type": request["contentType"],
                            "If-None-Match": "*",
                            "x-amz-checksum-sha256": base64.b64encode(
                                bytes.fromhex(request["sha256"])
                            ).decode(),
                        },
                        "expiresAt": expires,
                        "ref": ref,
                    },
                )
                return
            if path == "/api/v1/otlp/blobs/complete":
                request = json.loads(body)
                with store.lock:
                    store.completions.append(request)
                    stored = f"{request['traceId']}/{request['sha256']}" in store.objects
                if not stored:
                    self.json(409, {"error": "Not uploaded.", "status": "missing"})
                else:
                    self.json(200, {"status": "complete"})
                return
            if headers.get("content-encoding") == "gzip":
                body = gzip.decompress(body)
            if path.endswith("/traces"):
                traces = ExportTraceServiceRequest.FromString(body)
                with store.lock:
                    store.spans.extend(
                        span
                        for resource in traces.resource_spans
                        for scope in resource.scope_spans
                        for span in scope.spans
                    )
                store.traces_received.set()
                store.release_traces.wait(30)
                self.reply(
                    200, b"", {"Content-Type": "application/x-protobuf", "Hue-Pending-Spans": "1"}
                )
                return
            logs = ExportLogsServiceRequest.FromString(body)
            with store.lock:
                store.logs.extend(
                    log
                    for resource in logs.resource_logs
                    for scope in resource.scope_logs
                    for log in scope.log_records
                )
            self.reply(200, b"", {"Content-Type": "application/x-protobuf"})

        def log_message(self, *_args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    store.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield store
    finally:
        store.hang.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def client(store: Store, **options: Any) -> Hue:
    return Hue(
        store.url, options.pop("api_key", KEY), capture_content=True, live_spans=False, **options
    )


def test_values_over_the_limit_are_uploaded_and_replaced_by_their_first_16_kib(hue_store):
    text = "é" * (900 * KIB) + "tail"
    image = os.urandom(200 * KIB)
    rows = [{"id": index, "note": "n" * 40} for index in range(30_000)]
    rows_text = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    with client(hue_store) as hue:
        with hue.span("offloaded") as span:
            trace_id = span.trace_id
            span.set_attribute("custom.document", text)
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
            span.set_input("short input")
            span.set_output(rows)
        assert hue.force_flush()
        status = hue.export_status
        assert status.uploaded_values == 3
        assert status.upload_fallbacks == 0
        assert [issue for issue in hue.export_issues() if issue.kind == "warning"] == []
    record = hue_store.span("offloaded")
    entries = blobs(record)
    assert entries == [
        {
            "key": "custom.document",
            "sha256": sha256(text),
            "size": len(text.encode()),
            "content_type": "text/plain; charset=utf-8",
        },
        {
            "key": "gen_ai.input.messages#/0/parts/1/content",
            "sha256": sha256(image),
            "size": len(image),
            "content_type": "image/png",
        },
        {
            "key": "output.value",
            "sha256": sha256(rows_text),
            "size": len(rows_text.encode()),
            "content_type": "application/json",
        },
    ]
    # The store holds exactly the bytes the entries name, under the span's trace.
    for entry in entries:
        stored, content_type = hue_store.objects[f"{trace_id}/{entry['sha256']}"]
        assert len(stored) == entry["size"] and content_type == entry["content_type"]
    assert hue_store.objects[f"{trace_id}/{sha256(text)}"][0] == text.encode()
    assert hue_store.objects[f"{trace_id}/{sha256(image)}"][0] == image
    values = attrs(record)
    document = values["custom.document"].string_value
    assert len(document.encode()) == 16 * KIB and text.startswith(document)
    output = values["output.value"].string_value
    assert len(output.encode()) == 16 * KIB and rows_text.startswith(output)
    (message,) = json.loads(values["gen_ai.input.messages"].string_value)
    assert message["parts"][0] == {"type": "text", "content": "Describe this image."}
    assert message["parts"][1] == {
        "type": "blob",
        "modality": "image",
        "mime_type": "image/png",
        "content": base64.b64encode(image).decode()[: 16 * KIB],
    }
    # The whole values are listed as cut inline; a part is listed in hue.blobs alone.
    assert listed(record) == ["custom.document", "output.value"]
    assert values["input.value"].string_value == '"short input"'
    assert {reservation["traceId"] for reservation in hue_store.reservations} == {trace_id}
    assert len(hue_store.completions) == 3
    assert all("authorization" not in put["headers"] for put in hue_store.puts)
    # Each PUT carried its signed length, never a chunked body.
    assert [put["status"] for put in hue_store.puts] == [200, 200, 200]
    assert all("transfer-encoding" not in put["headers"] for put in hue_store.puts)


def test_a_value_hue_already_stores_under_the_trace_is_not_uploaded_again(hue_store):
    text = "r" * (3 * MIB)
    with client(hue_store) as hue:
        with hue.span("first") as parent:
            parent.set_attribute("tool.output", text)
            with hue.span("second") as child:
                child.set_attribute("tool.output", text)
            # The child is exported, its value uploaded, before the parent ends.
            assert hue.force_flush()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 2
    assert len(hue_store.puts) == 1
    assert len(hue_store.reservations) == 2
    assert len(hue_store.completions) == 1
    for name in ("first", "second"):
        record = hue_store.span(name)
        assert blobs(record) == [
            {
                "key": "tool.output",
                "sha256": sha256(text),
                "size": len(text),
                "content_type": "text/plain; charset=utf-8",
            }
        ]
        assert attrs(record)["tool.output"].string_value == "r" * (16 * KIB)


def test_the_put_that_loses_a_race_for_one_value_is_answered_412_and_taken_as_stored(hue_store):
    text = "w" * (2 * MIB)
    with client(hue_store) as hue:
        with hue.span("parent") as parent:
            parent.set_attribute("tool.output", text)
            with hue.span("child") as child:
                child.set_attribute("tool.output", text)
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 2
        assert hue.export_status.upload_fallbacks == 0
    assert len(hue_store.objects) == 1
    assert sorted(put["status"] for put in hue_store.puts) in ([200], [200, 412])
    for name in ("parent", "child"):
        assert [entry["sha256"] for entry in blobs(hue_store.span(name))] == [sha256(text)]


def test_an_expired_upload_url_is_reserved_again_once(hue_store):
    hue_store.put = lambda index: "expired" if index == 1 else 200
    with client(hue_store) as hue:
        with hue.span("expired") as span:
            span.set_attribute("custom.document", "e" * (2 * MIB))
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 1
    assert len(hue_store.reservations) == 2
    assert [put["status"] for put in hue_store.puts] == [403, 200]


def test_a_value_that_cannot_be_uploaded_is_cut_as_before_reported_counted_and_pauses(hue_store):
    hue_store.put = lambda _: 503
    text = "f" * (2 * MIB)
    image = os.urandom(100 * KIB)
    with client(hue_store) as hue:
        with hue.span("fallback") as span:
            trace_id = span.trace_id
            span.set_attribute("custom.document", text)
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
        # The export succeeds: the record was delivered, with the values cut.
        assert hue.force_flush()
        status = hue.export_status
        assert status.ok and status.uploaded_values == 0 and status.upload_fallbacks == 2
        failure_sequence = hue.export_failure_sequence()
        (warning,) = [issue for issue in hue.export_issues() if issue.kind == "warning"]
        assert warning.count == 2 and warning.trace_ids == (trace_id,)
        assert "could not be uploaded" in warning.message
        record = hue_store.span("fallback")
        assert attrs(record)["custom.document"].string_value == "f" * MIB
        assert listed(record) == ["custom.document"]
        assert "hue.blobs" not in attrs(record)
        # The image falls back to its digest, as the SDK exported it before uploads.
        (message,) = json.loads(attrs(record)["gen_ai.input.messages"].string_value)
        assert message["parts"][1] == {
            "type": "blob",
            "modality": "image",
            "mime_type": "image/png",
            "sha256": sha256(image),
            "size": len(image),
        }
        # Each failed PUT was retried once, never more; the failure paused uploads, so a later
        # value meets no request at all.
        attempts = len(hue_store.puts)
        assert attempts <= 4
        with hue.span("paused") as span:
            span.set_attribute("custom.document", text)
        assert hue.force_flush()
        assert len(hue_store.puts) == attempts
        assert attrs(hue_store.span("paused"))["custom.document"].string_value == "f" * MIB
        assert hue.export_status.upload_fallbacks == 3
        # A warning is not a failure.
        assert hue.export_failure_sequence() == failure_sequence == 0


def test_a_receiver_without_the_upload_route_is_remembered(hue_store):
    hue_store.reserve = lambda _: (404, {}, False)
    with client(hue_store) as hue:
        for name in ("first", "second"):
            with hue.span(name) as span:
                span.set_attribute("custom.document", "n" * (2 * MIB))
            assert hue.force_flush()
            assert attrs(hue_store.span(name))["custom.document"].string_value == "n" * MIB
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1, 1]
    assert len(hue_store.reservations) == 1


def test_hue_s_own_404_is_a_failure_not_a_receiver_without_uploads(hue_store):
    hue_store.reserve = lambda _: (404, {}, True)
    with client(hue_store) as hue:
        for name in ("archived", "again"):
            with hue.span(name) as span:
                span.set_attribute("custom.document", "a" * (2 * MIB))
            assert hue.force_flush()
            assert attrs(hue_store.span(name))["custom.document"].string_value == "a" * MIB
        warnings = [issue for issue in hue.export_issues() if issue.kind == "warning"]
        assert [
            issue.message.startswith("Values over Hue's inline limit could not")
            for issue in warnings
        ] == [True, True]
    # The refusal paused uploads, so the next value met no request; it was not taken for a
    # receiver without the route, whose values are cut when queued.
    assert len(hue_store.reservations) == 1


@pytest.mark.parametrize(
    "answer",
    [(405, {}, False), (501, {}, False), (200, {}, b"OK"), (200, {}, b'{"accepted":true}')],
    ids=["405", "501", "200 text", "200 other JSON"],
)
def test_a_receiver_that_refuses_the_method_or_answers_no_reservation_lacks_the_route(
    hue_store, answer
):
    hue_store.reserve = lambda _: answer
    with client(hue_store) as hue:
        for name in ("first", "second"):
            with hue.span(name) as span:
                span.set_attribute("custom.document", "r" * (2 * MIB))
            assert hue.force_flush()
            assert attrs(hue_store.span(name))["custom.document"].string_value == "r" * MIB
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1, 1]
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == []


def test_an_upload_body_reports_its_position_and_ends_when_its_upload_must_stop():
    from time import monotonic

    from hue_sdk._blobs import _Body

    stopped = [False]
    body = _Body("é" * 10, 20, monotonic() + 60, lambda: stopped[0])
    # A position lets the HTTP client send the signed Content-Length rather than a chunked body.
    assert len(body) == 20 and body.tell() == 0
    assert body.read(3) == "é".encode() + b"\xc3"
    assert body.tell() == 3
    stopped[0] = True
    with pytest.raises(TimeoutError):
        body.read(3)
    with pytest.raises(TimeoutError):
        _Body(b"x", 1, monotonic() - 1, lambda: False).read(1)


def test_a_message_s_large_inline_file_is_held_apart_from_the_queue_budget(hue_store):
    # The message's text is larger than the whole queue; its copy with the file as its digest is
    # not, so the queue takes the span as it did before uploads existed.
    image = os.urandom(200 * KIB)
    with client(hue_store, max_queue_bytes=256 * KIB) as hue:
        with hue.span("small queue") as span:
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
        assert hue.force_flush()
        status = hue.export_status
        assert status.dropped_trace_records == 0 and status.uploaded_values == 1
    (entry,) = blobs(hue_store.span("small queue"))
    assert entry["key"] == "gen_ai.input.messages#/0/parts/1/content"
    assert entry["sha256"] == sha256(image)


def test_inline_files_queued_while_the_receiver_lacks_the_route_are_reported_per_file(hue_store):
    hue_store.reserve = lambda _: (404, {}, False)
    images = [os.urandom(100 * KIB), os.urandom(120 * KIB)]
    with client(hue_store) as hue:
        with hue.span("learn") as span:
            span.set_attribute("custom.document", "n" * (2 * MIB))
        assert hue.force_flush()
        with hue.span("files") as span:
            span.set_attribute(
                "gen_ai.input.messages",
                json.dumps(
                    [
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "type": "blob",
                                    "mime_type": "image/png",
                                    "content": base64.b64encode(image).decode(),
                                }
                            ],
                        }
                        for image in images
                    ]
                ),
            )
        assert hue.force_flush()
        assert hue.export_status.upload_fallbacks == 3
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1, 2]
    assert len(hue_store.reservations) == 1
    messages = json.loads(attrs(hue_store.span("files"))["gen_ai.input.messages"].string_value)
    assert [message["parts"][0]["sha256"] for message in messages] == [
        sha256(image) for image in images
    ]


def test_a_message_cut_after_the_queue_digested_its_files_reports_the_files_and_the_cut(
    hue_store,
):
    hue_store.reserve = lambda _: (404, {}, False)

    def message(text: str) -> str:
        return json.dumps(
            [
                {
                    "role": "user",
                    "parts": [
                        {"type": "text", "content": text},
                        {
                            "type": "blob",
                            "mime_type": "image/png",
                            "content": base64.b64encode(os.urandom(100 * KIB)).decode(),
                        },
                    ],
                }
            ]
        )

    with client(hue_store) as hue:
        with hue.span("learn") as span:
            span.set_attribute("custom.document", "n" * (2 * MIB))
        assert hue.force_flush()
        with hue.span("long") as span:
            span.set_attribute("gen_ai.input.messages", message("t" * (MIB + 20 * KIB)))
            span.set_attribute("gen_ai.output.messages", message("u" * (MIB + 200 * KIB)))
        assert hue.force_flush()
        assert hue.export_status.upload_fallbacks == 5
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1, 4]
    assert listed(hue_store.span("long")) == ["gen_ai.input.messages", "gen_ai.output.messages"]


def test_the_fallback_for_an_unfinished_placement_reports_each_inline_file_it_digests():
    from hue_sdk._blobs import _fallback

    result = _fallback("gen_ai.input.messages", message_with_image(os.urandom(100 * KIB)), MIB)
    assert '"sha256"' in result.value
    assert result.fallbacks == ["failed"] and not result.listed


def test_a_reply_that_trickles_is_cut_off_at_its_deadline_and_frees_its_upload_slot(hue_store):
    hue_store.put = lambda _: "trickle"
    hue = client(hue_store, export_timeout_seconds=0.5)
    try:
        with hue.span("trickled") as span:
            span.set_attribute("custom.document", "t" * (2 * MIB))
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=20_000)
        # Six request budgets for the uploads, then the span's own request; the store's answer
        # would have taken 100 s.
        assert time.monotonic() - started < 6
        assert hue.export_status.upload_fallbacks == 1
        slots = hue._uploads.uploader._slots
        deadline = time.monotonic() + 2
        while slots._value < 4 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert slots._value == 4
    finally:
        hue.shutdown(timeout_millis=5_000)


def test_a_placed_span_lets_go_of_its_whole_value_while_it_is_sent(hue_store):
    hue_store.release_traces.clear()
    text = "w" * (2 * MIB)
    flushing = None
    with client(hue_store) as hue:
        try:
            span = hue.tracer.start_span("released")
            span.set_attribute("custom.document", text)
            span.end()
            del span
            gc.collect()
            # The application's reference, and the queued copy's.
            queued = sys.getrefcount(text)
            flushing = Thread(target=hue.force_flush, daemon=True)
            flushing.start()
            assert hue_store.traces_received.wait(10)
            # Uploaded and being sent: the queued copy no longer holds the whole value, so the
            # held-value budget it released is not held twice.
            deadline = time.monotonic() + 2
            while sys.getrefcount(text) >= queued and time.monotonic() < deadline:
                time.sleep(0.01)
            assert sys.getrefcount(text) == queued - 1
        finally:
            hue_store.release_traces.set()
            if flushing is not None:
                flushing.join(15)
    assert len(blobs(hue_store.span("released"))) == 1


def test_a_rate_limited_reservation_is_retried_after_its_retry_after(hue_store):
    hue_store.reserve = lambda index: (429, {"Retry-After": "1"}, True) if index == 1 else None
    with client(hue_store) as hue:
        with hue.span("limited") as span:
            span.set_attribute("custom.document", "l" * (2 * MIB))
        started = time.monotonic()
        assert hue.force_flush()
        assert time.monotonic() - started >= 0.9
    assert len(hue_store.reservations) == 2
    assert len(blobs(hue_store.span("limited"))) == 1


def test_the_redactor_s_answer_is_uploaded_and_metadata_only_export_uploads_nothing(hue_store):
    secret = "sk-synthetic-redacted-0123456789"
    text = "s" * (2 * MIB) + secret

    def redact(_key: str, value: Any) -> Any:
        return value.replace(secret, "[key]") if isinstance(value, str) else value

    with client(hue_store, redactor=redact) as hue:
        with hue.span("redacted") as span:
            span.set_output(text)
        assert hue.force_flush()
    ((stored, _),) = hue_store.objects.values()
    assert secret.encode() not in stored
    assert stored == json.dumps("s" * (2 * MIB) + "[key]").encode()
    # Without content capture, content is removed and nothing at all is uploaded: a custom value
    # over the limit is cut, as before.
    reserved = len(hue_store.reservations)
    with Hue(hue_store.url, KEY, capture_content=False, live_spans=False) as metadata:
        with metadata.span("metadata") as span:
            span.set_attribute("input.value", text)
            span.set_attribute("custom.document", text)
        assert metadata.force_flush()
        assert metadata.export_status.upload_fallbacks == 0
    assert len(hue_store.reservations) == reserved
    record = hue_store.span("metadata")
    assert "input.value" not in attrs(record)
    assert attrs(record)["custom.document"].string_value == "s" * MIB
    assert "hue.blobs" not in attrs(record)


def test_a_recorded_request_over_the_record_budget_is_scrubbed_on_export_and_uploaded(hue_store):
    request = json.dumps(
        {
            "model": "synthetic-model",
            "tools": [
                {
                    "type": "mcp",
                    "server_label": "synthetic",
                    "headers": {"Authorization": "Bearer synthetic-upload-token"},
                }
            ],
            "input": "x" * 3_000_000,
        }
    )
    with client(hue_store, max_queue_bytes=2 * MIB) as hue:
        span = hue.tracer.start_span("request")
        span.set_attribute("input.value", request)
        span.end()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 1
    ((stored, content_type),) = hue_store.objects.values()
    assert b"synthetic-upload-token" not in stored
    assert b"[redacted]" in stored
    assert content_type == "application/json"
    assert (
        "synthetic-upload-token" not in attrs(hue_store.span("request"))["input.value"].string_value
    )


def test_a_setup_credential_never_uploads_and_a_log_body_is_cut_inline(hue_store):
    with client(hue_store, api_key="hue_setup_synthetic") as setup:
        with setup.span("setup") as span:
            span.set_attribute("custom.document", "x" * (2 * MIB))
        setup.force_flush()
    with client(hue_store) as hue:
        hue._logger.emit(body="y" * (2 * MIB))
        hue.force_flush()
    assert hue_store.reservations == []
    (log,) = hue_store.logs
    assert log.body.string_value == "y" * MIB


def test_a_store_that_never_answers_delays_the_export_by_the_upload_budget_at_most(hue_store):
    hue_store.put = lambda _: "hang"
    hue = client(hue_store, export_timeout_seconds=0.2)
    try:
        with hue.span("hung") as span:
            span.set_attribute("custom.document", "h" * (2 * MIB))
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=10_000)
        # Six request budgets for the uploads, then the span's own request.
        assert time.monotonic() - started < 5
        assert hue.export_status.upload_fallbacks == 1
        assert attrs(hue_store.span("hung"))["custom.document"].string_value == "h" * MIB
    finally:
        started = time.monotonic()
        assert hue.shutdown(timeout_millis=5_000)
        assert time.monotonic() - started < 5
