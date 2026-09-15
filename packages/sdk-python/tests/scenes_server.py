"""Synthetic public Scenes API and independent source endpoint for consumer acceptance."""

from __future__ import annotations

import gzip
import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from urllib.parse import urlsplit
from uuid import uuid4

from hue_sdk.scenes import canonical_json
from hue_sdk.scenes._json import sha256


class SceneServer:
    def __init__(self):
        self.lock = Lock()
        self.requests = []
        self.scenes = {}
        self.snapshots = {}
        self.artifacts = {}
        self.replays = {}
        self.idempotency = {}
        self.source_hits = []
        self.corrupt_download = False
        self.reject_observation_once = False
        self.slow_headers = Event()
        self.slow_release = Event()
        self.bad_verified_hash = False
        self.conflict_finalize_once = False

    def metadata(self, method, path, body):
        pieces = path.split("/")[3:]
        resource = pieces[0]
        key = (path, body.get("idempotencyKey"))
        if method == "POST" and key[1] is not None and key in self.idempotency:
            return self.idempotency[key]
        status = 200
        if resource == "artifacts":
            if len(pieces) == 1:
                artifact_id = str(uuid4())
                self.artifacts[artifact_id] = {**body, "id": artifact_id, "state": "pending"}
                response, status = self.artifacts[artifact_id].copy(), 201
            else:
                artifact = self.artifacts[pieces[1]]
                if pieces[2] == "upload":
                    response = {
                        "uploadUrl": self.url + "/upload/" + pieces[1],
                        "method": "PUT",
                        "headers": {"X-Upload-Capability": "synthetic-only"},
                        "expiresAt": "2099-01-01T00:00:00Z",
                    }
                else:
                    data = artifact.get("bytes", b"")
                    artifact.update(
                        state="ready",
                        verifiedBytes=len(data),
                        verifiedSha256="0" * 64 if self.bad_verified_hash else sha256(data),
                    )
                    response = {key: value for key, value in artifact.items() if key != "bytes"}
        elif resource == "scenes":
            if len(pieces) == 1:
                scene_id = str(uuid4())
                self.scenes[scene_id] = {
                    **body,
                    "id": scene_id,
                    "captureRevision": 1,
                    "observations": [],
                    "sources": [],
                }
                response = {"id": scene_id, "captureRevision": 1}
            else:
                scene = self.scenes[pieces[1]]
                if len(pieces) == 2:
                    return 200, {"id": scene["id"], "captureRevision": scene["captureRevision"]}
                route = pieces[2]
                if route in {"observations", "sources"}:
                    for record in body[route]:
                        if not any(existing["id"] == record["id"] for existing in scene[route]):
                            scene[route].append(record)
                            scene["captureRevision"] += 1
                    response = {
                        "accepted": len(body[route]),
                        "captureRevision": scene["captureRevision"],
                    }
                elif route == "finalize":
                    if self.conflict_finalize_once:
                        self.conflict_finalize_once = False
                        scene["captureRevision"] += 1
                        return 409, {}
                    assert body["expectedCaptureRevision"] == scene["captureRevision"]
                    revision = sum(1 for key in self.snapshots if key[0] == scene["id"]) + 1
                    manifest = {
                        "schemaVersion": "1",
                        "sceneId": scene["id"],
                        "projectId": "11111111-1111-4111-8111-111111111111",
                        "revision": revision,
                        "externalTraceId": scene["externalTraceId"],
                        "bindings": scene["bindings"],
                        "observations": scene["observations"],
                        "sources": scene["sources"],
                        "producers": body["producers"],
                        "createdAt": body["endedAt"],
                    }
                    for field in ("input", "sessionId", "observedUserId", "capturePolicy"):
                        if field in scene:
                            manifest[field] = scene[field]
                    manifest = json.loads(json.dumps(manifest))
                    digest = sha256(canonical_json(manifest))
                    self.snapshots[(scene["id"], revision)] = {
                        "manifest": manifest,
                        "digest": digest,
                    }
                    response = {"sceneId": scene["id"], "revision": revision, "digest": digest}
                else:
                    response = self.snapshots[(scene["id"], int(pieces[3]))]
        elif resource == "scene-replays":
            if len(pieces) == 1:
                replay_id = str(uuid4())
                self.replays[replay_id] = {**body, "id": replay_id, "events": []}
                response = {"id": replay_id}
            else:
                replay = self.replays[pieces[1]]
                if pieces[2] == "events":
                    for event in body["events"]:
                        if not any(existing["id"] == event["id"] for existing in replay["events"]):
                            replay["events"].append(event)
                    response = {"accepted": len(body["events"])}
                else:
                    replay["state"] = body["state"]
                    response = {
                        "id": replay["id"],
                        "state": replay["state"],
                        "missCount": sum(event["status"] == "miss" for event in replay["events"]),
                    }
        else:
            return 404, {}
        if method == "POST" and key[1] is not None:
            self.idempotency[key] = status, response
        if self.reject_observation_once and resource == "scenes" and pieces[-1] == "observations":
            self.reject_observation_once = False
            return 503, {}
        return status, response


@contextmanager
def scene_server():
    state = SceneServer()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_GET(self):
            self.handle_route()

        def do_POST(self):
            self.handle_route()

        def do_PUT(self):
            self.handle_route()

        def handle_route(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            path = urlsplit(self.path).path
            status, headers = 200, {}
            if self.server.source:
                state.source_hits.append((self.command, self.path, body, dict(self.headers)))
                data = b"observed source document"
                if path == "/files/error":
                    status, data = 503, b"source temporarily unavailable"
                if path == "/files/gzip":
                    data = gzip.compress(data)
                    headers["Content-Encoding"] = "gzip"
                if path == "/files/json":
                    data = json.dumps({"content": "source json", "request": body.decode()}).encode()
                    headers["Content-Type"] = "application/json"
                if path in {"/files/secrets", "/files/secrets-gzip"}:
                    data = json.dumps(
                        {"content": "document", "access_token": "source-token"}
                    ).encode()
                    headers["Content-Type"] = "application/json"
                    if path.endswith("-gzip"):
                        data = gzip.compress(data)
                        headers["Content-Encoding"] = "gzip"
                if path == "/files/document.pdf":
                    data = b"%PDF synthetic observed source"
                    headers["Content-Type"] = "application/pdf"
                if path == "/files/large":
                    data = b"x" * (300 * 1024)
                headers["Set-Cookie"] = "secret=do-not-capture"
            elif path.startswith("/upload/"):
                assert "Authorization" not in self.headers
                assert self.headers["X-Upload-Capability"] == "synthetic-only"
                state.artifacts[path.split("/")[-1]]["bytes"] = body
                data = b""
            else:
                assert self.headers["Authorization"] == "Bearer synthetic-scenes-key"
                state.requests.append((self.command, path, body, dict(self.headers)))
                if path.endswith("/download"):
                    artifact = state.artifacts[path.split("/")[-2]]
                    data = b"corrupt" if state.corrupt_download else artifact["bytes"]
                else:
                    with state.lock:
                        status, response = state.metadata(
                            self.command, path, json.loads(body) if body else {}
                        )
                    data = json.dumps(response).encode()
                    headers["Content-Type"] = "application/json"
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            if self.server.source and path == "/files/slow":
                state.slow_headers.set()
                state.slow_release.wait(5)
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    servers, threads = [], []
    for source in (False, True):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        server.source = source
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append(server)
        threads.append(thread)
    state.url = f"http://127.0.0.1:{servers[0].server_port}"
    state.source_url = f"http://127.0.0.1:{servers[1].server_port}"
    try:
        yield state
    finally:
        state.slow_release.set()
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join()
