"""The release acceptance wait: registry lag is polled out, a real absence still fails."""

import importlib.util
import io
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location(
    "wait_for_registry", Path(__file__).with_name("wait-for-registry.py")
)
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def scripted(states):
    """A fetch that answers from `states[poll][url]`, advancing one state per full poll."""
    poll = {"index": 0}

    def fetch(url, headers):
        state = states[min(poll["index"], len(states) - 1)]
        return state.get(url)

    return fetch, poll


FULL = "https://registry.npmjs.org/@hue-run%2fsdk/0.10.0"
ABBREVIATED = "https://registry.npmjs.org/@hue-run%2fsdk"
SIMPLE = "https://pypi.org/simple/hue-run/"
PUBLISHED = {
    FULL: {"version": "0.10.0", "dist": {"integrity": "sha512-x"}},
    ABBREVIATED: {"versions": {"0.9.0": {}, "0.10.0": {}}, "dist-tags": {"latest": "0.10.0"}},
}


class WaitTests(unittest.TestCase):
    def test_npm_waits_for_the_version_documents_and_the_tag(self):
        stale = {ABBREVIATED: {"versions": {"0.9.0": {}}, "dist-tags": {"latest": "0.9.0"}}}
        untagged = {
            **PUBLISHED,
            ABBREVIATED: {"versions": {"0.10.0": {}}, "dist-tags": {"latest": "0.9.0"}},
        }
        fetch, poll = scripted([stale, untagged, PUBLISHED])
        self.assertEqual(
            registry.npm_missing("0.10.0", "latest", fetch),
            ["the full version document", "the version in the install document"],
        )
        poll["index"] = 1
        self.assertEqual(registry.npm_missing("0.10.0", "latest", fetch), ["the latest dist-tag"])
        poll["index"] = 2
        self.assertEqual(registry.npm_missing("0.10.0", "latest", fetch), [])

    def test_pypi_waits_for_both_files_in_the_simple_index(self):
        listed = lambda *names: {SIMPLE: {"files": [{"filename": name} for name in names]}}  # noqa: E731
        fetch, poll = scripted(
            [
                {},
                listed("hue_run-0.6.0-py3-none-any.whl", "hue_run-0.6.1-py3-none-any.whl"),
                listed("hue_run-0.6.1-py3-none-any.whl", "hue_run-0.6.1.tar.gz"),
            ]
        )
        self.assertEqual(len(registry.pypi_missing("0.6.1", fetch)), 2)
        poll["index"] = 1
        self.assertEqual(
            registry.pypi_missing("0.6.1", fetch), ["hue_run-0.6.1.tar.gz in the simple index"]
        )
        poll["index"] = 2
        self.assertEqual(registry.pypi_missing("0.6.1", fetch), [])

    def test_wait_returns_once_served_and_fails_at_its_bound(self):
        clock = Clock()
        answers = iter([["x"], ["x"], []])
        polls = registry.wait(lambda: next(answers), 600, 15, clock.sleep, lambda: clock.now)
        self.assertEqual((polls, clock.sleeps), (3, [15, 15]))
        clock = Clock()
        with self.assertRaisesRegex(TimeoutError, "After 5 polls over 60 seconds .* lacks x"):
            registry.wait(lambda: ["x"], 60, 15, clock.sleep, lambda: clock.now)
        # The last sleep never passes the deadline.
        self.assertEqual(sum(clock.sleeps), 60)

    def test_lag_and_outages_are_polled_but_other_refusals_fail(self):
        def refusing(code):
            def urlopen(request, timeout):
                raise HTTPError(request.full_url, code, "refused", {}, io.BytesIO())

            return urlopen

        for code in (404, 429, 503):
            with patch.object(registry, "urlopen", refusing(code)):
                self.assertIsNone(registry.fetch_json(SIMPLE, {}))
        with patch.object(registry, "urlopen", refusing(403)):
            with self.assertRaises(HTTPError):
                registry.fetch_json(SIMPLE, {})


if __name__ == "__main__":
    unittest.main()
