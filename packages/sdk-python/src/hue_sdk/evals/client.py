from __future__ import annotations

import json
import math
from typing import Any
from urllib.parse import urlencode

import requests

from ..transport import normalize_base_url
from ._json import MISSING, encode, json_value, uuid


class HueApiError(RuntimeError):
    def __init__(self, status: int | None = None) -> None:
        self.status = status
        super().__init__(
            f"Hue API request failed (HTTP {status})."
            if status
            else "Hue API connection or response failed."
        )


class EvaluationClient:
    """Project-key v1 client. Mutations never retry implicitly; retain their idempotency keys.

    Returned dictionaries use the public HTTP contract's camelCase field names.
    Connection/read timeout is bounded; redirects and oversized responses are rejected.
    """

    def __init__(self, base_url: str, api_key: str, *, timeout_seconds: float = 10) -> None:
        self.base_url = normalize_base_url(base_url)
        if not isinstance(api_key, str) or not api_key or any(c.isspace() for c in api_key):
            raise ValueError("api_key must be a nonempty project service key without whitespace.")
        if (
            type(timeout_seconds) not in (int, float)
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0
        ):
            raise ValueError("timeout_seconds must be positive and finite.")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._timeout = timeout_seconds

    def __repr__(self) -> str:
        return "EvaluationClient()"

    def _request(self, method: str, path: str, body: Any = MISSING) -> Any:
        payload = None if body is MISSING else encode(json_value(body, 1024 * 1024))
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
                    raise HueApiError(response.status_code)
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_content(chunk_size=8192):
                    size += len(chunk)
                    if size > 4 * 1024 * 1024:
                        raise HueApiError()
                    chunks.append(chunk)
                return json.loads(
                    b"".join(chunks).decode("utf-8"), parse_constant=_invalid_constant
                )
        except HueApiError:
            raise
        except (requests.RequestException, ValueError, UnicodeError, RecursionError):
            raise HueApiError() from None

    @staticmethod
    def _page(after: str | None, limit: int) -> str:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Page limit must be 1–100.")
        return "?" + urlencode(
            {"limit": limit, **({"after": uuid(after)} if after is not None else {})}
        )

    def check_connection(self) -> dict[str, Any]:
        return self._request("GET", "/projects/current")

    def create_dataset(self, *, name: str, slug: str, description: str = "") -> dict[str, Any]:
        return self._request(
            "POST", "/datasets", {"name": name, "slug": slug, "description": description}
        )

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        return self._request("GET", f"/datasets/{uuid(dataset_id)}")

    def list_datasets(self, *, after: str | None = None, limit: int = 100) -> dict[str, Any]:
        return self._request("GET", f"/datasets{self._page(after, limit)}")

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

    def create_scorer(self, *, name: str, slug: str, description: str = "") -> dict[str, Any]:
        return self._request(
            "POST", "/scorers", {"name": name, "slug": slug, "description": description}
        )

    def get_scorer(self, scorer_id: str) -> dict[str, Any]:
        return self._request("GET", f"/scorers/{uuid(scorer_id)}")

    def list_scorers(self, *, after: str | None = None, limit: int = 100) -> dict[str, Any]:
        return self._request("GET", f"/scorers{self._page(after, limit)}")

    def publish_scorer_version(self, scorer_id: str, definition: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST", f"/scorers/{uuid(scorer_id)}/versions", {"definition": definition}
        )

    def get_scorer_version(self, version_id: str) -> dict[str, Any]:
        return self._request("GET", f"/scorer-versions/{uuid(version_id)}")

    def create_experiment(
        self,
        *,
        idempotency_key: str,
        name: str,
        dataset_version_id: str,
        scorer_version_ids: list[str],
        config: Any,
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
            },
        )

    def get_experiment(self, experiment_id: str) -> dict[str, Any]:
        return self._request("GET", f"/experiments/{uuid(experiment_id)}")

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
