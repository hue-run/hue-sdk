"""Standalone public-package example. Default mode is explicitly synthetic."""

from __future__ import annotations

import argparse
import os
from collections.abc import Iterator

from hue_sdk import Hue


def synthetic_stream() -> Iterator[str]:
    yield "The synthetic "
    yield "tool returned "
    yield "21."


def run(hue: Hue) -> str:
    with hue.context(session_id="python-reference-session", user_id="synthetic-builder"):
        with hue.span("reference.chat", attributes={"hue.example.mode": "synthetic"}) as root:
            root.set_input({"message": "Double 10.5"})
            with hue.tool("double", call_id="synthetic-call-1") as tool:
                tool.set_input({"number": 10.5})
                result = 10.5 * 2
                tool.set_output({"result": result})
            with hue.model("synthetic-stream-v1", provider="synthetic") as model:
                model.set_input(
                    [{"role": "user", "parts": [{"type": "text", "content": "Double 10.5"}]}]
                )
                chunks: list[str] = []
                for index, chunk in enumerate(synthetic_stream()):
                    chunks.append(chunk)
                    # Chunk timing is metadata; text is captured once on completion.
                    model.otel_span.add_event("stream.chunk", {"stream.chunk.index": index})
                output = "".join(chunks)
                model.log_inference(
                    output=[{"role": "assistant", "parts": [{"type": "text", "content": output}]}]
                )
                # Synthetic token counts are deliberately unavailable, not invented.
            try:
                with hue.tool("controlled_failure"):
                    raise RuntimeError("Expected synthetic failure; message is not captured")
            except RuntimeError:
                root.set_attribute("hue.example.handled_error", True)
            root.set_output({"message": output})
            return root.trace_id


def run_openai(hue: Hue) -> str:
    """Optional real provider path; uses the official provider client directly."""
    from openai import OpenAI

    if not os.environ.get("OPENAI_API_KEY") or not os.environ.get("OPENAI_MODEL"):
        raise RuntimeError("Real mode requires OPENAI_API_KEY and OPENAI_MODEL.")
    model_name = os.environ["OPENAI_MODEL"]
    with OpenAI() as provider, hue.span("reference.real-chat") as root:
        with hue.model(model_name, provider="openai") as span:
            messages = [{"role": "user", "content": "Reply with one short greeting."}]
            span.set_input(messages)
            fragments: list[str] = []
            stream = provider.chat.completions.create(
                model=model_name,
                messages=messages,
                stream=True,
                max_completion_tokens=64,
                stream_options={"include_usage": True},
            )
            with stream:
                for chunk in stream:
                    if chunk.usage is not None:
                        span.set_usage(
                            input_tokens=chunk.usage.prompt_tokens,
                            output_tokens=chunk.usage.completion_tokens,
                        )
                    if chunk.choices and chunk.choices[0].delta.content:
                        fragments.append(chunk.choices[0].delta.content)
            span.set_output([{"role": "assistant", "content": "".join(fragments)}])
        return root.trace_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("synthetic", "openai"), default="synthetic")
    parser.add_argument("--capture-content", choices=("yes", "no"), required=True)
    args = parser.parse_args()
    with Hue(
        os.environ["HUE_BASE_URL"],
        os.environ["HUE_API_KEY"],
        capture_content=args.capture_content == "yes",
        service_name="python-reference-agent",
    ) as hue:
        hue.validate_project()
        trace_id = run(hue) if args.mode == "synthetic" else run_openai(hue)
        if not hue.force_flush():
            raise RuntimeError("Telemetry export did not complete successfully.")
        print(f"mode={args.mode} trace_id={trace_id} exported=true")


if __name__ == "__main__":
    main()
