"""Which target failures are the agent's own and which a service or world stopped."""

from __future__ import annotations

import asyncio
import socket
import sys
from types import SimpleNamespace

import pytest
import requests

from hue_sdk.environment import HueEnvironmentError, WorldCreationError
from hue_sdk.evals import HueApiError
from hue_sdk.evals._failure import error_type


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
    # A refusal the caller caused (configuration, a missing gateway, a bad key) is its own.
    for error in (
        HueEnvironmentError(409, None, "simulation_gateway_required"),
        HueApiError(401),
        HueApiError(404),
    ):
        assert error_type(error) == "TargetError"


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
