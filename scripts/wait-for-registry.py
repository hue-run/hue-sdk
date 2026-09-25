"""Wait until a registry serves a just-published version the way the acceptance tools read it.

npm and PyPI answer from caches that lag a publish by seconds to minutes, so an acceptance job
that reads them at once can see the previous state. This polls, from the job's own runner, the
same documents those tools request: npm's full version document and the abbreviated package
document `npm install` reads (with the dist-tag), and PyPI's simple index with pip's headers and
the version document the release check reads. It never writes to a registry.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

NPM_PACKAGE = "@hue-run%2fsdk"
PYPI_PROJECT = "hue-run"
# The Accept headers npm and pip send, so the caches answer these polls as they answer the tools.
NPM_INSTALL_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
PIP_SIMPLE_ACCEPT = (
    "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, "
    "text/html; q=0.01"
)

Fetch = Callable[[str, dict[str, str]], "dict | None"]


def fetch_json(url: str, headers: dict[str, str]) -> dict | None:
    """The JSON document at `url`, `{"html": text}` for a body that is not JSON (an HTML simple
    index, which pip also accepts), or None when the registry does not serve it yet."""
    request = Request(url, headers={"User-Agent": "hue-sdk-release-acceptance", **headers})
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read()
    except HTTPError as error:
        # Not published yet, rate limited or briefly unavailable: poll again. Anything else is real.
        if error.code == 404 or error.code == 429 or error.code >= 500:
            return None
        raise
    except (URLError, TimeoutError):
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"html": body.decode("utf-8", "replace")}


def npm_missing(version: str, dist_tag: str, fetch: Fetch) -> list[str]:
    missing = []
    full = fetch(
        f"https://registry.npmjs.org/{NPM_PACKAGE}/{version}",
        {"Accept": "application/json", "Cache-Control": "no-cache"},
    )
    if not full or full.get("version") != version or not full.get("dist", {}).get("integrity"):
        missing.append("the full version document")
    abbreviated = fetch(
        f"https://registry.npmjs.org/{NPM_PACKAGE}",
        {"Accept": NPM_INSTALL_ACCEPT, "Cache-Control": "no-cache"},
    )
    if not abbreviated or version not in abbreviated.get("versions", {}):
        missing.append("the version in the install document")
    elif abbreviated.get("dist-tags", {}).get(dist_tag) != version:
        missing.append(f"the {dist_tag} dist-tag")
    return missing


def pypi_missing(version: str, fetch: Fetch) -> list[str]:
    index = fetch(
        f"https://pypi.org/simple/{PYPI_PROJECT}/",
        {"Accept": PIP_SIMPLE_ACCEPT, "Cache-Control": "max-age=0"},
    )
    if index and "html" in index:
        listed = set(re.findall(r">\s*([^<>\s]+)\s*</a>", index["html"]))
    else:
        listed = {item.get("filename") for item in (index or {}).get("files", [])}
    # The release check reads the version's JSON document, a separately cached endpoint.
    release = fetch(
        f"https://pypi.org/pypi/{PYPI_PROJECT}/{version}/json",
        {"Accept": "application/json", "Cache-Control": "max-age=0"},
    )
    published = {item.get("filename") for item in (release or {}).get("urls", [])}
    wanted = [f"hue_run-{version}-py3-none-any.whl", f"hue_run-{version}.tar.gz"]
    return [f"{name} in the simple index" for name in wanted if name not in listed] + [
        f"{name} in the version document" for name in wanted if name not in published
    ]


def wait(
    missing: Callable[[], list[str]],
    timeout: float,
    interval: float,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Poll until nothing is missing; return the number of polls, or raise once `timeout` passes."""
    deadline = clock() + timeout
    polls = 0
    while True:
        polls += 1
        absent = missing()
        if not absent:
            return polls
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError(
                f"After {polls} polls over {timeout:.0f} seconds the registry still lacks "
                + "; ".join(absent)
            )
        print(f"Waiting for {'; '.join(absent)}", flush=True)
        sleep(min(interval, remaining))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("typescript", "python"))
    parser.add_argument("version")
    parser.add_argument("--dist-tag", default="latest")
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--interval", type=float, default=15)
    args = parser.parse_args()

    def missing() -> list[str]:
        if args.language == "typescript":
            return npm_missing(args.version, args.dist_tag, fetch_json)
        return pypi_missing(args.version, fetch_json)

    try:
        polls = wait(missing, args.timeout, args.interval)
    except TimeoutError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    print(f"The registry serves {args.language} {args.version} (after {polls} polls)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
