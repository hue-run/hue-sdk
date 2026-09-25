from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hue_sdk._inline_files import INLINE_FILE_LIMIT, hash_inline_files

# The TypeScript suite reads the same file; each digest is of the bytes the case was built from.
DIGEST_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "sdk-typescript"
        / "tests"
        / "fixtures"
        / "inline-file-digests.json"
    ).read_text(encoding="utf-8")
)


def test_the_shared_digest_fixture_uses_the_sdk_inline_file_limit() -> None:
    assert DIGEST_FIXTURE["limit"] == INLINE_FILE_LIMIT


@pytest.mark.parametrize("case", DIGEST_FIXTURE["cases"], ids=lambda case: case["name"])
def test_inline_file_digest_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    spec = case["content"]
    part = {
        **case["part"],
        case["key"]: spec["prefix"] + spec["unit"] * spec["times"] + spec["suffix"],
    }
    file = case["part"]["type"] == "file"
    message = {"role": "user", "content": [part]} if file else {"role": "user", "parts": [part]}
    value = json.dumps([message])
    result = hash_inline_files("ai.prompt.messages" if file else "gen_ai.input.messages", value)
    if case["expected"] is None:
        assert result is value
        return
    [exported] = json.loads(result)
    assert (exported["content"] if file else exported["parts"])[0] == {
        **case["part"],
        **case["expected"],
    }
