"""Return an inbox summary while Hue records the underlying Gmail HTTP reads."""

from __future__ import annotations

import argparse
import json
import os
from typing import TypedDict
from urllib.parse import quote

import requests

from hue_sdk import Hue


class Summary(TypedDict):
    count: int
    ids: list[str]


def summarize_inbox(
    hue: Hue, gmail: requests.Session, base_url: str, *, max_results: int = 5
) -> Summary:
    with hue.tool("summarize_inbox") as tool:
        tool.set_input({"query": "is:unread", "limit": max_results})
        response = gmail.get(
            f"{base_url}/gmail/v1/users/me/messages",
            params={"maxResults": max_results, "q": "is:unread"},
            timeout=15,
        )
        response.raise_for_status()
        listing = response.json()
        if not isinstance(listing, dict) or not isinstance(listing.get("messages", []), list):
            raise TypeError("Gmail returned an invalid message list.")
        ids: list[str] = []
        for entry in listing.get("messages", [])[:5]:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                raise TypeError("Gmail returned an invalid message ID.")
            message_response = gmail.get(
                f"{base_url}/gmail/v1/users/me/messages/{quote(entry['id'], safe='')}",
                params={"format": "full"},
                timeout=15,
            )
            message_response.raise_for_status()
            message = message_response.json()
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                raise TypeError("Gmail returned an invalid message.")
            ids.append(message["id"])
        summary: Summary = {"count": len(ids), "ids": ids}
        tool.set_output(summary)
        return summary


def env_bool(name: str) -> bool:
    value = os.environ.get(name, "true").lower()
    if value not in {"true", "false"}:
        raise ValueError(f"{name} must be true or false.")
    return value == "true"


def run(hue: Hue, base_url: str, access_token: str, *, max_results: int = 5) -> tuple[str, Summary]:
    with requests.Session() as gmail, hue.span("gmail.summary") as root:
        root.set_input({"task": "Summarize five unread Gmail messages."})
        gmail.headers["Authorization"] = f"Bearer {access_token}"
        summary = summarize_inbox(hue, gmail, base_url, max_results=max_results)
        root.set_output(summary)
        return root.trace_id, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="Read Gmail using local credentials.")
    mode.add_argument(
        "--model-scope",
        action="store_true",
        help="Verify model and nested tool HTTP capture offline.",
    )
    mode.add_argument(
        "--canonical",
        action="store_true",
        help="Use the shared canonical Gmail server fixture offline.",
    )
    args = parser.parse_args()
    options = {
        option: env_bool(variable)
        for option, variable in (
            ("capture_content", "HUE_CAPTURE_CONTENT"),
            ("capture_http", "HUE_CAPTURE_HTTP"),
            ("capture_http_bodies", "HUE_CAPTURE_HTTP_BODIES"),
        )
        if variable in os.environ
    }
    if args.live:
        try:
            with Hue(
                base_url=os.environ.get("HUE_BASE_URL", "https://app.hue.run"),
                api_key=os.environ["HUE_API_KEY"],
                service_name="gmail-summary-python",
                **options,
            ) as hue:
                trace_id, summary = run(
                    hue, "https://gmail.googleapis.com", os.environ["GMAIL_ACCESS_TOKEN"]
                )
                if not hue.force_flush():
                    raise RuntimeError("Telemetry export did not complete successfully.")
                print(json.dumps({"mode": "live", "trace_id": trace_id, "count": summary["count"]}))
        except Exception:
            raise SystemExit(
                "Live Gmail summary failed. "
                "Check local credentials, network access, and export status."
            ) from None
    else:
        from offline import verify

        verify(options, model_scope=args.model_scope, canonical=args.canonical)


if __name__ == "__main__":
    main()
