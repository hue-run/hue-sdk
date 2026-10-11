#!/usr/bin/env python3
"""Loopback stand-in for the Hue API: answers the project check and acknowledges OTLP.

Prints one JSON line when ready ({"ready": url}) and one per request it receives, so a
transcript of this process is the export evidence. Stdlib only; never use a real key.
"""

from __future__ import annotations

import gzip
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROJECT = {
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Synthetic verification project",
    "slug": "synthetic-verification",
    "organizationId": "00000000-0000-4000-8000-000000000002",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.respond()

    def do_POST(self) -> None:
        self.respond()

    def respond(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        headers = {"Content-Type": "application/x-protobuf"}
        status, result = 200, b""
        if self.path == "/api/v1/projects/current":
            headers, result = (
                {"Content-Type": "application/json"},
                json.dumps(PROJECT).encode(),
            )
        elif self.path.startswith("/api/v1/otlp/blobs"):
            status, result = 404, b"Not Found"
        elif self.path.endswith("/traces"):
            headers["Hue-Pending-Spans"] = "1"
        print(
            json.dumps(
                {
                    "method": self.command,
                    "path": self.path,
                    "status": status,
                    "bytes": len(body),
                    "bearer": self.headers.get("Authorization", "").startswith(
                        "Bearer "
                    ),
                }
            ),
            flush=True,
        )
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(result)))
        self.end_headers()
        self.wfile.write(result)

    def log_message(self, *_args: object) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(
        json.dumps({"ready": f"http://127.0.0.1:{server.server_address[1]}"}),
        flush=True,
    )
    server.serve_forever()
