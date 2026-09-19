from __future__ import annotations

import asyncio
import gzip
import io
import json
import time
from pathlib import Path

import pytest
import requests
from capture_api import capture_api

from hue_sdk.capture import CaptureSession
from hue_sdk.capture._json import canonical_json, sha256

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "capture-v1.json").read_text())
BINDING = {
    "id": "gmail",
    "kind": "tool",
    "contractVersion": "1",
    "operations": [{"name": "read", "inputSchema": {"type": "object"}}],
}


def options(url):
    return {
        "source_content": True,
        "api_key": "synthetic-key",
        "base_url": url,
        "bindings": [BINDING],
        "external_trace_id": "a" * 32,
    }


def test_cross_language_canonical_identity():
    for fixture in FIXTURES["canonical"]:
        assert canonical_json(fixture["value"]).decode() == fixture["canonical"]
    for fixture in FIXTURES["matching"]:
        assert sha256(canonical_json(fixture["arguments"])) == fixture["sha256"]


def test_capture_disabled_has_no_network_and_preserves_results():
    with capture_api() as (url, calls, _):
        session = CaptureSession(**{**options(url), "source_content": False})
        result = object()
        assert session.observe("gmail", "read", {}, lambda: result) is result
        assert session.finalize()["status"] == "disabled"
        assert calls == []


def test_sanitized_evidence_preserves_live_errors_and_values():
    with capture_api() as (url, calls, _):
        session = CaptureSession(**options(url))
        session.state_evidence(FIXTURES["stateEvidence"])
        result = {"body": "hello", "access_token": "synthetic-private"}
        assert (
            session.observe(
                "gmail", "read", {"id": "m1", "password": "synthetic-password"}, lambda: result
            )
            is result
        )
        failure = ValueError("synthetic-private-error")

        def fail():
            raise failure

        with pytest.raises(ValueError) as caught:
            session.observe("gmail", "read", {"id": "m2"}, fail)
        assert caught.value is failure
        report = session.finalize()
        assert report["status"] == "finalized", report
        assert report["pending"] == 0
        body = next(call["body"] for call in calls if call["path"].endswith("/append"))
        assert body["stateEvidence"] == [FIXTURES["stateEvidence"]]
        assert len(body["observations"]) == 4
        assert body["observations"][0]["arguments"]["value"] == {"id": "m1"}
        assert body["observations"][1]["result"]["value"] == {"body": "hello"}
        assert body["observations"][1]["replayable"] is False
        assert "synthetic-private" not in json.dumps(calls)
        assert "synthetic-password" not in json.dumps(calls)
        assert all(call["authorization"] == "Bearer synthetic-key" for call in calls)


def test_uncertain_export_reuses_exact_batch():
    with capture_api() as (url, calls, state):
        session = CaptureSession(**options(url))
        session.observe("gmail", "read", {}, lambda: {"id": "m1"})
        state["fail_append"] = True
        assert session.flush()["status"] == "failed"
        assert session.flush()["pending"] == 0
        appends = [call for call in calls if call["path"].endswith("/append")]
        assert appends[0]["body"] == appends[1]["body"]


@pytest.mark.parametrize("members", [False, True])
def test_compressed_capture_responses_finalize_over_http(members):
    with capture_api() as (url, calls, state):
        state.update(gzip=True, gzip_members=members)
        capture = CaptureSession(**options(url))
        result = {"id": "m1"}
        assert capture.observe("gmail", "read", {}, lambda: result) is result
        report = capture.finalize()
        assert report["status"] == "finalized", report
        assert report["pending"] == 0
        assert len([call for call in calls if call["path"].endswith("/finalize")]) == 1
        assert all(call["acceptEncoding"] == "gzip" for call in calls)


def test_compressed_capture_responses_enforce_decoded_size_limit():
    with capture_api() as (url, _calls, state):
        state.update(gzip=True, oversized_response=True)
        capture = CaptureSession(**options(url))
        result = {"id": "m1"}
        assert capture.observe("gmail", "read", {}, lambda: result) is result
        report = capture.flush()
        assert report["status"] == "failed"
        assert report["pending"] == 2
        assert "captureId" not in report
        state["oversized_response"] = False
        recovered = capture.finalize()
        assert recovered["status"] == "finalized", recovered
        assert recovered["pending"] == 0


def test_compressed_capture_trickler_cannot_hide_from_deadline():
    with capture_api() as (url, _calls, state):
        state.update(gzip=True, gzip_trickle=True)
        capture = CaptureSession(**options(url))
        result = {"id": "m1"}
        assert capture.observe("gmail", "read", {}, lambda: result) is result
        started = time.monotonic()
        report = capture.flush(deadline_seconds=0.1)
        elapsed = time.monotonic() - started
        assert report["status"] == "failed"
        assert report["pending"] == 2
        assert elapsed < 0.5, elapsed


@pytest.mark.parametrize("failure", ["gzip_truncated", "unsupported_encoding"])
def test_invalid_capture_encodings_preserve_pending_observations(failure):
    with capture_api() as (url, _calls, state):
        state.update(gzip=True, **{failure: True})
        capture = CaptureSession(**options(url))
        result = {"id": "m1"}
        assert capture.observe("gmail", "read", {}, lambda: result) is result
        report = capture.flush()
        assert report["status"] == "failed"
        assert report["pending"] == 2
        assert "captureId" not in report
        state[failure] = False
        recovered = capture.finalize()
        assert recovered["status"] == "finalized", recovered
        assert recovered["pending"] == 0


def test_queue_limits_and_unsupported_values_report_omissions():
    with capture_api() as (url, calls, _):
        session = CaptureSession(**options(url), max_queue_records=1)
        result = object()
        assert session.observe("gmail", "read", {}, lambda: result) is result
        assert session.finalize()["dropped"] == 1
        producer = next(c for c in calls if c["path"].endswith("/finalize"))["body"]["producers"][0]
        assert producer == {
            "producerId": session.producer_id,
            "lastSequence": 2,
            "dropped": 1,
            "pending": 0,
        }

        def broken(_value):
            raise ValueError("bad redactor")

        redacted = CaptureSession(**options(url), redact=broken)
        assert redacted.observe("gmail", "read", {}, lambda: 42) == 42
        assert redacted.finalize()["dropped"] == 1


def test_async_tools_have_the_same_evidence_contract():
    with capture_api() as (url, calls, _):
        session = CaptureSession(**options(url))
        result = {"id": "m1"}

        async def run():
            async def live():
                return result

            assert await session.aobserve("gmail", "read", {}, live) is result
            assert (await session.afinalize())["status"] == "finalized"

        asyncio.run(run())
        assert (
            len(next(c for c in calls if c["path"].endswith("/append"))["body"]["observations"])
            == 2
        )


def test_in_place_redaction_and_oversized_live_values_are_explicit_omissions():
    with capture_api() as (url, calls, _):

        def redact(value):
            if isinstance(value, dict):
                value.pop("body", None)
                if value.get("kind") == "initial_snapshot":
                    value["accountId"] = "reviewed-redaction"
            return value

        capture = CaptureSession(**options(url), redact=redact)
        initial = json.loads(json.dumps(FIXTURES["stateEvidence"]))
        capture.state_evidence(initial)
        result = {"body": "private-source", "id": "message"}
        assert capture.observe("gmail", "read", {}, lambda: result) is result
        oversized = {"body": "x" * (2 * 1024 * 1024)}
        assert capture.observe("gmail", "read", {}, lambda: oversized) is oversized
        assert capture.finalize()["status"] == "finalized"
        append = next(c["body"] for c in calls if c["path"].endswith("/append"))
        assert append["observations"][1]["omissionReason"] == "redacted_result"
        assert append["observations"][3]["omissionReason"] == "unsupported_result"
        assert append["stateEvidence"][0]["boundary"]["omissions"] == ["credential_redaction"]
        assert initial["accountId"] == "mailbox-example"
        assert result["body"] == "private-source"


@pytest.mark.parametrize("failure", ["before", "after"])
def test_finalize_recovers_after_uncertain_response_and_newer_evidence(failure):
    with capture_api() as (url, calls, state):
        capture = CaptureSession(**options(url))
        state["fail_finalize"] = failure
        assert capture.finalize()["status"] == "failed"
        first = next(c["body"] for c in calls if c["path"].endswith("/finalize"))
        capture.observe("gmail", "read", {"id": "new"}, lambda: {"id": "new"})
        flushed = capture.flush()
        assert flushed["status"] == "flushed"
        report = capture.finalize()
        assert report["status"] == "finalized"
        assert report["revision"] > flushed["revision"]
        finalizes = [c for c in calls if c["path"].endswith("/finalize")]
        assert finalizes[1]["body"] == first
        assert finalizes[2]["body"]["producers"][0]["lastSequence"] == 2


def test_source_descriptors_apply_custom_redaction_and_report_omissions():
    with capture_api() as (url, calls, _):

        def redact(value):
            if isinstance(value, dict) and "relation" in value:
                value["name"] = "redacted"
                value["uri"] = "urn:redacted"
                value.pop("metadata", None)
            return value

        capture = CaptureSession(**options(url), redact=redact)
        source = {
            "id": "source",
            "content": "complete",
            "relation": "tool_source",
            "name": "private-name",
            "uri": "https://example.test/private-source",
            "metadata": {"note": "private-note"},
        }
        capture.source(source)
        assert capture.finalize()["status"] == "finalized"
        recorded = next(c["body"] for c in calls if c["path"].endswith("/append"))["sources"][0]
        assert recorded == {
            "id": "source",
            "content": "partial",
            "relation": "tool_source",
            "name": "redacted",
            "uri": "urn:redacted",
        }
        assert source["name"] == "private-name"
        assert "private-note" not in json.dumps(calls)

        def broken(_value):
            raise ValueError("redactor failed")

        omitted = CaptureSession(**options(url), redact=broken)
        omitted.source(source)
        assert omitted.flush()["dropped"] == 1


@pytest.fixture
def upload_transport(monkeypatch):
    """Inspect prepared HTTPS requests after Requests applies auth/proxy settings."""
    attempts = []
    reply = {"status": 200}
    original = requests.adapters.HTTPAdapter.send

    def send(adapter, request, **kwargs):
        if request.url.startswith("https://capture-upload.invalid/"):
            attempts.append((request, kwargs))
            if "error" in reply:
                raise reply["error"]
            response = requests.Response()
            response.status_code = reply["status"]
            response.request = request
            response.url = request.url
            response.raw = io.BytesIO(b"")
            response._content = b""
            response.headers["Location"] = "https://capture-upload.invalid/redirected"
            return response
        return original(adapter, request, **kwargs)

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    return attempts, reply


@pytest.mark.parametrize("headers", ["missing", None, {}, {"X-Vercel-Blob-Access": "private"}])
def test_upload_uses_only_capability_authority_and_preserves_bytes(
    headers, upload_transport, monkeypatch, tmp_path
):
    netrc = tmp_path / "synthetic.netrc"
    netrc.write_text("machine capture-upload.invalid login ambient-user password ambient-secret\n")
    netrc.chmod(0o600)
    monkeypatch.setenv("NETRC", str(netrc))
    for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, "http://ambient-proxy.invalid:8080")
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(name, "127.0.0.1")
    attempts, _reply = upload_transport
    data = gzip.compress(b"\x00source bytes\xff")
    with capture_api() as (url, calls, state):
        if headers != "missing":
            state["upload_headers"] = headers
        capture = CaptureSession(**options(url))
        result = capture.upload_source(
            filename="source.bin", content_type="application/octet-stream", data=data
        )
        assert result == {
            "artifactId": "22222222-2222-4222-8222-222222222222",
            "sha256": sha256(data),
            "byteSize": len(data),
            "mimeType": "application/octet-stream",
        }
        assert len(attempts) == 1
        request, settings = attempts[0]
        assert request.method == "PUT"
        assert request.body == data
        assert request.headers["Content-Type"] == "application/octet-stream"
        assert request.headers["Content-Length"] == str(len(data))
        assert "Authorization" not in request.headers
        assert "Proxy-Authorization" not in request.headers
        assert "Content-Encoding" not in request.headers
        assert settings["proxies"] == {}
        assert all(call["authorization"] == "Bearer synthetic-key" for call in calls)
        assert len([call for call in calls if call["path"].endswith("/complete")]) == 1


@pytest.mark.parametrize(
    "headers",
    [
        {"authorization": "must-not-forward"},
        {"cookie": "must-not-forward"},
        {"content-type": "text/plain"},
        {"x-vercel-blob-access": "public"},
        {"x-vercel-blob-access": "private\r\nX-Injected: value"},
        {"content-type": None},
        [],
    ],
)
def test_upload_rejects_unsafe_capability_headers(headers, upload_transport):
    attempts, _reply = upload_transport
    with capture_api() as (url, calls, state):
        state["upload_headers"] = headers
        capture = CaptureSession(**options(url))
        assert (
            capture.upload_source(
                filename="source.bin", content_type="application/octet-stream", data=b"source"
            )
            is None
        )
        assert attempts == []
        assert capture.flush()["dropped"] == 1
        assert not any(call["path"].endswith("/complete") for call in calls)


@pytest.mark.parametrize("status", [307, 503])
def test_upload_never_retries_or_follows_redirects(status, upload_transport):
    attempts, reply = upload_transport
    reply["status"] = status
    with capture_api() as (url, calls, state):
        state["complete_status"] = 503
        capture = CaptureSession(**options(url))
        assert (
            capture.upload_source(
                filename="source.bin", content_type="application/octet-stream", data=b"source"
            )
            is None
        )
        assert len(attempts) == 1
        assert attempts[0][0].url == "https://capture-upload.invalid/source"
        assert capture.flush()["dropped"] == 1
        assert len([call for call in calls if call["path"].endswith("/complete")]) == 1


@pytest.mark.parametrize(
    "upload_url",
    [
        None,
        "https://capture-upload.invalid/" + "x" * 8192,
        "https://capture-upload.invalid/source\n",
        "https://capture-upload.invalid/source\x7f",
        "http://capture-upload.invalid/source",
        "https:///source",
        "https://user:password@capture-upload.invalid/source",
        "https://capture-upload.invalid:bad/source",
        "https://capture-upload.invalid/source#fragment",
    ],
)
def test_upload_rejects_invalid_capabilities_before_upload_or_completion(
    upload_url, upload_transport
):
    attempts, _reply = upload_transport
    with capture_api() as (url, calls, state):
        state["upload_url"] = upload_url
        capture = CaptureSession(**options(url))
        assert (
            capture.upload_source(
                filename="source.bin", content_type="application/octet-stream", data=b"source"
            )
            is None
        )
        assert attempts == []
        assert capture.flush()["dropped"] == 1
        assert not any(call["path"].endswith("/complete") for call in calls)


@pytest.mark.parametrize("failure", ["transport", "response"])
@pytest.mark.parametrize("verified", [False, True])
def test_upload_completion_resolves_uncertain_write_without_replay(
    failure, verified, upload_transport
):
    attempts, reply = upload_transport
    if failure == "transport":
        reply["error"] = requests.ConnectionError("Synthetic lost upload acknowledgement")
    else:
        reply["status"] = 503
    with capture_api() as (url, calls, state):
        state["complete_status"] = 200 if verified else 409
        capture = CaptureSession(**options(url))
        data = b"source bytes"
        result = capture.upload_source(
            filename="source.bin", content_type="application/octet-stream", data=data
        )
        assert len(attempts) == 1
        assert attempts[0][0].body == data
        assert len([call for call in calls if call["path"].endswith("/complete")]) == 1
        if verified:
            assert result == {
                "artifactId": "22222222-2222-4222-8222-222222222222",
                "sha256": sha256(data),
                "byteSize": len(data),
                "mimeType": "application/octet-stream",
            }
        else:
            assert result is None
        assert capture.flush()["dropped"] == (0 if verified else 1)
