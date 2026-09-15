from __future__ import annotations

import json
import os
import shutil
import stat
from pathlib import Path
from typing import Any
from uuid import uuid4

from ._json import digest, encode


class CheckpointStore:
    """Exclusive durable ownership. A crash leaves .lock for explicit operator recovery."""

    def __init__(self, directory: str | Path, identity: dict[str, Any]) -> None:
        self.directory = Path(os.path.abspath(directory))
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or not hasattr(os, "O_NOFOLLOW"):
            raise RuntimeError("Use a private POSIX checkpoint directory (0700, no symlink).")
        try:
            (self.directory / ".lock").mkdir(mode=0o700)
        except FileExistsError:
            raise RuntimeError(
                "Checkpoint directory is locked. Confirm its owner stopped "
                "before explicitly removing .lock."
            ) from None
        try:
            self.write(".lock/owner", {"pid": os.getpid()})
            expected = {"format": 1, "identity": identity, "digest": digest(identity)}
            prior = self.read("manifest")
            if prior is not None and (
                prior.get("format") != 1 or prior.get("digest") != expected["digest"]
            ):
                raise RuntimeError(
                    "Checkpoint identity differs from the project, run, pins or content policy."
                )
            if prior is None:
                self.write("manifest", expected)
        except BaseException:
            self.release()
            raise

    def read(self, key: str) -> Any:
        try:
            descriptor = os.open(self.directory / f"{key}.json", os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077
                or info.st_size > 8 * 1024 * 1024
            ):
                raise RuntimeError("Unsafe or oversized checkpoint.")
            envelope = json.loads(stream.read(8 * 1024 * 1024 + 1))
            if digest(envelope["value"]) != envelope["digest"]:
                raise RuntimeError("Checkpoint integrity check failed.")
            return envelope["value"]

    def write(self, key: str, value: Any) -> None:
        payload = encode({"value": value, "digest": digest(value)})
        if len(payload) > 8 * 1024 * 1024:
            raise ValueError("Checkpoint exceeds 8 MiB.")
        destination = self.directory / f"{key}.json"
        temporary = destination.with_suffix(f".{uuid4()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            directory = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    def release(self) -> None:
        shutil.rmtree(self.directory / ".lock")
