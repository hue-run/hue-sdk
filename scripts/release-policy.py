"""Closed release input policy, before any package tool or registry operation."""

import json
import os
from pathlib import Path
import re
import tomllib


def validate(language: str, version: str, tag: str, publish: bool, prepared_run_id: str) -> None:
    if language not in ("typescript", "python") or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected a package language and stable version")
    if tag not in ("latest", "hue-onboarding-candidate"):
        raise ValueError("Unsupported npm dist-tag")
    if prepared_run_id and not re.fullmatch(r"[1-9][0-9]{0,19}", prepared_run_id):
        raise ValueError("Invalid prepared run id")
    if language == "python" and (tag != "latest" or prepared_run_id):
        raise ValueError("npm tag and archive reuse do not apply to Python")
    if language == "typescript" and version == "0.4.0" and publish:
        if tag != "hue-onboarding-candidate" or not prepared_run_id:
            raise ValueError("0.4.0 must reuse the accepted prepare-only archive and publish as a candidate")


def main() -> None:
    language, version = os.environ["RELEASE_LANGUAGE"], os.environ["RELEASE_VERSION"]
    publish = os.environ["RELEASE_PUBLISH"]
    if publish not in ("true", "false"):
        raise ValueError("Expected an explicit publication choice")
    validate(language, version, os.environ["NPM_DIST_TAG"], publish == "true", os.environ["PREPARED_RUN_ID"])
    metadata = (json.loads(Path("packages/sdk-typescript/package.json").read_text()) if language == "typescript"
                else tomllib.loads(Path("packages/sdk-python/pyproject.toml").read_text())["project"])
    if metadata["version"] != version:
        raise ValueError("Version must match the committed package")


if __name__ == "__main__":
    main()
