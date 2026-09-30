"""Opt-in identity propagation through W3C baggage, mirroring the TypeScript suite."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from opentelemetry import context
from requests.structures import CaseInsensitiveDict

from hue_sdk import Hue

KEY = "synthetic-propagation-key"
WORLD = "hue-world=0b7c2d4e-1f3a-4b5c-8d9e-0a1b2c3d4e5f"
TRACEPARENT = f"00-{'a' * 32}-{'b' * 16}-01"
IDS = ("gen_ai.conversation.id", "user.id", "hue.workspace.id")
FIELDS = {"sessionId": IDS[0], "userId": IDS[1], "workspaceId": IDS[2]}
FIXTURE = (
    Path(__file__).resolve().parents[2] / "sdk-typescript/tests/fixtures/identity-baggage.json"
)
HOSTED = {
    "output": [
        {
            "type": "mcp_call",
            "id": "mcp-1",
            "name": "search_threads",
            "server_label": "gmail",
            "arguments": "{}",
        },
        {"type": "web_search_call", "id": "ws-1", "action": {"query": "q"}},
    ]
}


def attrs(span):
    return {attribute.key: attribute.value.string_value for attribute in span.attributes}


def identity(span):
    values = attrs(span)
    return tuple(values.get(key) for key in IDS)


def by_name(receiver, name):
    return [span for span in receiver.spans() if span.name == name]


def remote(baggage, traceparent=TRACEPARENT):
    return Hue.extract({"traceparent": traceparent, "baggage": baggage}, identity=True)


def test_default_inject_and_extract_ignore_identity_and_baggage(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.context(session_id="s", user_id="u", workspace_id="w"), hue.span("producer"):
            carrier: dict[str, str] = {}
            forged = {"baggage": "hue.user.id=forged"}
            Hue.inject(carrier)
            Hue.inject(forged)
        assert list(carrier) == ["traceparent"]
        assert forged["baggage"] == "hue.user.id=forged"
        extracted = Hue.extract({"traceparent": TRACEPARENT, "baggage": "hue.user.id=forged"})
        with hue.span("consumer", parent_context=extracted), hue.span("nested"):
            pass
        token = context.attach(extracted)
        try:
            with hue.span("attached"):
                pass
        finally:
            context.detach(token)
        assert hue.force_flush()
    for name in ("consumer", "nested", "attached"):
        assert identity(by_name(receiver, name)[0]) == (None, None, None)


def test_identity_travels_through_baggage_when_both_sides_opt_in(receiver):
    fixture_case = json.loads(FIXTURE.read_text())["encode"][0] if FIXTURE.is_file() else None
    session, user, workspace = "slack:T1:C1:1712.5", "org_1:U9", "T1"
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        carrier: dict[str, str] = {}
        with (
            hue.context(session_id=session, user_id=user, workspace_id=workspace),
            hue.span("producer") as producer,
        ):
            Hue.inject(carrier, identity=True)
        assert carrier["baggage"] == (
            "hue.session.id=slack%3AT1%3AC1%3A1712.5,hue.user.id=org_1%3AU9,hue.workspace.id=T1"
        )
        if fixture_case is not None:
            assert carrier["baggage"] == fixture_case["expected"]
        assert producer.span_id in carrier["traceparent"]
        assert KEY not in json.dumps(carrier)
        with hue.span("consumer", parent_context=Hue.extract(carrier, identity=True)):
            with hue.model("synthetic-model", provider="synthetic") as model:
                model.log_inference(output=[{"role": "assistant", "parts": []}])
            with hue.tool("lookup"):
                pass
            with hue.span("nested"):
                pass
        assert hue.force_flush()
        assert hue.export_status.instrumentation_failures == 0
    spans = {span.name: span for span in receiver.spans()}
    assert spans["consumer"].trace_id == spans["producer"].trace_id
    assert spans["consumer"].parent_span_id == spans["producer"].span_id
    for name in ("consumer", "chat synthetic-model", "execute_tool lookup", "nested"):
        assert identity(spans[name]) == (session, user, workspace), name
    (log,) = receiver.logs()
    assert attrs(log)["gen_ai.conversation.id"] == session


def test_inject_always_owns_the_hue_identity_members(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:

        def inject(headers, **ids):
            with hue.context(**ids), hue.span("s"):
                Hue.inject(headers, identity=True)
            return headers

        kept = inject({"baggage": f"{WORLD}, app=a%2Cb;p=1"}, session_id="s")
        assert kept["baggage"] == f"{WORLD}, app=a%2Cb;p=1,hue.session.id=s"
        assert inject({"baggage": "hue.user.id=old,app=1"}, user_id="new")["baggage"] == (
            "app=1,hue.user.id=new"
        )
        forged = inject({"baggage": "hue-world=w,hue.user.id=forged,hue.workspace.id=evil"})
        assert forged["baggage"] == "hue-world=w"
        assert list(inject({"baggage": "hue.session.id=forged"})) == ["traceparent"]
        capitalized = inject({"Baggage": "app=1"}, user_id="u")
        assert capitalized == {"Baggage": "app=1,hue.user.id=u", "traceparent": ANY}
        insensitive = inject(CaseInsensitiveDict({"BAGGAGE": "app=1"}), user_id="u")
        assert dict(insensitive.lower_items())["baggage"] == "app=1,hue.user.id=u"
        other_case = inject({"baggage": "HUE.USER.ID=x"}, user_id="u")
        assert other_case["baggage"] == "HUE.USER.ID=x,hue.user.id=u"
        # Outside any Hue scope and without an attached extracted context nothing is written.
        outside = {"baggage": "app=1,hue.user.id=forged"}
        Hue.inject(outside, identity=True)
        assert outside == {"baggage": "app=1"}
        # A value that is not a plain string is left as it is.
        typed = {"baggage": ["hue.user.id=forged"]}
        with hue.context(user_id="u"):
            Hue.inject(typed, identity=True)  # type: ignore[arg-type]
        assert typed == {"baggage": ["hue.user.id=forged"]}
        assert hue.export_status.instrumentation_failures == 0


class _Any:
    def __eq__(self, other):
        return True


ANY = _Any()


def test_identity_matches_the_typescript_fixture():
    # The TypeScript suite reads the same file. In CI a moved fixture must fail, not skip.
    if not FIXTURE.is_file():
        if os.environ.get("CI"):
            pytest.fail(f"Shared identity fixture is missing: {FIXTURE}")
        pytest.skip("TypeScript fixtures are not part of this checkout")
    from hue_sdk._propagation import merge_identity_baggage, read_identity_baggage

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for case in fixture["encode"]:
        ids = {FIELDS[field]: value for field, value in case["identity"].items()}
        assert merge_identity_baggage(case["existing"], ids) == case["expected"], case["name"]
        # The static inject writes the same header from a hue.context() scope.
        headers = {} if case["existing"] is None else {"baggage": case["existing"]}
        from hue_sdk._propagation import identity_scope

        token = identity_scope.set(ids)
        try:
            Hue.inject(headers, identity=True)
        finally:
            identity_scope.reset(token)
        assert headers.get("baggage") == case["expected"], case["name"]
    for case in fixture["decode"]:
        expected = case["identity"]
        if expected is not None:
            expected = {FIELDS[field]: value for field, value in expected.items()}
        assert read_identity_baggage(case["header"]) == expected, case["name"]


def test_remote_parent_overrides_outer_context_but_not_inner(receiver):
    extracted = remote("hue.session.id=remote,hue.user.id=ru")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.context(session_id="outer", user_id="X", workspace_id="w-outer"):
            with hue.span("joined", parent_context=extracted):
                with hue.model("m", provider="synthetic"):
                    pass
                with hue.context(user_id="Y"), hue.tool("inner"):
                    pass
            with hue.span("sibling") as sibling:
                pass
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    assert identity(spans["joined"]) == ("remote", "ru", "w-outer")
    assert identity(spans["chat m"]) == ("remote", "ru", "w-outer")
    assert identity(spans["execute_tool inner"]) == ("remote", "Y", "w-outer")
    assert identity(spans["sibling"]) == ("outer", "X", "w-outer")
    assert spans["joined"].trace_id == bytes.fromhex("a" * 32)
    assert sibling.trace_id != "a" * 32


def test_attributes_identifiers_are_explicit_scope_for_nested_helpers(receiver):
    extracted = remote("hue.session.id=remote,hue.user.id=ru")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("s", parent_context=extracted, attributes={"user.id": "explicit"}):
            with hue.model("m", provider="synthetic"):
                pass
            with hue.tool("t"):
                pass
            headers: dict[str, str] = {}
            Hue.inject(headers, identity=True)
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    for name in ("s", "chat m", "execute_tool t"):
        assert identity(spans[name]) == ("remote", "explicit", None), name
    assert headers["baggage"] == "hue.session.id=remote,hue.user.id=explicit"


def test_explicit_parent_without_identity_hides_an_attached_identity(receiver):
    # As in TypeScript, where helpers nested in a span resolve from its scope, not the active one.
    token = context.attach(remote("hue.session.id=remote,hue.user.id=ru"))
    try:
        with Hue(receiver.url, KEY, capture_content=False) as hue:
            plain = Hue.extract({"traceparent": TRACEPARENT})
            with hue.span("explicit", parent_context=plain):
                with hue.model("m", provider="synthetic"):
                    pass
                headers: dict[str, str] = {}
                Hue.inject(headers, identity=True)
            assert hue.force_flush()
    finally:
        context.detach(token)
    spans = {span.name: span for span in receiver.spans()}
    assert identity(spans["explicit"]) == (None, None, None)
    assert identity(spans["chat m"]) == (None, None, None)
    assert "baggage" not in headers


def test_invalid_identifier_attributes_do_not_replace_a_remote_identity(receiver):
    extracted = remote("hue.session.id=remote,hue.user.id=ru")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("s", parent_context=extracted, attributes={"user.id": ""}):
            with hue.tool("t"):
                pass
            headers: dict[str, str] = {}
            Hue.inject(headers, identity=True)
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    # The span keeps its own attribute as given; its scope, nested helpers and inject agree.
    assert identity(spans["s"]) == ("remote", "", None)
    assert identity(spans["execute_tool t"]) == ("remote", "ru", None)
    assert headers["baggage"] == "hue.session.id=remote,hue.user.id=ru"


def test_attached_remote_identity_does_not_override_nested_context(receiver):
    token = context.attach(remote("hue.session.id=remote,hue.user.id=ru"))
    try:
        with Hue(receiver.url, KEY, capture_content=False) as hue:
            with hue.span("root"):
                # Inside the block the attached identity is no longer on the current context, so
                # a parent derived from it does not carry the remote user over hue.context().
                with (
                    hue.context(user_id="Y"),
                    hue.span("derived", parent_context=context.get_current()),
                ):
                    pass
            with hue.context(user_id="X"):
                with hue.model("m", provider="openai") as model:
                    model.record_provider_tool_calls(HOSTED)
                # After the model block the attached identity is current again; the children
                # still take their parent's scope, not the remote user.
                model.record_provider_tool_calls(HOSTED)
            assert hue.force_flush()
            assert hue.export_status.instrumentation_failures == 0
    finally:
        context.detach(token)
    spans = receiver.spans()
    (root,) = [span for span in spans if span.name == "root"]
    assert identity(root) == ("remote", "ru", None)
    (derived,) = [span for span in spans if span.name == "derived"]
    assert identity(derived) == ("remote", "Y", None)
    assert derived.parent_span_id == root.span_id
    (model_span,) = [span for span in spans if span.name == "chat m"]
    assert identity(model_span) == ("remote", "X", None)
    children = [span for span in spans if span.name.startswith("execute_tool ")]
    assert len(children) == 4
    inside, after = children[:2], children[2:]
    for child in inside:
        assert identity(child) == ("remote", "X", None)
    for child in after:
        assert identity(child)[1] == "X"


def test_extract_treats_baggage_as_untrusted(receiver):
    def members(count):
        return ",".join(f"m{index}=v" for index in range(count))

    class Sneaky(str):
        def __str__(self):
            raise RuntimeError("synthetic conversion failure")

    refused = [
        "hue.session.id=%zz",
        "hue.session.id=%C3%28",
        "hue.session.id=%00",
        "hue.session.id=é",
        f"hue.session.id={'a' * 4097}",
        "hue.session.id=a,hue.session.id=b",
        "hue.session.id=s,pad=" + "p" * (8192 - len("hue.session.id=s,pad=") + 1),
        f"hue.session.id=s,{members(180)}",
        "HUE.SESSION.ID=s",
        "hue.session.id=",
        b"hue.session.id=s",
        ["hue.session.id=s"],
        Sneaky("hue.session.id=s"),
    ]
    assert len(refused[6].encode()) == 8193
    accepted = [
        " hue.session.id = s ;p=1 ",
        "hue.session.id=s,pad=" + "p" * (8192 - len("hue.session.id=s,pad=")),
        f"hue.session.id=s,{members(179)}",
    ]
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        for baggage in refused:
            with hue.span("refused", parent_context=remote(baggage)):
                pass
        for baggage in accepted:
            with hue.span("accepted", parent_context=remote(baggage)):
                pass
        assert hue.export_status.instrumentation_failures == 0
        assert hue.force_flush()
    assert len(by_name(receiver, "refused")) == len(refused)
    for span in by_name(receiver, "refused"):
        assert "gen_ai.conversation.id" not in attrs(span)
    assert [attrs(span)["gen_ai.conversation.id"] for span in by_name(receiver, "accepted")] == [
        "s"
    ] * len(accepted)


def test_inject_stays_within_baggage_bounds_without_counting_remote_crowding(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        long: dict[str, str] = {}
        with hue.context(session_id="s", workspace_id="w" * 4080), hue.span("long"):
            Hue.inject(long, identity=True)
        assert "traceparent" in long
        assert long["baggage"] == "hue.session.id=s"
        others = [f"m{index}={'v' * 3}{index}" for index in range(62)]
        crowded = {"baggage": ",".join([*others[:31], "hue.user.id=forged", *others[31:]])}
        with hue.context(session_id="s", user_id="u", workspace_id="w"), hue.span("crowded"):
            Hue.inject(crowded, identity=True)
        assert "traceparent" in crowded
        assert crowded["baggage"] == ",".join(others)
        large = {"baggage": f"app={'x' * 8180}"}
        with hue.context(session_id="s"):
            Hue.inject(large, identity=True)
        assert large == {"baggage": f"app={'x' * 8180}"}
        assert hue.export_status.instrumentation_failures == 0
        assert hue.force_flush()


def test_disabled_client_relays_only_an_attached_identity(receiver):
    hue = Hue(receiver.url, KEY, capture_content=False, enabled=False)
    extracted = remote("hue.session.id=s,hue.user.id=u")
    through_span = {"baggage": f"{WORLD},hue.user.id=forged"}
    with hue.context(session_id="local"), hue.span("off", parent_context=extracted):
        Hue.inject(through_span, identity=True)
    # The disabled span ignores parent_context, so neither trace context nor identity is relayed.
    assert through_span == {"baggage": WORLD}
    attached: dict[str, str] = {"baggage": WORLD}
    token = context.attach(extracted)
    try:
        Hue.inject(attached, identity=True)
    finally:
        context.detach(token)
    assert attached == {
        "baggage": f"{WORLD},hue.session.id=s,hue.user.id=u",
        "traceparent": TRACEPARENT,
    }
    assert hue.export_status.instrumentation_failures == 0
    hue.shutdown()
    assert receiver.requests == []


def test_identity_crosses_a_real_process_boundary(receiver, tmp_path):
    worker = tmp_path / "worker.py"
    worker.write_text(
        """
import json, os
from hue_sdk import Hue
with Hue(os.environ["HUE_BASE_URL"], os.environ["HUE_API_KEY"], capture_content=False) as hue:
    headers = {"traceparent": os.environ["TRACEPARENT"], "baggage": os.environ["BAGGAGE"]}
    with hue.span("worker", parent_context=Hue.extract(headers, identity=True)):
        pass
    assert hue.force_flush()
print(json.dumps({"baggage": os.environ["BAGGAGE"]}))
"""
    )
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        # The orchestrator seeds its carrier from an inherited BAGGAGE so hue-world survives.
        carrier = {"baggage": WORLD}
        with (
            hue.context(session_id="slack:T1:C1:1712.5", user_id="org_1:U9", workspace_id="T1"),
            hue.span("orchestrator"),
        ):
            Hue.inject(carrier, identity=True)
        completed = subprocess.run(
            [sys.executable, str(worker)],
            env={
                "PATH": os.environ["PATH"],
                "PYTHONNOUSERSITE": "1",
                "HUE_BASE_URL": receiver.url,
                "HUE_API_KEY": KEY,
                "TRACEPARENT": carrier["traceparent"],
                "BAGGAGE": carrier["baggage"],
            },
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        assert hue.force_flush()
    assert json.loads(completed.stdout)["baggage"].startswith(f"{WORLD},")
    spans = {span.name: span for span in receiver.spans()}
    assert spans["worker"].trace_id == spans["orchestrator"].trace_id
    assert spans["worker"].parent_span_id == spans["orchestrator"].span_id
    assert identity(spans["worker"]) == ("slack:T1:C1:1712.5", "org_1:U9", "T1")


def test_str_subclass_values_are_never_converted(receiver):
    hooks = []

    class Hooked(str):
        def __str__(self):
            hooks.append("str")
            raise RuntimeError("synthetic conversion failure")

        def __format__(self, spec):
            hooks.append("format")
            raise RuntimeError("synthetic formatting failure")

        def encode(self, *args, **kwargs):
            hooks.append("encode")
            raise RuntimeError("synthetic encoding failure")

    with Hue(receiver.url, KEY, capture_content=False) as hue:
        headers: dict[str, str] = {}
        with hue.context(session_id="s", user_id=Hooked("hooked")):
            Hue.inject(headers, identity=True)
        assert headers["baggage"] == "hue.session.id=s"
        extracted = remote("hue.session.id=remote")
        with hue.span("s", parent_context=extracted, attributes={"user.id": Hooked("attr")}):
            nested: dict[str, str] = {}
            Hue.inject(nested, identity=True)
        assert nested["baggage"] == "hue.session.id=remote"
        inbound = Hue.extract(
            {"traceparent": TRACEPARENT, "baggage": Hooked("hue.user.id=x")}, identity=True
        )
        out: dict[str, str] = {}
        token = context.attach(inbound)
        try:
            Hue.inject(out, identity=True)
        finally:
            context.detach(token)
        assert "baggage" not in out
    assert hooks == []


def test_identity_scope_is_task_local(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        seen: dict[str, str] = {}

        async def task(label):
            with hue.context(session_id=label):
                await asyncio.sleep(0)
                headers: dict[str, str] = {}
                Hue.inject(headers, identity=True)
                await asyncio.sleep(0)
                seen[label] = headers["baggage"]

        async def both():
            await asyncio.gather(task("one"), task("two"))

        asyncio.run(both())
        outside: dict[str, str] = {}
        Hue.inject(outside, identity=True)
    assert seen == {"one": "hue.session.id=one", "two": "hue.session.id=two"}
    assert outside == {}


def test_static_and_instance_calls_agree(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        static: dict[str, str] = {"baggage": WORLD}
        instance: dict[str, str] = {"baggage": WORLD}
        with hue.context(session_id="s", user_id="u"), hue.span("s"):
            Hue.inject(static, identity=True)
            hue.inject(instance, identity=True)
        assert static == instance
        assert static["baggage"] == f"{WORLD},hue.session.id=s,hue.user.id=u"
        # Only identity=True opts in; a truthy value of another type does not.
        truthy: dict[str, str] = {}
        with hue.context(session_id="s"):
            Hue.inject(truthy, identity=1)  # type: ignore[arg-type]
        assert truthy == {}
        assert hue.extract({"baggage": "hue.session.id=s"}, identity="yes") == context.Context()  # type: ignore[arg-type]
