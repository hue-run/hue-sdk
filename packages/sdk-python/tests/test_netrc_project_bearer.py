"""Project-key calls must send that bearer when netrc has a matching login.

A default netrc entry, or a machine entry for the request host, is loaded by
requests while trust_env stays on and no auth callable is passed. Basic auth
is applied after the caller sets Authorization, so the project bearer is
replaced. These tests fail until every Hue API session below keeps the bearer.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from hue_sdk import Hue, ProjectValidationError, TraceVerificationError
from hue_sdk.evals import EvaluationClient, HueApiError, MediaFetchError
from hue_sdk.world.client import HueEnvironmentError, WorldClient

PROJECT_KEY = "placeholder-project-key"
NETRC_LOGIN = "placeholder-netrc-user"
NETRC_PASSWORD = "placeholder-netrc-password"
HOST = "127.0.0.1"
TRACE_ID = "a" * 32
SHA256 = "b" * 64
ARTIFACT_ID = "00000000-0000-4000-8000-000000000010"
RUN_ID = "00000000-0000-4000-8000-000000000011"
_PROXY_ENV = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


def _netrc(mode: str) -> str:
    if mode == "default":
        return f"default\nlogin {NETRC_LOGIN}\npassword {NETRC_PASSWORD}\n"
    return f"machine {HOST}\nlogin {NETRC_LOGIN}\npassword {NETRC_PASSWORD}\n"


@pytest.fixture(params=("default", "host"))
def origin(tmp_path, monkeypatch, request):
    """Loopback Hue origin, and a netrc file requests will load for it."""
    netrc_path = tmp_path / "netrc"
    netrc_path.write_text(_netrc(request.param))
    monkeypatch.setenv("NETRC", str(netrc_path))
    for name in _PROXY_ENV:
        monkeypatch.delenv(name, raising=False)

    seen: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._record()

        def do_POST(self) -> None:
            self._record()

        def _record(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            seen.append((self.path, self.headers.get("Authorization")))
            body = b"{}"
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            return

    server = ThreadingHTTPServer((HOST, 0), Handler)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield f"http://{HOST}:{server.server_port}", seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _assert_project_bearer(seen: list[tuple[str, str | None]], *path_suffixes: str) -> None:
    expected = f"Bearer {PROJECT_KEY}"
    matched = [item for item in seen if not path_suffixes or item[0].endswith(path_suffixes)]
    assert matched, "the client made no request"
    assert all(authorization == expected for _, authorization in matched)


def test_evaluation_api_sends_project_bearer(origin) -> None:
    url, seen = origin
    client = EvaluationClient(url, PROJECT_KEY, timeout_seconds=2, max_attempts=1)
    with pytest.raises(HueApiError):
        client.check_connection()
    _assert_project_bearer(seen, "/api/v1/projects/current")


def test_artifact_download_sends_project_bearer(origin) -> None:
    url, seen = origin
    client = EvaluationClient(url, PROJECT_KEY, timeout_seconds=2, max_attempts=1)
    with pytest.raises(HueApiError):
        client.download_artifact(ARTIFACT_ID)
    _assert_project_bearer(seen, f"/api/v1/artifacts/{ARTIFACT_ID}/download")


def test_world_api_sends_project_bearer(origin) -> None:
    url, seen = origin
    client = WorldClient(url, PROJECT_KEY, timeout_seconds=2, max_attempts=1)
    with pytest.raises(HueEnvironmentError):
        client.get_run(RUN_ID)
    _assert_project_bearer(seen, f"/api/v1/instances/{RUN_ID}")


def test_media_grant_sends_project_bearer(origin) -> None:
    url, seen = origin
    client = EvaluationClient(url, PROJECT_KEY, timeout_seconds=2, max_attempts=1)
    with pytest.raises(MediaFetchError):
        client.media.fetch(sha256=SHA256, trace_id=TRACE_ID)
    _assert_project_bearer(seen, f"/api/v1/traces/{TRACE_ID}/blobs/{SHA256}")


def test_trace_receipt_sends_project_bearer(origin) -> None:
    url, seen = origin
    with Hue(
        url,
        PROJECT_KEY,
        capture_content=False,
        capture_http=False,
        live_spans=False,
        export_timeout_seconds=2,
    ) as hue:
        with pytest.raises(TraceVerificationError):
            hue.verify_trace(TRACE_ID, timeout_millis=2_000)
    _assert_project_bearer(seen, f"/api/v1/traces/{TRACE_ID}/receipt")


def test_project_validation_sends_project_bearer(origin) -> None:
    url, seen = origin
    with Hue(
        url,
        PROJECT_KEY,
        capture_content=False,
        capture_http=False,
        live_spans=False,
        export_timeout_seconds=2,
    ) as hue:
        with pytest.raises(ProjectValidationError):
            hue.validate_project()
    _assert_project_bearer(seen, "/api/v1/projects/current")


def test_otlp_export_sends_project_bearer(origin) -> None:
    url, seen = origin
    with Hue(
        url,
        PROJECT_KEY,
        capture_content=True,
        capture_http=False,
        live_spans=False,
        export_timeout_seconds=2,
    ) as hue:
        with hue.span("root") as root:
            root.set_output("placeholder-output")
            with hue.model("placeholder-model", provider="placeholder") as model:
                model.log_inference(output="placeholder-output")
        hue.force_flush(2_000)
    _assert_project_bearer(seen, "/api/v1/otlp/v1/traces")
    _assert_project_bearer(seen, "/api/v1/otlp/v1/logs")
