from __future__ import annotations

import gzip
import json
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


@contextmanager
def capture_api():
    calls = []
    state = {
        "revision": 0,
        "receipts": {},
        "fail_append": False,
        "finalized": {},
        "fail_finalize": None,
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "null"
            )
            calls.append(
                {
                    "path": self.path,
                    "body": body,
                    "authorization": self.headers.get("Authorization"),
                    "acceptEncoding": self.headers.get("Accept-Encoding"),
                }
            )
            status = 200
            if self.path == "/api/v1/captures":
                result = {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "captureRevision": state["revision"],
                }
            elif self.path.endswith("/append"):
                if body["idempotencyKey"] not in state["receipts"]:
                    state["revision"] += 1
                    state["receipts"][body["idempotencyKey"]] = state["revision"]
                result = {"captureRevision": state["receipts"][body["idempotencyKey"]]}
                if state["fail_append"]:
                    state["fail_append"] = False
                    status = 503
            elif self.path.endswith("/finalize"):
                fail = state["fail_finalize"]
                state["fail_finalize"] = None
                prior = state["finalized"].get(body["expectedCaptureRevision"])
                result = {
                    "revision": body["expectedCaptureRevision"],
                    "digest": "a" * 64,
                    "omissions": [],
                }
                if fail == "before":
                    status = 503
                elif prior:
                    if prior["body"] != body:
                        status = 409
                    result = prior["result"]
                elif body["expectedCaptureRevision"] != state["revision"]:
                    status = 409
                else:
                    state["finalized"][body["expectedCaptureRevision"]] = {
                        "body": body,
                        "result": result,
                    }
                    if fail == "after":
                        status = 503
            else:
                result = {"captureRevision": state["revision"]}
            encoded = json.dumps(result).encode()
            if state.get("oversized_response"):
                encoded = json.dumps({**result, "padding": "x" * (1024 * 1024)}).encode()
            if state.get("gzip"):
                if state.get("gzip_members"):
                    middle = len(encoded) // 2
                    encoded = gzip.compress(encoded[:middle]) + gzip.compress(encoded[middle:])
                else:
                    encoded = gzip.compress(encoded)
                if state.get("gzip_trickle"):
                    # A gzip filename header produces no decoded output while it arrives.
                    encoded = (
                        encoded[:3] + b"\x08" + encoded[4:10] + b"x" * 100 + b"\0" + encoded[10:]
                    )
                if state.get("gzip_truncated"):
                    encoded = encoded[:-4]
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if state.get("unsupported_encoding"):
                self.send_header("Content-Encoding", "unknown")
            elif state.get("gzip"):
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                if state.get("gzip_trickle"):
                    for byte in encoded[:111]:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.01)
                    encoded = encoded[111:]
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls, state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
