from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from hue_sdk._inline_files import content_path, media_bytes
from hue_sdk.evals import (
    CaseFileWrite,
    EvaluationClient,
    LocalFile,
    MediaFetchError,
    MediaFile,
    rehydrate_media,
)

KEY = "synthetic-media-key"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SPAN_ID = "00f067aa0ba902b7"
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4])
WAV = b"RIFF....WAVEfmt synthetic"
PDF = b"%PDF-1.7 synthetic"
LOST = b"never uploaded"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@dataclass(frozen=True)
class Broken:
    """An answer whose connection closes after ``sent``, before the body it announced."""

    sent: bytes


@dataclass
class Hue:
    """A synthetic Hue answering the media routes, with a storage route beside it."""

    url: str = ""
    answers: dict[str, dict[str, Any]] = field(default_factory=dict)
    seen: list[dict[str, Any]] = field(default_factory=list)
    artifacts: dict[str, dict[str, Any]] = field(default_factory=dict)
    reservations: dict[str, str] = field(default_factory=dict)
    cases: list[dict[str, Any]] = field(default_factory=list)
    puts: int = 0
    release: Event = field(default_factory=Event)
    lock: Lock = field(default_factory=Lock)

    def client(self, **options: Any) -> EvaluationClient:
        return EvaluationClient(self.url, KEY, **options)


@pytest.fixture
def hue():
    state = Hue()

    def view(stored: dict[str, Any]) -> dict[str, Any]:
        ready = stored["state"] == "ready"
        return {
            "id": stored["id"],
            "filename": stored["filename"],
            "declaredContentType": stored["contentType"],
            "declaredBytes": stored["byteSize"],
            "declaredSha256": stored["sha256"],
            "state": stored["state"],
            "copyState": stored["copyState"],
            "verifiedBytes": stored["byteSize"] if ready else None,
            "verifiedSha256": stored["sha256"] if ready else None,
            "failureCode": None,
        }

    def media(path: str, query: str) -> tuple[int, Any, dict[str, str]]:
        route = re.fullmatch(
            r"/api/v1/(?:traces/[0-9a-f-]+|trace-snapshots/([0-9a-f-]+))/blobs/([0-9a-f]{64})",
            path,
        )
        if route is None:
            return 404, {"error": "Not found"}, {}
        snapshot, digest = route.group(1) is not None, route.group(2)
        answer = state.answers.get(digest)
        if answer is None:
            return 404, {"error": "Not found"}, {}
        if answer["kind"] == "unavailable":
            if answer["times"] > 0:
                answer["times"] -= 1
                headers = (
                    {}
                    if answer.get("retry_after") is None
                    else {"Retry-After": answer["retry_after"]}
                )
                return 503, {"error": "Unavailable", "state": "unavailable"}, headers
            answer = state.answers[digest] = answer["then"]
        if answer["kind"] == "broken":
            if answer["times"] > 0:
                answer["times"] -= 1
                return 200, Broken(b'{"sha256":"'), {}
            answer = state.answers[digest] = answer.get("then", {"kind": "missing"})
        if answer["kind"] == "hang":
            state.release.wait(5)
            return 500, {}, {}
        if answer["kind"] == "missing":
            return 404, {"error": "Never uploaded", "state": "missing"}, {}
        if answer["kind"] == "forbidden":
            return 403, {"error": "Use a Read or Read and write key"}, {}
        data = answer["data"]
        return (
            200,
            {
                "sha256": digest,
                "size": len(data),
                **(
                    {}
                    if snapshot
                    else {"contentType": answer["content_type"], "fileName": answer["file_name"]}
                ),
                "url": f"{state.url}/storage/{digest}",
                "method": "GET",
                "expiresAt": "2026-10-12T00:05:00Z",
            },
            {},
        )

    def dispatch(method: str, path: str, query: str, raw: bytes) -> tuple[int, Any, dict[str, str]]:
        stored = re.fullmatch(r"/storage/([0-9a-f]{64})", path)
        if stored:
            answer = state.answers.get(stored.group(1)) or {}
            if answer.get("kind") != "stored":
                return 404, b"", {}
            return 200, answer.get("served", answer["data"]), {}
        blob = re.fullmatch(r"/blob/([0-9a-f-]+)", path)
        if blob and method == "PUT":
            state.artifacts[blob.group(1)]["bytes"] = raw
            state.puts += 1
            return 200, b"", {}
        body = json.loads(raw) if raw else {}
        if path == "/api/v1/artifacts" and method == "POST":
            identifier = state.reservations.get(body["idempotencyKey"])
            # As Hue does, a key already naming an artifact with other declarations is refused.
            named = state.artifacts.get(identifier) if identifier is not None else None
            if named is not None and any(
                named[key] != body[key] for key in ("filename", "contentType", "sha256")
            ):
                return 409, {"error": "Idempotency key already identifies a different artifact"}, {}
            if identifier is None:
                identifier = state.reservations[body["idempotencyKey"]] = str(uuid4())
                state.artifacts[identifier] = {
                    "id": identifier,
                    **{key: body[key] for key in ("filename", "contentType", "byteSize", "sha256")},
                    "state": "reserved",
                    "copyState": "none",
                }
            return 201, view(state.artifacts[identifier]), {}
        action = re.fullmatch(r"/api/v1/artifacts/([0-9a-f-]+)/(upload|complete)", path)
        if action:
            stored_artifact = state.artifacts[action.group(1)]
            if action.group(2) == "upload":
                stored_artifact["copyState"] = "started"
                return (
                    200,
                    {
                        "uploadUrl": f"{state.url}/blob/{stored_artifact['id']}",
                        "method": "PUT",
                        "headers": {"content-type": stored_artifact["contentType"]},
                        "expiresAt": "2026-10-12T00:05:00Z",
                    },
                    {},
                )
            if sha(stored_artifact.get("bytes", b"")) != stored_artifact["sha256"]:
                return 409, {"error": "mismatch"}, {}
            stored_artifact["state"], stored_artifact["copyState"] = "ready", "acknowledged"
            return 200, view(stored_artifact), {}
        # As Hue does, a version ID is read in either case.
        if re.fullmatch(r"/api/v1/dataset-versions/[0-9a-fA-F-]+/cases", path):
            state.cases.append(body)
            return 200, {"item": {"id": str(uuid4()), **body}, "version": {"revision": 2}}, {}
        return media(path, query)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond("GET")

        def do_POST(self):
            self.respond("POST")

        def do_PUT(self):
            self.respond("PUT")

        def respond(self, method: str) -> None:
            parts = urlsplit(self.path)
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with state.lock:
                state.seen.append(
                    {
                        "method": method,
                        "path": parts.path,
                        "span_id": parse_qs(parts.query).get("spanId", [None])[0],
                        "authorization": self.headers.get("Authorization"),
                    }
                )
            status, value, headers = dispatch(method, parts.path, parts.query, raw)
            if isinstance(value, Broken):
                # The headers promise more than is sent; the connection then closes mid-body.
                self.close_connection = True
                self.send_response(status)
                self.send_header("Content-Length", str(len(value.sent) + 64))
                self.end_headers()
                self.wfile.write(value.sent)
                return
            payload = value if isinstance(value, bytes) else json.dumps(value).encode()
            try:
                self.send_response(status)
                for name, header in headers.items():
                    self.send_header(name, header)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except OSError:
                pass

        def log_message(self, *_args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        thread.join(5)


def stored(data: bytes, content_type: str, file_name: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "stored",
        "data": data,
        "content_type": content_type,
        "file_name": file_name,
        **extra,
    }


def failure(call: Any) -> MediaFetchError:
    with pytest.raises(MediaFetchError) as raised:
        call()
    return raised.value


def test_fetch_downloads_a_trace_file_names_the_span_and_never_sends_the_key_to_storage(hue):
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png")
    file = hue.client().media.fetch(trace_id=TRACE_ID, span_id=SPAN_ID, sha256=sha(PNG))
    assert file == MediaFile(PNG, sha(PNG), len(PNG), "image/png", "chart.png")
    assert hue.seen == [
        {
            "method": "GET",
            "path": f"/api/v1/traces/{TRACE_ID}/blobs/{sha(PNG)}",
            "span_id": SPAN_ID,
            "authorization": f"Bearer {KEY}",
        },
        {"method": "GET", "path": f"/storage/{sha(PNG)}", "span_id": None, "authorization": None},
    ]


def test_fetch_refuses_bytes_whose_sha256_is_not_the_requested_digest(hue):
    tampered = PNG[:-1] + b"\x09"
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png", served=tampered)
    hue.answers[sha(PDF)] = stored(PDF, "application/pdf", "r.pdf", served=PDF + b"\x00")
    client = hue.client()
    assert failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG))).reason == (
        "digest_mismatch"
    )
    assert failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF))).reason == (
        "digest_mismatch"
    )


def test_fetch_tells_a_file_never_uploaded_from_one_hue_does_not_hold(hue):
    hue.answers[sha(LOST)] = {"kind": "missing"}
    client = hue.client()
    missing = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(LOST)))
    assert (missing.reason, missing.status) == ("missing", 404)
    unknown = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF)))
    assert (unknown.reason, unknown.status) == ("not_found", 404)
    # A miss is final: no retry and no storage request.
    assert len(hue.seen) == 2


def test_fetch_asks_once_more_after_an_unavailable_answer_waiting_its_retry_after(hue):
    hue.answers[sha(PNG)] = {
        "kind": "unavailable",
        "times": 1,
        "retry_after": "1",
        "then": stored(PNG, "image/png", "chart.png"),
    }
    hue.answers[sha(PDF)] = {"kind": "unavailable", "times": 5, "retry_after": "0"}
    hue.answers[sha(WAV)] = {"kind": "unavailable", "times": 5, "retry_after": "60"}
    client = hue.client()
    started = time.monotonic()
    assert client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)).data == PNG
    assert time.monotonic() - started >= 0.95
    assert sum(sha(PNG) in item["path"] for item in hue.seen) == 3

    still = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF)))
    assert (still.reason, still.status, still.retry_after_seconds) == ("unavailable", 503, 0)
    assert sum(sha(PDF) in item["path"] for item in hue.seen) == 2

    # A longer wait than the client holds is the caller's to schedule.
    later = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(WAV)))
    assert (later.reason, later.retry_after_seconds) == ("unavailable", 60)
    assert sum(sha(WAV) in item["path"] for item in hue.seen) == 1


def test_a_connection_lost_while_the_grant_is_read_is_asked_once_more_then_fails(hue):
    hue.answers.update(
        {
            sha(PNG): {"kind": "broken", "times": 1, "then": stored(PNG, "image/png", "c.png")},
            sha(PDF): {"kind": "broken", "times": 5},
        }
    )
    client = hue.client()
    assert client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)).data == PNG
    assert len([item for item in hue.seen if item["path"].startswith("/api/v1/")]) == 2
    with pytest.raises(MediaFetchError) as lost:
        client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF))
    assert lost.value.reason == "failed"
    assert len([item for item in hue.seen if sha(PDF) in item["path"]]) == 2


def test_a_key_without_content_access_is_forbidden_and_not_asked_again(hue):
    hue.answers[sha(PNG)] = {"kind": "forbidden"}
    refused = failure(lambda: hue.client().media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert (refused.reason, refused.status) == ("forbidden", 403)
    assert len(hue.seen) == 1


def test_a_request_that_never_answers_times_out_once_more_then_fails(hue):
    hue.answers[sha(PNG)] = {"kind": "hang"}
    client = hue.client(timeout_seconds=0.2)
    timed_out = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert (timed_out.reason, timed_out.status) == ("failed", None)
    assert len(hue.seen) == 2


def test_a_file_over_max_bytes_is_refused_before_any_byte_is_downloaded(hue):
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png")
    client = hue.client()
    large = failure(
        lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG), max_bytes=len(PNG) - 1)
    )
    assert large.reason == "too_large"
    assert [item["path"] for item in hue.seen] == [f"/api/v1/traces/{TRACE_ID}/blobs/{sha(PNG)}"]


def test_fetch_reads_a_snapshots_pinned_copy_which_carries_no_type_or_name(hue):
    snapshot_id = str(uuid4())
    hue.answers[sha(PDF)] = stored(PDF, "application/pdf", "r.pdf")
    file = hue.client().media.fetch(snapshot_id=snapshot_id, sha256=sha(PDF))
    assert file == MediaFile(PDF, sha(PDF), len(PDF))
    assert hue.seen[0]["path"] == f"/api/v1/trace-snapshots/{snapshot_id}/blobs/{sha(PDF)}"


@pytest.mark.parametrize(
    "target",
    [
        {"trace_id": TRACE_ID, "sha256": "abc"},
        {"trace_id": "0" * 32, "sha256": sha(PNG)},
        {"trace_id": TRACE_ID, "span_id": "xyz", "sha256": sha(PNG)},
        {"snapshot_id": "not-a-uuid", "sha256": sha(PNG)},
    ],
)
def test_invalid_identifiers_are_refused_before_any_request(hue, target):
    with pytest.raises(ValueError):
        hue.client().media.fetch(**target)
    assert hue.seen == []


def recorded() -> list[dict[str, Any]]:
    """Recorded messages in digest form, as the SDK exports a span's large media."""
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Compare the chart, the recording and the report."},
                {
                    "type": "image_url",
                    "image_url": {"detail": "low"},
                    "sha256": sha(PNG),
                    "size": len(PNG),
                },
                {
                    "type": "input_audio",
                    "input_audio": {"format": "wav"},
                    "sha256": sha(WAV),
                    "size": len(WAV),
                },
                {
                    "type": "file",
                    "file": {"filename": "r.pdf"},
                    "sha256": sha(PDF),
                    "size": len(PDF),
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png"},
                    "sha256": sha(PNG),
                    "size": len(PNG),
                }
            ],
        },
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "blob",
                    "modality": "image",
                    "mime_type": "image/png",
                    "sha256": sha(LOST),
                    "size": len(LOST),
                }
            ],
        },
        {
            "role": "assistant",
            "content": None,
            "audio": {"id": "audio_1", "transcript": "Here is the summary."},
            "sha256": sha(WAV),
            "size": len(WAV),
        },
    ]


def test_resolve_writes_each_parts_bytes_back_in_its_own_field_and_reports_the_rest(hue):
    hue.answers.update(
        {
            sha(PNG): stored(PNG, "image/png", "chart.png"),
            sha(WAV): stored(WAV, "audio/wav", "reply.wav"),
            sha(PDF): stored(PDF, "application/pdf", "r.pdf"),
            sha(LOST): {"kind": "missing"},
        }
    )
    value = recorded()
    before = copy.deepcopy(value)
    resolved = hue.client().media.resolve(value, trace_id=TRACE_ID, span_id=SPAN_ID)
    assert value == before
    assert resolved.resolved == 5
    assert [(f.pointer, f.sha256, f.reason) for f in resolved.failures] == [
        ("/2/parts/0", sha(LOST), "missing")
    ]
    assert resolved.value == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Compare the chart, the recording and the report."},
                {
                    "type": "image_url",
                    "image_url": {"detail": "low", "url": f"data:image/png;base64,{b64(PNG)}"},
                },
                {"type": "input_audio", "input_audio": {"format": "wav", "data": b64(WAV)}},
                {
                    "type": "file",
                    "file": {
                        "filename": "r.pdf",
                        "file_data": f"data:application/pdf;base64,{b64(PDF)}",
                    },
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": b64(PNG)},
                }
            ],
        },
        before[2],
        {
            "role": "assistant",
            "content": None,
            "audio": {"id": "audio_1", "transcript": "Here is the summary.", "data": b64(WAV)},
        },
    ]
    # Each distinct digest is read once, with the span named.
    reads = [item for item in hue.seen if item["path"].startswith("/api/v1/")]
    assert sorted(item["path"].rsplit("/", 1)[1] for item in reads) == sorted(
        [sha(PNG), sha(WAV), sha(PDF), sha(LOST)]
    )
    assert all(item["span_id"] == SPAN_ID for item in reads)


def test_resolve_as_bytes_writes_the_bytes_themselves(hue):
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png")
    parts = [{"type": "image", "sha256": sha(PNG), "size": len(PNG), "mediaType": "image/png"}]
    resolved = hue.client().media.resolve(parts, trace_id=TRACE_ID, as_="bytes")
    assert resolved.value == [{"type": "image", "mediaType": "image/png", "image": PNG}]


def test_rehydrate_media_writes_a_cases_local_files_back_into_its_inputs(tmp_path):
    path = tmp_path / "1-chart.png"
    path.write_bytes(PNG)
    chart = LocalFile(str(uuid4()), "source", "chart.png", "image/png", len(PNG), sha(PNG), path)

    @dataclass(frozen=True)
    class InMemory:
        sha256: str
        content_type: str
        data: bytes

    inputs = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe it."},
                    {"type": "image_url", "image_url": {}, "sha256": sha(PNG), "size": len(PNG)},
                    {
                        "type": "input_file",
                        "filename": "r.pdf",
                        "sha256": sha(PDF),
                        "size": len(PDF),
                    },
                    {
                        "type": "blob",
                        "mime_type": "audio/wav",
                        "sha256": sha(WAV),
                        "size": len(WAV),
                    },
                    {"type": "input_image", "sha256": sha(LOST), "size": len(LOST)},
                ],
            }
        ]
    }
    before = copy.deepcopy(inputs)
    resolved = rehydrate_media(
        inputs,
        [
            chart,
            InMemory(sha(PDF), "application/pdf", PDF),
            # A file that does not hash to its digest is never written.
            InMemory(sha(WAV), "audio/wav", LOST),
        ],
    )
    assert inputs == before
    assert resolved.resolved == 2
    assert [(f.pointer, f.reason) for f in resolved.failures] == [
        ("/messages/0/content/3", "digest_mismatch"),
        ("/messages/0/content/4", "not_found"),
    ]
    content = resolved.value["messages"][0]["content"]
    assert content[1] == {
        "type": "image_url",
        "image_url": {"url": f"data:image/png;base64,{b64(PNG)}"},
    }
    assert content[2] == {
        "type": "input_file",
        "filename": "r.pdf",
        "file_data": f"data:application/pdf;base64,{b64(PDF)}",
    }
    assert content[3] == before["messages"][0]["content"][3]


HELLO = b"hello"
LATIN1 = bytes([0x63, 0x61, 0x66, 0xE9])
LOOKS_LIKE_URL = b"data:,not a url"
MARKDOWN = "\ufeff# Notes\n".encode()


@dataclass(frozen=True)
class _Bytes:
    sha256: str
    content_type: str
    data: bytes


TEXT_FILES = [
    _Bytes(sha(HELLO), "text/plain", HELLO),
    _Bytes(sha(LATIN1), "text/csv", LATIN1),
    _Bytes(sha(LOOKS_LIKE_URL), "text/plain", LOOKS_LIKE_URL),
    _Bytes(sha(MARKDOWN), "text/markdown", MARKDOWN),
    _Bytes(sha(PDF), "application/pdf", PDF),
]


def text_parts() -> list[dict[str, Any]]:
    def blob(data: bytes, mime: str, kind: str = "blob") -> dict[str, Any]:
        return {"type": kind, "mime_type": mime, "sha256": sha(data), "size": len(data)}

    return [
        blob(HELLO, "text/plain"),
        blob(LATIN1, "text/csv"),
        blob(LOOKS_LIKE_URL, "text/plain"),
        blob(MARKDOWN, "text/markdown", "media"),
        blob(PDF, "application/pdf"),
    ]


def assert_written_back(value: list[dict[str, Any]]) -> None:
    # Text is written as its UTF-8, a byte order mark included; bytes that are no UTF-8, or text
    # that would read as a data: URL, as a typed data: URL; binary media as base64.
    assert [part.get("content", part.get("data")) for part in value] == [
        "hello",
        f"data:text/csv;base64,{b64(LATIN1)}",
        f"data:text/plain;base64,{b64(LOOKS_LIKE_URL)}",
        "\ufeff# Notes\n",
        b64(PDF),
    ]
    # Recorded again, every part reads as the same bytes.
    for part, file in zip(value, TEXT_FILES, strict=True):
        assert sha(media_bytes(content_path(part)).data) == file.sha256


def test_rehydrate_media_writes_textual_blobs_as_the_text_hue_reads_them_as():
    resolved = rehydrate_media(text_parts(), TEXT_FILES)
    assert resolved.resolved == 5
    assert_written_back(resolved.value)


def test_resolve_writes_textual_blobs_as_the_text_hue_reads_them_as(hue):
    hue.answers.update(
        {file.sha256: stored(file.data, file.content_type, "file") for file in TEXT_FILES}
    )
    resolved = hue.client().media.resolve(text_parts(), trace_id=TRACE_ID)
    assert resolved.resolved == 5
    assert_written_back(resolved.value)


CSV = b"question,answer\nsynthetic,yes\n"


def test_add_case_uploads_files_given_as_data_or_a_path_and_pins_every_file(hue, tmp_path):
    path = tmp_path / "answers.csv"
    path.write_bytes(CSV)
    existing, version_id = str(uuid4()), str(uuid4())
    files = [
        CaseFileWrite(role="source", filename="chart.png", content_type="image/png", data=PNG),
        {"artifactId": existing, "role": "attached_reference"},
        CaseFileWrite(
            role="evaluator_reference", filename="answers.csv", content_type="text/csv", path=path
        ),
    ]
    client = hue.client()

    def write() -> dict[str, Any]:
        return client.add_case(
            version_id,
            expected_revision=1,
            external_key="chart-question",
            inputs={"question": "What does the chart show?"},
            files=files,
        )

    write()
    uploaded = list(hue.artifacts.values())
    assert [(a["filename"], a["contentType"], a["byteSize"], a["sha256"]) for a in uploaded] == [
        ("chart.png", "image/png", len(PNG), sha(PNG)),
        ("answers.csv", "text/csv", len(CSV), sha(CSV)),
    ]
    assert [a["bytes"] for a in uploaded] == [PNG, CSV]
    assert hue.cases[0] == {
        "expectedRevision": 1,
        "externalKey": "chart-question",
        "inputs": {"question": "What does the chart show?"},
        "files": [
            {"artifactId": uploaded[0]["id"], "role": "source"},
            {"artifactId": existing, "role": "attached_reference"},
            {"artifactId": uploaded[1]["id"], "role": "evaluator_reference"},
        ],
    }
    # The same case sent again settles on the same verified artifacts without uploading again.
    write()
    assert hue.puts == 2 and len(hue.artifacts) == 2
    assert hue.cases[1] == hue.cases[0]


def test_add_case_with_a_corrected_content_type_reserves_a_new_artifact_for_it(hue):
    client = hue.client()
    version_id = str(uuid4())

    def write(content_type: str) -> None:
        client.add_case(
            version_id,
            expected_revision=1,
            external_key="answers",
            inputs={},
            files=[
                CaseFileWrite(
                    role="evaluator_reference",
                    filename="answers.csv",
                    content_type=content_type,
                    data=CSV,
                )
            ],
        )

    write("text/plain")
    write("text/csv")
    assert len(hue.reservations) == 2
    assert all(len(key) <= 200 for key in hue.reservations)
    assert [(a["contentType"], a["state"]) for a in hue.artifacts.values()] == [
        ("text/plain", "ready"),
        ("text/csv", "ready"),
    ]
    pinned = hue.cases[1]["files"][0]["artifactId"]
    assert hue.artifacts[pinned]["contentType"] == "text/csv"


@pytest.mark.parametrize(
    "files",
    [
        [CaseFileWrite(role="source", filename="a.svg", content_type="image/svg+xml", data=b"1")],
        [CaseFileWrite(role="source", filename="a.pcm", content_type="audio/pcm", data=b"1")],
        [CaseFileWrite(role="source", filename="../a.png", content_type="image/png", data=b"1")],
        [CaseFileWrite(role="source", filename="a\n.png", content_type="image/png", data=b"1")],
        [CaseFileWrite(role="output", filename="a.png", content_type="image/png", data=b"1")],  # type: ignore[arg-type]
        [CaseFileWrite(role="source", filename="a.png", content_type="image/png", data=b"")],
        [
            CaseFileWrite(
                role="source",
                filename="a.png",
                content_type="image/png",
                data=bytes(25 * 1024 * 1024 + 1),
            )
        ],
        [
            CaseFileWrite(
                role="source",
                filename="a.png",
                content_type="image/png",
                data=b"1",
                artifact_id=str(uuid4()),
            )
        ],
        [CaseFileWrite(role="source", filename="a.png", content_type="image/png", data=b"1")] * 2,
        [
            CaseFileWrite(
                role="source", filename=f"{index}.png", content_type="image/png", data=b"1"
            )
            for index in range(33)
        ],
    ],
)
def test_add_case_refuses_files_outside_the_artifact_policy_before_any_request(hue, files):
    with pytest.raises(ValueError):
        hue.client().add_case(
            str(uuid4()), expected_revision=1, external_key="refused", inputs={}, files=files
        )
    assert hue.seen == []


def test_add_case_counts_a_file_name_in_utf16_code_units_as_hue_does_before_any_upload(hue):
    client, version_id = hue.client(), str(uuid4())

    def write(filename: str) -> None:
        client.add_case(
            version_id,
            expected_revision=1,
            external_key="names",
            inputs={},
            files=[
                CaseFileWrite(
                    role="source", filename="chart.png", content_type="image/png", data=PNG
                ),
                CaseFileWrite(
                    role="evaluator_reference", filename=filename, content_type="text/csv", data=CSV
                ),
            ],
        )

    # 128 emoji are 128 code points but 256 UTF-16 code units, one past Hue's limit; Hue refuses
    # a name with an unpaired surrogate too.
    for filename in ("\U0001f600" * 128, "answers\ud800.csv", "\udc00"):
        with pytest.raises(ValueError):
            write(filename)
    assert hue.seen == []
    # 127 emoji and one letter are 255 code units.
    longest = "\U0001f600" * 127 + "x"
    write(longest)
    assert [artifact["filename"] for artifact in hue.artifacts.values()] == ["chart.png", longest]


@pytest.mark.parametrize(
    "fields",
    [
        {"inputs": {"x": float("nan")}},
        {"inputs": {"when": object()}},
        {"expected": {"x": float("inf")}},
        {"inputs": "x" * 200_000},
        {"metadata": ["not", "a", "dict"]},
        {"external_key": ""},
        {"external_key": "k" * 201},
        {"external_key": "key\ud800"},
        {"expected_revision": 0},
        {"expected_revision": True},
        # Each value fits on its own, but the case as sent has more than 20,000 JSON values.
        {"inputs": [1] * 10_500, "expected": [1] * 10_500},
    ],
)
def test_add_case_checks_the_case_itself_before_uploading_any_file(hue, fields):
    arguments: dict[str, Any] = {
        "expected_revision": 1,
        "external_key": "checked",
        "inputs": {},
        "files": [
            CaseFileWrite(role="source", filename="chart.png", content_type="image/png", data=PNG)
        ],
        **fields,
    }
    with pytest.raises(ValueError):
        hue.client().add_case(str(uuid4()), **arguments)
    assert hue.seen == []


def test_add_case_pins_an_artifact_once_when_a_reference_names_the_artifact_a_file_uploads_as(
    hue,
):
    client, version_id = hue.client(), str(uuid4())
    upload = CaseFileWrite(role="source", filename="chart.png", content_type="image/png", data=PNG)

    def write(files: list[CaseFileWrite | dict[str, str]]) -> None:
        client.add_case(
            version_id, expected_revision=1, external_key="chart", inputs={}, files=files
        )

    write([upload])
    artifact_id = hue.cases[0]["files"][0]["artifactId"]
    # The same artifact pinned with another role is a second pin, as Hue takes it.
    write(
        [
            {"artifactId": artifact_id.upper(), "role": "source"},
            upload,
            {"artifactId": artifact_id, "role": "evaluator_reference"},
        ]
    )
    assert hue.cases[1]["files"] == [
        {"artifactId": artifact_id, "role": "source"},
        {"artifactId": artifact_id, "role": "evaluator_reference"},
    ]


def test_add_case_reuses_a_files_artifact_whatever_the_case_of_the_version_id(hue):
    client, version_id = hue.client(), str(uuid4())
    for spelled in (version_id, version_id.upper()):
        client.add_case(
            spelled,
            expected_revision=1,
            external_key="chart",
            inputs={},
            files=[
                CaseFileWrite(
                    role="source", filename="chart.png", content_type="image/png", data=PNG
                )
            ],
        )
    assert len(hue.reservations) == 1 and len(hue.artifacts) == 1
    assert hue.cases[1] == hue.cases[0]
