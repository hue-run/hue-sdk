"""HTTP scope liveness shared by tasks that inherit an application context."""

from __future__ import annotations

import asyncio
import weakref
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from opentelemetry import trace

if TYPE_CHECKING:
    from .client import Hue


def _origin_task() -> weakref.ReferenceType[asyncio.Task[Any]] | None:
    try:
        task = asyncio.current_task()
    except RuntimeError:
        return None
    return weakref.ref(task) if task is not None else None


@dataclass
class HttpScope:
    client: Hue
    span: trace.Span
    model: bool | None
    previous: HttpScope | None
    active: bool = True
    origin_task: weakref.ReferenceType[asyncio.Task[Any]] | None = field(
        default_factory=_origin_task
    )


def _in_origin_task(frame: HttpScope) -> bool:
    owner = frame.origin_task() if frame.origin_task is not None else None
    if owner is None:
        return False
    try:
        return asyncio.current_task() is owner
    except RuntimeError:
        return False


def _visible(frame: HttpScope) -> bool:
    # Detached work keeps its original client; only the origin task resumes outside a closed scope.
    return frame.active or not _in_origin_task(frame)


client_scope: ContextVar[HttpScope | None] = ContextVar("hue_http_scope", default=None)


def scope_for(client: Hue | None = None) -> HttpScope | None:
    frame = client_scope.get()
    while frame is not None:
        if _visible(frame) and (client is None or frame.client is client):
            return frame
        frame = frame.previous
    return None


def model_for(client: Hue) -> bool | None:
    frame = client_scope.get()
    while frame is not None:
        if _visible(frame) and frame.client is client and frame.model is not None:
            return frame.model
        frame = frame.previous
    return None


def is_stale_span(span: trace.Span) -> bool:
    frame = client_scope.get()
    while frame is not None:
        if not frame.active and _in_origin_task(frame) and frame.span is span:
            return True
        frame = frame.previous
    return False
