"""World preparation retries preserve identity and have cancellable finite waits."""

import json
import threading
import time
from uuid import UUID, uuid4

import pytest

from hue_sdk.world import HueWorldError, WorldClient, WorldModelClient
from hue_sdk.world import client as world_client

KEY = "synthetic-preparation-key"
AT = "2026-10-17T00:00:00Z"


@pytest.mark.parametrize("method", ["materialize", "start", "reproduce", "run", "instance"])
def test_preparation_outlasts_attempt_count_with_identical_bytes(receiver, method):
    for _ in range(5):
        receiver.reply(503, **{"X-Hue-Diagnostic": "world_preparing", "Retry-After": "0"})
    receiver.reply(200, b'{"ready":true}')
    models = WorldModelClient(api_key=KEY, base_url=receiver.url, max_attempts=1)
    world = WorldClient(api_key=KEY, base_url=receiver.url, max_attempts=1)
    identity = str(uuid4())
    if method == "materialize":
        models.materialize(identity, at=AT)
    elif method == "start":
        models.start_instance(identity, at=AT, idempotency_key="stable-start")
    elif method == "reproduce":
        models.reproduce_instance(identity, idempotency_key="stable-reproduce")
    elif method == "run":
        world.create_run(environment_version_id=identity, idempotency_key="stable-run")
    else:
        world.create_instance(world_version_id=identity, idempotency_key="stable-instance")
    assert len(receiver.requests) == 6
    assert len({body for _, _, body in receiver.requests}) == 1


def test_materialization_generates_one_identity_per_call(receiver):
    receiver.reply(503, **{"X-Hue-Diagnostic": "world_preparing", "Retry-After": "0"})
    receiver.reply(200, b'{"world":{}}')
    receiver.reply(200, b'{"world":{}}')
    models = WorldModelClient(api_key=KEY, base_url=receiver.url, max_attempts=1)
    models.materialize(str(uuid4()), at=AT)
    models.materialize(str(uuid4()), at=AT)
    bodies = [json.loads(body) for _, _, body in receiver.requests]
    assert bodies[0] == bodies[1]
    assert str(UUID(bodies[0]["idempotencyKey"])) == bodies[0]["idempotencyKey"]
    assert bodies[0]["idempotencyKey"] != bodies[2]["idempotencyKey"]
    assert bodies[0]["at"] == AT


def test_other_errors_and_unrelated_reads_keep_attempt_limit(receiver):
    models = WorldModelClient(api_key=KEY, base_url=receiver.url, max_attempts=2)
    for diagnostic, operation in [
        ("world_unavailable", lambda: models.materialize(str(uuid4()), at=AT)),
        ("world_preparing", lambda: models.get_model(str(uuid4()))),
        ("WORLD_PREPARING", lambda: models.materialize(str(uuid4()), at=AT)),
    ]:
        for _ in range(2):
            receiver.reply(
                503, b"private response", **{"X-Hue-Diagnostic": diagnostic, "Retry-After": "0"}
            )
        with pytest.raises(HueWorldError) as caught:
            operation()
        assert "private response" not in str(caught.value)
    assert len(receiver.requests) == 6


def test_preparation_deadline_does_not_reset(receiver, monkeypatch):
    monkeypatch.setattr(world_client, "_WORLD_PREPARATION_WAIT_SECONDS", 0.2)
    for _ in range(10):
        receiver.reply(503, **{"X-Hue-Diagnostic": "world_preparing", "Retry-After": "0"})
    models = WorldModelClient(api_key=KEY, base_url=receiver.url, max_attempts=1)
    started = time.monotonic()
    with pytest.raises(HueWorldError):
        models.materialize(str(uuid4()), at=AT)
    assert 0.15 <= time.monotonic() - started < 1
    assert len(receiver.requests) <= 3


def test_preparation_deadline_ends_trickling_response_without_cancellation(receiver, monkeypatch):
    monkeypatch.setattr(world_client, "_WORLD_PREPARATION_WAIT_SECONDS", 0.3)
    tracked = []
    original_deadline = world_client._ReadDeadline
    original_send = world_client.WorldClient._send
    calls = 0

    class Deadline(original_deadline):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            tracked.append(self)

    def send(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            # Every byte arrives before the socket's per-read timeout. Only the
            # preparation window can interrupt this otherwise successful response.
            receiver.trickle_seconds = 0.02
        return original_send(self, *args, **kwargs)

    monkeypatch.setattr(world_client, "_ReadDeadline", Deadline)
    monkeypatch.setattr(world_client.WorldClient, "_send", send)
    receiver.reply(503, **{"X-Hue-Diagnostic": "world_preparing", "Retry-After": "0"})
    receiver.reply(200, b'{"ready":true}')
    models = WorldModelClient(api_key=KEY, base_url=receiver.url, max_attempts=1)
    started = time.monotonic()
    with pytest.raises(HueWorldError):
        models.materialize(str(uuid4()), at=AT)
    assert time.monotonic() - started < 0.8
    assert len(receiver.requests) == 2
    assert tracked[-1].passed
    for deadline in tracked:
        deadline._timer.join(timeout=0.2)
        assert not deadline._timer.is_alive()
        assert deadline._cancel_watch is None
        assert deadline._sockets == []


@pytest.mark.parametrize("phase", ["sleep", "request"])
def test_cancel_event_ends_wait_and_socket_read_without_monitor_leaks(receiver, monkeypatch, phase):
    tracked = []
    original = world_client._ReadDeadline

    class Deadline(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            tracked.append(self)

    monkeypatch.setattr(world_client, "_ReadDeadline", Deadline)
    if phase == "request":
        receiver.delay_seconds = 2
        receiver.reply(200, b'{"world":{}}')
    else:
        receiver.reply(503, **{"X-Hue-Diagnostic": "world_preparing", "Retry-After": "10"})
    cancel = threading.Event()
    timer = threading.Timer(0.08, cancel.set)
    timer.start()
    models = WorldModelClient(api_key=KEY, base_url=receiver.url)
    started = time.monotonic()
    try:
        with pytest.raises(HueWorldError):
            models.materialize(str(uuid4()), at=AT, cancel_event=cancel)
        assert time.monotonic() - started < 0.75
        assert len(receiver.requests) == 1
        assert tracked
        for deadline in tracked:
            deadline._timer.join(timeout=0.2)
            assert not deadline._timer.is_alive()
            assert deadline._cancel_watch is not None and not deadline._cancel_watch.is_alive()
            assert deadline._sockets == []
    finally:
        timer.cancel()
        timer.join(timeout=0.2)


def test_invalid_and_pre_cancelled_events_never_send(receiver):
    models = WorldModelClient(api_key=KEY, base_url=receiver.url)
    with pytest.raises(TypeError, match="threading.Event"):
        models.materialize(str(uuid4()), at=AT, cancel_event=object())
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(HueWorldError):
        models.start_instance(str(uuid4()), at=AT, idempotency_key="start", cancel_event=cancel)
    assert receiver.requests == []
