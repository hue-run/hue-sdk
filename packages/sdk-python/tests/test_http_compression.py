from __future__ import annotations

import gzip
import sys
import zlib

import brotli
import pytest

from hue_sdk._http_compression import decode_body


@pytest.mark.parametrize(
    "encoding,compress",
    [("gzip", gzip.compress), ("deflate", zlib.compress), ("br", brotli.compress)],
)
def test_decoded_limit_and_incomplete_input(encoding, compress):
    plain = b"x" * 4096
    wire = compress(plain)
    assert decode_body(wire, encoding, len(plain)) == plain
    assert decode_body(wire, encoding, len(plain) - 1) is None
    assert decode_body(wire[:-1], encoding, len(plain)) is None
    assert decode_body(b"invalid", encoding, len(plain)) is None
    assert decode_body(wire, encoding, len(wire) - 1) is None


def test_concatenated_gzip_members_and_padding_share_one_budget():
    wire = gzip.compress(b"a" * 1024) + gzip.compress(b"b" * 1024) + b"\0\0"
    assert decode_body(wire, "gzip", 2048) == b"a" * 1024 + b"b" * 1024
    assert decode_body(wire, "gzip", 2047) is None


def test_empty_gzip_members_bound_capture_work(monkeypatch):
    member = gzip.compress(b"", mtime=0)
    wire = member * 52428
    assert len(wire) <= 1024 * 1024
    real = zlib.decompressobj
    calls = []

    def observed(*args):
        calls.append(True)
        return real(*args)

    monkeypatch.setattr(zlib, "decompressobj", observed)
    assert decode_body(member * 16, "gzip", 1024 * 1024) == b""
    calls.clear()
    assert decode_body(wire, "gzip", 1024 * 1024) is None
    assert len(calls) == 16


def test_stacked_encoding_depth_is_bounded_before_decoding(monkeypatch):
    wire = b"{}"
    for _ in range(8):
        wire = gzip.compress(wire, mtime=0)
    assert decode_body(wire, ",".join(["gzip"] * 8), 1024) == b"{}"
    wire = gzip.compress(wire, mtime=0)
    called = []
    monkeypatch.setattr(zlib, "decompressobj", lambda *args: called.append(True))
    assert decode_body(wire, ",".join(["gzip"] * 9), 1024) is None
    assert called == []


def test_stacked_encodings_bound_intermediate_output():
    # The final JSON fits, but its padded intermediate gzip representation does not.
    inner = gzip.compress(b"{}") + bytes(8192)
    wire = gzip.compress(inner)
    assert len(wire) < 1024
    assert decode_body(wire, "gzip, gzip", 1024) is None
    assert decode_body(wire, "gzip, gzip", 16384) == b"{}"


def test_brotli_calls_keep_a_fixed_output_allocation(monkeypatch):
    real = brotli.Decompressor
    lengths = []

    class Observed:
        def __init__(self):
            self.decoder = real()

        def process(self, data, *, output_buffer_limit):
            assert output_buffer_limit == 1
            chunk = self.decoder.process(data, output_buffer_limit=output_buffer_limit)
            lengths.append(len(chunk))
            return chunk

        def is_finished(self):
            return self.decoder.is_finished()

    monkeypatch.setattr(brotli, "Decompressor", Observed)
    assert decode_body(brotli.compress(b"a" * (4 * 1024 * 1024)), "br", 1024) is None
    assert len(lengths) == 1 and max(lengths) <= 32768
    lengths.clear()
    plain = b"a" * 65536
    assert decode_body(brotli.compress(plain), "br", len(plain)) == plain
    assert len(lengths) > 1 and max(lengths) <= 32768


def test_missing_or_old_brotli_never_falls_back_to_unbounded_decode(monkeypatch):
    wire = brotli.compress(b"{}")
    monkeypatch.setitem(sys.modules, "brotli", None)
    assert decode_body(wire, "br", 1024) is None

    class Old:
        @staticmethod
        def process(data):
            raise AssertionError("must not run without an output bound")

    monkeypatch.setitem(
        sys.modules, "brotli", type("Module", (), {"Decompressor": Old, "__version__": "1.2.1"})
    )
    assert decode_body(wire, "br", 1024) is None


@pytest.mark.parametrize("version", ("1.1.0", "1.2.0", "1.2.1rc1", "2.0.0", ""))
def test_vulnerable_or_unaudited_brotli_is_not_called(monkeypatch, version):
    called = []
    monkeypatch.setattr(brotli, "__version__", version)
    monkeypatch.setattr(brotli, "Decompressor", lambda: called.append(True))
    assert decode_body(b"compressed", "br", 1024) is None
    assert called == []
