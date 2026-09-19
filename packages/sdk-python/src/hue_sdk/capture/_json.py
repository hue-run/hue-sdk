"""Portable JSON and credential filtering shared by capture and matching."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

SAFE_INTEGER = 9_007_199_254_740_991
CREDENTIAL_KEYS = frozenset(
    {
        "authorization",
        "proxyauthorization",
        "cookie",
        "setcookie",
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "token",
        "xapikey",
        "xauthtoken",
        "signature",
        "sig",
        "xamzsignature",
        "xamzcredential",
        "xamzsecuritytoken",
        "xgoogsignature",
        "xgoogcredential",
    }
)


def credential_key(key: str) -> bool:
    return key.lower().replace("-", "").replace("_", "") in CREDENTIAL_KEYS


def canonical_json(value: Any) -> bytes:
    """RFC 8785 JSON with the protocol's additional safe-integer restriction."""

    def encode(item: Any, depth: int = 0) -> str:
        if depth > 100:
            raise ValueError("Portable JSON is too deeply nested.")
        if item is None:
            return "null"
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, str):
            item.encode("utf-8")  # Reject unpaired surrogates.
            return json.dumps(item, ensure_ascii=False)
        if isinstance(item, int):
            if abs(item) > SAFE_INTEGER:
                raise ValueError("Portable integers must be interoperable.")
            return str(item)
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("Portable numbers must be finite.")
            if item.is_integer():
                return encode(int(item), depth)
            sign = "-" if item < 0 else ""
            raw = repr(abs(item))
            if "e" not in raw:
                return sign + raw
            mantissa, exponent_text = raw.split("e")
            exponent = int(exponent_text)
            if -6 <= exponent < 21:
                digits = mantissa.replace(".", "")
                point = 1 + exponent
                if point <= 0:
                    return sign + "0." + "0" * -point + digits
                return sign + digits[:point] + "." + digits[point:]
            return sign + mantissa + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(encode(child, depth + 1) for child in item) + "]"
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            keys = sorted(item, key=lambda key: key.encode("utf-16-be"))
            return (
                "{"
                + ",".join(
                    encode(key, depth + 1) + ":" + encode(item[key], depth + 1) for key in keys
                )
                + "}"
            )
        raise ValueError("Value does not have a portable JSON representation.")

    try:
        return encode(value).encode("utf-8")
    except (UnicodeError, RecursionError):
        raise ValueError("Value does not have a portable JSON representation.") from None


def clean_json(value: Any, depth: int = 0) -> Any:
    if depth > 100:
        raise ValueError("Portable JSON is too deeply nested.")
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("Portable JSON object keys must be strings.")
        return {
            key: clean_json(item, depth + 1)
            for key, item in value.items()
            if not credential_key(key)
        }
    if isinstance(value, (list, tuple)):
        return [clean_json(item, depth + 1) for item in value]
    if isinstance(value, str) and value.lower().startswith(("https://", "http://")):
        from ._url import safe_url

        return safe_url(value)
    return value


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request_key(binding_id: str, operation: str, contract_version: str, arguments: Any) -> str:
    return sha256(
        canonical_json(
            {
                "bindingId": binding_id,
                "operation": operation,
                "contractVersion": contract_version,
                "arguments": arguments,
            }
        )
    )
