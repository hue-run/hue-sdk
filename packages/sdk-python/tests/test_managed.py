from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk.managed import ManagedOutputFile, ManagedTargetHandler, ManagedTargetResult

EXECUTION = "11111111-1111-4111-8111-111111111111"
FILE = "22222222-2222-4222-8222-222222222222"
TRACE = "1234567890abcdef1234567890abcdef"
DATA = b"synthetic document bytes"
HASH = hashlib.sha256(DATA).hexdigest()
HEADERS = {
    "Authorization": "Bearer synthetic-machine",
    "X-Hue-Invocation-Token": "synthetic-scoped-token",
}


def invocation():
    return {
        "protocolVersion": 1,
        "executionId": EXECUTION,
        "attempt": 1,
        "input": {"query": "synthetic"},
        "config": {},
        "inputFiles": [],
        "deadline": (datetime.now(timezone.utc) + timedelta(seconds=5))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "traceparent": f"00-{TRACE}-1234567890abcdef-01",
    }


def with_file():
    body = invocation()
    body["inputFiles"] = [
        {
            "artifactId": FILE,
            "filename": "source.docx",
            "contentType": "application/octet-stream",
            "byteSize": len(DATA),
            "sha256": HASH,
            "role": "source",
        }
    ]
    return body


@pytest.fixture
def managed():
    class Fixture:
        def __init__(self):
            self.requests = []
            self.outcomes = []
            self.claimed = False
            self.target_calls = 0
            self.ready = False
            self.upload_headers = {"x-vercel-blob-access": "private"}
            self.hook = lambda _path: None
            self.exporter = InMemorySpanExporter()
            self.provider = TracerProvider()
            self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))

        def target(self, _context):
            self.target_calls += 1
            return ManagedTargetResult(
                output="real callback output",
                files=(
                    ManagedOutputFile(
                        "answer.docx",
                        "application/octet-stream",
                        DATA,
                        primary=True,
                    ),
                ),
            )

        def flush(self):
            assert len(self.outcomes) == 1
            self.provider.force_flush()

        def handler(self, **overrides):
            return ManagedTargetHandler(
                **{
                    "machine_credential": "synthetic-machine",
                    "base_url": self.url,
                    "target": self.target,
                    "flush_telemetry": self.flush,
                    "tracer": self.provider.get_tracer("test"),
                    **overrides,
                }
            )

    fixture = Fixture()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.answer()

        def do_GET(self):
            self.answer()

        def do_PUT(self):
            self.answer()

        def log_message(self, *_args):
            pass

        def answer(self):
            data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            fixture.requests.append((self.path, self.headers.get("Authorization"), data))
            injected = fixture.hook(self.path)
            if injected == "disconnect":
                self.close_connection = True
                return
            if injected:
                self.send_response(injected)
                self.end_headers()
                return
            body = b"{}"
            if self.path.endswith("/claim"):
                body = json.dumps(
                    {"claimed": not fixture.claimed, "executionId": EXECUTION, "state": "running"}
                ).encode()
                fixture.claimed = True
            elif "/inputs/" in self.path:
                body = DATA
            elif self.path.endswith("/files"):
                body = json.dumps(
                    {"artifactId": FILE, "state": "ready"}
                    if fixture.ready
                    else {
                        "artifactId": FILE,
                        "uploadUrl": fixture.url + "/upload",
                        "headers": fixture.upload_headers,
                    }
                ).encode()
            elif self.path.endswith("/outcome"):
                fixture.outcomes.append(json.loads(data))
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fixture.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield fixture
    server.shutdown()
    server.server_close()
    fixture.provider.shutdown()
    thread.join(timeout=2)


def test_claim_upload_checkpoint_flush_and_duplicate(managed):
    handler = managed.handler()
    response = handler.handle(invocation(), HEADERS)
    assert response.status_code == 200
    assert response.body == {
        "protocolVersion": 1,
        "executionId": EXECUTION,
        "state": "checkpointed",
        "telemetry": "flushed",
    }
    outcome = managed.outcomes[0]
    assert outcome["output"] == "real callback output"
    assert outcome["artifactIds"] == [FILE] and outcome["primaryArtifactId"] == FILE
    span = managed.exporter.get_finished_spans()[0]
    assert outcome["traceId"] == TRACE
    assert outcome["expectedSpanIds"] == [format(span.context.span_id, "016x")]
    assert next(item for item in managed.requests if item[0] == "/upload")[1:] == (None, DATA)
    assert all(
        auth == "Bearer synthetic-scoped-token"
        for path, auth, _ in managed.requests
        if path != "/upload"
    )
    assert managed.requests[-1][0].endswith("/telemetry")
    assert handler.handle(invocation(), HEADERS).status_code == 409
    assert managed.target_calls == 1


def test_auth_and_validation_have_no_network(managed):
    handler = managed.handler()
    assert handler.handle(invocation(), {}).status_code == 401
    for field, value in (
        ("callbackUrl", "https://evil.invalid"),
        ("attempt", True),
        ("traceparent", f"00-{TRACE}-{'0' * 16}-01"),
    ):
        payload = invocation()
        payload[field] = value
        assert handler.handle(payload, HEADERS).status_code == 400
    assert managed.requests == []
    assert "synthetic" not in repr(handler)


def test_input_bytes_verified_before_target(managed):
    seen = []

    def target(context):
        seen.append(context.input_files[0].data)
        return ManagedTargetResult(output=None)

    assert managed.handler(target=target).handle(with_file(), HEADERS).status_code == 200
    assert seen == [DATA]
    assert managed.outcomes[0]["output"] is None


@pytest.mark.parametrize("boundary", ["hash", "redirect"])
def test_bad_input_never_calls_target(managed, boundary):
    payload = with_file()
    if boundary == "hash":
        payload["inputFiles"][0]["sha256"] = "0" * 64
    else:
        managed.hook = lambda path: 302 if "/inputs/" in path else None
    assert managed.handler().handle(payload, HEADERS).status_code == 200
    assert managed.target_calls == 0
    assert managed.outcomes[0]["state"] == "error"


def test_claim_loss_does_not_retry_or_run_target(managed):
    managed.hook = lambda _path: "disconnect"
    response = managed.handler().handle(invocation(), HEADERS)
    assert response.status_code == 503 and response.body["state"] == "uncertain"
    assert len(managed.requests) == 1 and managed.target_calls == 0


def test_lost_checkpoint_retries_identical_outcome_only(managed):
    def hook(path):
        if (
            path.endswith("/outcome")
            and len([r for r in managed.requests if r[0].endswith("/outcome")]) == 1
        ):
            return "disconnect"
        return None

    managed.hook = hook
    assert managed.handler().handle(invocation(), HEADERS).status_code == 200
    attempts = [r[2] for r in managed.requests if r[0].endswith("/outcome")]
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert managed.target_calls == 1


def test_error_still_uploads_secondary(managed):
    def target(_context):
        return ManagedTargetResult(
            state="error",
            error={"type": "missing_artifact"},
            files=(ManagedOutputFile("secondary.pptx", "application/zip", DATA),),
        )

    assert managed.handler(target=target).handle(invocation(), HEADERS).status_code == 200
    assert managed.outcomes[0]["artifactIds"] == [FILE]
    assert managed.outcomes[0]["error"]["type"] == "missing_artifact"


def test_flush_failure_preserves_outcome(managed):
    def flush():
        raise RuntimeError("private exporter error")

    response = managed.handler(flush_telemetry=flush).handle(invocation(), HEADERS)
    assert response.status_code == 200 and response.body["telemetry"] == "pending"
    assert managed.outcomes[0]["state"] == "succeeded"
    assert not any(r[0].endswith("/telemetry") for r in managed.requests)


def test_target_deadline_is_uncertain_without_false_terminal_outcome(managed):
    def target(context):
        context.cancelled.wait(timeout=1)
        return ManagedTargetResult(output="too late")

    response = managed.handler(
        target=target, max_execution_millis=30, finalization_millis=20
    ).handle(invocation(), HEADERS)
    assert response.status_code == 503
    assert managed.outcomes == []


def test_ready_reservation_skips_reupload(managed):
    managed.ready = True
    assert managed.handler().handle(invocation(), HEADERS).status_code == 200
    assert not any(r[0] == "/upload" or r[0].endswith("/complete") for r in managed.requests)
    assert managed.outcomes[0]["primaryArtifactId"] == FILE


def test_unapproved_upload_credentials_rejected(managed):
    managed.upload_headers = {"authorization": "must-never-forward"}
    assert managed.handler().handle(invocation(), HEADERS).status_code == 200
    assert not any(r[0] == "/upload" for r in managed.requests)
    assert managed.outcomes[0]["state"] == "error"
    assert managed.outcomes[0]["output"] == "real callback output"


def test_completion_resolves_lost_upload_acknowledgement(managed):
    managed.hook = lambda path: 409 if path == "/upload" else None
    assert managed.handler().handle(invocation(), HEADERS).status_code == 200
    assert any(r[0].endswith("/complete") for r in managed.requests)
    assert managed.outcomes[0]["state"] == "succeeded"
    assert managed.outcomes[0]["primaryArtifactId"] == FILE


def test_raw_target_exception_is_not_recorded_or_returned(managed):
    def target(_context):
        raise RuntimeError("secret-provider-body")

    response = managed.handler(target=target).handle(invocation(), HEADERS)
    assert response.status_code == 200
    assert "secret-provider-body" not in json.dumps(managed.outcomes)
    span = managed.exporter.get_finished_spans()[0]
    assert span.status.description is None
    assert not span.events
