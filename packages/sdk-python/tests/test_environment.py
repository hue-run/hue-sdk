"""World API additions: trace context on create, evidence reads, Retry-After and the handoff."""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

import hue_sdk.environment.client as environment_module
from hue_sdk.environment import (
    EnvironmentClient,
    EnvironmentSealTimeoutError,
    HueEnvironmentError,
    agent_environment,
    is_hue_control_plane_credential,
    legacy_mcp_capability,
    mcp_config_file,
    world_handoff,
)

KEY = "hue_sk_test_kkkkkkkkkkkk_" + "s" * 43
RUN_ID = str(uuid4())
VERSION_ID = str(uuid4())
TOKEN = "hue_world_" + "c" * 64 + "." + "s" * 43
MIRROR = "https://app.hue.test/api/sim/gmailmcp.googleapis.com/mcp/v1"
REST = "https://app.hue.test/api/sim/gmail.googleapis.com/gmail/v1"


def gateway_run(**overrides):
    run = {
        "id": RUN_ID,
        "environmentVersionId": VERSION_ID,
        "clockNs": "0",
        "stateDigest": "a" * 64,
        "maxSteps": 500,
        "expiresAt": "2026-09-24T12:00:00.000Z",
        "actions": [],
        "worldId": RUN_ID,
        "token": TOKEN,
        "lifecycle": "live",
        "completingUntil": None,
        "baggage": f"hue-world={RUN_ID}",
        "traceparent": None,
        "surfaces": [
            {
                "provider": "google.gmail",
                "surface": "google.gmail/mcp",
                "providerInstanceKey": "gmail-primary",
                "url": MIRROR,
                "alias": None,
            },
            {
                "provider": "google.gmail",
                "surface": "google.gmail/rest",
                "providerInstanceKey": "gmail-primary",
                "url": REST,
                "alias": None,
            },
        ],
        "env": {
            "HUE_WORLD_ID": RUN_ID,
            "HUE_WORLD_TOKEN": TOKEN,
            "BAGGAGE": f"hue-world={RUN_ID}",
            "HUE_SIM_GOOGLE_GMAIL_MCP_URL": MIRROR,
            "HUE_SIM_GOOGLE_GMAIL_REST_URL": REST,
        },
        "mcpConfig": {
            "mcpServers": {
                "gmail-primary": {
                    "type": "http",
                    "url": MIRROR,
                    "headers": {"Authorization": f"Bearer {TOKEN}"},
                }
            }
        },
        "connection": None,
    }
    run.update(overrides)
    return run


@pytest.fixture
def backoff(monkeypatch):
    """Capture the client's waits; the HTTP receiver keeps real time."""
    from unittest.mock import patch

    with patch.object(environment_module, "time") as clock:
        monkeypatch.setattr(environment_module.random, "random", lambda: 0.5)
        yield clock.sleep


def reply(receiver, value, status=200, **headers):
    receiver.reply(
        status, json.dumps(value).encode(), **{"Content-Type": "application/json", **headers}
    )


def test_handoff_copies_the_gateway_fields_and_is_absent_for_legacy_worlds():
    run = gateway_run()
    world = world_handoff(run)
    assert world is not None
    assert world["id"] == RUN_ID and world["token"] == TOKEN and world["lifecycle"] == "live"
    assert world["env"]["HUE_SIM_GOOGLE_GMAIL_MCP_URL"] == MIRROR
    world["mcpConfig"]["mcpServers"]["gmail-primary"]["headers"]["Authorization"] = "changed"
    assert run["mcpConfig"]["mcpServers"]["gmail-primary"]["headers"]["Authorization"].startswith(
        "Bearer "
    )
    legacy = gateway_run()
    for field in ("token", "env", "mcpConfig", "surfaces"):
        legacy.pop(field)
    assert world_handoff(legacy) is None


def test_agent_environment_drops_hue_control_plane_credentials_unless_opted_in():
    world = world_handoff(gateway_run())
    assert world is not None
    parent = {
        "PATH": "/usr/bin",
        "OPENAI_API_KEY": "customer-model-key",
        "HUE_API_KEY": KEY,
        "HUE_MCP_KEY": "hue_mcp_project",
        "ANOTHER_KEY": "hue_sk_live_aaaaaaaaaaaa_secret",
        "GRANT": "hue_attempt_" + "a" * 20 + "." + "b" * 43,
        "HUE_BASE_URL": "https://app.hue.test",
        "HUE_WORLD_TOKEN": "stale",
    }
    child = agent_environment(world, parent=parent)
    for name in ("HUE_API_KEY", "HUE_MCP_KEY", "ANOTHER_KEY", "GRANT"):
        assert name not in child
    assert child["PATH"] == "/usr/bin"
    assert child["OPENAI_API_KEY"] == "customer-model-key"
    assert child["HUE_BASE_URL"] == "https://app.hue.test"
    assert child["HUE_WORLD_TOKEN"] == TOKEN
    assert child["HUE_SIM_GOOGLE_GMAIL_MCP_URL"] == MIRROR
    # The retired bridge's names point at the first MCP mirror for one compatibility release.
    assert child["HUE_MCP_URL"] == MIRROR
    assert child["HUE_MCP_TOKEN"] == TOKEN
    assert child["HUE_MCP_EXPIRES_AT"] == world["expiresAt"]
    assert (
        agent_environment(world, parent=parent, include_hue_credentials=True)["HUE_API_KEY"] == KEY
    )
    assert "HUE_MCP_URL" not in agent_environment(world, parent=parent, legacy_mcp_variables=False)
    assert is_hue_control_plane_credential("X", "hue_sk_test_abc_def")
    assert not is_hue_control_plane_credential("X", "sk-live-not-hue")


def test_legacy_projection_uses_the_first_mcp_mirror():
    world = world_handoff(gateway_run())
    assert world is not None
    assert legacy_mcp_capability(world) == {
        "url": MIRROR,
        "token": TOKEN,
        "expiresAt": world["expiresAt"],
    }
    rest_only = {**world, "mcpConfig": {"mcpServers": {}}}
    assert legacy_mcp_capability(rest_only) is None


def test_mcp_config_file_is_owner_only_and_removed_afterwards():
    world = world_handoff(gateway_run())
    assert world is not None
    with mcp_config_file(world) as path:
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
        with open(path, encoding="utf-8") as handle:
            assert json.load(handle) == world["mcpConfig"]
        directory = os.path.dirname(path)
    assert not os.path.exists(directory)


def test_create_forwards_trace_context_and_revision_and_validates_them(receiver):
    client = EnvironmentClient(receiver.url, KEY)
    traceparent = "00-" + "1" * 32 + "-" + "2" * 16 + "-01"
    reply(receiver, gateway_run(traceparent=traceparent), status=201)
    run = client.create_run(
        idempotency_key="execution:abc",
        environment_version_id=VERSION_ID,
        ttl_seconds=600,
        traceparent=traceparent,
        agent_revision="agent@1.2.3",
    )
    assert run["token"] == TOKEN and run["traceparent"] == traceparent
    body = json.loads(receiver.requests[-1][2])
    assert body["traceparent"] == traceparent and body["agentRevision"] == "agent@1.2.3"
    assert body["ttlSeconds"] == 600
    for bad in (
        "01-bad",
        "00-" + "0" * 32 + "-" + "2" * 16 + "-01",
        "00-" + "1" * 32 + "-" + "0" * 16 + "-01",
        "00-" + "1" * 32 + "-" + "2" * 16 + "-ff",
    ):
        with pytest.raises(ValueError):
            client.create_run(
                idempotency_key="k", environment_version_id=VERSION_ID, traceparent=bad
            )
    with pytest.raises(ValueError):
        client.create_run(
            idempotency_key="k", environment_version_id=VERSION_ID, agent_revision="x" * 257
        )
    assert len(receiver.requests) == 1


def test_evidence_read_carries_section_and_bodies(receiver):
    client = EnvironmentClient(receiver.url, KEY)
    reply(receiver, {"worldId": RUN_ID})
    assert client.get_evidence(RUN_ID) == {"worldId": RUN_ID}
    assert (
        receiver.requests[-1][0]
        == f"/api/v1/environment-runs/{RUN_ID}/evidence?section=all&bodies=true"
    )
    reply(receiver, {"worldId": RUN_ID})
    client.get_evidence(RUN_ID, section="ledger", bodies=False)
    assert receiver.requests[-1][0].endswith("?section=ledger&bodies=false")
    with pytest.raises(ValueError):
        client.get_evidence(RUN_ID, section="bodies")  # type: ignore[arg-type]


def test_retry_after_is_honored_and_bounded(receiver, backoff):
    client = EnvironmentClient(receiver.url, KEY, max_attempts=3)
    reply(receiver, {"error": "rate_limited"}, status=429, **{"Retry-After": "1"})
    reply(receiver, {"error": "rate_limited"}, status=503, **{"Retry-After": "99999"})
    reply(receiver, gateway_run(), status=201)
    run = client.create_run(idempotency_key="k", environment_version_id=VERSION_ID)
    assert run["id"] == RUN_ID
    assert [call.args[0] for call in backoff.call_args_list] == [1.0, 10.0]
    reply(receiver, {"error": "sealed"}, status=409, **{"Retry-After": "1"})
    with pytest.raises(HueEnvironmentError) as refused:
        client.finish_run(RUN_ID, idempotency_key="f", status="completed")
    assert refused.value.status == 409 and refused.value.retry_after is None
    assert refused.value.diagnostic is None


def test_refusal_carries_the_diagnostic_code_and_drops_anything_else(receiver):
    client = EnvironmentClient(receiver.url, KEY, max_attempts=1)
    reply(
        receiver,
        {"error": "refused"},
        status=409,
        **{"X-Hue-Diagnostic": "simulation_gateway_required"},
    )
    with pytest.raises(HueEnvironmentError) as typed:
        client.create_run(idempotency_key="k", environment_version_id=VERSION_ID)
    assert typed.value.status == 409
    assert typed.value.diagnostic == "simulation_gateway_required"
    assert str(typed.value) == (
        "Hue environment request failed (HTTP 409, simulation_gateway_required)."
    )
    for hostile in ("Simulation-Gateway", "a b", "x" * 65, "<script>", "\x00"):
        reply(receiver, {"error": "refused"}, status=409, **{"X-Hue-Diagnostic": hostile})
        with pytest.raises(HueEnvironmentError) as dropped:
            client.create_run(idempotency_key="k", environment_version_id=VERSION_ID)
        assert dropped.value.diagnostic is None
        assert str(dropped.value) == "Hue environment request failed (HTTP 409)."


def test_wait_for_seal_reads_past_completion_grace(monkeypatch):
    client = EnvironmentClient("https://app.hue.test", KEY)
    states = iter([{"status": "open"}, {"status": "completed"}])
    sleeps = []
    monkeypatch.setattr(client, "_get_run_once", lambda _run_id, **_: next(states))
    monkeypatch.setattr(environment_module.time, "sleep", lambda seconds: sleeps.append(seconds))
    completing_until = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
    state = client.wait_for_seal(RUN_ID, completing_until=completing_until)
    assert state["status"] == "completed"
    assert sleeps and sleeps[0] > 0


def test_wait_for_seal_retries_transient_reads(monkeypatch):
    client = EnvironmentClient("https://app.hue.test", KEY)
    responses = iter(
        [
            HueEnvironmentError(503, retry_after=1),
            HueEnvironmentError(),
            {"status": "completed"},
        ]
    )

    def read(_run_id):
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(client, "_get_run_once", lambda _run_id, **_: read(_run_id))
    sleeps = []
    monkeypatch.setattr(environment_module.time, "sleep", lambda seconds: sleeps.append(seconds))
    state = client.wait_for_seal(RUN_ID)
    assert state["status"] == "completed"
    assert sleeps[0] == 1


def test_wait_for_seal_honors_retry_after_with_loopback(receiver, monkeypatch):
    client = EnvironmentClient(receiver.url, KEY)
    reply(receiver, {"error": "busy"}, status=429, **{"Retry-After": "1"})
    reply(receiver, gateway_run(status="completed", lifecycle="sealed"))
    sleeps: list[float] = []
    monkeypatch.setattr(environment_module.time, "sleep", sleeps.append)

    state = client.wait_for_seal(RUN_ID)

    assert state["status"] == "completed"
    assert 1.0 in sleeps
    assert len(receiver.requests) == 2


def test_wait_for_seal_deadline_has_distinct_error(receiver, monkeypatch):
    monkeypatch.setattr(environment_module, "SEAL_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(environment_module, "SEAL_POLL_SECONDS", 0.02)
    client = EnvironmentClient(receiver.url, KEY)
    for _ in range(100):
        reply(receiver, gateway_run(status="open", lifecycle="completing"))
    started = time.monotonic()

    with pytest.raises(
        EnvironmentSealTimeoutError, match="was not sealed after its completion grace"
    ) as timed_out:
        client.wait_for_seal(RUN_ID)

    assert timed_out.value.status is None and timed_out.value.run_id == RUN_ID
    assert 0.3 <= time.monotonic() - started < 2
    # It kept reading the open world until the deadline rather than giving up after one read.
    assert len(receiver.requests) > 3


def test_wait_for_seal_cuts_off_a_read_that_never_answers(receiver, monkeypatch):
    monkeypatch.setattr(environment_module, "SEAL_WAIT_SECONDS", 0.3)
    client = EnvironmentClient(receiver.url, KEY)
    receiver.delay_seconds = 2
    reply(receiver, gateway_run(status="completed", lifecycle="sealed"))
    started = time.monotonic()

    with pytest.raises(EnvironmentSealTimeoutError):
        client.wait_for_seal(RUN_ID)

    assert time.monotonic() - started < 1.5
    assert len(receiver.requests) == 1


def test_wait_for_seal_cuts_off_a_read_that_trickles_its_response(receiver, monkeypatch):
    # Each byte arrives well inside the per-read timeout; only elapsed time can end the read.
    monkeypatch.setattr(environment_module, "SEAL_WAIT_SECONDS", 0.3)
    client = EnvironmentClient(receiver.url, KEY)
    receiver.trickle_seconds = 0.05
    reply(receiver, {"status": "completed"})
    started = time.monotonic()

    with pytest.raises(EnvironmentSealTimeoutError):
        client.wait_for_seal(RUN_ID)

    assert time.monotonic() - started < 1.5
    assert len(receiver.requests) == 1


def test_wait_for_seal_cuts_off_a_stalled_tls_handshake(monkeypatch):
    # TLS takes over the connection's socket before its handshake, so a server that trickles
    # one handshake record must still be cut off when the read's window passes.
    monkeypatch.setattr(environment_module, "SEAL_WAIT_SECONDS", 0.3)
    server = socket.create_server(("127.0.0.1", 0))
    stop = threading.Event()

    def trickle():
        connection, _ = server.accept()
        with connection:
            connection.recv(65536)  # the ClientHello
            try:
                # A handshake record header announcing 16 KiB, then its body a byte at a time.
                connection.sendall(b"\x16\x03\x03\x40\x00")
                while not stop.wait(0.05):
                    connection.sendall(b"\x00")
            except OSError:
                pass  # The client shut the connection.

    thread = threading.Thread(target=trickle, daemon=True)
    thread.start()
    shut_down: list[int] = []
    real_shut_down = environment_module._shut_down
    monkeypatch.setattr(
        environment_module,
        "_shut_down",
        lambda sock: (shut_down.append(sock.fileno()), real_shut_down(sock)),
    )
    client = EnvironmentClient(f"https://127.0.0.1:{server.getsockname()[1]}", KEY)
    started = time.monotonic()
    try:
        with pytest.raises(EnvironmentSealTimeoutError):
            client.wait_for_seal(RUN_ID)
        assert time.monotonic() - started < 1.5
        # The deadline ended the handshake on a live socket, not one TLS had already detached.
        assert shut_down and -1 not in shut_down
    finally:
        stop.set()
        thread.join(timeout=5)
        server.close()


def test_bounded_reads_extend_a_proxy_connection_class(receiver, monkeypatch):
    # A SOCKS proxy swaps in its own pool and a connection class that takes proxy options. The
    # read's deadline must extend that class rather than replace it, and still end a slow read.
    # The hook is urllib3's socket factory, verified with urllib3 1.26.20, 2.7.0 and 2.8.0.
    from requests.adapters import HTTPAdapter
    from urllib3.connection import HTTPConnection
    from urllib3.connectionpool import HTTPConnectionPool

    opened: list[str] = []

    class ProxyConnection(HTTPConnection):
        def __init__(self, *args, _proxy_options, **kwargs):
            self._proxy_options = _proxy_options
            super().__init__(*args, **kwargs)

        def _new_conn(self):
            opened.append(self._proxy_options)
            return super()._new_conn()

    class ProxyPool(HTTPConnectionPool):
        ConnectionCls = ProxyConnection

    def proxied(self, request, verify, proxies=None, cert=None):
        parsed = urlsplit(request.url)
        return ProxyPool(parsed.hostname, parsed.port, _proxy_options="tunnel")

    monkeypatch.setattr(HTTPAdapter, "get_connection_with_tls_context", proxied)
    monkeypatch.setattr(environment_module, "SEAL_WAIT_SECONDS", 0.3)
    client = EnvironmentClient(receiver.url, KEY)
    reply(receiver, gateway_run(status="completed", lifecycle="sealed"))
    assert client.wait_for_seal(RUN_ID)["status"] == "completed"

    receiver.trickle_seconds = 0.05
    reply(receiver, {"status": "completed"})
    started = time.monotonic()
    with pytest.raises(EnvironmentSealTimeoutError):
        client.wait_for_seal(RUN_ID)
    assert time.monotonic() - started < 1.5
    assert opened == ["tunnel", "tunnel"]


def test_wait_for_seal_rejects_non_transient_read(monkeypatch):
    client = EnvironmentClient("https://app.hue.test", KEY)
    monkeypatch.setattr(
        client,
        "_get_run_once",
        lambda _run_id, **_: (_ for _ in ()).throw(HueEnvironmentError(404)),
    )
    with pytest.raises(HueEnvironmentError) as refused:
        client.wait_for_seal(RUN_ID)
    assert refused.value.status == 404
