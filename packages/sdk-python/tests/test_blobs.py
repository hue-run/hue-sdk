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
import tracemalloc
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
        # does. It is called outside the store's lock, so it may block.
        self.reserve: Callable[[int], tuple[int, dict[str, str], bool | bytes] | None] = lambda _: (
            None
        )
        # The store's status for the n-th PUT: 200 stores, "hang" never answers, "expired"
        # answers S3's expired-URL refusal, "trickle" answers 200 a byte at a time, "gate" reads
        # the body and stores it as 200 does once ``gate`` is set.
        self.put: Callable[[int], int | str] = lambda _: 200
        self.hang = Event()
        self.gate = Event()
        # The status of the n-th completion, with headers; ``None`` answers as Hue does.
        self.complete: Callable[[int], int | tuple[int, dict[str, str]] | None] = lambda _: None
        # The answer to the n-th trace request, a status and headers, instead of accepting it;
        # ``None`` accepts it.
        self.traces_reply: Callable[[int], tuple[int, dict[str, str]] | None] = lambda _: None
        self.trace_requests = 0
        # When each span arrived (``time.monotonic()``), by name.
        self.received_at: dict[str, float] = {}
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


def eventually(condition: Callable[[], Any], seconds: float = 10) -> bool:
    """Whether ``condition`` holds within ``seconds``."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)
    return True


def settled(hue: Hue, seconds: float = 10) -> bool:
    """Waits for every upload the client accepted so far, as a flush does after its export."""
    assert hue._uploads is not None
    return hue._uploads.uploader.wait_idle(time.monotonic() + seconds)


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
                if behavior == "gate":
                    store.gate.wait(30)
                    behavior = put["status"] = 200
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
                    reservation = len(store.reservations)
                answer = store.reserve(reservation)
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
                    status = store.complete(len(store.completions))
                if status is not None:
                    status, reply_headers = status if isinstance(status, tuple) else (status, {})
                    self.json(status, {"error": "Synthetic refusal."}, reply_headers)
                elif not stored:
                    self.json(409, {"error": "Not uploaded.", "status": "missing"})
                else:
                    self.json(200, {"status": "complete"})
                return
            if headers.get("content-encoding") == "gzip":
                body = gzip.decompress(body)
            if path.endswith("/traces"):
                with store.lock:
                    store.trace_requests += 1
                    refusal = store.traces_reply(store.trace_requests)
                if refusal is not None:
                    self.reply(refusal[0], b"", refusal[1])
                    return
                traces = ExportTraceServiceRequest.FromString(body)
                arrived = time.monotonic()
                with store.lock:
                    received = [
                        span
                        for resource in traces.resource_spans
                        for scope in resource.scope_spans
                        for span in scope.spans
                    ]
                    store.spans.extend(received)
                    for span in received:
                        store.received_at.setdefault(span.name, arrived)
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
        store.gate.set()
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
            "key": "gen_ai.input.messages#/0/parts/1",
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
        "sha256": sha256(image),
        "size": len(image),
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
    assert len(hue_store.reservations) == 1
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


def not_uploaded(hue: Hue) -> list[int]:
    """The counts of the warnings for uploads that failed after their record was exported."""
    return [
        issue.count
        for issue in hue.export_issues()
        if issue.message.startswith("Content listed in hue.blobs could not be uploaded")
    ]


def test_a_receiver_without_the_upload_route_is_remembered(hue_store):
    hue_store.reserve = lambda _: (404, {}, False)
    text = "n" * (2 * MIB)
    with client(hue_store) as hue:
        # The first value is listed when its record is exported; the receiver answers its
        # reservation without the route afterwards, so its reference is never stored.
        with hue.span("first") as span:
            span.set_attribute("custom.document", text)
        assert hue.force_flush()
        record = hue_store.span("first")
        assert attrs(record)["custom.document"].string_value == "n" * (16 * KIB)
        assert listed(record) == ["custom.document"]
        assert [entry["sha256"] for entry in blobs(record)] == [sha256(text)]
        assert not_uploaded(hue) == [1]
        # Learned: the next value is cut when it is queued, as before uploads existed.
        with hue.span("second") as span:
            span.set_attribute("custom.document", text)
        assert hue.force_flush()
        record = hue_store.span("second")
        assert attrs(record)["custom.document"].string_value == "n" * MIB
        assert listed(record) == ["custom.document"]
        assert "hue.blobs" not in attrs(record)
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1]
    assert len(hue_store.reservations) == 1


def test_hue_s_own_404_is_a_failure_not_a_receiver_without_uploads(hue_store):
    hue_store.reserve = lambda _: (404, {}, True)
    with client(hue_store) as hue:
        for name in ("archived", "again"):
            with hue.span(name) as span:
                span.set_attribute("custom.document", "a" * (2 * MIB))
            assert hue.force_flush()
            record = hue_store.span(name)
            assert attrs(record)["custom.document"].string_value == "a" * (16 * KIB)
            assert len(blobs(record)) == 1
        assert not_uploaded(hue) == [1, 1]
        assert [issue for issue in hue.export_issues() if issue.kind != "warning"] == []
    # A refusal is final for its value alone: it is not retried, nothing pauses, and it is not
    # taken for a receiver without the route, whose values are cut when queued.
    assert len(hue_store.reservations) == 2


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
        # The first is listed when exported and learns the route is missing; the second is cut.
        first, second = hue_store.span("first"), hue_store.span("second")
        assert attrs(first)["custom.document"].string_value == "r" * (16 * KIB)
        assert len(blobs(first)) == 1
        assert attrs(second)["custom.document"].string_value == "r" * MIB
        assert blobs(second) == []
        assert not_uploaded(hue) == [1]
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [1]
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
    assert entry["key"] == "gen_ai.input.messages#/0/parts/1"
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
        assert warnings == [2]
        assert not_uploaded(hue) == [1]
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
        assert warnings == [4]
        assert not_uploaded(hue) == [1]
    assert listed(hue_store.span("long")) == ["gen_ai.input.messages", "gen_ai.output.messages"]


def test_messages_queued_as_the_same_cut_text_report_their_own_files(hue_store):
    hue_store.reserve = lambda _: (404, {}, False)

    def message(images: int) -> str:
        return json.dumps(
            [
                {
                    "role": "user",
                    "parts": [
                        {"type": "text", "content": "u" * (MIB + 200 * KIB)},
                        *(
                            {
                                "type": "blob",
                                "mime_type": "image/png",
                                "content": base64.b64encode(os.urandom(100 * KIB)).decode(),
                            }
                            for _ in range(images)
                        ),
                    ],
                }
            ]
        )

    with client(hue_store) as hue:
        with hue.span("learn") as span:
            span.set_attribute("custom.document", "n" * (2 * MIB))
        assert hue.force_flush()
        with hue.span("shared prefix") as span:
            span.set_attribute("gen_ai.input.messages", message(1))
            span.set_attribute("gen_ai.output.messages", message(2))
        assert hue.force_flush()
        # One file and one cut, then two files and one cut.
        warnings = [
            issue.count
            for issue in hue.export_issues()
            if issue.message.startswith("This Hue server does not accept uploaded")
        ]
        assert warnings == [5]
        assert not_uploaded(hue) == [1]
    values = attrs(hue_store.span("shared prefix"))
    assert values["gen_ai.input.messages"].string_value == (
        values["gen_ai.output.messages"].string_value
    )


def test_the_fallback_for_an_unfinished_placement_reports_each_inline_file_it_digests():
    from hue_sdk._blobs import _fallback

    result = _fallback("gen_ai.input.messages", message_with_image(os.urandom(100 * KIB)), MIB)
    assert '"sha256"' in result.value
    assert result.fallbacks == ["failed"] and not result.listed


def test_a_put_that_trickles_is_cut_off_at_its_own_deadline_once_and_frees_its_worker(hue_store):
    hue_store.put = lambda _: "trickle"
    hue = client(hue_store, export_timeout_seconds=0.5)
    try:
        with hue.span("trickled") as span:
            span.set_attribute("custom.document", "t" * (2 * MIB))
        ended = time.monotonic()
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=20_000)
        # The span went out at once; its PUT ran out of its own deadline (six export timeouts,
        # 3 s) where the store's answer would have taken 100 s, and was not tried again.
        assert hue_store.received_at["trickled"] - ended < 1.5
        assert time.monotonic() - started < 5
        assert len(hue_store.puts) == 1
        assert hue.export_status.upload_fallbacks == 1
        assert hue._uploads.uploader._running == 0
    finally:
        hue.shutdown(timeout_millis=5_000)


def test_a_held_value_is_let_go_once_its_upload_settles_whatever_its_span_request_does(
    hue_store,
):
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
            # The span's request is held unanswered; its upload runs all the same.
            assert hue_store.traces_received.wait(10)
            assert eventually(lambda: hue_store.puts, 10)
            # Stored: neither the queued copy nor its upload holds the whole value any more, and
            # the held-value budget it was charged is free.
            assert eventually(lambda: sys.getrefcount(text) < queued, 10)
            assert sys.getrefcount(text) == queued - 1
            assert eventually(lambda: hue._uploads.held.held == 0, 10)
        finally:
            hue_store.release_traces.set()
            if flushing is not None:
                flushing.join(15)
    assert len(blobs(hue_store.span("released"))) == 1


def test_an_image_in_input_value_is_let_go_once_placed_without_a_collection(hue_store):
    # Admission and export each parse the value, decode its image and edit its text. What they
    # make is freed as soon as they are done with it, by reference counting alone: with the
    # cycle collector off, spans placed one after another peak near one span's copies, rather
    # than adding each span's to the last.
    text = f"data:image/png;base64,{base64.b64encode(os.urandom(384 * KIB)).decode()}"
    image = {"type": "image_url", "image_url": {"url": text}}
    value = {"messages": [{"role": "user", "content": [image]}]}
    spans = 8
    with client(hue_store) as hue:
        with hue.span("warm up") as span:
            span.set_input(value)
        assert hue.force_flush()
        tracing = tracemalloc.is_tracing()
        gc.collect()
        gc.disable()
        try:
            if not tracing:
                tracemalloc.start()
            before = tracemalloc.get_traced_memory()[0]
            tracemalloc.reset_peak()
            for index in range(spans):
                with hue.span(f"image {index}") as span:
                    span.set_input(value)
                del span
                assert hue.force_flush()
                # The store keeps what it is sent; only the SDK's memory is measured.
                with hue_store.lock:
                    hue_store.objects.clear()
            peak = tracemalloc.get_traced_memory()[1] - before
        finally:
            if not tracing:
                tracemalloc.stop()
            gc.enable()
        assert hue.export_status.uploaded_values == spans + 1
    # One span's admission holds its value's text, its JSON and the image decoded; its export
    # holds them again while the image uploads. Left to the collector, each span added about
    # three copies of the text.
    assert peak < 8 * len(text), f"{peak / len(text):.1f} copies of the value's text"
    (entry,) = blobs(hue_store.span(f"image {spans - 1}"))
    assert entry["key"] == "input.value#/messages/0/content/0"


def test_a_rate_limited_reservation_is_retried_after_its_retry_after(hue_store):
    reserved: list[float] = []

    def reserve(index: int) -> Any:
        reserved.append(time.monotonic())
        return (429, {"Retry-After": "1"}, True) if index == 1 else None

    hue_store.reserve = reserve
    with client(hue_store) as hue:
        with hue.span("limited") as span:
            span.set_attribute("custom.document", "l" * (2 * MIB))
        started = time.monotonic()
        assert hue.force_flush()
        assert time.monotonic() - started >= 0.9
        assert hue.export_status.uploaded_values == 1
    assert len(hue_store.reservations) == 2
    assert reserved[1] - reserved[0] >= 0.9
    # The span did not wait for the rate-limited upload.
    assert hue_store.received_at["limited"] < reserved[1]
    assert len(blobs(hue_store.span("limited"))) == 1


def test_a_stored_value_settles_while_its_completion_waits_out_a_retry_after(hue_store):
    from hue_sdk._blobs import UPLOAD_CONCURRENCY

    # Hue's accounting is rate limited: each completion is answered with a 59-second wait, the
    # value's bytes already stored.
    hue_store.complete = lambda _: (429, {"Retry-After": "59"})
    values = [f"{index:x}" * (2 * MIB) for index in range(UPLOAD_CONCURRENCY + 1)]
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        for index, value in enumerate(values[:-1]):
            with hue.span(f"stored {index}") as span:
                span.set_attribute("custom.document", value)
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=10_000)
        # Each upload settled once its bytes were stored and its completion sent once: counted,
        # its bytes and its charge let go.
        assert time.monotonic() - started < 5
        assert hue.export_status.uploaded_values == UPLOAD_CONCURRENCY
        assert uploads.held.held == 0
        assert len(hue_store.completions) == UPLOAD_CONCURRENCY
        # The completions wait out their Retry-After on no upload thread: a later value uploads
        # at once.
        with hue.span("later") as span:
            span.set_attribute("custom.document", values[-1])
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=10_000)
        assert time.monotonic() - started < 5
        assert hue.export_status.uploaded_values == UPLOAD_CONCURRENCY + 1
        assert uploads.held.held == 0
    assert len(hue_store.objects) == len(hue_store.completions) == UPLOAD_CONCURRENCY + 1


def test_a_flush_stops_waiting_once_no_pending_upload_can_be_stored_before_its_deadline(
    hue_store,
):
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    # Every reservation waits out a 59-second Retry-After: no upload is stored within a flush.
    hue_store.reserve = lambda _: (429, {"Retry-After": "59"}, True)
    provider = TracerProvider(shutdown_on_exit=False)
    hue = client(hue_store, tracer_provider=provider)
    budgets: list[int] = []

    class Application(BatchSpanProcessor):
        """The application's own processor, after Hue's on the provider it shares."""

        def force_flush(self, timeout_millis: int = 30_000) -> bool:
            budgets.append(timeout_millis)
            return super().force_flush(timeout_millis)

    other = InMemorySpanExporter()
    provider.add_span_processor(Application(other, schedule_delay_millis=60_000))
    tracer = provider.get_tracer("application")
    try:
        for index in range(3):
            span = tracer.start_span(f"borrowed {index}")
            span.set_attribute("custom.document", str(index) * (2 * MIB))
            span.end()
            started = time.monotonic()
            # Hue's processor sends its record, then reports its uploads pending as soon as each
            # waits out its Retry-After past the deadline, rather than spend the provider's
            # budget, which the processor after it keeps.
            assert not provider.force_flush(2_000)
            assert time.monotonic() - started < 1.5
            assert f"borrowed {index}" in hue_store.received_at
            assert all(budget > 1_000 for budget in budgets)
        # The client's own flush, as soon.
        started = time.monotonic()
        assert not hue.force_flush(timeout_millis=2_000)
        assert time.monotonic() - started < 1.5
        # An upload being sent is still waited for.
        hue_store.reserve = lambda _: None
        hue_store.put = lambda _: "gate"
        span = tracer.start_span("sent")
        span.set_attribute("custom.document", "s" * (2 * MIB))
        span.end()
        started = time.monotonic()
        assert not hue._span_processor.force_flush(1_000)
        assert time.monotonic() - started >= 0.9
    finally:
        hue_store.gate.set()
        hue.shutdown(timeout_millis=5_000)
        provider.shutdown()
    assert len(hue_store.reservations) == 4


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


def test_a_store_that_never_answers_never_delays_the_span(hue_store):
    hue_store.put = lambda _: "hang"
    text = "h" * (2 * MIB)
    hue = client(hue_store, export_timeout_seconds=0.2)
    try:
        with hue.span("hung") as span:
            span.set_attribute("custom.document", text)
        ended = time.monotonic()
        assert hue.force_flush(timeout_millis=10_000)
        # The span went out at once, its value listed; the PUT was tried three times, each
        # unanswered past the request timeout, then counted as not uploaded.
        assert hue_store.received_at["hung"] - ended < 1
        record = hue_store.span("hung")
        assert attrs(record)["custom.document"].string_value == "h" * (16 * KIB)
        assert [entry["sha256"] for entry in blobs(record)] == [sha256(text)]
        assert len(hue_store.puts) == 3
        assert hue.export_status.upload_fallbacks == 1
    finally:
        started = time.monotonic()
        assert hue.shutdown(timeout_millis=5_000)
        assert time.monotonic() - started < 5


def test_a_span_is_sent_while_its_upload_is_stalled(hue_store):
    hue_store.put = lambda _: "gate"
    text = "d" * (2 * MIB)
    image = os.urandom(100 * KIB)
    with client(hue_store) as hue:
        with hue.span("stalled") as span:
            trace_id = span.trace_id
            span.set_attribute("custom.document", text)
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
        flushed: list[bool] = []
        flushing = Thread(
            target=lambda: flushed.append(hue.force_flush(timeout_millis=30_000)), daemon=True
        )
        flushing.start()
        try:
            # While the store holds both PUTs, the span reaches Hue in its final form.
            assert eventually(lambda: "stalled" in hue_store.received_at, 3)
            assert eventually(lambda: hue_store.puts, 3)
            assert hue_store.objects == {}
            assert flushed == []
            record = hue_store.span("stalled")
            values = attrs(record)
            assert values["custom.document"].string_value == "d" * (16 * KIB)
            assert listed(record) == ["custom.document"]
            assert blobs(record) == [
                {
                    "key": "custom.document",
                    "sha256": sha256(text),
                    "size": len(text),
                    "content_type": "text/plain; charset=utf-8",
                },
                {
                    "key": "gen_ai.input.messages#/0/parts/1",
                    "sha256": sha256(image),
                    "size": len(image),
                    "content_type": "image/png",
                },
            ]
            (message,) = json.loads(values["gen_ai.input.messages"].string_value)
            assert message["parts"][1] == {
                "type": "blob",
                "modality": "image",
                "mime_type": "image/png",
                "sha256": sha256(image),
                "size": len(image),
            }
        finally:
            hue_store.gate.set()
        flushing.join(30)
        # The flush waited for both uploads.
        assert flushed == [True]
        assert set(hue_store.objects) == {
            f"{trace_id}/{sha256(text)}",
            f"{trace_id}/{sha256(image)}",
        }
        assert hue.export_status.uploaded_values == 2
        assert hue._uploads.held.held == 0


def test_a_span_ended_after_a_stalled_upload_is_not_held_behind_it(hue_store):
    hue_store.put = lambda _: "gate"
    with client(hue_store) as hue:
        with hue.span("A") as span:
            span.set_attribute("custom.document", "a" * (2 * MIB))
        # A's export ran and its PUT is held at the store.
        assert eventually(lambda: hue_store.puts, 5)
        time.sleep(0.2)
        with hue.span("B"):
            pass
        ended = time.monotonic()
        assert eventually(lambda: "B" in hue_store.received_at, 3)
        assert hue_store.received_at["B"] - ended < 1.5
        assert hue_store.objects == {}
        hue_store.gate.set()
        assert hue.force_flush()


def test_spans_ending_while_an_upload_is_stalled_are_not_dropped(hue_store):
    hue_store.put = lambda _: "gate"
    with client(hue_store, max_queue_size=8) as hue:
        with hue.span("large") as span:
            span.set_attribute("custom.document", "x" * (2 * MIB))
        assert eventually(lambda: hue_store.puts, 5)
        # Spans keep ending while the upload is held: they are exported as usual, never queued
        # behind it until the small queue overflows.
        for index in range(20):
            with hue.span(f"small {index}"):
                pass
            time.sleep(0.2)
        assert eventually(lambda: len(hue_store.spans) == 21, 5)
        assert hue.export_status.dropped_trace_records == 0
        assert hue_store.objects == {}
        hue_store.gate.set()
        assert hue.force_flush()


def test_rate_limited_reservations_never_delay_or_drop_spans(hue_store, monkeypatch):
    import hue_sdk._blobs as blob_module
    from hue_sdk.transport import RATE_LIMITED

    monkeypatch.setattr(blob_module, "SHUTDOWN_UPLOAD_SECONDS", 0)
    # Every reservation is rate limited for 30 s, and the span's first request for 1 s.
    hue_store.reserve = lambda _: (429, {"Retry-After": "30"}, True)
    hue_store.traces_reply = lambda index: (429, {"Retry-After": "1"}) if index == 1 else None
    values = {f"custom.document.{index}": str(index) * (2 * MIB) for index in range(4)}
    hue = client(hue_store, export_timeout_seconds=1)
    with hue.span("limited") as span:
        for key, value in values.items():
            span.set_attribute(key, value)
    ended = time.monotonic()
    assert eventually(lambda: "limited" in hue_store.received_at, 4)
    assert hue_store.received_at["limited"] - ended < 4
    assert len(blobs(hue_store.span("limited"))) == 4
    status = hue.export_status
    assert status.failed_trace_batches == status.dropped_trace_records == 0
    assert all(issue.message != RATE_LIMITED for issue in hue.export_issues())
    # The uploads still wait out their Retry-After: shutdown gives them no grace and abandons
    # them, counted.
    started = time.monotonic()
    hue.shutdown(timeout_millis=2_000)
    assert time.monotonic() - started < 3
    assert hue._shutdown_done.wait(5)
    assert eventually(lambda: hue.export_status.upload_fallbacks == 4, 5)
    assert len(hue_store.reservations) == 4
    assert not_uploaded(hue) and sum(not_uploaded(hue)) == 4
    assert hue.export_status.failed_trace_batches == 0


def test_a_value_whose_upload_fails_keeps_its_reference_and_is_counted(hue_store, monkeypatch):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "_RETRY_DELAY_SECONDS", 0)
    hue_store.put = lambda _: 503
    text = "f" * (2 * MIB)
    image = os.urandom(100 * KIB)
    with client(hue_store) as hue:
        with hue.span("fallback") as span:
            trace_id = span.trace_id
            span.set_attribute("custom.document", text)
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
        # The export succeeds; the record was sent before its uploads failed.
        assert hue.force_flush()
        status = hue.export_status
        assert status.ok and status.uploaded_values == 0 and status.upload_fallbacks == 2
        assert hue.export_failure_sequence() == 0
        warnings = [issue for issue in hue.export_issues() if issue.kind == "warning"]
        assert sum(not_uploaded(hue)) == 2 and len(warnings) == len(not_uploaded(hue))
        assert all(issue.trace_ids == (trace_id,) for issue in warnings)
        assert all("could not be uploaded" in issue.message for issue in warnings)
        # The record keeps what it was exported with: the prefix, its listing and both entries,
        # which Hue reads as missing.
        record = hue_store.span("fallback")
        assert attrs(record)["custom.document"].string_value == "f" * (16 * KIB)
        assert listed(record) == ["custom.document"]
        assert [(entry["key"], entry["sha256"]) for entry in blobs(record)] == [
            ("custom.document", sha256(text)),
            ("gen_ai.input.messages#/0/parts/1", sha256(image)),
        ]
        (message,) = json.loads(attrs(record)["gen_ai.input.messages"].string_value)
        assert message["parts"][1]["sha256"] == sha256(image)
        # Each PUT was tried three times.
        assert len(hue_store.puts) == 6 and len(hue_store.reservations) == 2
        assert hue_store.objects == {}
        # Nothing pauses: a later value is reserved and stored at once.
        hue_store.put = lambda _: 200
        with hue.span("later") as span:
            span.set_attribute("custom.document", "g" * (2 * MIB))
        assert hue.force_flush()
        assert len(hue_store.reservations) == 3
        assert hue.export_status.uploaded_values == 1
        assert hue.export_failure_sequence() == 0


def test_every_entry_point_lists_its_reference_when_the_upload_fails(hue_store):
    from hue_sdk import Attachment

    hue_store.put = lambda _: 400
    text = "v" * (2 * MIB)
    image = os.urandom(10 * KIB)
    pdf = b"%PDF-1.4\n%every entry point\n%%EOF\n"
    csv = b"a,b\n1,2\n"
    with client(hue_store) as hue:
        with hue.span("every entry point") as span:
            span.set_attribute("custom.document", text)
            span.set_attribute("gen_ai.input.messages", message_with_image(image))
            span.set_output({"report": Attachment(pdf, content_type="application/pdf")})
            span.record_file(role="output", media_type="text/csv", data=csv, upload=True)
        assert hue.force_flush()
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (0, 4)
    record = hue_store.span("every entry point")
    assert sorted((entry["key"], entry["sha256"]) for entry in blobs(record)) == sorted(
        [
            ("custom.document", sha256(text)),
            ("gen_ai.input.messages#/0/parts/1", sha256(image)),
            ("output.value#/report", sha256(pdf)),
            (f"event:hue.file:{sha256(csv)}", sha256(csv)),
        ]
    )
    # A 400 is final: one PUT each.
    assert len(hue_store.puts) == 4 and hue_store.objects == {}


def test_a_later_reference_resolves_an_earlier_failed_upload(hue_store):
    hue_store.put = lambda index: 400 if index == 1 else 200
    text = "r" * (2 * MIB)
    with client(hue_store) as hue:
        with hue.span("parent"):
            with hue.span("A") as span:
                trace_id = span.trace_id
                span.set_attribute("tool.output", text)
            assert hue.force_flush()
            assert hue.export_status.upload_fallbacks == 1
            # The failed identity is forgotten: the same bytes later in the trace upload again.
            with hue.span("B") as span:
                span.set_attribute("tool.output", text)
            assert hue.force_flush()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values >= 1
    (entry,) = blobs(hue_store.span("A"))
    assert hue_store.objects[f"{trace_id}/{entry['sha256']}"][0] == text.encode()
    assert len(hue_store.reservations) == 2
    assert [put["status"] for put in hue_store.puts] == [400, 200]


def test_force_flush_waits_for_pending_uploads(hue_store):
    hue_store.put = lambda _: "gate"
    with client(hue_store) as hue:
        with hue.span("pending") as span:
            trace_id = span.trace_id
            span.set_attribute("custom.document", "p" * (2 * MIB))
        flushed: list[bool] = []
        flushing = Thread(target=lambda: flushed.append(hue.force_flush()), daemon=True)
        flushing.start()
        try:
            assert eventually(lambda: "pending" in hue_store.received_at, 3)
            time.sleep(0.5)
            assert flushing.is_alive() and flushed == []
        finally:
            hue_store.gate.set()
        flushing.join(30)
        assert flushed == [True]
        assert hue.export_status.uploaded_values == 1
    assert f"{trace_id}/{sha256('p' * (2 * MIB))}" in hue_store.objects


def test_force_flush_reports_a_timeout_while_an_upload_is_pending(hue_store):
    hue_store.put = lambda _: "gate"
    with client(hue_store) as hue:
        with hue.span("pending") as span:
            span.set_attribute("custom.document", "t" * (2 * MIB))
        try:
            assert not hue.force_flush(timeout_millis=500)
            # A timeout, not a failure.
            assert hue.export_status.ok and hue.export_failure_sequence() == 0
            assert "pending" in hue_store.received_at
        finally:
            hue_store.gate.set()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 1


def test_a_borrowed_provider_s_shutdown_never_waits_for_uploads_and_hue_s_shutdown_does(
    hue_store,
):
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    hue_store.put = lambda _: "gate"
    provider = TracerProvider(shutdown_on_exit=False)
    hue = client(hue_store, tracer_provider=provider)
    # The application's own processor, after Hue's, exports only when it is flushed or shut down.
    other = InMemorySpanExporter()
    provider.add_span_processor(BatchSpanProcessor(other, schedule_delay_millis=60_000))
    try:
        tracer = provider.get_tracer("third-party")
        span = tracer.start_span("borrowed")
        span.set_attribute("custom.document", "b" * (2 * MIB))
        span.end()
        assert not provider.force_flush(500)
        hue_store.gate.set()
        assert provider.force_flush()
        assert len(hue_store.objects) == 1
        hue_store.gate.clear()
        span = tracer.start_span("at shutdown")
        span.set_attribute("custom.document", "c" * (2 * MIB))
        span.end()
        started = time.monotonic()
        provider.shutdown()
        # The provider's shutdown sends Hue's record and never holds the processor after Hue's
        # behind the pending upload.
        assert time.monotonic() - started < 5
        assert "at shutdown" in hue_store.received_at
        assert "at shutdown" in [span.name for span in other.get_finished_spans()]
        assert eventually(lambda: len(hue_store.puts) == 2, 5)
        assert len(hue_store.objects) == 1
        # Hue's own shutdown then gives the pending upload its grace.
        results: list[bool] = []
        stopping = Thread(target=lambda: results.append(hue.shutdown(30_000)), daemon=True)
        stopping.start()
        stopping.join(0.5)
        assert stopping.is_alive()
        hue_store.gate.set()
        stopping.join(10)
        assert results == [True]
        assert len(hue_store.objects) == 2
    finally:
        hue_store.gate.set()
        hue.shutdown(timeout_millis=5_000)


def test_shutdown_gives_pending_uploads_a_bounded_grace_then_counts_them(hue_store, monkeypatch):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "SHUTDOWN_UPLOAD_SECONDS", 0.5)
    # The store never answers the PUT while the client waits.
    hue_store.put = lambda _: "gate"
    hue = client(hue_store, export_timeout_seconds=1)
    with hue.span("abandoned") as span:
        span.set_attribute("custom.document", "z" * (2 * MIB))
    assert eventually(lambda: hue_store.puts, 5)
    started = time.monotonic()
    assert not hue.shutdown(timeout_millis=1_000)
    assert time.monotonic() - started < 1.5
    assert hue._shutdown_done.wait(5)
    uploads = hue._uploads
    assert uploads is not None
    assert eventually(lambda: hue.export_status.upload_fallbacks == 1, 5)
    assert uploads.held.held == 0
    assert eventually(lambda: uploads.uploader._workers == 0, 5)
    assert "abandoned" in hue_store.received_at and hue_store.objects == {}


def test_a_full_upload_queue_keeps_the_fallback_without_waiting(hue_store):
    from hue_sdk._blobs import FALLBACK_MESSAGES

    hue_store.put = lambda _: "gate"
    with client(hue_store) as hue:
        hue._uploads.uploader._queue_limit = 1
        with hue.span("full queue") as span:
            span.set_attribute("custom.first", "1" * (2 * MIB))
            span.set_attribute("custom.second", "2" * (2 * MIB))
        ended = time.monotonic()
        assert eventually(lambda: "full queue" in hue_store.received_at, 3)
        assert hue_store.received_at["full queue"] - ended < 2
        record = hue_store.span("full queue")
        assert attrs(record)["custom.first"].string_value == "1" * (16 * KIB)
        assert attrs(record)["custom.second"].string_value == "2" * MIB
        assert listed(record) == ["custom.first", "custom.second"]
        assert [entry["key"] for entry in blobs(record)] == ["custom.first"]
        assert [
            issue.count
            for issue in hue.export_issues()
            if issue.message == FALLBACK_MESSAGES["budget"]
        ] == [1]
        hue_store.gate.set()
        assert hue.force_flush()
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (1, 1)


def test_a_full_held_budget_cuts_new_values_at_admission_without_waiting(hue_store):
    from hue_sdk._blobs import FALLBACK_MESSAGES

    hue_store.put = lambda _: "gate"
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        uploads.held._limit = 3 * MIB
        with hue.span("held") as span:
            span.set_attribute("custom.document", "1" * (2 * MIB))
        # The first value stays charged while its upload is pending: the second does not fit.
        with hue.span("cut") as span:
            span.set_attribute("custom.document", "2" * (2 * MIB))
        ended = time.monotonic()
        assert eventually(lambda: {"held", "cut"} <= hue_store.received_at.keys(), 3)
        assert max(hue_store.received_at[name] for name in ("held", "cut")) - ended < 2
        held, cut = hue_store.span("held"), hue_store.span("cut")
        assert attrs(held)["custom.document"].string_value == "1" * (16 * KIB)
        assert len(blobs(held)) == 1
        assert attrs(cut)["custom.document"].string_value == "2" * MIB
        assert listed(cut) == ["custom.document"] and blobs(cut) == []
        assert [
            issue.count
            for issue in hue.export_issues()
            if issue.message == FALLBACK_MESSAGES["budget"]
        ] == [1]
        hue_store.gate.set()
        assert hue.force_flush()
        assert uploads.held.held == 0


def test_stalled_uploads_give_way_to_later_values_so_no_later_span_is_dropped(
    hue_store, monkeypatch
):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "SHUTDOWN_UPLOAD_SECONDS", 0)
    # Every reservation is rate limited for 59 s: the four workers wait it out, the rest queue.
    hue_store.reserve = lambda _: (429, {"Retry-After": "59"}, True)
    hue = client(hue_store)
    uploads = hue._uploads
    assert uploads is not None
    size = blob_module.held_size("e" * (2 * MIB))
    # The held-value budget holds the earlier requests' sixteen values exactly.
    uploads.held._limit = 16 * size
    try:
        for index in range(16):
            with hue.span(f"earlier {index}") as span:
                span.set_attribute("custom.document", f"{index:x}" * (2 * MIB))
        assert not hue.force_flush(timeout_millis=200)
        # Every earlier record was placed and sent, its upload queued or waiting out its 429.
        assert eventually(lambda: len(hue_store.spans) == 16, 5)
        assert eventually(lambda: len(hue_store.reservations) == 4, 5)
        assert uploads.held.held == 16 * size
        # A later request ends more spans with values over the cap than the 8 MiB record queue
        # holds cut inline: each is held for upload in place of an earlier queued one.
        with hue.span("later"):
            for index in range(10):
                with hue.span(f"tool {index}") as span:
                    span.set_attribute("custom.document", chr(ord("g") + index) * (2 * MIB))
        assert not hue.force_flush(timeout_millis=2_000)
        assert hue.export_status.dropped_trace_records == 0
        for index in range(10):
            record = hue_store.span(f"tool {index}")
            text = chr(ord("g") + index) * (2 * MIB)
            assert attrs(record)["custom.document"].string_value == text[: 16 * KIB]
            assert [entry["sha256"] for entry in blobs(record)] == [sha256(text)]
        assert "later" in hue_store.received_at
        # The ten earlier uploads given up are counted as not uploaded; their records were
        # exported listing them.
        assert eventually(lambda: sum(not_uploaded(hue)) == 10, 5)
        assert len(blobs(hue_store.span("earlier 15"))) == 1
    finally:
        hue.shutdown(timeout_millis=1_000)


@pytest.mark.parametrize("entry_point", ["record_file", "attachment", "log_inference"])
def test_stalled_uploads_give_way_to_later_files_and_log_values(
    hue_store, monkeypatch, entry_point
):
    import hue_sdk._blobs as blob_module
    from hue_sdk import Attachment

    monkeypatch.setattr(blob_module, "SHUTDOWN_UPLOAD_SECONDS", 0)
    hue_store.reserve = lambda _: (429, {"Retry-After": "59"}, True)
    hue = client(hue_store)
    uploads = hue._uploads
    assert uploads is not None
    size = blob_module.held_size("e" * (2 * MIB))
    uploads.held._limit = 16 * size
    data = os.urandom(64 * KIB)
    try:
        for index in range(16):
            with hue.span(f"earlier {index}") as span:
                span.set_attribute("custom.document", f"{index:x}" * (2 * MIB))
        assert not hue.force_flush(timeout_millis=200)
        # Every earlier record was placed and sent, its upload queued or waiting out its 429.
        assert eventually(lambda: len(hue_store.spans) == 16, 5)
        assert eventually(lambda: len(hue_store.reservations) == 4, 5)
        assert uploads.held.held == 16 * size
        with hue.span("later") as span:
            # A file recorded while the budget is full is held in place of an earlier queued
            # upload, not refused (a refused record_file is an instrumentation failure).
            if entry_point == "record_file":
                span.record_file(role="output", media_type="image/png", data=data, upload=True)
            elif entry_point == "attachment":
                span.set_output({"scan": Attachment(data, content_type="image/png")})
            else:
                span.log_inference(input=[Attachment(data, content_type="image/png")])
            # So is each log record's message over the cap, which would otherwise be cut into
            # the 8 MiB log queue.
            for index in range(10):
                message = [
                    {
                        "role": "user",
                        "parts": [
                            {"type": "text", "content": chr(ord("A") + index) * (5 * MIB // 4)},
                            {
                                "type": "blob",
                                "modality": "image",
                                "mime_type": "image/png",
                                "content": base64.b64encode(os.urandom(KIB)).decode(),
                            },
                        ],
                    }
                ]
                hue._logger.emit(
                    body=f"log {index}", attributes={"gen_ai.input.messages": json.dumps(message)}
                )
        assert not hue.force_flush(timeout_millis=2_000)
        status = hue.export_status
        assert status.dropped_trace_records == status.dropped_log_records == 0
        assert status.instrumentation_failures == 0
        with hue_store.lock:
            logs = list(hue_store.logs)
        emitted = [log for log in logs if log.body.string_value.startswith("log ")]
        assert len(emitted) == 10 and all(len(blobs(log)) == 1 for log in emitted)
        if entry_point == "log_inference":
            (inference,) = [log for log in logs if log not in emitted]
            assert [entry["sha256"] for entry in blobs(inference)] == [sha256(data)]
        else:
            assert [entry["sha256"] for entry in blobs(hue_store.span("later"))] == [sha256(data)]
        assert eventually(lambda: sum(not_uploaded(hue)) > 0, 5)
    finally:
        hue.shutdown(timeout_millis=1_000)


def test_settled_uploads_are_counted_while_another_stays_pending(hue_store):
    hue_store.put = lambda index: "gate" if index == 1 else 200
    with client(hue_store) as hue:
        with hue.span("stalled") as span:
            span.set_attribute("custom.stalled", "s" * (2 * MIB))
        assert eventually(lambda: len(hue_store.puts) == 1, 5)
        with hue.span("stored") as span:
            for index in range(5):
                span.set_attribute(f"custom.stored.{index}", str(index) * (2 * MIB))
        assert eventually(lambda: len(hue_store.objects) == 5, 5)
        # Counted within the report interval, with no flush and no later upload settling.
        assert eventually(lambda: hue.export_status.uploaded_values == 5, 3)
        hue_store.gate.set()


def test_copies_of_one_pending_value_share_its_upload(hue_store):
    hue_store.put = lambda _: "gate"
    text = "s" * (2 * MIB)
    with client(hue_store) as hue:
        with hue.span("parent") as parent:
            parent.set_attribute("tool.output", text)
            with hue.span("child") as child:
                child.set_attribute("tool.output", text)
        assert eventually(lambda: {"parent", "child"} <= hue_store.received_at.keys(), 3)
        for name in ("parent", "child"):
            assert [entry["sha256"] for entry in blobs(hue_store.span(name))] == [sha256(text)]
        # The spans go out before their upload runs: wait for its PUT, held at the store.
        assert eventually(lambda: len(hue_store.puts) == 1, 5)
        assert len(hue_store.reservations) == len(hue_store.puts) == 1
        hue_store.gate.set()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 2
    assert len(hue_store.reservations) == len(hue_store.puts) == 1


def test_uploads_use_at_most_four_workers(hue_store):
    hue_store.put = lambda _: "gate"
    images = [os.urandom(KIB) for _ in range(12)]
    messages = json.dumps(
        [
            {
                "role": "user",
                "parts": [
                    {
                        "type": "blob",
                        "mime_type": "image/png",
                        "content": base64.b64encode(image).decode(),
                    }
                    for image in images
                ],
            }
        ]
    )
    hue = client(hue_store)
    uploads = hue._uploads
    assert uploads is not None
    uploader = uploads.uploader
    try:
        with hue.span("twelve") as span:
            span.set_attribute("gen_ai.input.messages", messages)
        assert eventually(lambda: len(hue_store.puts) == 4, 5)
        time.sleep(0.2)
        # Four PUTs are held at the store; the other eight wait in the queue, no thread each.
        assert uploader._workers == uploader._running == 4
        assert len(uploader._queue) == 8 and len(hue_store.puts) == 4
    finally:
        hue_store.gate.set()
        assert hue.shutdown(timeout_millis=10_000)
    assert eventually(lambda: uploader._workers == 0, 5)
    assert len(hue_store.objects) == 12


def test_upload_counters_are_current_when_flush_returns(hue_store):
    with client(hue_store) as hue:
        for index in range(20):
            with hue.span(f"image {index}") as span:
                span.set_attribute("gen_ai.input.messages", message_with_image(os.urandom(64)))
            assert hue.force_flush()
            assert hue.export_status.uploaded_values == index + 1


def test_a_failed_upload_never_pauses_staging_or_the_next_upload(hue_store, monkeypatch):
    import hue_sdk._blobs as blob_module
    from hue_sdk import Attachment

    monkeypatch.setattr(blob_module, "_RETRY_DELAY_SECONDS", 0)
    hue_store.put = lambda index: 503 if index <= 3 else 200
    png = os.urandom(2 * KIB)
    with client(hue_store) as hue:
        with hue.span("failed") as span:
            span.set_attribute("custom.document", "f" * (2 * MIB))
        assert hue.force_flush()
        assert hue.export_status.upload_fallbacks == 1
        # Recorded at once after the failure: staged, listed and uploaded.
        with hue.span("attached") as span:
            trace_id = span.trace_id
            span.set_input({"scan": Attachment(png, content_type="image/png")})
        assert hue.force_flush()
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (1, 1)
    (entry,) = blobs(hue_store.span("attached"))
    assert entry["key"] == "input.value#/scan"
    assert hue_store.objects[f"{trace_id}/{sha256(png)}"] == (png, "image/png")


def test_the_route_is_learned_in_the_background(hue_store):
    from hue_sdk._blobs import FALLBACK_MESSAGES

    hue_store.reserve = lambda _: (404, {}, False)
    text = "l" * (2 * MIB)
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        with hue.span("before") as span:
            span.set_attribute("tool.output", text)
        assert hue.force_flush()
        # Listed when exported; its reservation then found no route.
        before = hue_store.span("before")
        assert attrs(before)["tool.output"].string_value == "l" * (16 * KIB)
        assert [entry["sha256"] for entry in blobs(before)] == [sha256(text)]
        assert not_uploaded(hue) == [1]
        assert not uploads.holds()
        with hue.span("after") as span:
            span.set_attribute("tool.output", text)
        assert hue.force_flush()
        after = hue_store.span("after")
        assert attrs(after)["tool.output"].string_value == "l" * MIB and blobs(after) == []
        assert [
            issue.count
            for issue in hue.export_issues()
            if issue.message == FALLBACK_MESSAGES["unsupported"]
        ] == [1]
        assert hue.export_status.upload_fallbacks == 2
    assert len(hue_store.reservations) == 1 and hue_store.puts == []


@pytest.mark.parametrize("held", ["put", "reservation"])
def test_a_later_flush_sends_its_own_records_while_an_earlier_one_waits_for_an_upload(
    hue_store, monkeypatch, held
):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "SHUTDOWN_UPLOAD_SECONDS", 0)
    if held == "put":
        # The store never answers the PUT while the test runs.
        hue_store.put = lambda _: "gate"
    else:
        # The reservation is refused for now and asked again in 20 s.
        hue_store.reserve = lambda index: (503, {"Retry-After": "20"}, True) if index == 1 else None
    hue = client(hue_store)
    try:
        with hue.span("earlier") as span:
            span.set_attribute("custom.document", "e" * (2 * MIB))
        earlier: list[bool] = []
        waiting = Thread(
            target=lambda: earlier.append(hue.force_flush(timeout_millis=30_000)), daemon=True
        )
        waiting.start()
        assert eventually(lambda: "earlier" in hue_store.received_at, 3)
        assert eventually(lambda: hue_store.puts if held == "put" else hue_store.reservations, 3)
        time.sleep(0.3)
        # The earlier flush is waiting for its upload.
        assert waiting.is_alive() and earlier == []
        # A later request's span and log record are recorded after the upload started; its own
        # flush puts them on the wire at once, before it returns, whatever the earlier one waits
        # for.
        with hue.span("later") as span:
            span.log_inference(output=None)
        started = time.monotonic()
        later = hue.force_flush_safe(timeout_millis=1_000)
        returned = time.monotonic()
        assert "later" in hue_store.received_at
        assert hue_store.received_at["later"] - started < 0.5
        with hue_store.lock:
            assert len(hue_store.logs) == 1
        # The earlier upload is still pending: the later flush reports a timeout, not a
        # failure, at its own deadline.
        assert not later and returned - started < 1.5
        assert hue.export_status.ok and hue.export_failure_sequence() == 0
        assert waiting.is_alive() and earlier == []
        assert hue_store.objects == {}
    finally:
        hue_store.gate.set()
        hue.shutdown(timeout_millis=5_000)
        assert hue._shutdown_done.wait(5)


def test_a_value_is_charged_once_from_its_upload_s_acceptance_to_its_end(hue_store):
    hue_store.put = lambda _: "gate"
    # The span's request is held unanswered: its export has not ended.
    hue_store.release_traces.clear()
    first, second = "1" * (2 * MIB), "2" * (2 * MIB)
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        # Room for both values charged once each, not for one charged twice.
        uploads.held._limit = sys.getsizeof(first) + sys.getsizeof(second)
        try:
            with hue.span("first") as span:
                span.set_attribute("custom.document", first)
            assert hue_store.traces_received.wait(5)
            assert eventually(lambda: hue_store.puts, 5)
            # Accepted, uploading and its record still being sent: charged once.
            assert uploads.held.held == sys.getsizeof(first)
            with hue.span("second") as span:
                span.set_attribute("custom.document", second)
            # Admitted whole beside it.
            assert uploads.held.held == sys.getsizeof(first) + sys.getsizeof(second)
            hue_store.release_traces.set()
            assert eventually(lambda: len(hue_store.puts) == 2, 5)
            assert uploads.held.held == sys.getsizeof(first) + sys.getsizeof(second)
        finally:
            hue_store.release_traces.set()
            hue_store.gate.set()
        assert hue.force_flush()
        assert uploads.held.held == 0
        assert hue.export_status.uploaded_values == 2
    for name in ("first", "second"):
        assert len(blobs(hue_store.span(name))) == 1


def test_a_receiver_without_the_upload_route_is_remembered_for_the_client_s_life(
    hue_store, monkeypatch
):
    import hue_sdk._blobs as blob_module

    hue_store.reserve = lambda _: (404, {}, False)
    text = "k" * (2 * MIB)
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        with hue.span("learns") as span:
            span.set_attribute("custom.document", text)
        assert hue.force_flush()
        # Only the record exported before its first answer lists a value it never stores.
        assert len(blobs(hue_store.span("learns"))) == 1
        assert not_uploaded(hue) == [1]
        # An hour on, the receiver is still known to lack the route: it is not asked again, and
        # no value is listed for an upload it would never store; each is cut when it is queued.
        later = time.monotonic() + 3600
        monkeypatch.setattr(blob_module, "monotonic", lambda: later)
        assert not uploads.holds() and uploads.uploader.refusal() == "unsupported"
        monkeypatch.setattr(blob_module, "monotonic", time.monotonic)
        for name in ("an hour on", "still"):
            with hue.span(name) as span:
                span.set_attribute("custom.document", text)
            assert hue.force_flush()
            record = hue_store.span(name)
            assert attrs(record)["custom.document"].string_value == "k" * MIB
            assert blobs(record) == []
        assert hue.export_status.uploaded_values == 0
    assert len(hue_store.reservations) == 1 and hue_store.puts == []
