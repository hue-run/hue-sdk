from __future__ import annotations

import base64
import copy
import functools
import hashlib
import json
import os
import re
import time
import tracemalloc
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

import hue_sdk.evals._media as media_module
from hue_sdk._inline_files import inline_file
from hue_sdk.evals import (
    CaseFileWrite,
    EvaluationClient,
    LocalFile,
    MediaFetchError,
    MediaFile,
    MediaResolveFailure,
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


@dataclass(frozen=True)
class Trickle:
    """Bytes sent in ``pieces``, one every ``every`` seconds; with ``stall_after`` no more are
    sent after that many."""

    data: bytes
    pieces: int
    every: float
    stall_after: int | None = None


@dataclass(frozen=True)
class Hashed:
    """An upload the receiver hashed as it arrived instead of keeping: its SHA-256 and size."""

    sha256: str
    size: int


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
    # Uploads are hashed as they arrive and kept as ``Hashed``, so the receiver holds none whole.
    hash_uploads: bool = False
    # Called with a reservation's body before it is answered.
    on_reserve: Callable[[dict[str, Any]], object] | None = None

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
                return 200, Broken(answer.get("sent", b'{"sha256":"')), {}
            answer = state.answers[digest] = answer.get("then", {"kind": "missing"})
        if answer["kind"] == "hang":
            state.release.wait(5)
            return 500, {}, {}
        if answer["kind"] == "redirect":
            return answer["status"], b"", {"Location": f"{state.url}/storage/{digest}"}
        if answer["kind"] == "missing":
            return 404, {"error": "Never uploaded", "state": "missing"}, {}
        if answer["kind"] == "forbidden":
            return 403, {"error": "Use a Read or Read and write key"}, {}
        data = answer["data"]
        # The host the link names, with the storage route's port; its own origin by default.
        origin = state.url
        if answer.get("link_host"):
            origin = f"http://{answer['link_host']}:{urlsplit(state.url).port}"
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
                "url": f"{origin}/storage/{digest}",
                "method": "GET",
                "expiresAt": "2026-10-12T00:05:00Z",
            },
            {},
        )

    def dispatch(
        method: str, path: str, query: str, raw: bytes | Hashed
    ) -> tuple[int, Any, dict[str, str]]:
        stored = re.fullmatch(r"/storage/([0-9a-f]{64})", path)
        if stored:
            answer = state.answers.get(stored.group(1)) or {}
            if answer.get("kind") != "stored":
                return 404, b"", {}
            if answer.get("trickle"):
                pieces, every, stall_after = answer["trickle"]
                return 200, Trickle(answer["data"], pieces, every, stall_after), {}
            if answer.get("storage_redirect"):
                location = f"{state.url}/api/v1/projects/current"
                return answer["storage_redirect"], b"", {"Location": location}
            return 200, answer.get("served", answer["data"]), {}
        blob = re.fullmatch(r"/blob/([0-9a-f-]+)", path)
        if blob and method == "PUT":
            state.artifacts[blob.group(1)]["bytes"] = raw
            state.puts += 1
            return 200, b"", {}
        body = json.loads(raw) if raw else {}
        if path == "/api/v1/artifacts" and method == "POST":
            if state.on_reserve is not None:
                state.on_reserve(body)
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
            received = stored_artifact.get("bytes", b"")
            digest = received.sha256 if isinstance(received, Hashed) else sha(received)
            if digest != stored_artifact["sha256"]:
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
            length = int(self.headers.get("Content-Length", "0"))
            raw: bytes | Hashed
            if method == "PUT" and state.hash_uploads:
                digest, size = hashlib.sha256(), 0
                while size < length and (piece := self.rfile.read(min(length - size, 65536))):
                    digest.update(piece)
                    size += len(piece)
                raw = Hashed(digest.hexdigest(), size)
            else:
                raw = self.rfile.read(length)
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
            if isinstance(value, Trickle):
                size = -(-len(value.data) // value.pieces)
                try:
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(value.data)))
                    self.end_headers()
                    for index in range(value.pieces):
                        if value.stall_after is not None and index >= value.stall_after:
                            state.release.wait(5)
                            return
                        time.sleep(value.every)
                        self.wfile.write(value.data[index * size : (index + 1) * size])
                        self.wfile.flush()
                except OSError:
                    pass
                return
            payload = value if isinstance(value, bytes) else json.dumps(value).encode()
            try:
                self.send_response(status)
                for name, header in headers.items():
                    # Test data only; a line break would split the response.
                    self.send_header(
                        name.replace("\r", "").replace("\n", ""),
                        str(header).replace("\r", "").replace("\n", ""),
                    )
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


def test_an_answer_over_its_bound_cut_mid_body_is_refused_not_asked_again(hue):
    # The connection closes after 66,000 bytes of an answer longer than any grant: it is no grant
    # whether or not the rest arrives, so it fails at once, as the TypeScript SDK fails it.
    hue.answers[sha(PNG)] = {"kind": "broken", "times": 5, "sent": b'{"sha256":"' + b"a" * 65_989}
    with pytest.raises(MediaFetchError) as cut:
        hue.client().media.fetch(trace_id=TRACE_ID, sha256=sha(PNG))
    assert cut.value.reason == "failed"
    assert len([item for item in hue.seen if sha(PNG) in item["path"]]) == 1


def test_a_redirect_is_an_unexpected_answer_failed_with_its_status_never_followed_or_asked_again(
    hue,
):
    hue.answers[sha(PNG)] = {"kind": "redirect", "status": 302}
    hue.answers[sha(PDF)] = stored(PDF, "application/pdf", "r.pdf", storage_redirect=307)
    client = hue.client()
    grant = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert (grant.reason, grant.status) == ("failed", 302)
    download = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF)))
    assert (download.reason, download.status) == ("failed", 307)
    assert [item["path"] for item in hue.seen] == [
        f"/api/v1/traces/{TRACE_ID}/blobs/{sha(PNG)}",
        f"/api/v1/traces/{TRACE_ID}/blobs/{sha(PDF)}",
        f"/storage/{sha(PDF)}",
    ]


def test_a_plain_http_link_must_write_its_loopback_host_as_localhost_127_0_0_1_or_ipv6(hue):
    hosts = ["127.1", "0x7f.0.0.1", "2130706433", "[0::1]", "127.0.0.1.", "127.0.0.1"]
    files = [f"file behind {host}".encode() for host in hosts]
    for host, data in zip(hosts, files, strict=True):
        hue.answers[sha(data)] = stored(data, "text/plain", "f.txt", link_host=host)
    client = hue.client()
    # The TypeScript URL parser would rewrite these hosts to 127.0.0.1 or [::1].
    for data in files[:-1]:
        refused = failure(
            functools.partial(client.media.fetch, trace_id=TRACE_ID, sha256=sha(data))
        )
        assert (refused.reason, refused.status) == ("failed", None)
    assert not any(item["path"].startswith("/storage/") for item in hue.seen)
    assert client.media.fetch(trace_id=TRACE_ID, sha256=sha(files[-1])).data == files[-1]


def test_a_key_without_content_access_is_forbidden_and_not_asked_again(hue):
    hue.answers[sha(PNG)] = {"kind": "forbidden"}
    refused = failure(lambda: hue.client().media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert (refused.reason, refused.status) == ("forbidden", 403)
    assert len(hue.seen) == 1


def test_a_refused_key_is_told_the_key_its_target_needs(hue):
    hue.answers[sha(PNG)] = {"kind": "forbidden"}
    client = hue.client()
    trace = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert str(trace) == "The key cannot read recorded content; use a Read or Read and write key."
    snapshot = failure(lambda: client.media.fetch(snapshot_id=str(uuid4()), sha256=sha(PNG)))
    assert (snapshot.reason, snapshot.status) == ("forbidden", 403)
    assert str(snapshot) == "The key cannot read a snapshot's files; use a Read and write key."


def test_a_request_that_never_answers_times_out_once_more_then_fails(hue):
    hue.answers[sha(PNG)] = {"kind": "hang"}
    client = hue.client(timeout_seconds=0.2)
    timed_out = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PNG)))
    assert (timed_out.reason, timed_out.status) == ("failed", None)
    assert len(hue.seen) == 2


def test_a_download_ends_when_no_byte_arrives_in_time_not_while_bytes_keep_arriving(
    hue, monkeypatch
):
    monkeypatch.setattr(media_module, "_MIN_DOWNLOAD_IDLE_SECONDS", 0.4)
    steady = bytes([7]) * 4096
    # Two seconds in all, a piece every 200 ms: longer than the bound, never idle as long.
    hue.answers[sha(steady)] = stored(
        steady, "application/octet-stream", "s", trickle=(10, 0.2, None)
    )
    hue.answers[sha(PDF)] = stored(PDF, "application/pdf", "r.pdf", trickle=(3, 0.01, 1))
    client = hue.client(timeout_seconds=0.1)
    assert client.media.fetch(trace_id=TRACE_ID, sha256=sha(steady)).data == steady
    started = time.monotonic()
    stalled = failure(lambda: client.media.fetch(trace_id=TRACE_ID, sha256=sha(PDF)))
    assert (stalled.reason, stalled.status) == ("failed", None)
    assert time.monotonic() - started < 3


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
# Four letters of the base64 alphabet: written raw, Hue would read them as base64.
TEST4 = b"test"
LATIN1 = bytes([0x63, 0x61, 0x66, 0xE9])
MARKDOWN = "\ufeff# Notes\n".encode()


@dataclass(frozen=True)
class _Bytes:
    sha256: str
    content_type: str
    data: bytes


TEXT_FILES = [
    _Bytes(sha(HELLO), "text/plain", HELLO),
    _Bytes(sha(TEST4), "text/plain", TEST4),
    _Bytes(sha(LATIN1), "text/csv", LATIN1),
    _Bytes(sha(MARKDOWN), "text/markdown", MARKDOWN),
    _Bytes(sha(PDF), "application/pdf", PDF),
]


def text_parts() -> list[dict[str, Any]]:
    def blob(data: bytes, mime: str, kind: str = "blob") -> dict[str, Any]:
        return {"type": kind, "mime_type": mime, "sha256": sha(data), "size": len(data)}

    return [
        blob(HELLO, "text/plain"),
        blob(TEST4, "text/plain"),
        blob(LATIN1, "text/csv"),
        blob(MARKDOWN, "text/markdown", "media"),
        blob(PDF, "application/pdf"),
    ]


def assert_written_back(value: list[dict[str, Any]]) -> None:
    written = [part.get("content", part.get("data")) for part in value]
    # GenAI blob and Vertex media content is base64 for every media type.
    assert written == [b64(file.data) for file in TEXT_FILES]
    # Read as Hue reads it (a data: URL, base64 when it reads as base64, the text otherwise), every
    # part stands for the file's own bytes; "test" written raw would not.
    for content, file in zip(written, TEXT_FILES, strict=True):
        assert sha(inline_file(content).data) == file.sha256
    assert sha(inline_file("test").data) != sha(TEST4)


def test_rehydrate_media_writes_blob_content_as_base64_for_every_media_type():
    resolved = rehydrate_media(text_parts(), TEXT_FILES)
    assert resolved.resolved == 5
    assert_written_back(resolved.value)


def test_resolve_writes_blob_content_as_base64_for_every_media_type(hue):
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
        # A reference takes only its artifact and role; a name or type beside it is refused.
        [CaseFileWrite(role="source", artifact_id=str(uuid4()), filename="renamed.png")],
        [CaseFileWrite(role="source", artifact_id=str(uuid4()), content_type="image/png")],
        [{"artifactId": str(uuid4()), "role": "source", "filename": "renamed.png"}],
        [CaseFileWrite(role="source", filename="a.png", content_type="image/png", data=b"1")] * 2,
        # A path with no file behind it is refused as any other file that cannot be read.
        [
            CaseFileWrite(
                role="source",
                filename="a.png",
                content_type="image/png",
                path=f"/nonexistent-{uuid4()}/a.png",
            )
        ],
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


def test_add_case_holds_at_most_one_file_given_by_path_at_a_time(hue, tmp_path):
    hue.hash_uploads = True
    size = 8 * 1024 * 1024
    digests = []
    for index in range(4):
        data = os.urandom(size + index)
        (tmp_path / f"{index}.pdf").write_bytes(data)
        digests.append(Hashed(sha(data), len(data)))
    del data
    tracemalloc.start()
    try:
        hue.client().add_case(
            str(uuid4()),
            expected_revision=1,
            external_key="large-files",
            inputs={},
            files=[
                CaseFileWrite(
                    role="source",
                    filename=f"{index}.pdf",
                    content_type="application/pdf",
                    path=tmp_path / f"{index}.pdf",
                )
                for index in range(4)
            ],
        )
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # The four files come to 32 MiB: each is hashed a slice at a time and read again only to be
    # uploaded, one after the other, so the write never held two of them at once.
    assert peak < 2 * size
    assert [artifact["bytes"] for artifact in hue.artifacts.values()] == digests
    assert all(artifact["state"] == "ready" for artifact in hue.artifacts.values())


CHANGED = "changed after it was checked"


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda path, data: path.write_bytes(data[:-1] + bytes([data[-1] ^ 1])), CHANGED),
        (lambda path, data: path.write_bytes(data + b"x"), CHANGED),
        (lambda path, data: path.write_bytes(data[:-1]), CHANGED),
        (lambda path, data: path.unlink(), "could not be read"),
    ],
    ids=["rewritten", "grown", "shrunk", "removed"],
)
def test_add_case_refuses_a_file_given_by_path_that_changed_after_it_was_checked(
    hue, tmp_path, change, reason
):
    path = tmp_path / "report.pdf"
    # Several slices long: the check hashes it in pieces, the upload reads it again whole.
    original = os.urandom(2 * 1024 * 1024 + 512 * 1024)
    path.write_bytes(original)

    # The file changes once its reservation, made from the checked size and SHA-256, arrives.
    def reserved(declared: dict[str, Any]) -> None:
        if declared["filename"] == "report.pdf":
            change(path, original)

    hue.on_reserve = reserved
    with pytest.raises(ValueError) as raised:
        hue.client().add_case(
            str(uuid4()),
            expected_revision=1,
            external_key="changed",
            inputs={},
            files=[
                CaseFileWrite(
                    role="source", filename="chart.png", content_type="image/png", data=PNG
                ),
                CaseFileWrite(
                    role="source", filename="report.pdf", content_type="application/pdf", path=path
                ),
            ],
        )
    assert str(raised.value) == f"Case file 2 {reason}."
    # None of the report's bytes are sent: no upload is asked for, nothing is staged or completed,
    # and no case is written.
    report = next(item for item in hue.artifacts.values() if item["filename"] == "report.pdf")
    assert report["state"] == "reserved"
    assert "bytes" not in report
    requested = [seen["path"] for seen in hue.seen if report["id"] in seen["path"]]
    assert requested == []
    assert hue.cases == []


def test_a_recorded_value_keeps_an_own___proto___key_as_typescript_does(hue):
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png")
    value = json.loads(
        '{"message": {"__proto__": {"role": "system"}, "role": "user"}, "part": {"type":'
        f' "image_url", "image_url": {{}}, "sha256": "{sha(PNG)}", "size": {len(PNG)}}}}}'
    )
    for resolved in (
        hue.client().media.resolve(value, trace_id=TRACE_ID),
        rehydrate_media(value, [_Bytes(sha(PNG), "image/png", PNG)]),
    ):
        assert resolved.value["message"] == value["message"]
        assert list(resolved.value["message"]) == ["__proto__", "role"]
        assert resolved.value["part"] == {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64(PNG)}"},
        }


def test_an_anthropic_source_whose_type_is_absent_or_null_takes_base64_a_url_one_is_left():
    def block(**source: Any) -> dict[str, Any]:
        return {
            "type": "image",
            "source": {"media_type": "image/png", **source},
            "sha256": sha(PNG),
            "size": len(PNG),
        }

    resolved = rehydrate_media(
        [block(), block(type=None), block(type="url")], [_Bytes(sha(PNG), "image/png", PNG)]
    )
    assert resolved.resolved == 2
    assert resolved.value == [
        {"type": "image", "source": {"media_type": "image/png", "data": b64(PNG)}},
        {"type": "image", "source": {"media_type": "image/png", "type": None, "data": b64(PNG)}},
        block(type="url"),
    ]


def test_a_snapshots_parts_that_declare_no_type_take_it_from_the_records_hue_blobs(hue):
    snapshot_id = str(uuid4())
    hue.answers.update(
        {
            sha(PNG): stored(PNG, "image/png", "chart.png"),
            sha(PDF): stored(PDF, "application/pdf", "r.pdf"),
            sha(WAV): stored(WAV, "audio/wav", "reply.wav"),
        }
    )
    parts = [
        {"type": "image_url", "image_url": {}, "sha256": sha(PNG), "size": len(PNG)},
        {"type": "input_file", "filename": "r.pdf", "sha256": sha(PDF), "size": len(PDF)},
        # A part's own type comes first.
        {"type": "file", "mediaType": "audio/x-wav", "sha256": sha(WAV), "size": len(WAV)},
    ]

    def entry(index: int, data: bytes, content_type: str) -> str:
        return json.dumps(
            {
                "key": f"gen_ai.input.messages#/0/content/{index}",
                "sha256": sha(data),
                "size": len(data),
                "content_type": content_type,
            }
        )

    blobs = [
        "not an entry",
        entry(0, PNG, "image/png"),
        entry(1, PDF, "application/pdf"),
        entry(2, WAV, "audio/wav"),
    ]
    client = hue.client()
    resolved = client.media.resolve(parts, snapshot_id=snapshot_id, blobs=blobs)
    assert resolved.value == [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(PNG)}"}},
        {
            "type": "input_file",
            "filename": "r.pdf",
            "file_data": f"data:application/pdf;base64,{b64(PDF)}",
        },
        {"type": "file", "mediaType": "audio/x-wav", "data": f"data:audio/x-wav;base64,{b64(WAV)}"},
    ]
    # Without the entries, a snapshot's copy names no type.
    bare = client.media.resolve(parts[:1], snapshot_id=snapshot_id)
    assert bare.value[0]["image_url"]["url"].startswith("data:application/octet-stream;base64,")
    # Every form Hue reads hue.blobs in gives the same types: one string holding the JSON array,
    # and a list of dicts; anything else is no list of entries and is ignored.
    objects = [json.loads(item) for item in blobs[1:]]
    for form in (json.dumps(blobs[1:]), objects):
        read = client.media.resolve(parts, snapshot_id=snapshot_id, blobs=form)
        assert read.value == resolved.value
    ignored = client.media.resolve(parts[:1], snapshot_id=snapshot_id, blobs="entries")
    assert ignored.value[0]["image_url"]["url"].startswith("data:application/octet-stream;base64,")


def test_an_entry_whose_size_is_out_of_range_is_ignored_never_raised(hue):
    snapshot_id = str(uuid4())
    hue.answers[sha(PNG)] = stored(PNG, "image/png", "chart.png")
    parts = [{"type": "image_url", "image_url": {}, "sha256": sha(PNG), "size": len(PNG)}]

    def entry(index: int, size: object) -> dict[str, Any]:
        return {
            "key": f"gen_ai.input.messages#/{index}",
            "sha256": sha(PNG),
            "size": size,
            "content_type": "image/gif",
        }

    # Sizes Hue's reader refuses, the first too large for a float: each entry is ignored, so the
    # part takes the type of the valid entry after them.
    blobs: list[str | dict[str, Any]] = [
        entry(0, 10**400),
        entry(1, 10**9 + 1),
        entry(2, 0),
        entry(3, True),
        entry(4, 1.5),
        entry(5, float("inf")),
        entry(6, "12345678901"),
        json.dumps({**entry(7, 1), "content_type": "image/png"}),
    ]
    resolved = hue.client().media.resolve(parts, snapshot_id=snapshot_id, blobs=blobs)
    assert resolved.value[0]["image_url"]["url"] == f"data:image/png;base64,{b64(PNG)}"


def test_text_kept_as_its_first_16_kib_is_reported_as_prefix_only_and_never_written(hue):
    text_in = b"A long report. " * 6000
    text_out = b"An output summary. " * 5000
    short = b"a short file"
    # Both files are stored: resolve still writes neither, since an entry names a pointer and not
    # the value it was read from.
    hue.answers.update(
        {
            sha(text_in): stored(text_in, "text/plain", "input.txt"),
            sha(text_out): stored(text_out, "text/plain", "output.txt"),
            sha(short): stored(short, "text/plain", "short.txt"),
        }
    )

    def message(role: str, content: str) -> dict[str, Any]:
        return {
            "role": role,
            "parts": [{"type": "blob", "mime_type": "text/plain", "content": content}],
        }

    input_messages = [message("user", text_in[: 16 * 1024].decode()), message("user", "short")]
    output_messages = [message("assistant", text_out[: 16 * 1024].decode())]

    def entry(key: str, data: bytes) -> str:
        return json.dumps(
            {"key": key, "sha256": sha(data), "size": len(data), "content_type": "text/plain"}
        )

    blobs = [
        entry("gen_ai.input.messages#/0/parts/0/content", text_in),
        # The output's text file at the same pointer as the input's.
        entry("gen_ai.output.messages#/0/parts/0/content", text_out),
        # A field holding text shorter than a prefix is complete and left alone.
        entry("gen_ai.output.messages#/1/parts/0/content", short),
    ]
    both = [
        MediaResolveFailure("/0/parts/0", sha(text_in), "prefix_only"),
        MediaResolveFailure("/0/parts/0", sha(text_out), "prefix_only"),
    ]
    client = hue.client()
    for recorded in (input_messages, output_messages):
        resolved = client.media.resolve(recorded, trace_id=TRACE_ID, blobs=blobs)
        assert resolved.value == recorded
        assert resolved.resolved == 0
        assert resolved.failures == both
    # The entries of the value's own attribute name its own file.
    own = client.media.resolve(output_messages, trace_id=TRACE_ID, blobs=blobs[1:])
    assert own.failures == [both[1]]
    assert [item for item in hue.seen if "/blobs/" in item["path"]] == []
