"""Which target failures are the agent's own and which a service or world stopped."""

from __future__ import annotations

import asyncio
import json
import socket
import sys
from types import SimpleNamespace

import pytest
import requests

from hue_sdk.environment import HueEnvironmentError, WorldCreationError
from hue_sdk.evals import HueApiError
from hue_sdk.evals._failure import error_cause, error_type


# The shapes of httpx, openai and anthropic errors, recognized by class name as the runner does.
class HTTPError(Exception):
    pass


class TimeoutException(HTTPError):
    pass


class ReadTimeout(TimeoutException):
    pass


class TransportError(HTTPError):
    pass


class NetworkError(TransportError):
    pass


class ConnectError(NetworkError):
    pass


class ReadError(NetworkError):
    pass


class RemoteProtocolError(TransportError):
    pass


class HTTPStatusError(HTTPError):
    def __init__(self, status_code: object) -> None:
        super().__init__(f"Server error '{status_code}'")
        self.response = SimpleNamespace(status_code=status_code)


class APIError(Exception):
    pass


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIConnectionError):
    pass


class APIStatusError(APIError):
    def __init__(self, status_code: object) -> None:
        super().__init__(f"Error code: {status_code}")
        self.status_code = status_code
        self.response = SimpleNamespace(status_code=status_code)


def caused(error: BaseException, links: int) -> BaseException:
    """``error`` behind ``links`` ordinary errors, each raised from the next."""
    for index in range(links):
        outer = RuntimeError(f"wrapper {index}")
        outer.__cause__ = error
        error = outer
    return error


def test_hue_clients_without_a_response_failed_to_connect_and_retryable_statuses_refused():
    for error in (HueEnvironmentError(), HueApiError()):
        assert error_type(error) == "ConnectionFailed"
    for error in (
        HueEnvironmentError(503),
        HueEnvironmentError(429, 1.0),
        HueApiError(502),
        HueApiError(408),
    ):
        assert error_type(error) == "ServiceRefused"
    # Any other status Hue answered (a missing gateway, a bad key, a world or version it refused)
    # is the caller's configuration: Hue's own clients never show the agent's error.
    for error in (
        HueEnvironmentError(409, None, "simulation_gateway_required"),
        HueEnvironmentError(400),
        HueApiError(401),
        HueApiError(404),
        HueApiError(422),
    ):
        assert error_type(error) == "ConfigurationRejected"
    assert error_type(caused(HueApiError(404), 3)) == "ConfigurationRejected"
    # The clients follow no redirect and raise the 3xx they got: the configured endpoint's doing.
    assert error_type(HueApiError(302)) == "ConfigurationRejected"
    assert error_type(HueEnvironmentError(308)) == "ConfigurationRejected"
    # Only from Hue's clients: another service's 4xx stays the agent's.
    assert error_type(APIStatusError(404)) == "TargetError"
    assert error_type(APIStatusError(401)) == "TargetError"


def test_a_world_that_could_not_be_created_is_a_setup_failure_whatever_its_status():
    for status in (None, 400, 409, 503):
        error = WorldCreationError(status)
        assert isinstance(error, HueEnvironmentError)
        assert error_type(error) == "EnvironmentSetupFailed"


def test_timeouts_including_connection_timeouts():
    for error in (
        TimeoutError("timed out"),
        asyncio.TimeoutError(),
        ReadTimeout("read timed out"),
        APITimeoutError("Request timed out."),
        requests.Timeout("read timed out"),
        requests.ConnectTimeout("connect timed out"),
    ):
        assert error_type(error) == "TimedOut"


def test_connection_failures():
    for error in (
        ConnectionResetError("reset by peer"),
        ConnectionRefusedError("refused"),
        BrokenPipeError("broken pipe"),
        ConnectError("All connection attempts failed"),
        ReadError("read failed"),
        RemoteProtocolError("Server disconnected without sending a response."),
        APIConnectionError("Connection error."),
    ):
        assert error_type(error) == "ConnectionFailed"
    assert error_type(FileNotFoundError("missing.docx")) == "TargetError"


def test_a_real_refused_connection_failed_to_connect_through_its_chain():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    session = requests.Session()
    session.trust_env = False
    with pytest.raises(requests.ConnectionError) as refused:
        session.get(f"http://127.0.0.1:{port}/", timeout=5)
    # requests' ConnectionError is not the builtin one; it is recognized by its class name.
    assert not isinstance(refused.value, ConnectionError)
    assert error_type(refused.value) == "ConnectionFailed"


def test_retryable_refusals():
    for status in (408, 429, 500, 502, 503, 504, 529, 599):
        assert error_type(APIStatusError(status)) == "ServiceRefused"
        assert error_type(HTTPStatusError(status)) == "ServiceRefused"
    response = requests.Response()
    response.status_code = 503
    assert error_type(requests.HTTPError("503 Server Error", response=response)) == (
        "ServiceRefused"
    )
    for status in (400, 401, 404, 409, 422, 600, "503", True, None):
        assert error_type(APIStatusError(status)) == "TargetError"
        assert error_type(HTTPStatusError(status)) == "TargetError"
    # A status alone, with no exchange it came from, is the agent's own error.
    for name in ("status", "status_code"):
        own = RuntimeError("The agent's 503")
        setattr(own, name, 503)
        assert error_type(own) == "TargetError"


def test_everything_else_is_the_agents_own_target_error():
    for error in (
        RuntimeError("The agent could not draft a reply"),
        ValueError("bad output"),
        KeyError("missing"),
        AssertionError("wrong answer"),
    ):
        assert error_type(error) == "TargetError"


def test_causes_are_walked_six_links_deep_but_an_implicit_context_is_not():
    assert error_type(caused(HueApiError(503), 6)) == "ServiceRefused"
    assert error_type(caused(HueApiError(503), 7)) == "TargetError"
    try:
        try:
            raise ConnectionResetError("reset by peer")
        except ConnectionResetError as reset:
            raise RuntimeError("The model call failed") from reset
    except RuntimeError as error:
        assert error_type(error) == "ConnectionFailed"
    # An agent that handled the reset and then failed on its own is the agent's failure.
    for suppress in (False, True):
        try:
            try:
                raise ConnectionResetError("reset by peer")
            except ConnectionResetError:
                if suppress:
                    raise RuntimeError("The agent gave up") from None
                raise RuntimeError("The agent gave up")  # noqa: B904
        except RuntimeError as error:
            assert error.__context__ is not None
            assert error_type(error) == "TargetError"


def test_the_most_specific_signal_wins():
    signals = {
        "EnvironmentSetupFailed": lambda: WorldCreationError(503),
        "TimedOut": lambda: TimeoutError("timed out"),
        "ConnectionFailed": lambda: ConnectionResetError("reset"),
        "ServiceRefused": lambda: APIStatusError(503),
        "ConfigurationRejected": lambda: HueEnvironmentError(409, None, "world_not_live"),
    }
    order = list(signals)
    for index, expected in enumerate(order):
        present = [signals[name]() for name in order[index:]]
        outer: BaseException = RuntimeError("agent")
        # Each signal is raised from the next, so the least specific one is nearest.
        for error in present:
            error.__cause__ = outer
            outer = error
        assert error_type(outer) == expected


def test_cycles_end_and_an_attribute_that_raises_hides_nothing():
    first, second = RuntimeError("first"), RuntimeError("second")
    first.__cause__, second.__cause__ = second, first
    assert error_type(first) == "TargetError"
    reset = ConnectionResetError("reset")
    second.__cause__, reset.__cause__ = reset, first
    assert error_type(first) == "ConnectionFailed"

    class Hostile(Exception):
        @property
        def response(self):
            raise RuntimeError("no reads")

    assert error_type(Hostile("hostile")) == "TargetError"
    hostile = Hostile("hostile")
    hostile.__cause__ = APIStatusError(503)
    assert error_type(hostile) == "ServiceRefused"


@pytest.mark.skipif(sys.version_info < (3, 11), reason="exception groups are Python 3.11+")
def test_exception_group_members_are_walked():
    group = ExceptionGroup("task group", [ValueError("a"), ConnectError("refused")])  # noqa: F821
    assert error_type(group) == "ConnectionFailed"
    nested = ExceptionGroup("outer", [ValueError("b"), group])  # noqa: F821
    assert error_type(caused(nested, 2)) == "ConnectionFailed"


def test_a_socket_timeout_errno_is_a_timeout_and_a_response_status_alone_refuses():
    import errno

    timed_out = OSError(errno.ETIMEDOUT, "Connection timed out")
    assert error_type(timed_out) == "TimedOut"
    assert error_type(TimeoutError("timed out")) == "TimedOut"

    class _Answered(Exception):
        def __init__(self, status: int) -> None:
            super().__init__(f"HTTP {status}")
            self.response = SimpleNamespace(status=status)

    assert error_type(_Answered(429)) == "ServiceRefused"
    assert error_type(_Answered(503)) == "ServiceRefused"
    assert error_type(_Answered(400)) == "TargetError"


# What Hue's gateway answers a refused call: the diagnostic in the body and the header.
def _gateway_response(status: int, diagnostic: str) -> SimpleNamespace:
    body = {"error": "Simulation gateway request failed", "diagnostic": diagnostic}
    return SimpleNamespace(
        status_code=status, headers={"x-hue-diagnostic": diagnostic}, text=json.dumps(body)
    )


class GatewayStatusError(HTTPError):
    """httpx's status error, as the MCP client raises it: the response on the error."""

    def __init__(self, response: object) -> None:
        super().__init__(f"HTTP {getattr(response, 'status_code', '?')}")
        self.response = response


class _CaseInsensitive(dict):
    def get(self, key, default=None):  # noqa: ANN001
        for name, value in self.items():
            if name.lower() == str(key).lower():
                return value
        return default


def test_a_gateway_refusal_through_the_agents_client_is_the_services_with_its_diagnostic_as_cause():
    refused = GatewayStatusError(_gateway_response(503, "authorization_unavailable"))
    assert error_type(refused) == "ServiceRefused"
    assert error_cause(refused) == "authorization_unavailable"
    # Through a chain, nearest first.
    chained = RuntimeError("tool failed")
    chained.__cause__ = refused
    assert error_cause(chained) == "authorization_unavailable"
    # A bad token, an unknown route or a refused operation is the agent's own error.
    assert error_type(GatewayStatusError(_gateway_response(401, "invalid_token"))) == "TargetError"


def test_the_cause_is_read_from_a_header_a_body_or_hues_own_client():
    # A case-insensitive header mapping, as httpx and requests spell theirs.
    headers = _CaseInsensitive({"X-Hue-Diagnostic": "gateway_failure"})
    on_error = Exception("503")
    on_error.headers = headers  # type: ignore[attr-defined]
    on_error.response = SimpleNamespace(status_code=503)  # type: ignore[attr-defined]
    assert error_cause(on_error) == "gateway_failure"
    # The OpenAI SDK's ``body``.
    with_body = Exception("503")
    with_body.body = {"error": "unavailable", "diagnostic": "authorization_unavailable"}  # type: ignore[attr-defined]
    assert error_cause(with_body) == "authorization_unavailable"
    # A response whose text quotes the body, with no header.
    text_only = GatewayStatusError(
        SimpleNamespace(
            status_code=503, headers={}, text='{"diagnostic": "authorization_unavailable"}'
        )
    )
    assert error_cause(text_only) == "authorization_unavailable"
    # Hue's own clients read the header into ``diagnostic``.
    assert error_cause(HueApiError(503, None, "store_unavailable")) == "store_unavailable"
    assert error_cause(HueEnvironmentError(409, None, "simulation_gateway_required")) == (
        "simulation_gateway_required"
    )


def test_an_answer_naming_no_diagnostic_or_no_token_has_no_cause():
    assert (
        error_cause(GatewayStatusError(SimpleNamespace(status_code=503, headers={}, text="")))
        is None
    )
    assert error_cause(HueApiError(502)) is None
    assert error_cause(RuntimeError('{"diagnostic": "authorization_unavailable"}')) is None
    for diagnostic in ["Not A Token", "a" * 65, "", "x-y"]:
        assert error_cause(GatewayStatusError(_gateway_response(503, diagnostic))) is None
    text_raises = GatewayStatusError(SimpleNamespace(status_code=503, headers={}))

    class _Unread:
        @property
        def text(self) -> str:
            raise RuntimeError("not read")

        headers: dict[str, str] = {}
        status_code = 503

    assert error_cause(GatewayStatusError(_Unread())) is None
    assert error_cause(text_raises) is None
    assert error_cause(ConnectionResetError("reset")) is None
