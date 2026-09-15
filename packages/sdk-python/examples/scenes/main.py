"""Installed-wheel example. Point both URLs at your own approved synthetic test services."""

from __future__ import annotations

import os
from uuid import uuid4

import httpx
import requests

from hue_sdk.scenes import Binding, Scenes, SnapshotMissError, SourceFile
from hue_sdk.scenes.httpx import SceneTransport


def main() -> None:
    scenes = Scenes(os.environ["HUE_BASE_URL"], os.environ["HUE_API_KEY"], capture_content=True)
    source_url = os.environ["HUE_SYNTHETIC_SOURCE_URL"]
    calls = []

    @scenes.tool(
        "documents",
        "read_document",
        sources=lambda result: [
            SourceFile("observed.txt", result["content"].encode(), "text/plain", "tool_source")
        ],
    )
    def read_document(document_id):
        calls.append(document_id)
        response = requests.get(source_url + "/files/large", timeout=10)
        response.raise_for_status()
        return {"documentId": document_id, "content": response.text}

    bindings = [
        Binding(
            "documents",
            operations=(
                {
                    "name": "read_document",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"document_id": {"type": "string"}},
                        "required": ["document_id"],
                    },
                },
            ),
        ),
        Binding("http-files", kind="http", http_origin=source_url, path_prefix="/files"),
    ]
    with httpx.Client(transport=SceneTransport(scenes)) as http:
        with scenes.capture(
            bindings=bindings,
            external_trace_id=uuid4().hex,
            input={"question": "Read the observed source."},
        ) as capture:
            expected = read_document("observed-1")
            assert http.get(source_url + "/files/error").status_code == 503
        finalized = capture.finalize()
        if not finalized.ok:
            raise RuntimeError("Scene finalization did not finish successfully.")
        recording = scenes.load(finalized.snapshot)
        with recording.replay(
            binding_ids=["documents", "http-files"], external_trace_id=uuid4().hex
        ) as replay:
            assert read_document("observed-1") == expected
            assert http.get(source_url + "/files/error").status_code == 503
            try:
                read_document("unobserved-2")
            except SnapshotMissError as error:
                assert error.reason == "unrecorded"
            else:
                raise AssertionError("An unobserved source must miss.")
        if not replay.delivery_ok:
            raise RuntimeError("Replay diagnostics were not acknowledged.")
    assert calls == ["observed-1"]
    print("source_calls=1 playback=matched caught_misses=1 diagnostics=acknowledged")


if __name__ == "__main__":
    main()
