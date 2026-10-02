"""What a target's raised error shows about why the case stopped, for the execution's error type.

``EnvironmentSetupFailed`` when ``create_run`` could not create the world
(``WorldCreationError``), so no agent acted in it. For a service the agent called that stopped
it: ``ServiceRefused`` for a retryable HTTP status (408, 429 or 5xx) from a model provider, Hue or
another service, such as a rate limit or an outage; ``ConnectionFailed`` for a connection that
failed; ``TimedOut`` for a call that timed out. Hue classes all four as infrastructure.
``ConfigurationRejected`` for any other status Hue's own clients answered with (a 3xx or 4xx: a
key, a project, an environment version or a world Hue refused, an endpoint that redirected), the
caller's configuration, which Hue classes as configuration; an error from Hue's own clients is
never the agent's. ``TargetError``
is the agent's own failure. Errors of optional dependencies (httpx, requests, openai, anthropic)
are recognized by class name, never imported.

A simulated world the agent reaches through its own client answers Hue's gateway refusals with a
status and a diagnostic (``503 authorization_unavailable`` when Hue could not authorize the world
token because its database could not answer, ``503 gateway_failure`` when the gateway failed);
``error_cause`` reads the diagnostic from the answer, the service's own word for what failed,
which the runner records beside the type as the error's ``cause``.
"""

from __future__ import annotations

import asyncio
import errno
import json
import re
from collections.abc import Callable
from typing import Literal

from .client import HueApiError

ErrorType = Literal[
    "EnvironmentSetupFailed",
    "ServiceRefused",
    "ConnectionFailed",
    "TimedOut",
    "ConfigurationRejected",
    "TargetError",
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


def _rejected(error: BaseException) -> bool:
    """A status Hue's own client answered with that is neither a success nor retryable, a 3xx or
    a 4xx: Hue refused the caller's key, project, environment version or world, or the
    configured endpoint redirected (the clients follow none), so the case could not run as
    configured. Only Hue's clients show it; another service's 4xx stays the agent's."""
    if not _hue_error(error):
        return False
    status = getattr(error, "status", None)
    return (
        isinstance(status, int)
        and not isinstance(status, bool)
        and 300 <= status < 500
        and not _retryable(status)
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


# The header Hue's gateway names its diagnostic in, beside the JSON body's ``diagnostic``.
_DIAGNOSTIC_HEADER = "x-hue-diagnostic"
# A diagnostic's spelling: a short lower-case token (``authorization_unavailable``).
_DIAGNOSTIC = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# The most of a body read for a diagnostic.
_MAX_BODY = 8192


def _header_value(headers: object, name: str) -> str | None:
    """A header's value from a mapping with ``get`` (httpx's and requests' are case-insensitive)
    or a plain dict of names to values, matched case-insensitively; None otherwise."""
    if headers is None:
        return None
    get = getattr(headers, "get", None)
    if callable(get):
        value = get(name)
        if value is None and isinstance(headers, dict):
            value = next((v for k, v in headers.items() if str(k).lower() == name), None)
        return value if isinstance(value, str) else None
    return None


def _body_diagnostic(body: object) -> str | None:
    """The ``diagnostic`` a JSON body names: a dict's, or the object a string carries from its
    first brace."""
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    if isinstance(body, str):
        start = body.find("{")
        if start < 0 or len(body) - start > _MAX_BODY:
            return None
        try:
            return _body_diagnostic(json.loads(body[start:]))
        except ValueError:
            return None
    if isinstance(body, dict):
        # Hue's REST refusal names it at the top; its MCP refusal, a JSON-RPC error, in
        # ``error.data``.
        diagnostic = body.get("diagnostic")
        if isinstance(diagnostic, str):
            return diagnostic
        error = body.get("error")
        data = error.get("data") if isinstance(error, dict) else None
        named = data.get("diagnostic") if isinstance(data, dict) else None
        return named if isinstance(named, str) else None
    return None


def _diagnostic_of(error: BaseException) -> str | None:
    """The diagnostic one error carries: the one it names itself (Hue's own clients read the
    header into ``diagnostic``), else the header on its ``headers`` or its ``response``'s, else
    the body on its ``body`` or its ``response``'s text."""
    named = getattr(error, "diagnostic", None)
    if isinstance(named, str):
        return named
    response = getattr(error, "response", None)
    from_header = _header_value(getattr(error, "headers", None), _DIAGNOSTIC_HEADER)
    if from_header is None and response is not None:
        from_header = _header_value(getattr(response, "headers", None), _DIAGNOSTIC_HEADER)
    if from_header is not None:
        return from_header
    from_body = _body_diagnostic(getattr(error, "body", None))
    if from_body is None and response is not None:
        from_body = _body_diagnostic(getattr(response, "text", None))
    return from_body


def error_cause(error: BaseException) -> str | None:
    """The service's own word for what failed, when the answer a target's raise carries names
    one: Hue's gateway diagnostic (``authorization_unavailable``, ``gateway_failure``), read from
    the ``X-Hue-Diagnostic`` header or the JSON body's ``diagnostic`` of any error linked from the
    raise, nearest first. None when no answer names one, or the name is not a diagnostic's
    token. Read for a service failure (``error_type``), where the runner records it as the
    error's ``cause``."""
    for item in _linked(error):
        try:
            diagnostic = _diagnostic_of(item)
        except Exception:
            continue
        if diagnostic is not None and _DIAGNOSTIC.fullmatch(diagnostic):
            return diagnostic
    return None


def error_type(error: BaseException) -> ErrorType:
    """Classify a target's failure by the errors linked from it, in precedence order: a world that
    was never created, a timeout, a failed connection, a retryable refusal, a status Hue's own
    client was refused with, else the agent's."""
    errors = _linked(error)
    if _any(errors, _world_not_created):
        return "EnvironmentSetupFailed"
    if _any(errors, _timed_out):
        return "TimedOut"
    if _any(errors, _disconnected):
        return "ConnectionFailed"
    if _any(errors, _refused):
        return "ServiceRefused"
    if _any(errors, _rejected):
        return "ConfigurationRejected"
    return "TargetError"
