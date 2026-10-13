"""Media read in place (``read_large_media_text``) is placed exactly as media parsed out of the
value: the same text, entries, uploads and fallbacks, for every shape of the shared corpus and for
the corpus with its files lengthened past the long-string threshold, which this suite lowers so
every such file is read in place. Each upload hashes the bytes it is given, so a file decoded a
slice at a time must give the bytes decoded whole. Mirrors ``large-media.test.ts``."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from time import monotonic
from typing import Any

import pytest

import hue_sdk._large_media as large_media
from hue_sdk._blobs import BLOBS_KEY, Held, _Outcome, digest_of, place_spans
from hue_sdk._large_media import read_large_media_text
from hue_sdk._limits import TRUNCATED_KEY

_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")


class _Uploader:
    """Hashes what it is given and stores it, or refuses every value."""

    def __init__(self, ok: bool) -> None:
        self.ok = ok
        self.uploads: list[tuple[str, str, int, str]] = []

    def unsupported(self) -> bool:
        return False

    def store(self, trace_id, key, value, content_type, digest, deadline, wait, sharing=None):
        assert digest_of(value) == digest
        self.uploads.append((key, *digest, content_type))
        return _Outcome(True, content_type=content_type) if self.ok else _Outcome(False, "failed")


def place(key: str, text: str, large: bool, ok: bool) -> dict[str, Any]:
    uploader = _Uploader(ok)
    held = Held(
        values={key: text},
        inspected=set() if large else {key},
        large={key} if large else set(),
    )
    (attributes,), tally = place_spans(
        [({key: text}, held, "0123456789abcdef0123456789abcdef")],
        uploader=uploader,  # type: ignore[arg-type]
        value_bytes=1_000_000_000,
        deadline=monotonic() + 60,
        wait=lambda _: False,
    )
    return {
        "value": attributes[key],
        "entries": attributes.get(BLOBS_KEY),
        "truncated": attributes.get(TRUNCATED_KEY),
        "uploads": uploader.uploads,
        "uploaded": tally.uploaded,
        "fallbacks": {reason: count for reason, (count, _) in tally.fallbacks.items()},
    }


def lengthened(value: Any) -> Any:
    """A value with each file it holds as base64 or a data: URL lengthened past the lowered
    threshold: base64 decoded and its bytes repeated, percent-escaped data repeated whole."""
    if isinstance(value, str):
        comma = value.find(",")
        if value.startswith("data:") and comma != -1:
            header, data = value[5:comma], value[comma + 1 :]
            if ";base64" in header and len(data) % 4 == 0 and _BASE64.match(data):
                raw = base64.b64decode(data)
                if not raw:
                    return value
                repeated = raw * -(-3000 // len(raw))
                return f"data:{header},{base64.b64encode(repeated).decode()}"
            return f"data:{header},{data * -(-2000 // len(data))}" if data else value
        if len(value) >= 16 and len(value) % 4 == 0 and _BASE64.match(value):
            raw = base64.b64decode(value)
            return base64.b64encode(raw * -(-3000 // len(raw))).decode()
        return value
    if isinstance(value, list):
        return [lengthened(item) for item in value]
    if isinstance(value, dict):
        return {key: lengthened(item) for key, item in value.items()}
    return value


_CORPUS = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())
CASES: list[tuple[str, str, str]] = []
for _case in _CORPUS["fixtures"]:
    if "value" in _case:
        CASES.append((_case["id"], _case["attribute"], _case["value"]))
        CASES.append(
            (f"{_case['id']} (lengthened)", _case["attribute"], lengthened(_case["value"]))
        )
    else:
        CASES.append((_case["id"], _case["attribute"], json.dumps(_case["messages"])))
        CASES.append(
            (
                f"{_case['id']} (lengthened)",
                _case["attribute"],
                json.dumps(lengthened(_case["messages"])),
            )
        )

_MIB = 1024 * 1024
_LONG = base64.b64encode(bytes([3]) * 4000).decode()
_TEXT = "data:text/plain;charset=utf-8," + "caf%C3%A9 é 🎧 %20%0A" * 200
_WAV = base64.b64encode(b"RIFF\0\0\0\0WAVE" + bytes(4000)).decode()
_NOTES = base64.b64encode(b"notes\n" * 20_000).decode()
_ARGUMENTS = json.dumps({"image": f"data:image/png;base64,{_LONG}"})
CASES += [
    ("percent data: URL", "input.value", json.dumps({"doc": _TEXT}, ensure_ascii=False)),
    ("raw percent data: URL with a line break", "metadata", f"{_TEXT}\nline two%21"),
    (
        "padded base64",
        "gen_ai.input.messages",
        json.dumps(
            [
                {
                    "parts": [
                        {
                            "type": "blob",
                            "mime_type": "audio/wav",
                            "content": base64.b64encode(bytes([5]) * 4001).decode(),
                        }
                    ]
                }
            ]
        ),
    ),
    ("a long base64 key", "input.value", json.dumps({_LONG: {"type": "blob", "content": _LONG}})),
    (
        "duplicate members",
        "input.value",
        f'{{"type":"blob","mime_type":"image/png","content":"{_LONG}",'
        f'"content":"{base64.b64encode(bytes([9]) * 3000).decode()}"}}',
    ),
    ("a JSON string at the root", "input.value", json.dumps(f"data:image/png;base64,{_LONG}")),
    (
        "assistant audio named by its signature",
        "gen_ai.output.messages",
        json.dumps([{"role": "assistant", "audio": {"id": "a", "data": _WAV}}]),
    ),
    (
        "a text file declared base64",
        "gen_ai.input.messages",
        json.dumps([{"parts": [{"inlineData": {"mimeType": "text/plain", "data": _NOTES}}]}]),
    ),
    (
        "an escaped slash",
        "input.value",
        f'{{"type":"blob","mime_type":"image/png","content":"{_LONG[:400]}\\/{_LONG[400:]}"}}',
    ),
    (
        "unterminated JSON",
        "input.value",
        f'{{"type":"blob","mime_type":"image/png","content":"{_LONG}',
    ),
    (
        "a control character in a data: URL",
        "input.value",
        '{"image":"data:text/plain,' + "a" * 400 + '\u0001"}',
    ),
    (
        "a tool call's encoded arguments",
        "gen_ai.input.messages",
        json.dumps(
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {"type": "function", "function": {"name": "f", "arguments": _ARGUMENTS}}
                    ],
                }
            ]
        ),
    ),
    # Data ending in whitespace trims to a label Hue's reader matches (a file id), so it is parsed.
    (
        "a file id that trims to a label",
        "input.value",
        json.dumps(
            {
                "type": "file",
                "file_id": "data:,a" + " " * 400,
                "name": "data:image/png;base64,iVBORw0KGgo=",
            }
        ),
    ),
    (
        "a file id that trims to a label (ideographic space)",
        "input.value",
        json.dumps(
            {
                "type": "file",
                "file": {
                    "file_id": "data:,a" + "\u3000" * 400,
                    "filename": "data:image/png;base64,iVBORw0KGgo=",
                },
            },
            ensure_ascii=False,
        ),
    ),
    # A value that is no JSON is the file whatever it ends in, and a JSON string whose trim is no
    # label is read in place.
    (
        "a raw data: URL ending in a line break",
        "metadata",
        "data:application/octet-stream," + "hello%20world " * 40 + "\n",
    ),
    (
        "a data: URL ending in spaces",
        "input.value",
        json.dumps({"image": "data:application/octet-stream," + "x" * 400 + " " * 400}),
    ),
    # Percent-escaped data read a 1 Mi slice at a time: never split inside a surrogate pair or an
    # escape, and a run of lone high surrogates still moves on.
    ("a surrogate pair across slices", "metadata", "data:text/plain," + "a" * (_MIB - 1) + "😀b"),
    ("an escape across slices", "metadata", "data:text/plain," + "a" * (_MIB - 1) + "%41%42"),
    (
        "an escape two units before a slice",
        "metadata",
        "data:text/plain," + "a" * (_MIB - 2) + "%41",
    ),
    ("lone high surrogates past a slice", "metadata", "data:text/plain," + "\ud800" * (_MIB + 8)),
]


@pytest.fixture
def low_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(large_media, "LONG_STRING_UNITS", 300)


@pytest.mark.parametrize("ok", [True, False], ids=["uploaded", "refused"])
@pytest.mark.parametrize(("name", "key", "text"), CASES, ids=[case[0] for case in CASES])
def test_media_read_in_place_is_placed_as_media_parsed_out(low_threshold, name, key, text, ok):
    assert place(key, text, True, ok) == place(key, text, False, ok), name


def test_long_strings_are_read_in_place_and_the_json_around_them_is_bounded():
    value = json.dumps([{"parts": [{"type": "blob", "mime_type": "audio/wav", "content": _LONG}]}])
    read = read_large_media_text("gen_ai.input.messages", value, 300)
    assert read is not None and len(read.long) == 1
    assert read.media.files[0].content != _LONG
    # Past 8 Mi code units of JSON around its long strings, a value is not read at all.
    padded = json.dumps(
        [
            {
                "parts": [
                    {"type": "text", "content": "a\n" * (9 * 1024 * 1024 // 2)},
                    {"type": "blob", "content": _LONG},
                ]
            }
        ]
    )
    assert read_large_media_text("gen_ai.input.messages", padded, 300) is None


def test_a_value_over_the_bound_is_refused_without_a_copy_of_it():
    import tracemalloc

    # 96 Mi characters of escaped text before a file: the scan stops at the bound, without copying
    # or reading the value to its end.
    value = (
        '[{"parts":[{"type":"text","content":"'
        + "a\\n" * (32 * _MIB)
        + f'"}},{{"type":"blob","content":"{_LONG}"}}]}}]'
    )
    tracemalloc.start()
    try:
        assert read_large_media_text("gen_ai.input.messages", value, 300) is None
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 4 * _MIB, peak
