"""A non-loopback Hue origin must not choose where output bytes are PUT.

These tests fail while the worker still delivers the file. They pass once it does not.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import ssl
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import requests.adapters
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk._blobs import BlobUploader
from hue_sdk.evals.client import EvaluationClient, HueApiError
from hue_sdk.managed import ManagedOutputFile, ManagedTargetHandler, ManagedTargetResult

EXECUTION = "11111111-1111-4111-8111-111111111111"
FILE = "22222222-2222-4222-8222-222222222222"
TRACE = "1234567890abcdef1234567890abcdef"
OUTPUT = b"synthetic model output"
API_HOST = "hue-api.invalid"
REBINDING_HOST = "storage.invalid"
PUBLIC = "203.0.113.10"
HEADERS = {
    "Authorization": "Bearer synthetic-machine",
    "X-Hue-Invocation-Token": "synthetic-scoped-token",
}

_REAL_GETADDRINFO = socket.getaddrinfo
_REAL_CONNECT = socket.socket.connect


def _local(host: str) -> bool:
    try:
        address = ipaddress_address(host)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(address.is_loopback or (mapped is not None and mapped.is_loopback))


def ipaddress_address(host: str):
    import ipaddress

    return ipaddress.ip_address(host)


def _getaddrinfo(host, port, *args, **kwargs):
    """The connect lookup of the rebinding name answers loopback.

    A pre-check that omits the port sees the public address. urllib3's
    ``create_connection`` (urllib3 2.8.0 ``util/connection.py``) passes the port,
    which is the lookup the PUT uses.
    """
    name = host.strip("[]") if isinstance(host, str) else host
    if name == API_HOST or name == "localhost":
        return _REAL_GETADDRINFO("127.0.0.1", port, *args, **kwargs)
    if name == REBINDING_HOST:
        chosen = PUBLIC if port is None else "127.0.0.1"
        return _REAL_GETADDRINFO(chosen, port, *args, **kwargs)
    return _REAL_GETADDRINFO(host, port, *args, **kwargs)


def _connect(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if isinstance(host, str) and not _local(host) and _is_ip(host):
        raise OSError("refused non-local connect")
    return _REAL_CONNECT(self, address)


def _is_ip(host: str) -> bool:
    try:
        ipaddress_address(host.split("%", 1)[0])
    except ValueError:
        return False
    return True


socket.getaddrinfo = _getaddrinfo
socket.socket.connect = _connect


def _restore_network() -> None:
    socket.getaddrinfo = _REAL_GETADDRINFO
    socket.socket.connect = _REAL_CONNECT


@pytest.fixture(scope="module", autouse=True)
def _network():
    yield
    _restore_network()


@pytest.fixture(scope="module")
def material(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    directory = tmp_path_factory.mktemp("upload-certs")
    ca_key = directory / "ca.key"
    ca = directory / "ca.pem"
    key = directory / "key.pem"
    csr = directory / "csr.pem"
    cert = directory / "cert.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=HueTestCA",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(csr),
            "-nodes",
            "-subj",
            "/CN=sink",
            "-addext",
            "subjectAltName="
            "DNS:hue-api.invalid,DNS:storage.invalid,DNS:127.1,DNS:0x7f.0.0.1,DNS:localhost,"
            "IP:127.0.0.1,IP:127.0.0.2",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(csr),
            "-CA",
            str(ca),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(cert),
            "-days",
            "1",
            "-copy_extensions",
            "copy",
        ],
        check=True,
        capture_output=True,
    )
    import certifi

    bundle = directory / "bundle.pem"
    bundle.write_bytes(Path(certifi.where()).read_bytes() + b"\n" + ca.read_bytes())
    previous = requests.adapters.DEFAULT_CA_BUNDLE_PATH
    previous_env = os.environ.get("REQUESTS_CA_BUNDLE")
    requests.adapters.DEFAULT_CA_BUNDLE_PATH = str(bundle)
    os.environ["REQUESTS_CA_BUNDLE"] = str(bundle)
    yield {"key": key, "cert": cert, "bundle": bundle}
    requests.adapters.DEFAULT_CA_BUNDLE_PATH = previous
    if previous_env is None:
        os.environ.pop("REQUESTS_CA_BUNDLE", None)
    else:
        os.environ["REQUESTS_CA_BUNDLE"] = previous_env


def _invocation() -> dict:
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=8)).isoformat(
        timespec="milliseconds"
    )
    return {
        "protocolVersion": 1,
        "executionId": EXECUTION,
        "attempt": 1,
        "input": {"query": "synthetic"},
        "config": {},
        "inputFiles": [],
        "deadline": deadline.replace("+00:00", "Z"),
        "traceparent": f"00-{TRACE}-1234567890abcdef-01",
    }


class _Recorder:
    def __init__(self) -> None:
        self.hits: list[tuple[str, bytes]] = []
        self.file_posts = 0
        self.blob_posts = 0
        self.upload_url = ""

    def record(self, path: str, body: bytes, method: str) -> bytes:
        if method == "PUT":
            self.hits.append((path, body))
        if method == "POST" and path.endswith("/files"):
            self.file_posts += 1
        if method == "POST" and path.endswith("/blobs"):
            self.blob_posts += 1
        if path.endswith("/claim"):
            return json.dumps(
                {"claimed": True, "executionId": EXECUTION, "state": "running"}
            ).encode()
        if path.endswith("/files"):
            return json.dumps(
                {
                    "artifactId": FILE,
                    "state": "pending",
                    "uploadUrl": self.upload_url,
                    "headers": {"x-vercel-blob-access": "private"},
                }
            ).encode()
        if path.endswith("/blobs"):
            return json.dumps(
                {
                    "status": "upload",
                    "method": "PUT",
                    "url": self.upload_url,
                    "headers": {"content-type": "text/plain"},
                    "ref": {"content_type": "text/plain"},
                }
            ).encode()
        return b"{}"


def _serve(recorder: _Recorder, tls: dict[str, Path] | None, host: str = "127.0.0.1"):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self._answer()

        def do_POST(self):
            self._answer()

        def do_PUT(self):
            self._answer()

        def log_message(self, *_args):
            return

        def _answer(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            payload = recorder.record(self.path, body, self.command)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    class Bound(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

    server = Bound((host, 0), Handler)
    if tls is not None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls["cert"], tls["key"])
        server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    return server, thread


def _handler(base_url: str) -> ManagedTargetHandler:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    def target(_context):
        return ManagedTargetResult(
            output="synthetic model output",
            files=(ManagedOutputFile("answer.txt", "text/plain", OUTPUT, primary=True),),
        )

    def flush():
        provider.force_flush()

    return ManagedTargetHandler(
        machine_credential="synthetic-machine",
        base_url=base_url,
        target=target,
        flush_telemetry=flush,
        tracer=provider.get_tracer("upload-destination"),
    )


def _assert_managed(upload_url: str, sink: _Recorder, api: _Recorder, server, thread) -> None:
    api.upload_url = upload_url
    try:
        _handler(f"https://{API_HOST}:{server.server_port}").handle(_invocation(), HEADERS)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert api.file_posts == 1
    assert sink.hits == []


def test_remote_managed_api_cannot_put_output_on_loopback_http(material):
    sink_record = _Recorder()
    sink, thread = _serve(sink_record, None)
    api_record = _Recorder()
    api, api_thread = _serve(api_record, material)
    try:
        _assert_managed(
            f"http://127.0.0.1:{sink.server_port}/out", sink_record, api_record, api, api_thread
        )
    finally:
        sink.shutdown()
        sink.server_close()
        thread.join(timeout=2)


def test_remote_managed_api_cannot_put_output_on_localhost_or_ipv6(material):
    for url_of in (
        lambda port: f"http://localhost:{port}/out",
        lambda port: f"http://[::1]:{port}/out",
    ):
        host = "::1" if "[::1]" in url_of(1) else "127.0.0.1"
        sink_record = _Recorder()
        sink, thread = _serve(sink_record, None, host)
        api_record = _Recorder()
        api, api_thread = _serve(api_record, material)
        try:
            _assert_managed(url_of(sink.server_port), sink_record, api_record, api, api_thread)
        finally:
            sink.shutdown()
            sink.server_close()
            thread.join(timeout=2)


def test_remote_managed_api_cannot_put_output_on_https_loopback(material):
    cases = (
        ("127.0.0.1", lambda port: f"https://127.0.0.1:{port}/out"),
        ("127.0.0.1", lambda port: f"https://127.1:{port}/out"),
        ("127.0.0.1", lambda port: f"https://0x7f.0.0.1:{port}/out"),
        ("127.0.0.2", lambda port: f"https://127.0.0.2:{port}/out"),
    )
    for host, url_of in cases:
        sink_record = _Recorder()
        sink, thread = _serve(sink_record, material, host)
        api_record = _Recorder()
        api, api_thread = _serve(api_record, material)
        try:
            _assert_managed(url_of(sink.server_port), sink_record, api_record, api, api_thread)
        finally:
            sink.shutdown()
            sink.server_close()
            thread.join(timeout=2)


def test_rebinding_name_does_not_receive_managed_output(material):
    sink_record = _Recorder()
    sink, thread = _serve(sink_record, material)
    api_record = _Recorder()
    api, api_thread = _serve(api_record, material)
    try:
        _assert_managed(
            f"https://{REBINDING_HOST}:{sink.server_port}/out",
            sink_record,
            api_record,
            api,
            api_thread,
        )
    finally:
        sink.shutdown()
        sink.server_close()
        thread.join(timeout=2)


def test_remote_evaluation_origin_cannot_put_artifact_bytes(material):
    client = EvaluationClient(f"https://{API_HOST}", api_key="synthetic-project-key")
    cases = (
        ("127.0.0.1", False, lambda port: f"http://127.0.0.1:{port}/out"),
        ("127.0.0.1", True, lambda port: f"https://127.0.0.1:{port}/out"),
        ("127.0.0.1", True, lambda port: f"https://127.1:{port}/out"),
        ("127.0.0.1", True, lambda port: f"https://{REBINDING_HOST}:{port}/out"),
    )
    for host, tls, url_of in cases:
        sink_record = _Recorder()
        sink, thread = _serve(sink_record, material if tls else None, host)
        upload = {
            "uploadUrl": url_of(sink.server_port),
            "method": "PUT",
            "headers": {"content-type": "text/plain"},
            "expiresAt": "2099-01-01T00:00:00Z",
        }
        with pytest.raises(HueApiError):
            client.upload_artifact_bytes(upload, OUTPUT, "text/plain")
        sink.shutdown()
        sink.server_close()
        thread.join(timeout=2)
        assert sink_record.hits == []


def test_remote_trace_origin_cannot_put_blob_bytes_on_loopback_or_a_rebinding_name(material):
    digest = (hashlib.sha256(OUTPUT).hexdigest(), len(OUTPUT))
    cases = (
        ("127.0.0.1", False, lambda port: f"http://127.0.0.1:{port}/out"),
        ("127.0.0.2", False, lambda port: f"http://127.0.0.2:{port}/out"),
        ("127.0.0.1", True, lambda port: f"https://{REBINDING_HOST}:{port}/out"),
    )
    for host, tls, url_of in cases:
        sink_record = _Recorder()
        sink, thread = _serve(sink_record, material if tls else None, host)
        api_record = _Recorder()
        api, api_thread = _serve(api_record, material)
        api_record.upload_url = url_of(sink.server_port)
        uploader = BlobUploader(
            f"https://{API_HOST}:{api.server_port}",
            {"Authorization": "Bearer synthetic-project-key"},
            5,
        )
        try:
            uploader.store(TRACE, "output", OUTPUT, "text/plain", digest)
        finally:
            uploader.close()
            api.shutdown()
            api.server_close()
            api_thread.join(timeout=2)
            sink.shutdown()
            sink.server_close()
            thread.join(timeout=2)
        assert api_record.blob_posts == 1
        assert sink_record.hits == []
