"""What Hue's receiver accepts, and how the exporters stay within it.

Every OTLP acknowledgement, whatever its status, advertises the receiver's limits in
``Hue-Max-Request-Bytes`` (one request on the wire, after gzip), ``Hue-Max-Decoded-Bytes`` (one
request after decompression) and ``Hue-Max-Value-Bytes`` (one attribute value or log body kept
inline). Until one arrives the exporters assume the receiver's limits as of this release.
"""

from __future__ import annotations

import gzip
from collections.abc import Mapping
from dataclasses import dataclass, replace
from io import BytesIO
from threading import Lock

_KIB = 1024
_MIB = 1024 * _KIB

# One request on the wire (after gzip) before the receiver advertises its own limit.
MAX_REQUEST_BYTES = _MIB
# One request after decompression before the receiver advertises its own limit.
MAX_DECODED_BYTES = 4 * _MIB
# One attribute value or log body kept whole before the receiver advertises its own limit; a
# longer value is cut to it and listed under ``hue.truncated``.
MAX_CONTENT_BYTES = _MIB
# The ordinary size of one request before gzip. Advertised limits are ceilings, not targets: a
# receiver decodes a larger request more slowly, so batches stay at this size (or the advertised
# decoded limit when that is lower), and only a single record that needs more travels alone in a
# larger request, up to the advertised ceilings.
BATCH_TARGET_BYTES = 4 * _MIB
# How long one export holds its records for a receiver that refused them for their rate (HTTP 429)
# and asked to be retried later than a request's deadline allows. The records stay queued, counted
# against the queue's bounds; a longer wait loses them, reported like any refused request.
MAX_RATE_LIMIT_HOLD_SECONDS = 60.0

# The record attribute listing the keys whose values were cut to the cap: Hue's receiver writes
# it for the values it cuts, and the SDK writes it for the values it cuts before export.
TRUNCATED_KEY = "hue.truncated"
# The size of a value the receiver's marker replaced.
TRUNCATED_BYTES_KEY = "hue.truncated_bytes"
# The root span attribute counting this trace's records the SDK could not export at all: what
# Hue stores of the trace is incomplete by that many records.
DROPPED_RECORDS_KEY = "hue.sdk.dropped_records"


@dataclass(frozen=True)
class ReceiverLimits:
    """What a Hue receiver accepts, in bytes."""

    request_bytes: int = MAX_REQUEST_BYTES
    decoded_bytes: int = MAX_DECODED_BYTES
    value_bytes: int = MAX_CONTENT_BYTES


# Each advertised limit's header and the range it is clamped to, so a faulty value can neither
# make requests unboundedly large nor too small to carry a record.
_ADVERTISED = (
    ("request_bytes", "Hue-Max-Request-Bytes", _MIB, 64 * _MIB),
    ("decoded_bytes", "Hue-Max-Decoded-Bytes", _MIB, 64 * _MIB),
    ("value_bytes", "Hue-Max-Value-Bytes", 256 * _KIB, 16 * _MIB),
)


def _decimal(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > 20 or not text.isascii() or not text.isdigit():
        return None
    return int(text)


def advertised_limits(current: ReceiverLimits, headers: Mapping[str, str]) -> ReceiverLimits:
    """``current`` with every limit the headers advertise adopted, clamped to its range.

    A lower advertised limit is adopted as readily as a higher one: the exporters never exceed
    what the receiver last said.
    """
    changes: dict[str, int] = {}
    for field, header, low, high in _ADVERTISED:
        try:
            value = _decimal(headers.get(header))
        except Exception:
            value = None
        if value is not None:
            changes[field] = min(high, max(low, value))
    return replace(current, **changes) if changes else current


class AdvertisedLimits:
    """The receiver's limits as it last advertised them, shared by a client's exporters,
    processors and content helpers."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._current = ReceiverLimits()

    @property
    def current(self) -> ReceiverLimits:
        with self._lock:
            return self._current

    def adopt(self, headers: Mapping[str, str]) -> None:
        with self._lock:
            self._current = advertised_limits(self._current, headers)


def fits_without_compression(size: int, limit: int) -> bool:
    """Whether ``size`` bytes before gzip certainly stay within ``limit`` after it: deflate's worst
    case (stored blocks) adds a few bytes per 16 KiB, plus gzip's header and trailer."""
    return size + -(-size // 1024) + 64 <= limit


def gzip_size(data: bytes) -> int:
    """The size of ``data`` compressed as the OTLP exporter compresses a request body."""
    buffer = BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="w") as stream:
        stream.write(data)
    return len(buffer.getvalue())


def over_utf8(value: str, limit: int) -> bool:
    """Whether ``value`` is longer than ``limit`` UTF-8 bytes, encoding at most ``limit``
    characters of it. A lone surrogate raises ``UnicodeEncodeError``."""
    if len(value) > limit:
        return True
    if len(value) * 4 <= limit:
        return False
    return len(value.encode("utf-8")) > limit


def cut_utf8(value: str, limit: int) -> str:
    """``value`` cut to at most ``limit`` UTF-8 bytes, ending on a character boundary.

    The copy is bounded before the cut: ``limit`` characters hold at least ``limit`` bytes.
    A lone surrogate raises ``UnicodeEncodeError``, as encoding the value whole would.
    """
    encoded = value[:limit].encode("utf-8")
    if len(encoded) <= limit:
        return value[:limit]
    return encoded[:limit].decode("utf-8", errors="ignore")
