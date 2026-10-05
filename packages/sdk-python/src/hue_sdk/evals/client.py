from __future__ import annotations

import json
import math
import random
import re
import time
from typing import Any
from urllib.parse import urlencode

import requests

from ..transport import DEFAULT_BASE_URL, normalize_base_url, reject_positional_api_key
from ._json import MISSING, encode, json_value, uuid


def _tag_names(tags: list[str]) -> list[str]:
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise ValueError("tags must be a list of tag names.")
    return tags


def _tagged(tags: list[str] | None) -> dict[str, Any]:
    return {} if tags is None else {"tags": _tag_names(tags)}


class HueApiError(RuntimeError):
    """A failed evaluation API request; the message is fixed and never includes response text.

    ``status`` is the HTTP status when Hue answered, ``None`` for a connection, timeout or
    parsing failure. ``retry_after_seconds`` is the wait Hue asked for (``Retry-After`` on a 429
    or 503) when it said. ``diagnostic`` is Hue's ``X-Hue-Diagnostic`` code, which tells refusals
    of one status apart, when it sent one.
    """

    status: int | None
    retry_after_seconds: int | None
    diagnostic: str | None
    reason: str | None

    def __init__(
        self,
        status: int | None = None,
        retry_after_seconds: int | None = None,
        diagnostic: str | None = None,
        *,
        reason: str | None = None,
    ) -> None:
        self.status = status
        self.retry_after_seconds = retry_after_seconds
        self.diagnostic = diagnostic
        # ``malformed_response``: Hue answered, but with a body the client refused (oversized or
        # not the JSON it expected); sending the request again would not change it.
        self.reason = reason
        super().__init__(
            f"Hue API request failed (HTTP {status}{f', {diagnostic}' if diagnostic else ''})."
            if status
            else "Hue API connection or response failed."
        )


_TRANSIENT_STATUSES = frozenset((408, 429, 500, 502, 503, 504))


def is_transient_api_error(error: object) -> bool:
    """Whether the same request, sent again, can succeed.

    A connection failure, a timeout, or a status Hue answers while it cannot act yet (408, 429,
    500, 502, 503, 504) is transient. A refusal Hue decided on, any other 4xx, is not, and no
    number of attempts changes it.
    """
    return (
        isinstance(error, HueApiError)
        and error.reason is None
        and (error.status is None or error.status in _TRANSIENT_STATUSES)
    )


_DIAGNOSTIC = re.compile(r"[a-z_]{1,64}")


def _diagnostic_of(response: requests.Response) -> str | None:
    value = response.headers.get("X-Hue-Diagnostic")
    return value if value is not None and _DIAGNOSTIC.fullmatch(value) else None


def _retryable(method: str, body: Any, idempotent: bool) -> bool:
    """Whether a request may be sent again after a transient failure.

    Every read, an update that sets fields to given values (sent twice, it changes nothing more)
    and a mutation the server deduplicates by the ``idempotencyKey`` in its body. Any other
    mutation is sent once; its caller resolves the outcome before asking again.
    """
    if method == "GET" or idempotent:
        return True
    return isinstance(body, dict) and isinstance(body.get("idempotencyKey"), str)


_REGISTRY_FIELD_ALIASES = (
    ("datasetId", "evalSetId"),
    ("datasetVersionId", "evalSetVersionId"),
    ("scorerId", "evaluatorId"),
    ("scorerVersionId", "evaluatorVersionId"),
)
_REGISTRY_ENVELOPES = frozenset(("items", "item", "versions", "version"))


def _product_registry_fields(value: Any) -> Any:
    """Add product names only to Hue envelopes, leaving customer JSON untouched."""
    if isinstance(value, list):
        return [_product_registry_fields(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = dict(value)
    for key in _REGISTRY_ENVELOPES & result.keys():
        result[key] = _product_registry_fields(result[key])
    for legacy, product in _REGISTRY_FIELD_ALIASES:
        if legacy in result:
            if product in result and result[product] != result[legacy]:
                raise HueApiError()
            result[product] = result[legacy]
    return result


_RUN_FIELD_ALIASES = (
    ("datasetId", "evalSetId"),
    ("datasetName", "evalSetName"),
    ("datasetDisplayName", "evalSetDisplayName"),
    ("datasetVersion", "evalSetVersion"),
    ("datasetVersionId", "evalSetVersionId"),
    ("datasetVersionIds", "evalSetVersionIds"),
    ("scorerId", "evaluatorId"),
    ("scorerName", "evaluatorName"),
    ("scorerVersion", "evaluatorVersion"),
    ("scorerVersionId", "evaluatorVersionId"),
    ("scorerVersionIds", "evaluatorVersionIds"),
    ("scorerVersions", "evaluatorVersions"),
    ("evaluationRunId", "scoringId"),
)
_RUN_ENVELOPES = frozenset(
    ("items", "item", "versions", "version", "scorerVersions", "evaluatorVersions")
)


def _product_run_fields(value: Any, kind: str) -> Any:
    """Name Hue run/scoring envelopes without changing customer JSON fields."""
    if isinstance(value, list):
        return [_product_run_fields(item, kind) for item in value]
    if not isinstance(value, dict):
        return value
    result = dict(value)
    for key in _RUN_ENVELOPES & result.keys():
        result[key] = _product_run_fields(result[key], kind)
    for key in ("evaluation", "scoring"):
        if key in result:
            result[key] = _product_run_fields(result[key], "scoring")
    identity_alias = ("runId", "scoringId") if kind == "result" else ("experimentId", "runId")
    aliases = (*_RUN_FIELD_ALIASES, identity_alias)
    for legacy, product in aliases:
        if legacy in result:
            if product in result and result[product] != result[legacy]:
                raise HueApiError()
            result[product] = result[legacy]
    if "evaluation" in result and "scoring" not in result:
        result["scoring"] = result["evaluation"]
    return result


# Times a refused request is sent again before its refusal is the caller's error.
_REFUSAL_RETRIES = 4
# A refusal asking for a longer wait fails at once rather than holding the caller.
_MAX_REFUSAL_RETRY_AFTER_SECONDS = 5


def _retry_after_seconds(response: requests.Response) -> int | None:
    """The whole-second ``Retry-After`` of a 429 or 503, whatever its length, when Hue sent one."""
    if response.status_code not in (429, 503):
        return None
    header = (response.headers.get("Retry-After") or "").strip()
    if not (header.isascii() and header.isdigit()) or len(header) > 6:
        return None
    return int(header)


def _refusal_retry_after(response: requests.Response) -> int | None:
    """The whole-second ``Retry-After`` of a 429 or 503 asking for at most 5 seconds.

    Hue sends one only when it refused the request before acting on it, such as a busy key check,
    so sending any method again is safe. A date, a longer wait or any other failure, a timeout
    included, is not retried.
    """
    if response.status_code not in (429, 503):
        return None
    header = (response.headers.get("Retry-After") or "").strip()
    if not (header.isascii() and header.isdigit()) or len(header) > 6:
        return None
    seconds = int(header)
    return seconds if seconds <= _MAX_REFUSAL_RETRY_AFTER_SECONDS else None


class EvaluationClient:
    """Project-key v1 client. A mutation without an idempotency key is sent once.

    A request Hue refused before acting on it with a short ``Retry-After`` (HTTP 429 or 503, at
    most 5 seconds) is sent again after that wait, up to four times, whatever its method. A read,
    or a mutation the server deduplicates by the ``idempotencyKey`` in its body, is also sent
    again after a connection failure, a timeout or a 408 or 5xx that carried no ``Retry-After``,
    up to ``max_attempts`` (default 4) times with a jittered backoff; ``is_transient_api_error``
    names those failures. A mutation without a key is never sent again implicitly; its caller
    retains the key it would send and resolves the outcome first.

    ``EvaluationClient(api_key=...)`` uses Hue Cloud. ``base_url`` overrides the origin;
    existing ``EvaluationClient(base_url, api_key)`` calls remain supported, and a bare key
    in the first position raises ``TypeError`` naming ``api_key=`` instead.
    Returned dictionaries use the public HTTP contract's camelCase field names.
    Connection/read timeout is bounded; redirects and oversized responses are rejected.
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
        if (
            isinstance(max_attempts, bool)
            or type(max_attempts) is not int
            or not 1 <= max_attempts <= 10
        ):
            raise ValueError("max_attempts must be 1–10.")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts

    def __repr__(self) -> str:
        return "EvaluationClient()"

    def _request(
        self, method: str, path: str, body: Any = MISSING, *, idempotent: bool = False
    ) -> Any:
        payload = None if body is MISSING else encode(json_value(body, 1024 * 1024))
        attempts = self._max_attempts if _retryable(method, body, idempotent) else 1
        attempt = 1
        while True:
            try:
                return self._request_once(method, path, payload)
            except HueApiError as error:
                # A refusal that carried ``Retry-After`` was decided in ``_request_once``: sent
                # again while the wait was short, the caller's error when it was long. This loop
                # covers the failures Hue did not time: a lost connection, a timeout, a 5xx or
                # 408 without the header.
                if (
                    not is_transient_api_error(error)
                    or error.retry_after_seconds is not None
                    or attempt >= attempts
                ):
                    raise
            backoff = min(0.1 * 2 ** (attempt - 1), 2.0)
            time.sleep(backoff + random.random() * backoff)
            attempt += 1

    def _request_once(self, method: str, path: str, payload: bytes | None) -> Any:
        try:
            attempt = 0
            while True:
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
                    delay = _refusal_retry_after(response) if attempt < _REFUSAL_RETRIES else None
                    if delay is None:
                        if not 200 <= response.status_code < 300:
                            raise HueApiError(
                                response.status_code,
                                _retry_after_seconds(response),
                                _diagnostic_of(response),
                            )
                        chunks: list[bytes] = []
                        size = 0
                        for chunk in response.iter_content(chunk_size=8192):
                            size += len(chunk)
                            if size > 4 * 1024 * 1024:
                                raise HueApiError(reason="malformed_response")
                            chunks.append(chunk)
                        return json.loads(
                            b"".join(chunks).decode("utf-8"), parse_constant=_invalid_constant
                        )
                # Never sooner than asked; jitter spreads out parallel requests refused together.
                time.sleep(delay * (1 + random.random() / 2))
                attempt += 1
        except HueApiError:
            raise
        except requests.RequestException:
            raise HueApiError() from None
        except (ValueError, UnicodeError, RecursionError):
            raise HueApiError(reason="malformed_response") from None

    @staticmethod
    def _page(after: str | None, limit: int, tags: list[str] | None = None) -> str:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Page limit must be 1–100.")
        query: list[tuple[str, str | int]] = [("limit", limit)]
        if after is not None:
            query.append(("after", uuid(after)))
        # Items carrying any of the named tags.
        query.extend(("tag", tag) for tag in ([] if tags is None else _tag_names(tags)))
        return "?" + urlencode(query)

    def check_connection(self) -> dict[str, Any]:
        return self._request("GET", "/projects/current")

    def create_dataset(
        self, *, name: str, slug: str, description: str = "", tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Creates a dataset; `tags` names its first tags, creating any the project lacks."""
        return self._request(
            "POST",
            "/datasets",
            {"name": name, "slug": slug, "description": description, **_tagged(tags)},
        )

    def update_dataset(
        self,
        dataset_id: str,
        *,
        name: str | None = None,
        slug: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Renames a dataset or replaces its tags by name; omitted fields stay."""
        return self._request(
            "PATCH",
            f"/datasets/{uuid(dataset_id)}",
            {
                **({"name": name} if name is not None else {}),
                **({"slug": slug} if slug is not None else {}),
                **({"description": description} if description is not None else {}),
                **_tagged(tags),
            },
            idempotent=True,
        )

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        return self._request("GET", f"/datasets/{uuid(dataset_id)}")

    def list_datasets(
        self, *, after: str | None = None, limit: int = 100, tags: list[str] | None = None
    ) -> dict[str, Any]:
        return self._request("GET", f"/datasets{self._page(after, limit, tags)}")

    def create_dataset_version(
        self, dataset_id: str, *, from_version_id: str | None = None
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/datasets/{uuid(dataset_id)}/versions",
            {} if from_version_id is None else {"fromVersionId": uuid(from_version_id)},
        )

    def get_dataset_version(self, version_id: str) -> dict[str, Any]:
        return self._request("GET", f"/dataset-versions/{uuid(version_id)}")

    def list_cases(
        self, version_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return self._request(
            "GET", f"/dataset-versions/{uuid(version_id)}/cases{self._page(after, limit)}"
        )

    def add_case(
        self,
        version_id: str,
        *,
        expected_revision: int,
        external_key: str,
        inputs: Any,
        expected: Any = MISSING,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/dataset-versions/{uuid(version_id)}/cases",
            {
                "expectedRevision": expected_revision,
                "externalKey": external_key,
                "inputs": inputs,
                **({"expected": expected} if expected is not MISSING else {}),
                **({"metadata": metadata} if metadata is not None else {}),
            },
        )

    def freeze_dataset_version(self, version_id: str, expected_revision: int) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/dataset-versions/{uuid(version_id)}/freeze",
            {"expectedRevision": expected_revision},
        )

    def create_scorer(
        self, *, name: str, slug: str, description: str = "", tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Creates a scorer; `tags` names its first tags, creating any the project lacks."""
        return self._request(
            "POST",
            "/scorers",
            {"name": name, "slug": slug, "description": description, **_tagged(tags)},
        )

    def update_scorer(
        self,
        scorer_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Renames a scorer or replaces its tags by name; omitted fields stay."""
        return self._request(
            "PATCH",
            f"/scorers/{uuid(scorer_id)}",
            {
                **({"name": name} if name is not None else {}),
                **({"description": description} if description is not None else {}),
                **_tagged(tags),
            },
            idempotent=True,
        )

    def list_tags(self) -> dict[str, Any]:
        """The project's tags in its order: as people arranged them in Hue, then newer tags."""
        return self._request("GET", "/tags")

    def get_scorer(self, scorer_id: str) -> dict[str, Any]:
        return self._request("GET", f"/scorers/{uuid(scorer_id)}")

    def list_scorers(
        self, *, after: str | None = None, limit: int = 100, tags: list[str] | None = None
    ) -> dict[str, Any]:
        return self._request("GET", f"/scorers{self._page(after, limit, tags)}")

    def publish_scorer_version(self, scorer_id: str, definition: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST", f"/scorers/{uuid(scorer_id)}/versions", {"definition": definition}
        )

    def get_scorer_version(self, version_id: str) -> dict[str, Any]:
        return self._request("GET", f"/scorer-versions/{uuid(version_id)}")

    def create_eval_set(
        self, *, name: str, slug: str, description: str = "", tags: list[str] | None = None
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.create_dataset(name=name, slug=slug, description=description, tags=tags)
        )

    def update_eval_set(
        self,
        eval_set_id: str,
        *,
        name: str | None = None,
        slug: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.update_dataset(
                eval_set_id, name=name, slug=slug, description=description, tags=tags
            )
        )

    def get_eval_set(self, eval_set_id: str) -> dict[str, Any]:
        return _product_registry_fields(self.get_dataset(eval_set_id))

    def list_eval_sets(
        self, *, after: str | None = None, limit: int = 100, tags: list[str] | None = None
    ) -> dict[str, Any]:
        return _product_registry_fields(self.list_datasets(after=after, limit=limit, tags=tags))

    def create_eval_set_version(
        self, eval_set_id: str, *, from_version_id: str | None = None
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.create_dataset_version(eval_set_id, from_version_id=from_version_id)
        )

    def get_eval_set_version(self, version_id: str) -> dict[str, Any]:
        return _product_registry_fields(self.get_dataset_version(version_id))

    def list_eval_set_cases(
        self, version_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return _product_registry_fields(self.list_cases(version_id, after=after, limit=limit))

    def add_eval_set_case(
        self,
        version_id: str,
        *,
        expected_revision: int,
        external_key: str,
        inputs: Any,
        expected: Any = MISSING,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.add_case(
                version_id,
                expected_revision=expected_revision,
                external_key=external_key,
                inputs=inputs,
                expected=expected,
                metadata=metadata,
            )
        )

    def freeze_eval_set_version(self, version_id: str, expected_revision: int) -> dict[str, Any]:
        return _product_registry_fields(self.freeze_dataset_version(version_id, expected_revision))

    def create_evaluator(
        self, *, name: str, slug: str, description: str = "", tags: list[str] | None = None
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.create_scorer(name=name, slug=slug, description=description, tags=tags)
        )

    def update_evaluator(
        self,
        evaluator_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        return _product_registry_fields(
            self.update_scorer(evaluator_id, name=name, description=description, tags=tags)
        )

    def get_evaluator(self, evaluator_id: str) -> dict[str, Any]:
        return _product_registry_fields(self.get_scorer(evaluator_id))

    def list_evaluators(
        self, *, after: str | None = None, limit: int = 100, tags: list[str] | None = None
    ) -> dict[str, Any]:
        return _product_registry_fields(self.list_scorers(after=after, limit=limit, tags=tags))

    def publish_evaluator_version(
        self, evaluator_id: str, definition: dict[str, Any]
    ) -> dict[str, Any]:
        return _product_registry_fields(self.publish_scorer_version(evaluator_id, definition))

    def get_evaluator_version(self, version_id: str) -> dict[str, Any]:
        return _product_registry_fields(self.get_scorer_version(version_id))

    def create_experiment(
        self,
        *,
        idempotency_key: str,
        name: str,
        dataset_version_id: str,
        scorer_version_ids: list[str],
        config: Any,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/experiments",
            {
                "idempotencyKey": idempotency_key,
                "name": name,
                "datasetVersionId": uuid(dataset_version_id),
                "scorerVersionIds": [uuid(i) for i in scorer_version_ids],
                "config": config,
                **_tagged(tags),
            },
        )

    def get_experiment(self, experiment_id: str) -> dict[str, Any]:
        return self._request("GET", f"/experiments/{uuid(experiment_id)}")

    def update_experiment(
        self, experiment_id: str, *, name: str | None = None, tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Renames an experiment or replaces its own tags by name; it also shows its dataset's."""
        return self._request(
            "PATCH",
            f"/experiments/{uuid(experiment_id)}",
            {**({"name": name} if name is not None else {}), **_tagged(tags)},
            idempotent=True,
        )

    def list_experiment_items(
        self, experiment_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return self._request(
            "GET", f"/experiments/{uuid(experiment_id)}/items{self._page(after, limit)}"
        )

    def get_experiment_case(self, experiment_id: str, case_id: str) -> dict[str, Any]:
        return self._request("GET", f"/experiments/{uuid(experiment_id)}/items/{uuid(case_id)}")

    def start_execution(
        self,
        experiment_id: str,
        case_id: str,
        *,
        idempotency_key: str,
        trace_external_id: str | None = None,
        previous_execution_id: str | None = None,
        allow_uncertain_retry: bool = False,
    ) -> dict[str, Any]:
        if type(allow_uncertain_retry) is not bool:
            raise TypeError("allow_uncertain_retry must explicitly be a boolean.")
        return self._request(
            "POST",
            f"/experiments/{uuid(experiment_id)}/items/{uuid(case_id)}/start",
            {
                "idempotencyKey": idempotency_key,
                **({"traceExternalId": trace_external_id} if trace_external_id is not None else {}),
                **(
                    {"previousExecutionId": uuid(previous_execution_id)}
                    if previous_execution_id is not None
                    else {}
                ),
                **({"allowUncertainRetry": True} if allow_uncertain_retry else {}),
            },
        )

    def get_execution(self, execution_id: str) -> dict[str, Any]:
        return self._request("GET", f"/experiment-executions/{uuid(execution_id)}")

    def complete_execution(self, execution_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Payload uses protocol fields, including idempotencyKey and explicit output presence."""
        return self._request(
            "POST", f"/experiment-executions/{uuid(execution_id)}/complete", payload
        )

    def finish_experiment(self, experiment_id: str, idempotency_key: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/experiments/{uuid(experiment_id)}/finish",
            {"idempotencyKey": idempotency_key},
        )

    def create_evaluation_run(
        self,
        *,
        idempotency_key: str,
        name: str,
        subject_ids: list[str],
        scorer_version_ids: list[str],
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/evaluation-runs",
            {
                "idempotencyKey": idempotency_key,
                "name": name,
                "subjectIds": [uuid(i) for i in subject_ids],
                "scorerVersionIds": [uuid(i) for i in scorer_version_ids],
            },
        )

    def get_evaluation_run(self, run_id: str) -> dict[str, Any]:
        return self._request("GET", f"/evaluation-runs/{uuid(run_id)}")

    def list_evaluation_items(
        self, run_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return self._request(
            "GET", f"/evaluation-runs/{uuid(run_id)}/items{self._page(after, limit)}"
        )

    def get_subject(self, subject_id: str) -> dict[str, Any]:
        return self._request("GET", f"/evaluation-subjects/{uuid(subject_id)}")

    def submit_results(
        self, run_id: str, *, idempotency_key: str, results: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/evaluation-runs/{uuid(run_id)}/results",
            {"idempotencyKey": idempotency_key, "results": results},
        )

    def list_results(
        self, run_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return self._request(
            "GET", f"/evaluation-runs/{uuid(run_id)}/results{self._page(after, limit)}"
        )

    def get_result(self, result_id: str) -> dict[str, Any]:
        return self._request("GET", f"/evaluation-results/{uuid(result_id)}")

    def create_run(
        self,
        *,
        idempotency_key: str,
        name: str,
        eval_set_version_id: str,
        evaluator_version_ids: list[str],
        config: Any,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        return _product_run_fields(
            self._request(
                "POST",
                "/experiments",
                {
                    "idempotencyKey": idempotency_key,
                    "name": name,
                    "evalSetVersionId": uuid(eval_set_version_id),
                    "evaluatorVersionIds": [uuid(i) for i in evaluator_version_ids],
                    "config": config,
                    **_tagged(tags),
                },
            ),
            "run",
        )

    def get_run(self, run_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_experiment(run_id), "run")

    def update_run(
        self, run_id: str, *, name: str | None = None, tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Renames a run or replaces its own tags by name; its eval set's tags are not its own."""
        return self.update_experiment(run_id, name=name, tags=tags)

    def list_run_items(
        self, run_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return _product_run_fields(
            self.list_experiment_items(run_id, after=after, limit=limit), "run"
        )

    def get_run_case(self, run_id: str, case_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_experiment_case(run_id, case_id), "run")

    def start_run_execution(
        self,
        run_id: str,
        case_id: str,
        *,
        idempotency_key: str,
        trace_external_id: str | None = None,
        previous_execution_id: str | None = None,
        allow_uncertain_retry: bool = False,
    ) -> dict[str, Any]:
        return _product_run_fields(
            self.start_execution(
                run_id,
                case_id,
                idempotency_key=idempotency_key,
                trace_external_id=trace_external_id,
                previous_execution_id=previous_execution_id,
                allow_uncertain_retry=allow_uncertain_retry,
            ),
            "run",
        )

    def get_run_execution(self, execution_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_execution(execution_id), "run")

    def complete_run_execution(self, execution_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return _product_run_fields(self.complete_execution(execution_id, payload), "run")

    def finish_run(self, run_id: str, idempotency_key: str) -> dict[str, Any]:
        return _product_run_fields(self.finish_experiment(run_id, idempotency_key), "run")

    def create_scoring(
        self,
        *,
        idempotency_key: str,
        name: str,
        subject_ids: list[str],
        evaluator_version_ids: list[str],
    ) -> dict[str, Any]:
        return _product_run_fields(
            self._request(
                "POST",
                "/evaluation-runs",
                {
                    "idempotencyKey": idempotency_key,
                    "name": name,
                    "subjectIds": [uuid(i) for i in subject_ids],
                    "evaluatorVersionIds": [uuid(i) for i in evaluator_version_ids],
                },
            ),
            "scoring",
        )

    def get_scoring(self, scoring_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_evaluation_run(scoring_id), "scoring")

    def list_scorings(self, *, after: str | None = None, limit: int = 100) -> dict[str, Any]:
        return _product_run_fields(
            self._request("GET", f"/evaluation-runs{self._page(after, limit)}"), "scoring"
        )

    def list_scoring_items(
        self, scoring_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return _product_run_fields(
            self.list_evaluation_items(scoring_id, after=after, limit=limit), "scoring"
        )

    def get_scoring_subject(self, subject_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_subject(subject_id), "run")

    def submit_scoring_results(
        self, scoring_id: str, *, idempotency_key: str, results: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return _product_run_fields(
            self._request(
                "POST",
                f"/evaluation-runs/{uuid(scoring_id)}/results",
                {"idempotencyKey": idempotency_key, "results": results},
            ),
            "result",
        )

    def list_scoring_results(
        self, scoring_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return _product_run_fields(
            self.list_results(scoring_id, after=after, limit=limit), "result"
        )

    def get_scoring_result(self, result_id: str) -> dict[str, Any]:
        return _product_run_fields(self.get_result(result_id), "result")

    def create_judge_jobs(
        self, run_id: str, *, idempotency_key: str, jobs: list[dict[str, str]]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/evaluation-runs/{uuid(run_id)}/judge-jobs",
            {"idempotencyKey": idempotency_key, "jobs": jobs},
        )

    def list_judge_jobs(
        self, run_id: str, *, after: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        return self._request(
            "GET", f"/evaluation-runs/{uuid(run_id)}/judge-jobs{self._page(after, limit)}"
        )

    def get_judge_job(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/judge-jobs/{uuid(job_id)}")

    def cancel_judge_job(self, job_id: str, *, reason: str) -> dict[str, Any]:
        return self._request("POST", f"/judge-jobs/{uuid(job_id)}/cancel", {"reason": reason})

    def get_judge_budget(self) -> dict[str, Any]:
        return self._request("GET", "/judge-budget")


def _invalid_constant(_value: str) -> None:
    raise ValueError("Non-finite JSON is unsupported.")
