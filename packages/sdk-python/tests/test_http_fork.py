from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires os.fork")
@pytest.mark.parametrize("inherited", ("none", "requests", "aiohttp"))
def test_fork_keeps_http_working_and_allows_fresh_capture(receiver, inherited):
    result = subprocess.run(
        [sys.executable, "-I", "-c", FORK_CONSUMER, receiver.url, inherited],
        capture_output=True,
        text=True,
        timeout=12,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "fork-http-ok" in result.stdout
    spans = receiver.spans()
    assert len(spans) == 3 + int(inherited != "none")
    assert sum(span.name == "fork-child" for span in spans) == 1
    calls = {
        fields["url.full"]: fields
        for span in spans
        if "http.request.method" in (fields := attributes(span))
    }
    assert len(calls) == 2 + int(inherited != "none")
    for path in ("/child-requests", "/child-aiohttp"):
        (fields,) = [fields for url, fields in calls.items() if url.endswith(path)]
        assert fields["http.response.status_code"] == 200
        assert json.loads(fields["output.value"]) == {"ok": True}
    assert not any(url.endswith("/ordinary") for url in calls)
    if inherited == "requests":
        (fields,) = [fields for url, fields in calls.items() if url.endswith("/inherited")]
        assert "output.value" not in fields


def attributes(span):
    return {
        item.key: getattr(item.value, item.value.WhichOneof("value")) for item in span.attributes
    }


FORK_CONSUMER = r"""
import asyncio
import gc
import os
import signal
import sys
import threading
import traceback
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import aiohttp
import requests
from hue_sdk import Hue
from hue_sdk import _http_capture, _http_streams

warnings.filterwarnings("ignore", category=DeprecationWarning)
BODY = b'{"ok":true}'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
url = "http://127.0.0.1:" + str(server.server_port)
original_send = requests.adapters.HTTPAdapter.send
original_chunk = aiohttp.StreamReader._read_nowait_chunk
hue = Hue(sys.argv[1], "synthetic-fork-key", live_spans=False)
pending = None

async def parent_stream():
    async with aiohttp.ClientSession() as client:
        async with client.get(url + "/inherited") as response:
            assert await response.content.read(1) == BODY[:1]

if sys.argv[2] == "requests":
    pending = requests.get(url + "/inherited", stream=True)
elif sys.argv[2] == "aiohttp":
    asyncio.run(parent_stream())
    assert aiohttp.StreamReader._read_nowait_chunk is not original_chunk

entered, release = threading.Event(), threading.Event()

def hold_locks():
    with _http_capture._lock, _http_streams._lock:
        entered.set()
        release.wait(10)

holder = threading.Thread(target=hold_locks)
holder.start()
assert entered.wait(5)

async def child_request():
    async with aiohttp.ClientSession() as client:
        async with client.get(url + "/child-aiohttp") as response:
            assert await response.read() == BODY

try:
    child = os.fork()
    if child == 0:
        def timeout(*args):
            os.write(2, b"fork HTTP capture timed out\n")
            os._exit(124)

        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(4)
        try:
            assert requests.get(url + "/ordinary", timeout=1).content == BODY
            if pending is not None:
                assert pending.content == BODY
                pending.close()
                pending = None
                gc.collect()
            with Hue(sys.argv[1], "synthetic-child-key", live_spans=False) as fresh:
                with fresh.span("fork-child"):
                    assert requests.get(url + "/child-requests", timeout=1).content == BODY
                    asyncio.run(child_request())
                assert fresh.force_flush()
            assert requests.adapters.HTTPAdapter.send is original_send
            assert aiohttp.StreamReader._read_nowait_chunk is original_chunk
            signal.alarm(0)
        except BaseException:
            traceback.print_exc()
            os._exit(1)
        os._exit(0)
    _, status = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(status) == 0
finally:
    release.set()
    holder.join(5)
    if pending is not None:
        pending.close()
    assert hue.shutdown_safe()
    server.shutdown()
    server.server_close()
print("fork-http-ok")
"""
