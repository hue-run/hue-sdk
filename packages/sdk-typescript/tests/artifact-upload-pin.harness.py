"""Network namespace for the upload pin test. argv: node-driver cert key. JSON on stdout."""

from __future__ import annotations

import fcntl
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _sa(address: str) -> bytes:
    return struct.pack("H2s4s8s", socket.AF_INET, b"\0\0", socket.inet_aton(address), b"\0" * 8)


def _address(name: bytes, ip: str, mask: str) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if name == b"lo":
        raw = fcntl.ioctl(sock, 0x8913, struct.pack("16sH14s", name, 0, b"\0" * 14))
        flags = struct.unpack("16sH14s", raw)[1]
        fcntl.ioctl(sock, 0x8914, struct.pack("16sH14s", name, flags | 1, b"\0" * 14))
    fcntl.ioctl(sock, 0x8916, struct.pack("16s", name) + _sa(ip))
    fcntl.ioctl(sock, 0x891C, struct.pack("16s", name) + _sa(mask))
    sock.close()


_address(b"lo", "127.0.0.1", "255.0.0.0")
_address(b"lo:1", "203.0.113.10", "255.255.255.255")

HITS: list[dict[str, object]] = []
COUNTS: dict[str, int] = {}
FIXED = {
    "evil.example": "203.0.113.10",
    "loop.hue.test": "127.0.0.1",
    "evil2.example": "203.0.113.10",
    "loop2.hue.test": "127.0.0.1",
}


def _answer(name: str) -> str:
    fixed = FIXED.get(name.rstrip("."))
    if fixed:
        return fixed
    COUNTS[name] = COUNTS.get(name, 0) + 1
    return "203.0.113.10" if COUNTS[name] == 1 else "127.0.0.1"


def _dns() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("127.0.0.1", 53))
    while True:
        data, addr = server.recvfrom(512)
        index = 12
        labels: list[str] = []
        while data[index] != 0:
            length = data[index]
            labels.append(data[index + 1 : index + 1 + length].decode())
            index += 1 + length
        qtype = int.from_bytes(data[index + 1 : index + 3], "big")
        question = data[12 : index + 5]
        if qtype != 1:
            server.sendto(data[:2] + b"\x81\x80\x00\x01\x00\x00\x00\x00\x00\x00" + question, addr)
            continue
        ip = _answer(".".join(labels))
        answer = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x00\x00\x04" + socket.inet_aton(ip)
        server.sendto(
            data[:2] + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" + question + answer, addr
        )


class _Handler(BaseHTTPRequestHandler):
    where = ""

    def do_PUT(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        HITS.append(
            {
                "where": self.where,
                "path": self.path,
                "body": body.decode(),
                "authorization": self.headers.get("Authorization"),
                "blob": self.headers.get("X-Vercel-Blob-Access"),
                "type": self.headers.get("Content-Type"),
            }
        )
        self.send_response(200)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def _serve(ip: str, cert: str, key: str, port: int) -> int:
    class Handler(_Handler):
        where = "public" if ip == "203.0.113.10" else "loop"

    httpd = ThreadingHTTPServer((ip, port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    bound = int(httpd.server_address[1])
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return bound


threading.Thread(target=_dns, daemon=True).start()
mode, cert, key = sys.argv[1:4]
driver = sys.argv[4] if mode == "node" else ""
port = _serve("203.0.113.10", cert, key, 0)
_serve("127.0.0.1", cert, key, port)
resolv = Path("/tmp/upload-pin-resolv.conf")
resolv.write_text("nameserver 127.0.0.1\noptions timeout:1 attempts:1\n")
subprocess.check_call(["mount", "--bind", str(resolv), "/etc/resolv.conf"])
os.environ["REQUESTS_CA_BUNDLE"] = cert
env = {
    **os.environ,
    "PORT": str(port),
    "NODE_EXTRA_CA_CERTS": cert,
    "REQUESTS_CA_BUNDLE": cert,
    "http_proxy": "",
    "https_proxy": "",
    "HTTP_PROXY": "",
    "HTTPS_PROXY": "",
}
node_result = None
if mode == "node":
    node = subprocess.run(
        ["node", driver],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if node.returncode != 0:
        raise SystemExit(node.stderr or node.stdout)
    node_result = json.loads(node.stdout)

python_result = None
if mode == "python":
    from hue_sdk.evals.client import EvaluationClient

    remote = EvaluationClient(
        base_url="https://hue.invalid",
        api_key="synthetic-upload-key",
        timeout_seconds=2,
        max_attempts=1,
    )
    allowlisted = EvaluationClient(
        base_url="https://storage2.hue.test",
        api_key="synthetic-upload-key",
        timeout_seconds=2,
        max_attempts=1,
    )
    payload = b"pinned-python-bytes"

    def once(client: EvaluationClient, upload_url: str) -> str:
        try:
            client.upload_artifact_bytes(
                {
                    "uploadUrl": upload_url,
                    "method": "PUT",
                    "headers": {"content-type": "text/plain", "x-vercel-blob-access": "private"},
                    "expiresAt": "2099-01-01T00:00:00Z",
                },
                payload,
                "text/plain",
            )
        except Exception as error:
            return type(error).__name__
        return "sent"

    python_result = {
        "evil": once(remote, f"https://evil2.example:{port}/evil2"),
        "loop": once(remote, f"https://loop2.hue.test:{port}/loop2"),
        "pin": once(allowlisted, f"https://storage2.hue.test:{port}/pinned-python?sig=keep"),
    }
print(json.dumps({"node": node_result, "python": python_result, "hits": HITS}))
