from __future__ import annotations

import json

import pytest
import requests

from hue_sdk import Hue

URL = "https://backend.composio.dev/v3/mcp/synthetic-server/mcp?user_id=synthetic-user"
ENDPOINT = {
    "url": URL,
    "source": "client_config",
    "method": "POST",
    "capture_query_parameters": ["user_id"],
}
RESULT = {"kind": "sync", "result": json.dumps({"successful": True, "data": {"items": []}})}


def record(receiver, endpoint=None, **options):
    hue = Hue(receiver.url, "synthetic-endpoint-key", **options)
    calls = 0
    try:
        with hue.tool("mcp_read", endpoint=endpoint) as span:
            span.set_input({"tool": "SYNTHETIC_LIST", "arguments": {}})
            calls += 1
            result = RESULT
            span.set_output(result)
        assert result is RESULT
        assert calls == 1
        hue.force_flush()
        return {
            a.key: a.value.string_value for a in receiver.spans()[-1].attributes
        }, hue.export_status
    finally:
        hue.shutdown_safe()


def test_endpoint_is_opt_in(receiver):
    attributes, _ = record(receiver)
    assert "url.full" not in attributes
    assert json.loads(attributes["gen_ai.tool.call.result"]) == RESULT


@pytest.mark.parametrize(
    "path",
    [
        "/api/v3/tools/execute/SYNTHETIC_LIST",
        "/tool_router/session/synthetic-session/mcp",
        "/v3/mcp/synthetic-server/mcp",
    ],
)
def test_configured_endpoint_provenance(receiver, path):
    target = f"https://backend.composio.dev{path}?user_id=synthetic-user"
    attributes, status = record(receiver, {**ENDPOINT, "url": target})
    assert attributes["url.full"] == target
    assert attributes["http.request.method"] == "POST"
    assert attributes["hue.tool.endpoint.source"] == "client_config"
    assert status.instrumentation_failures == 0


def test_duplicate_and_empty_selectors_preserved_credentials_removed(receiver):
    target = (
        URL.replace("https://", "https://synthetic-login:synthetic-password@")
        + "&user_id=second&user_id=&api_key=synthetic-secret"
        "&other=synthetic-private#synthetic-fragment"
    )
    attributes, _ = record(receiver, {**ENDPOINT, "url": target})
    assert attributes["url.full"] == URL + "&user_id=second&user_id="
    for marker in [
        b"synthetic-login",
        b"synthetic-password",
        b"synthetic-secret",
        b"synthetic-private",
        b"synthetic-fragment",
    ]:
        assert all(marker not in body for _, _, body in receiver.requests)


def test_no_allowlist_and_no_method(receiver):
    attributes, _ = record(receiver, {"url": URL, "source": "receipt"})
    assert attributes["url.full"] == URL.split("?")[0]
    assert "http.request.method" not in attributes


def test_metadata_only_omits_endpoint(receiver):
    attributes, _ = record(receiver, ENDPOINT, capture_content=False)
    for key in ["url.full", "http.request.method", "hue.tool.endpoint.source"]:
        assert key not in attributes
    assert all(b"synthetic-user" not in body for _, _, body in receiver.requests)


def test_existing_redactor_controls_url(receiver):
    attributes, _ = record(
        receiver,
        ENDPOINT,
        redactor=lambda field, value: (
            value.replace("synthetic-user", "[redacted]") if field == "url.full" else value
        ),
    )
    assert attributes["url.full"] == URL.replace("synthetic-user", "[redacted]")
    assert all(b"synthetic-user" not in body for _, _, body in receiver.requests)


@pytest.mark.parametrize(
    "endpoint",
    [
        {**ENDPOINT, "url": "not a URL"},
        {**ENDPOINT, "url": URL + "%GG"},
        {**ENDPOINT, "url": "https://backend.composio.dev/\nsynthetic"},
        {**ENDPOINT, "capture_query_parameters": ["api_key"]},
        {**ENDPOINT, "method": "POST\r\nX: bad"},
    ],
)
def test_invalid_evidence_does_not_change_execution(receiver, endpoint):
    attributes, status = record(receiver, endpoint)
    assert "url.full" not in attributes
    assert status.instrumentation_failures > 0


def test_failing_redactor_does_not_change_execution(receiver):
    def redact(field, value):
        if field == "url.full":
            raise ValueError("synthetic-redactor")
        return value

    attributes, status = record(receiver, ENDPOINT, redactor=redact)
    assert "url.full" not in attributes
    assert status.instrumentation_failures > 0


def test_application_error_identity_and_single_execution(receiver):
    error = RuntimeError("synthetic-business-error")
    calls = 0
    with Hue(receiver.url, "synthetic-endpoint-key") as hue:
        with pytest.raises(RuntimeError) as caught:
            with hue.tool("mcp_read", endpoint=ENDPOINT):
                calls += 1
                raise error
        assert hue.force_flush()
    assert caught.value is error
    assert calls == 1


def test_request_evidence_describes_one_local_http_call(receiver):
    receiver.reply(200, json.dumps(RESULT).encode(), **{"Content-Type": "application/json"})
    with Hue(receiver.url, "synthetic-endpoint-key") as hue:
        request = requests.Request(
            "POST", receiver.url + "/mcp?user_id=synthetic-local-user"
        ).prepare()
        with hue.tool(
            "mcp_read",
            endpoint={
                "url": request.url,
                "method": request.method,
                "source": "request",
                "capture_query_parameters": ["user_id"],
            },
        ) as span:
            with requests.Session() as session:
                response = session.send(request)
                result = response.json()
                span.set_output(result)
        assert result == RESULT
        assert hue.force_flush()
    attributes = {a.key: a.value.string_value for a in receiver.spans()[-1].attributes}
    assert attributes["url.full"] == request.url
    assert attributes["http.request.method"] == "POST"
    assert len([path for path, _, _ in receiver.requests if path.startswith("/mcp?")]) == 1
