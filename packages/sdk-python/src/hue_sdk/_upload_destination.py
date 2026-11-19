"""Where bytes sent to an upload URL Hue issued may connect."""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Mapping
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from urllib3.util.connection import create_connection

# This machine, private networks, link-local (cloud metadata), shared, benchmarking, multicast
# and reserved ranges. IPv4-mapped IPv6 addresses are checked as their IPv4 address.
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


def loopback(hostname: str) -> bool:
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return hostname.lower() == "localhost"


def _internal(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in network for network in _INTERNAL)


def _connect(connection: HTTPConnection) -> socket.socket:
    """One lookup of the connection's host; the socket goes to an address it answered only when
    every address it answered is public, so a second DNS answer cannot rebind the upload."""
    host = connection.host.strip("[]")
    try:
        answers = socket.getaddrinfo(host, connection.port, type=socket.SOCK_STREAM)
        addresses = [str(answer[4][0]) for answer in answers]
        if not addresses or any(_internal(address) for address in addresses):
            raise OSError(f"{host} resolves to an address on this machine or a private network")
        return create_connection(
            (addresses[0], connection.port),
            connection.timeout,
            source_address=connection.source_address,
            socket_options=connection.socket_options,
        )
    except TimeoutError as error:
        raise ConnectTimeoutError(connection, f"Connection to {host} timed out.") from error
    except OSError as error:
        raise NewConnectionError(
            connection, f"Failed to establish a new connection: {error}"
        ) from error


class _PublicHTTPConnection(HTTPConnection):
    def _new_conn(self) -> socket.socket:
        return _connect(self)


class _PublicHTTPSConnection(HTTPSConnection):
    def _new_conn(self) -> socket.socket:
        return _connect(self)


class _PublicHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _PublicHTTPConnection


class _PublicHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _PublicHTTPSConnection


class _PublicAdapter(HTTPAdapter):
    """Connects only to public addresses, and never through a proxy, which would resolve the
    store's host itself. TLS still verifies the certificate against the URL's host."""

    def init_poolmanager(self, *args: object, **kwargs: object) -> None:
        super().init_poolmanager(*args, **kwargs)  # type: ignore[arg-type]
        self.poolmanager.pool_classes_by_scheme = {
            "http": _PublicHTTPConnectionPool,
            "https": _PublicHTTPSConnectionPool,
        }

    def send(
        self,
        request: requests.PreparedRequest,
        stream: bool = False,
        timeout: float | tuple[float, float] | tuple[float, None] | None = None,
        verify: bool | str = True,
        cert: bytes | str | tuple[bytes | str, bytes | str] | None = None,
        proxies: Mapping[str, str] | None = None,
    ) -> requests.Response:
        return super().send(request, stream, timeout, verify, cert, None)


def upload_adapter(url: str, origin: str) -> HTTPAdapter | None:
    """How a request that sends bytes to an upload URL Hue issued must connect.

    A Hue origin on this machine may name what the caller's own checks admit: ``None``. Any
    other Hue must name HTTPS on a host whose every address is public, so a hostile or
    compromised Hue cannot have this machine send the bytes to itself or its private network:
    the request must go through the returned adapter (see ``mount``), which checks the
    addresses it connects to. Raises ``ValueError`` when the destination is refused.
    """
    if loopback(urlsplit(origin).hostname or ""):
        return None
    if urlsplit(url).scheme != "https":
        raise ValueError("The upload URL must use HTTPS.")
    return _PublicAdapter()


def mount(session: requests.Session, adapter: HTTPAdapter | None) -> None:
    """Send every request of ``session`` through ``adapter``, when there is one."""
    if adapter is not None:
        session.mount("https://", adapter)
        session.mount("http://", adapter)
