from __future__ import annotations

from importlib.metadata import version

import pytest
import requests
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from hue_sdk import Hue, __version__
from hue_sdk.evals import EvaluationClient

KEY = "synthetic-configuration-key"


def test_cloud_defaults_route_validation_traces_logs_and_evaluations(receiver, monkeypatch):
    # Exercise the real HTTP/protobuf path while keeping every request on loopback.
    original_request = requests.Session.request
    destinations = []

    def route_to_receiver(session, method, url, **kwargs):
        assert url.startswith("https://app.hue.run/api/v1/")
        assert kwargs["allow_redirects"] is False
        destinations.append(url)
        return original_request(
            session, method, receiver.url + url.removeprefix("https://app.hue.run"), **kwargs
        )

    monkeypatch.setattr(requests.Session, "request", route_to_receiver)
    with Hue(api_key=KEY, capture_content=False) as hue:
        client = EvaluationClient(api_key=KEY)
        assert receiver.requests == []  # Construction does not make network requests.
        assert hue.base_url == client.base_url == "https://app.hue.run"
        assert hue.validate_project().slug == client.check_connection()["slug"]
        with hue.span("configured-default") as span:
            span.set_input("content-must-stay-private")
            span.log_inference(output="content-must-stay-private")
        assert hue.force_flush()

    assert len(destinations) == 4
    assert {url.removeprefix("https://app.hue.run") for url in destinations} == {
        "/api/v1/projects/current",
        "/api/v1/otlp/v1/traces",
        "/api/v1/otlp/v1/logs",
    }
    assert len(receiver.spans()) == len(receiver.logs()) == 1
    assert __version__ == version("hue-run")
    for path, headers, body in receiver.requests:
        assert headers["Authorization"] == f"Bearer {KEY}"
        assert b"content-must-stay-private" not in body
        if path.endswith("/traces"):
            message = ExportTraceServiceRequest.FromString(body)
            scope = message.resource_spans[0].scope_spans[0].scope
            assert scope.name == "hue-run" and scope.version == __version__
        elif path.endswith("/logs"):
            message = ExportLogsServiceRequest.FromString(body)
            scope = message.resource_logs[0].scope_logs[0].scope
            assert scope.name == "hue-run" and scope.version == __version__


@pytest.mark.parametrize("positional", [True, False])
def test_explicit_origin_overrides_cloud_and_preserves_positional_calls(receiver, positional):
    args = (receiver.url + "/", KEY) if positional else ()
    kwargs = {} if positional else {"base_url": receiver.url + "/", "api_key": KEY}
    with Hue(*args, **kwargs, capture_content=False) as hue:
        client = EvaluationClient(*args, **kwargs)
        assert hue.base_url == client.base_url == receiver.url
        assert hue.validate_project().slug == client.check_connection()["slug"]
        with hue.span("configured-override"):
            pass
        assert hue.force_flush()
    assert len(receiver.spans()) == 1
    assert len(receiver.requests) == 3


@pytest.mark.parametrize("client_class", [Hue, EvaluationClient])
@pytest.mark.parametrize(
    "base_url",
    [
        None,
        "",
        "http://example.test",
        "https://example.test/api/v1",
        "https://example.test?key=secret",
    ],
)
def test_invalid_explicit_origin_does_not_fall_back_to_cloud(client_class, base_url):
    options = {"capture_content": False} if client_class is Hue else {}
    with pytest.raises(ValueError) as error:
        client_class(base_url=base_url, api_key=KEY, **options)
    assert "secret" not in str(error.value)
    assert KEY not in str(error.value)


@pytest.mark.parametrize("client_class", [Hue, EvaluationClient])
@pytest.mark.parametrize(
    "key_options", [{}, {"api_key": None}, {"api_key": ""}, {"api_key": "a b"}]
)
def test_cloud_default_still_requires_valid_explicit_key(client_class, key_options):
    options = {"capture_content": False} if client_class is Hue else {}
    with pytest.raises(ValueError, match="api_key must be"):
        client_class(**key_options, **options)
