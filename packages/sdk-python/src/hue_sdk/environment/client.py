from __future__ import annotations

import json
import math
import random
import re
import time
from typing import Any, cast
from urllib.parse import urlencode

import requests

from ..evals._json import MISSING, encode, json_value, uuid
from ..transport import DEFAULT_BASE_URL, normalize_base_url, reject_positional_api_key
from .types import (
    ActionResult,
    CoverageGapResult,
    EnvironmentRun,
    FinishStatus,
    Json,
    RunState,
    SealedRun,
    StepPage,
    WorldEvidenceSection,
)

_RETRYABLE = frozenset({408, 429, 500, 502, 503, 504})
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# A Retry-After longer than this waits this long: the gateway asks for 1 s, never minutes.
_MAX_RETRY_AFTER_SECONDS = 10.0
# Version 00 reserves the high six trace-flags bits; only the low two are currently defined.
_TRACEPARENT = re.compile(r"^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-0[0-3]$")
_EVIDENCE_SECTIONS = ("all", "start", "end", "diff", "ledger")


class HueEnvironmentError(RuntimeError):
    """Sanitized transport/refusal error; response bodies and credentials are never included."""

    def __init__(self, status: int | None = None, retry_after: float | None = None) -> None:
        self.status = status
        # The server's Retry-After in seconds, bounded, when a 429 or 503 carried one.
        self.retry_after = retry_after
        super().__init__(
            f"Hue environment request failed (HTTP {status})."
            if status is not None
            else "Hue environment connection or response failed."
        )


def _retry_after(response: requests.Response) -> float | None:
    """Whole seconds only, as the gateway sends them; a date or garbage is ignored."""
    if response.status_code not in (429, 503):
        return None
    header = (response.headers.get("Retry-After") or "").strip()
    if not header.isdigit() or len(header) > 6:
        return None
    return min(float(header), _MAX_RETRY_AFTER_SECONDS)


def _invalid_constant(_value: str) -> None:
    raise ValueError("Invalid JSON constant.")


class EnvironmentClient:
    """Synchronous project-key client for Hue's authoritative simulated worlds.

    ``EnvironmentClient(api_key=...)`` uses Hue Cloud; ``base_url`` overrides the origin, and a
    bare key in the first position raises ``TypeError`` naming ``api_key=`` instead. Unlike
    ``EvaluationClient``, this client retries mutations: all carry an identity the World API
    deduplicates, and it waits Hue's ``Retry-After`` on 429 and 503. Responses retain the HTTP
    camelCase keys.
    """

    base_url: str

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        *,
        timeout_seconds: float = 10,
        max_attempts: int = 4,
    ) -> None:
        reject_positional_api_key(base_url)
        self.base_url = normalize_base_url(base_url)
        if not isinstance(api_key, str) or not api_key or any(c.isspace() for c in api_key):
            raise ValueError("api_key must be a nonempty project service key without whitespace.")
        if (
            type(timeout_seconds) not in (int, float)
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0
        ):
            raise ValueError("timeout_seconds must be positive and finite.")
        if type(max_attempts) is not int or not 1 <= max_attempts <= 10:
            raise ValueError("max_attempts must be 1–10.")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts

    def __repr__(self) -> str:
        return "EnvironmentClient()"

    def _send(self, method: str, path: str, payload: bytes | None) -> Any:
        try:
            with requests.request(
                method,
                f"{self.base_url}/api/v1{path}",
                data=payload,
                headers={
                    **self._headers,
                    **({"Content-Type": "application/json"} if payload is not None else {}),
                },
                timeout=self._timeout,
                allow_redirects=False,
                stream=True,
            ) as response:
                if not 200 <= response.status_code < 300:
                    raise HueEnvironmentError(response.status_code, _retry_after(response))
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_content(chunk_size=8192):
                    size += len(chunk)
                    if size > _MAX_RESPONSE_BYTES:
                        raise HueEnvironmentError()
                    chunks.append(chunk)
                return json.loads(
                    b"".join(chunks).decode("utf-8"), parse_constant=_invalid_constant
                )
        except HueEnvironmentError:
            raise
        except (requests.RequestException, ValueError, UnicodeError, RecursionError):
            raise HueEnvironmentError() from None

    def _request(self, method: str, path: str, body: Any = MISSING) -> Any:
        # Validate/serialize before retrying. Neither caller mutation nor another
        # attempt can change these bytes, the invocation ID, or the idempotency key.
        payload = None if body is MISSING else encode(json_value(body, 1024 * 1024))
        for attempt in range(self._max_attempts):
            try:
                return self._send(method, path, payload)
            except HueEnvironmentError as error:
                if (
                    error.status is not None and error.status not in _RETRYABLE
                ) or attempt + 1 == self._max_attempts:
                    raise
                # The gateway's admission refusals say how long to wait; anything else backs off.
                backoff = min(0.1 * 2**attempt, 2)
                time.sleep(
                    error.retry_after
                    if error.retry_after is not None
                    else backoff + random.random() * backoff
                )
        raise AssertionError("Unreachable")

    def create_run(
        self,
        *,
        idempotency_key: str,
        environment_version_id: str,
        execution_id: str | None = None,
        seed: str | None = None,
        max_steps: int | None = None,
        ttl_seconds: int | None = None,
        traceparent: str | None = None,
        agent_revision: str | None = None,
    ) -> EnvironmentRun:
        """Create or replay a world. `traceparent` is the case span's W3C context; its trace ID
        must equal the trace the execution declared. `agent_revision` (1–256 characters) joins
        the world's fingerprint. Both are part of the idempotency digest."""
        if traceparent is not None and not (
            isinstance(traceparent, str) and _TRACEPARENT.match(traceparent)
        ):
            raise ValueError("traceparent must be a version-00 W3C trace context.")
        if agent_revision is not None and not (
            isinstance(agent_revision, str) and 1 <= len(agent_revision) <= 256
        ):
            raise ValueError("agent_revision must be 1–256 characters.")
        return self._request(
            "POST",
            "/environment-runs",
            {
                "idempotencyKey": idempotency_key,
                "environmentVersionId": uuid(environment_version_id),
                **({"executionId": uuid(execution_id)} if execution_id is not None else {}),
                **({"seed": seed} if seed is not None else {}),
                **({"maxSteps": max_steps} if max_steps is not None else {}),
                **({"ttlSeconds": ttl_seconds} if ttl_seconds is not None else {}),
                **({"traceparent": traceparent} if traceparent is not None else {}),
                **({"agentRevision": agent_revision} if agent_revision is not None else {}),
            },
        )

    def get_run(self, run_id: str) -> RunState:
        run = self._request("GET", f"/environment-runs/{uuid(run_id)}")
        state: dict[str, Any] = {"validity": "not_assessed", "coverageGap": None}
        state.update(run)
        return cast(RunState, state)

    def record_coverage_gap(
        self,
        run_id: str,
        *,
        idempotency_key: str,
        provider: str,
        operation: str,
        code: str,
        args: dict[str, Json],
        description: str,
    ) -> CoverageGapResult:
        """Record a known gap; transport retries preserve the supplied durable identity."""
        if type(args) is not dict:
            raise ValueError("Coverage gap arguments must be a JSON object.")
        json_value(args, 16_000)
        return self._request(
            "POST",
            f"/environment-runs/{uuid(run_id)}/coverage-gap",
            {
                "idempotencyKey": uuid(idempotency_key),
                "provider": provider,
                "operation": operation,
                "code": code,
                "args": args,
                "description": description,
            },
        )

    def act(
        self,
        run_id: str,
        *,
        invocation_id: str,
        action: str,
        args: dict[str, Json] | None = None,
    ) -> ActionResult:
        """Repeat the same identity and arguments to replay a recorded invocation."""
        return self._request(
            "POST",
            f"/environment-runs/{uuid(run_id)}/actions",
            {
                "invocationId": uuid(invocation_id),
                "action": action,
                "args": {} if args is None else args,
            },
        )

    def list_steps(
        self, run_id: str, *, after: int | None = None, limit: int | None = None
    ) -> StepPage:
        """Page by numeric step ordinal (including zero), never by step UUID."""
        query: dict[str, int] = {}
        if after is not None:
            if type(after) is not int or after < -1:
                raise ValueError("Step cursor must be an ordinal.")
            query["after"] = after
        if limit is not None:
            if type(limit) is not int or not 1 <= limit <= 100:
                raise ValueError("Page limit must be 1–100.")
            query["limit"] = limit
        suffix = "?" + urlencode(query) if query else ""
        return self._request("GET", f"/environment-runs/{uuid(run_id)}/steps{suffix}")

    def finish_run(self, run_id: str, *, idempotency_key: str, status: FinishStatus) -> SealedRun:
        return self._request(
            "POST",
            f"/environment-runs/{uuid(run_id)}/finish",
            {"idempotencyKey": idempotency_key, "status": status},
        )

    def get_evidence(
        self,
        run_id: str,
        *,
        section: WorldEvidenceSection = "all",
        bodies: bool = True,
    ) -> dict[str, Any]:
        """The evaluator-only evidence of a sealed world: a project key reads it, a world token
        never does; an open world answers 409 until it is sealed. The server's shape is the
        authority (docs/simulation-gateway-evidence.md in Fern)."""
        if section not in _EVIDENCE_SECTIONS:
            raise ValueError("section must be all, start, end, diff or ledger.")
        if type(bodies) is not bool:
            raise TypeError("bodies must be a boolean.")
        query = urlencode({"section": section, "bodies": "true" if bodies else "false"})
        return self._request("GET", f"/environment-runs/{uuid(run_id)}/evidence?{query}")
