"""Case files: pinning input files on a case write, and the verified local copies a runner hands
to targets and scorers, as the TypeScript SDK's ``evals/files.ts`` does."""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import warnings
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from time import monotonic, sleep
from typing import Any
from uuid import uuid4

from ._json import uuid
from .client import ArtifactSizeError, EvaluationClient, HueApiError
from .types import CaseFileWrite, LocalFile

# Roles the target receives. Organization templates and evaluator references stay with grading,
# as in the managed protocol.
TARGET_FILE_ROLES = ("source", "attached_template", "attached_reference", "original")
_CASE_FILE_ROLES = (*TARGET_FILE_ROLES, "org_template", "evaluator_reference")
_MAX_CASE_FILES = 32
_MAX_FILE_BYTES = 25 * 1024 * 1024
# The longest file name the runner writes, in UTF-8 bytes.
_MAX_NAME_BYTES = 200


class CaseFileError(RuntimeError):
    """A pinned file whose downloaded bytes differ from the manifest's size or SHA-256
    (``case_file_mismatch``). Raised before the case's execution starts, so no execution or
    target call is spent on it."""

    code: str
    artifact_id: str

    def __init__(self, code: str, artifact_id: str, message: str) -> None:
        self.code = code
        self.artifact_id = artifact_id
        super().__init__(f"{message} ({code})")


@dataclass(frozen=True)
class _Settling:
    """How long an upload waits for Hue to verify one artifact, and how often it looks. Hue
    verifies within a two-minute lease, which can outlast one request's timeout."""

    settle_seconds: float = 180.0
    poll_seconds: float = 1.0
    max_poll_seconds: float = 10.0


ARTIFACT_SETTLING = _Settling()


def _may_still_verify(error: HueApiError) -> bool:
    """A completion failure that can mean Hue is still verifying: a lost or timed-out response,
    a verification already running (409), or a refusal to retry (429, 503)."""
    return error.reason is None and error.status in (None, 409, 429, 503)


def _settle_artifact(client: EvaluationClient, artifact_id: str, timing: _Settling) -> str:
    """Complete an artifact's verification and return the state it settles in, as the
    TypeScript SDK does: a completion that times out, finds verification running or is refused
    for now is followed by a read after a pause; an artifact a retryable refusal left unverified
    is completed again up to three times; all within ``timing.settle_seconds``."""
    deadline = monotonic() + timing.settle_seconds
    known: dict[str, Any] | None = None

    def timed_out(last: dict[str, Any] | None) -> RuntimeError:
        seconds = round(timing.settle_seconds)
        if last is not None and last.get("state") == "verifying":
            return RuntimeError(
                f"Hue was still verifying file {artifact_id} after {seconds} seconds."
            )
        state = f"it was {last.get('state')}" if last else "its state could not be read"
        return RuntimeError(
            f"Hue had not verified file {artifact_id} after {seconds} seconds ({state})."
        )

    pause = timing.poll_seconds
    retries = 0
    while True:
        try:
            return str(client.complete_artifact(artifact_id)["state"])
        except HueApiError as error:
            if not _may_still_verify(error):
                raise
            if monotonic() >= deadline:
                raise timed_out(known) from None
            refused_for_now = error.status != 409
            asked = error.retry_after_seconds or 0
        sleep(max(0.0, min(max(pause, asked), deadline - monotonic())))
        pause = min(pause * 2, timing.max_poll_seconds)
        current: dict[str, Any] | None = None
        try:
            current = known = client.get_artifact(artifact_id)
        except HueApiError as error:
            if not _may_still_verify(error):
                raise
        if current is not None and current.get("state") == "ready":
            return "ready"
        unverified = (
            current is not None
            and current.get("state") in ("reserved", "rejected")
            and current.get("failureCode") != "mismatch"
        )
        if current is not None and current.get("state") != "verifying":
            if not (unverified and refused_for_now and retries < 3):
                return str(current.get("state"))
            retries += 1
        if monotonic() >= deadline:
            raise timed_out(current or known)


def publish_artifact(
    client: EvaluationClient,
    *,
    idempotency_key: str,
    filename: str,
    content_type: str,
    data: bytes,
    label: str,
    timing: _Settling = ARTIFACT_SETTLING,
) -> str:
    """Reserve, stage and verify one artifact; its ID once Hue verified it. Replaying the key
    settles on the same artifact, including one Hue finished verifying earlier."""
    reserved = client.reserve_artifact(
        idempotency_key=idempotency_key,
        filename=filename,
        content_type=content_type,
        byte_size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    artifact_id = uuid(reserved["id"])
    state = reserved.get("state")
    if state != "ready":
        # A verification already running holds the uploaded bytes; Hue refuses another upload.
        if reserved.get("copyState") != "acknowledged" and state != "verifying":
            upload = client.request_artifact_upload(artifact_id)
            try:
                client.upload_artifact_bytes(upload, data, content_type)
            except HueApiError:
                # A lost staging acknowledgement or an immutable object already present can only
                # be settled by verified completion; never rewrite a final object here.
                pass
        state = _settle_artifact(client, artifact_id, timing)
    if state != "ready":
        raise RuntimeError(f"{label} was not verified by Hue ({state}).")
    return artifact_id


def _case_file_name(name: object) -> str:
    """A case file name as the artifact API takes it: well-formed Unicode of 1–255 UTF-16 code
    units, as Hue counts them, without a control character or a path separator."""
    if (
        not isinstance(name, str)
        or not name
        or any(0xD800 <= ord(c) <= 0xDFFF for c in name)
        or len(name.encode("utf-16-le")) // 2 > 255
        or any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in name)
    ):
        raise ValueError(
            "A case file needs a well-formed filename of 1–255 UTF-16 code units without path "
            "separators or control characters."
        )
    return name


def _case_file_bytes(path: object, label: str) -> bytes:
    if not isinstance(path, (str, os.PathLike)) or not os.fspath(path):
        raise ValueError(f"{label} needs data or a path.")
    file = Path(path)
    info = file.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{label} is not a regular file.")
    if info.st_size > _MAX_FILE_BYTES:
        raise ValueError(f"{label} exceeds 25 MiB.")
    return file.read_bytes()


# A stand-in for an artifact a case file is uploaded as, the length of a real ID.
_STAND_IN_ID = "00000000-0000-4000-8000-000000000000"


def case_file_references(
    client: EvaluationClient,
    version_id: str,
    external_key: object,
    files: Sequence[CaseFileWrite | Mapping[str, Any]],
    timing: _Settling = ARTIFACT_SETTLING,
    *,
    before_upload: Callable[[list[dict[str, str]]], object] | None = None,
) -> list[dict[str, str]]:
    """The ``files`` of a case write as the case API takes them.

    References are kept; each file given as data or a path is checked against the artifact
    policy (role, name, one of the artifact content types, 1 byte to 25 MiB) and uploaded as a
    verified artifact. Every file is checked, and then ``before_upload`` is given the references
    with a stand-in ID for each upload, before the first upload. The reservation key names the
    version, the case's ``external_key``, the role and the bytes. Each artifact is pinned once
    with a role, even when a reference names the artifact a file was uploaded as.
    """
    # The artifact content types, shared with managed outputs; imported here because the managed
    # module imports the evaluation package.
    from ..managed import _OUTPUT_TYPES

    if not isinstance(files, (list, tuple)):
        raise ValueError("files must be a list of case files.")
    if len(files) > _MAX_CASE_FILES:
        raise ValueError(f"A case pins at most {_MAX_CASE_FILES} files.")
    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, given in enumerate(files, start=1):
        label = f"Case file {index}"
        if isinstance(given, Mapping):
            if set(given) != {"artifactId", "role"}:
                raise ValueError(f"{label} must name exactly an artifactId and a role.")
            file = CaseFileWrite(role=given["role"], artifact_id=given["artifactId"])
        elif isinstance(given, CaseFileWrite):
            file = given
        else:
            raise ValueError(f"{label} is not a CaseFileWrite.")
        if file.role not in _CASE_FILE_ROLES:
            raise ValueError(f"{label} has an unsupported role {file.role!r}.")
        if file.artifact_id is not None:
            if any(
                value is not None
                for value in (file.data, file.path, file.filename, file.content_type)
            ):
                raise ValueError(f"{label} names an artifact_id and a file; give one.")
            artifact_id = file.artifact_id
            reference = {
                "artifactId": uuid(artifact_id.lower() if isinstance(artifact_id, str) else ""),
                "role": file.role,
            }
            prepared.append(reference)
            identity = f"artifact:{reference['artifactId']}"
        else:
            filename = _case_file_name(file.filename)
            if file.content_type not in _OUTPUT_TYPES:
                raise ValueError(f"{label} has an unsupported content type {file.content_type!r}.")
            if file.data is not None and file.path is not None:
                raise ValueError(f"{label} names data and a path; give one.")
            if file.data is not None and not isinstance(file.data, bytes):
                raise ValueError(f"{label} data must be bytes.")
            data = file.data if file.data is not None else _case_file_bytes(file.path, label)
            if not data:
                raise ValueError(f"{label} is empty.")
            if len(data) > _MAX_FILE_BYTES:
                raise ValueError(f"{label} exceeds 25 MiB.")
            digest = hashlib.sha256(data).hexdigest()
            prepared.append(
                {
                    "role": file.role,
                    "filename": filename,
                    "contentType": file.content_type,
                    "data": data,
                    "sha256": digest,
                }
            )
            identity = f"file:{digest}:{file.content_type}:{filename}"
        pinned = f"{identity}:{file.role}"
        if pinned in seen:
            raise ValueError(f"{label} is pinned twice with the role {file.role}.")
        seen.add(pinned)
    if before_upload is not None:
        before_upload(
            [
                item if "artifactId" in item else {"artifactId": _STAND_IN_ID, "role": item["role"]}
                for item in prepared
            ]
        )
    case_key = hashlib.sha256(str(external_key).encode()).hexdigest()[:16]
    references: list[dict[str, str]] = []
    # A reference and an upload that settle on the same artifact are pinned once: Hue refuses an
    # artifact pinned twice with one role.
    pins: set[tuple[str, str]] = set()

    def pin(reference: dict[str, str]) -> None:
        identity = (reference["artifactId"].lower(), reference["role"])
        if identity not in pins:
            pins.add(identity)
            references.append(reference)

    for item in prepared:
        if "artifactId" in item:
            pin(item)
            continue
        name_key = hashlib.sha256(item["filename"].encode()).hexdigest()[:16]
        type_key = hashlib.sha256(item["contentType"].encode()).hexdigest()[:16]
        artifact_id = publish_artifact(
            client,
            # The key names everything the reservation declares, so a corrected name or type
            # reserves a new artifact instead of colliding with the earlier one.
            idempotency_key=(
                f"hue-sdk:case:{version_id}:{case_key}:{item['role']}:{item['sha256']}"
                f":{name_key}:{type_key}"
            ),
            filename=item["filename"],
            content_type=item["contentType"],
            data=item["data"],
            label=f"Case file {item['filename']}",
            timing=timing,
        )
        pin({"artifactId": artifact_id, "role": item["role"]})
    return references


def _truncate_bytes(name: str, size: int) -> str:
    kept, used = "", 0
    for character in name:
        used += len(character.encode())
        if used > size:
            break
        kept += character
    return kept


def safe_filename(name: str) -> str:
    """A declared file name reduced to one printable path segment of at most 200 UTF-8 bytes; a
    longer name keeps its extension and is marked with a short hash of the whole name."""
    cleaned = "".join(c for c in name if ord(c) >= 32 and ord(c) != 127 and c not in "/\\").strip()
    kept = cleaned
    if len(cleaned.encode()) > _MAX_NAME_BYTES:
        extension = os.path.splitext(cleaned)[1]
        extension = extension if len(extension.encode()) <= 32 else ""
        mark = f"~{hashlib.sha256(cleaned.encode()).hexdigest()[:8]}"
        room = _MAX_NAME_BYTES - len(extension.encode()) - len(mark)
        stem = cleaned[: len(cleaned) - len(extension)] if extension else cleaned
        kept = f"{_truncate_bytes(stem, room)}{mark}{extension}"
    return kept if kept and kept not in (".", "..") else "file"


def _private_directory(path: Path) -> Path:
    root = Path(os.path.abspath(path))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or (hasattr(os, "getuid") and info.st_uid != os.getuid())
        or (os.name != "nt" and info.st_mode & 0o077)
    ):
        raise RuntimeError(
            "Use a private files directory (owned by this user, mode 0700, no symlink)."
        )
    return root


def _write_private(path: Path, data: bytes) -> None:
    temporary = path.with_name(f"{path.name}.{uuid4()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, path)


def _matches(path: Path, file: Mapping[str, Any]) -> bool:
    try:
        data = path.read_bytes()
    except OSError:
        return False
    return len(data) == file["byteSize"] and hashlib.sha256(data).hexdigest() == file["sha256"]


def _download_verified(client: EvaluationClient, file: Mapping[str, Any]) -> bytes:
    """One pinned file, checked against the manifest's size and SHA-256; the download stops one
    byte past the pinned size."""
    mismatch = CaseFileError(
        "case_file_mismatch",
        file["artifactId"],
        f"Downloaded file {str(file['filename'])[:120]!r} does not match its pinned size and "
        "SHA-256",
    )
    try:
        data = client.download_artifact(file["artifactId"], max_bytes=file["byteSize"])
    except ArtifactSizeError:
        raise mismatch from None
    if len(data) != file["byteSize"] or hashlib.sha256(data).hexdigest() != file["sha256"]:
        raise mismatch
    return data


def verify_case_files(client: EvaluationClient, files: Sequence[Mapping[str, Any]]) -> None:
    """Check pinned files against the manifest without keeping them: nothing is written."""
    for file in files:
        _download_verified(client, file)


def remove_case_files(directory: Path) -> None:
    """Remove a directory of case files; a failure is a warning and never fails the case."""
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass
    except OSError:
        warnings.warn(f"Could not remove the case files in {directory}", stacklevel=2)


def download_case_files(
    client: EvaluationClient, files: Sequence[Mapping[str, Any]], directory: Path
) -> list[LocalFile]:
    """Save verified copies of pinned files under ``directory``; a copy already present with
    the pinned identity is reused, so a resumed run does not download again."""
    root = _private_directory(directory)
    saved: list[LocalFile] = []
    for index, file in enumerate(files, start=1):
        path = root / f"{index}-{safe_filename(str(file['filename']))}"
        if not _matches(path, file):
            _write_private(path, _download_verified(client, file))
        saved.append(
            LocalFile(
                artifact_id=file["artifactId"],
                role=file["role"],
                filename=file["filename"],
                content_type=file["contentType"],
                byte_size=file["byteSize"],
                sha256=file["sha256"],
                path=path,
            )
        )
    return saved


def download_case_inputs(
    client: EvaluationClient, files: Sequence[Mapping[str, Any]], case_directory: Path
) -> tuple[list[LocalFile], list[LocalFile]]:
    """A case's needed inputs: agent-visible roles into ``inputs/`` and evaluator-only files into
    ``evaluator-inputs/``, so the target's directory never holds an evaluator's file. Returns all
    of them in manifest order (for scorers) and the agent-visible ones (for the target)."""
    agent = [file for file in files if file["role"] in TARGET_FILE_ROLES]
    evaluator = [file for file in files if file["role"] not in TARGET_FILE_ROLES]
    target = download_case_files(client, agent, case_directory / "inputs") if agent else []
    graders = (
        download_case_files(client, evaluator, case_directory / "evaluator-inputs")
        if evaluator
        else []
    )
    by_identity = {(file.artifact_id, file.role): file for file in (*target, *graders)}
    return [by_identity[(file["artifactId"], file["role"])] for file in files], target
