from urllib.parse import unquote_plus, urlsplit, urlunsplit

from ._json import credential_key


def safe_url(value: str) -> str:
    parts = urlsplit(value)
    host = parts.hostname
    if not host:
        raise ValueError("Invalid source URL")
    if ":" in host:
        host = f"[{host}]"
    if parts.port and not (
        parts.port == 443 and parts.scheme == "https" or parts.port == 80 and parts.scheme == "http"
    ):
        host += f":{parts.port}"
    query = "&".join(
        pair
        for pair in parts.query.split("&")
        if not credential_key(unquote_plus(pair.split("=", 1)[0]))
    )
    return urlunsplit((parts.scheme, host, parts.path or "/", query, ""))
