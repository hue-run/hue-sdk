from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path
from typing import Any

import pytest

from hue_sdk._inline_files import (
    INLINE_FILE_LIMIT,
    _file_bytes,
    dumps_message,
    hash_inline_files,
    loads_message,
)

# The TypeScript suite reads the same file; each digest is of the bytes the case was built from.
# A checkout without the TypeScript fixtures skips these tests rather than failing to collect;
# the release gate copies the fixtures beside the tests it runs.
DIGEST_PATH = (
    Path(__file__).resolve().parents[2]
    / "sdk-typescript"
    / "tests"
    / "fixtures"
    / "inline-file-digests.json"
)
DIGEST_FIXTURE: dict[str, Any] = (
    json.loads(DIGEST_PATH.read_text(encoding="utf-8"))
    if DIGEST_PATH.is_file()
    else {"limit": None, "cases": []}
)
needs_fixture = pytest.mark.skipif(
    not DIGEST_PATH.is_file(), reason="TypeScript fixtures are not part of this checkout"
)


@needs_fixture
def test_the_shared_digest_fixture_uses_the_sdk_inline_file_limit() -> None:
    assert DIGEST_FIXTURE["limit"] == INLINE_FILE_LIMIT


@needs_fixture
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
    # Content that reads as base64 is the file's base64 whatever the part's media type, as Hue's
    # reader reads it: a text file's bytes, not the base64 text.
    if case["expected"] is None:
        if part[case["key"]].startswith("data:application/octet-stream"):
            [exported] = json.loads(result)
            data = _file_bytes(part[case["key"]])
            assert exported["parts"][0] == {
                **case["part"],
                "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data),
            }
            return
        assert result is value
        return
    [exported] = json.loads(result)
    assert (exported["content"] if file else exported["parts"])[0] == {
        **case["part"],
        **case["expected"],
    }


def test_a_data_url_with_millions_of_parameters_is_still_decoded_by_its_own_encoding() -> None:
    data = bytes([7]) * 70_000
    content = (
        "data:application/octet-stream"
        + ";" * 3_400_000
        + ";base64,"
        + base64.b64encode(data).decode("ascii")
    )
    value = json.dumps(
        [{"role": "user", "parts": [{"type": "blob", "modality": "document", "content": content}]}]
    )
    [message] = json.loads(hash_inline_files("gen_ai.input.messages", value))
    assert message["parts"][0] == {
        "type": "blob",
        "modality": "document",
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": 70_000,
    }


def test_lone_surrogates_are_replaced_once_for_a_whole_part() -> None:
    # Replacing them in each percent-escaped segment raised and caught an error per segment,
    # several times the cost of the same text without them.
    def seconds(unit: str) -> float:
        content = "data:text/plain," + unit * (2 * 1024 * 1024 // len(unit))
        best = float("inf")
        for _ in range(3):
            started = time.perf_counter()
            _file_bytes(content)
            best = min(best, time.perf_counter() - started)
        return best

    assert seconds("a%41\ud800") < 3 * seconds("a%41\u00e9")


def test_placed_json_numbers_are_written_as_javascript_writes_them():
    # Pinned against Node's JSON.stringify(JSON.parse(text)).
    text = (
        '{"threshold":1e-5,"id":9007199254740993,"big":1e21,"tiny":1e-7,"scale":1.5e20,'
        '"ratio":-0.25,"zero":-0,"exact":2.0,"huge":123456789012345678901234567890,'
        '"small":1.23e-18,"max":1.7976931348623157e308,"over":1e400}'
    )
    assert dumps_message(loads_message(text)) == (
        '{"threshold":0.00001,"id":9007199254740992,"big":1e+21,"tiny":1e-7,'
        '"scale":150000000000000000000,"ratio":-0.25,"zero":0,"exact":2,'
        '"huge":1.2345678901234568e+29,"small":1.23e-18,"max":1.7976931348623157e+308,'
        '"over":null}'
    )
    # Values a caller supplies are written the same way.
    assert dumps_message({"x": 2.0, "y": 1e17, "z": 0.5, "w": 1e-6}) == (
        '{"x":2,"y":100000000000000000,"z":0.5,"w":0.000001}'
    )


def test_json_edits_to_many_members_render_in_time_linear_in_them():
    import time

    from hue_sdk._json_edits import JsonEdit, apply_json_edits

    count = 20_000
    text = json.dumps(
        [{"type": "blob", "content": f"c{index}", "keep": 1} for index in range(count)],
        separators=(",", ":"),
    )
    edits = [
        JsonEdit(f"/{index}", remove="content", set=(("size", str(index)),))
        for index in range(count)
    ]
    started = time.perf_counter()
    placed = apply_json_edits(text, edits)
    # 20,000 edited parts render in about a second; visiting every piece for every member took
    # tens of seconds.
    assert time.perf_counter() - started < 5
    assert json.loads(placed) == [
        {"type": "blob", "keep": 1, "size": index} for index in range(count)
    ]
