"""Decode bounded copies for capture without changing application response streams."""

from __future__ import annotations

import re
import zlib


def content_encodings(header: str) -> tuple[str, ...]:
    return tuple(
        encoding
        for value in header.split(",")
        if (encoding := value.strip().lower()) not in {"", "identity"}
    )


def supported_encodings(header: str) -> bool:
    return all(value in {"gzip", "x-gzip", "deflate", "br"} for value in content_encodings(header))


def _inflate(data: bytes, cap: int, *, gzip: bool = False, raw: bool = False) -> bytes | None:
    output = bytearray()
    while data:
        decoder = zlib.decompressobj(31 if gzip else -15 if raw else 15)
        chunk = decoder.decompress(data, cap - len(output) + 1)
        if len(chunk) > cap - len(output) or not decoder.eof:
            return None
        output.extend(chunk)
        if not gzip:
            break
        data = decoder.unused_data
        # Gzip permits concatenated members and trailing zero padding.
        if not data.strip(b"\0"):
            break
    return bytes(output)


def _brotli(data: bytes, cap: int) -> bytes | None:
    # Optional: installing Brotli can change HTTP clients' own encoding negotiation.
    import brotli  # type: ignore[import-untyped]

    version = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", getattr(brotli, "__version__", ""))
    # 1.2.1 fixes CVE-2026-111497. A base install may find an older application dependency.
    if version is None or not (1, 2, 1) <= tuple(map(int, version.groups())) < (2, 0, 0):
        return None
    decoder = brotli.Decompressor()
    output = bytearray()
    while True:
        # Brotli 1.2.1 rounds the bound to its first 32 KiB allocation block. Asking for
        # one byte keeps every call at that fixed bound, including decompression bombs.
        chunk = decoder.process(data, output_buffer_limit=1)
        if len(chunk) > cap - len(output):
            return None
        output.extend(chunk)
        if decoder.is_finished():
            return bytes(output)
        if not chunk:
            return None
        data = b""


def decode_body(data: bytes, header: str, cap: int) -> bytes | None:
    """Reject incomplete, unsupported, unavailable or over-limit content at each layer."""
    if len(data) > cap:
        return None
    try:
        for encoding in reversed(content_encodings(header)):
            if encoding in {"gzip", "x-gzip"}:
                decoded = _inflate(data, cap, gzip=True)
            elif encoding == "deflate":
                try:
                    decoded = _inflate(data, cap)
                except zlib.error:
                    decoded = _inflate(data, cap, raw=True)
            elif encoding == "br":
                decoded = _brotli(data, cap)
            else:
                return None
            if decoded is None:
                return None
            data = decoded
        return data
    except Exception:
        # Missing/old optional decoders and malformed input never affect the caller.
        return None
