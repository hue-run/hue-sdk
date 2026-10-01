"""What a target's raised error shows about why the case stopped, for the execution's error type.

``EnvironmentSetupFailed`` when ``create_run`` could not create the world
(``WorldCreationError``), so no agent acted in it. For a service the agent called that stopped
it: ``ServiceRefused`` for a retryable HTTP status (408, 429 or 5xx) from a model provider, Hue or
another service, such as a rate limit or an outage; ``ConnectionFailed`` for a connection that
failed; ``TimedOut`` for a call that timed out. Hue classes all four as infrastructure.
``TargetError`` is the agent's own failure. Errors of optional dependencies (httpx, requests,
openai, anthropic) are recognized by class name, never imported.
"""

from __future__ import annotations

import asyncio
import errno
from collections.abc import Callable
from typing import Literal

from .client import HueApiError

ErrorType = Literal[
    "EnvironmentSetupFailed", "ServiceRefused", "ConnectionFailed", "TimedOut", "TargetError"
]

_TIMEOUT_NAMES = frozenset(
    {"TimeoutException", "ReadTimeout", "ConnectTimeout", "APITimeoutError", "Timeout"}
)
_NETWORK_NAMES = frozenset(
    {"ConnectError", "ConnectionError", "NetworkError", "RemoteProtocolError", "APIConnectionError"}
)
# Links followed from the raised error, and errors read at most.
_MAX_DEPTH = 6
_MAX_ERRORS = 64


def _links(error: BaseException) -> list[object]:
    """``__cause__`` and an exception group's members; an attribute that raises when read links
    nothing. The implicit ``__context__`` is not followed: an agent that handled a rate limit and
    then raised its own error failed on its own."""
    try:
        grouped = getattr(error, "exceptions", None)
        members = list(grouped[:_MAX_ERRORS]) if isinstance(grouped, tuple) else []
        return [error.__cause__, *members]
    except Exception:
        return []


def _linked(error: BaseException) -> list[BaseException]:
    """The raised error and every error within ``_MAX_DEPTH`` links of it, each once, so a cycle
    ends the walk."""
    found: list[BaseException] = []
    seen: set[int] = set()
    level: list[object] = [error]
    for _ in range(_MAX_DEPTH + 1):
        following: list[object] = []
        for item in level:
            if not isinstance(item, BaseException) or id(item) in seen:
                continue
            if len(found) == _MAX_ERRORS:
                return found
            seen.add(id(item))
            found.append(item)
            following += _links(item)
        level = following
    return found


def _names(error: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(error).__mro__}


def _hue_error(error: BaseException) -> bool:
    # Imported here: the environment client imports this package while it initializes.
    from ..environment.client import HueEnvironmentError

    return isinstance(error, (HueApiError, HueEnvironmentError))


def _world_not_created(error: BaseException) -> bool:
    from ..environment.client import WorldCreationError

    return isinstance(error, WorldCreationError)


def _timed_out(error: BaseException) -> bool:
    # A socket that timed out reports ETIMEDOUT; socket.timeout is a TimeoutError since 3.10.
    return (
        isinstance(error, (TimeoutError, asyncio.TimeoutError))
        or getattr(error, "errno", None) == errno.ETIMEDOUT
        or bool(_TIMEOUT_NAMES & _names(error))
    )


def _disconnected(error: BaseException) -> bool:
    # Hue's clients report a request that got no usable response without a status.
    if _hue_error(error) and getattr(error, "status", None) is None:
        return True
    return isinstance(error, ConnectionError) or bool(_NETWORK_NAMES & _names(error))


def _retryable(status: object) -> bool:
    return (
        isinstance(status, int)
        and not isinstance(status, bool)
        and (status in (408, 429) or 500 <= status < 600)
    )


def _refused(error: BaseException) -> bool:
    """A retryable status a service answered with: on Hue's own clients, or on an error that also
    carries the exchange it came from (``response`` in requests, httpx, openai and anthropic;
    ``request_info`` in aiohttp), so an agent's own error that only names a status stays the
    agent's."""
    if _hue_error(error):
        return _retryable(getattr(error, "status", None))
    response = getattr(error, "response", None)
    if response is None and getattr(error, "request_info", None) is None:
        return False
    return (
        _retryable(getattr(error, "status", None))
        or _retryable(getattr(error, "status_code", None))
        or _retryable(getattr(response, "status_code", None))
        or _retryable(getattr(response, "status", None))
    )


def _any(errors: list[BaseException], signal: Callable[[BaseException], bool]) -> bool:
    """Whether any error shows the signal; one whose attributes raise when read shows none."""
    for error in errors:
        try:
            if signal(error):
                return True
        except Exception:
            continue
    return False


def error_type(error: BaseException) -> ErrorType:
    """Classify a target's failure by the errors linked from it, in precedence order: a world that
    was never created, a timeout, a failed connection, a retryable refusal, else the agent's."""
    errors = _linked(error)
    if _any(errors, _world_not_created):
        return "EnvironmentSetupFailed"
    if _any(errors, _timed_out):
        return "TimedOut"
    if _any(errors, _disconnected):
        return "ConnectionFailed"
    if _any(errors, _refused):
        return "ServiceRefused"
    return "TargetError"
