"""Where a PUT of file bytes to an upload URL Hue answered may connect."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from requests.adapters import HTTPAdapter

# This machine, private networks, link-local (cloud metadata), shared, benchmarking, multicast
# and reserved ranges, as the TypeScript SDK refuses them.
_INTERNAL = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/3",
        "::/128",
        "::1/128",
        "64:ff9b::/96",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
)
# A pinned upload connects to the checked address itself: a proxy would resolve the name again.
DIRECT: dict[str, Any] = {"http": None, "https": None, "all": None}


def _internal(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in network for network in _INTERNAL)


def _loopback(hostname: str) -> bool:
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return hostname == "localhost"


def upload_address(url: str, origin: str, *, any_host: bool = False) -> str | None:
    """The address a PUT to ``url``, an upload URL Hue answered, must connect to.

    Hue chooses the URL, so unless ``origin`` is on this machine (a development server, which may
    answer any URL its caller accepts) the URL must use HTTPS on ``origin``'s own host, and every
    address that host resolves to must be public. ``any_host`` lifts the host and scheme rules for
    a presigned store on another host, whose scheme the caller checks. A name is resolved once
    here and the first of those checked addresses is returned for :func:`pinned`, so a second DNS
    answer cannot move the bytes onto this machine's network; None when no pin is needed.

    Raises ValueError when the URL is refused.
    """
    origin_host = urlsplit(origin).hostname or ""
    if _loopback(origin_host):
        return None
    parts = urlsplit(url)
    host = parts.hostname or ""
    if not any_host and (parts.scheme != "https" or host != origin_host):
        raise ValueError()
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    if literal:
        addresses = [host]
    else:
        try:
            addresses = [
                str(info[4][0])
                for info in socket.getaddrinfo(
                    host, parts.port or (443 if parts.scheme == "https" else 80)
                )
            ]
        except (OSError, UnicodeError):
            raise ValueError() from None
    if not addresses or any(_internal(address) for address in addresses):
        raise ValueError()
    # An IP literal is where the connection goes already; only a name needs the pin.
    return None if literal else addresses[0]


class _PinnedAdapter(HTTPAdapter):
    """Verifies TLS against the URL's own host while the request goes to its checked address."""

    def __init__(self, hostname: str) -> None:
        self._hostname = hostname
        super().__init__()

    def init_poolmanager(
        self, connections: int, maxsize: int, block: bool = False, **pool_kwargs: Any
    ) -> None:
        pool_kwargs.update(server_hostname=self._hostname, assert_hostname=self._hostname)
        super().init_poolmanager(connections, maxsize, block, **pool_kwargs)


def pinned(session: requests.Session, url: str, address: str | None) -> tuple[str, dict[str, str]]:
    """The URL to request on ``session`` and the Host header to add, so that the request connects
    to ``address`` (from :func:`upload_address`) with the path and query unchanged. Send it with
    ``proxies=DIRECT``. Without an address, ``url`` as it is and no header."""
    if address is None:
        return url, {}
    parts = urlsplit(url)
    netloc = f"[{address}]" if ":" in address else address
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    if parts.scheme == "https":
        session.mount("https://", _PinnedAdapter(parts.hostname or ""))
    return urlunsplit(parts._replace(netloc=netloc)), {"Host": parts.netloc}
