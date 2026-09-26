"""The public skill must get a Hue API key first and never send agents into anonymous setup.

`npx skills add hue-run/hue-sdk --skill hue` installs skills/hue/SKILL.md from main, so its
guidance is live as soon as it merges. The Hue team sets up accounts; the agent setup page on
docs.hue.run has the user create and store a key, and the skill names the contact for a user
without an account.
"""

import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills/hue/SKILL.md"
KEY_SECTION = "Get a Hue API key"
SETUP_URL = "https://docs.hue.run/guides/agent-setup.md"
CONTACT_EMAIL = "founders@hue.run"
BOOKING_URL = "https://calendar.notion.so/meet/akethini/fd2smi4yej"
# Commands that start or continue anonymous setup or account linkage.
SETUP_COMMAND = re.compile(r"(@hue-run/sdk\S*|\bhue)\s+(setup|resume|claim)\b")
# Copy from the retired invite-only gate, and the production preset the setup key must not be.
FORBIDDEN = ("invite-only", "heightened demand", "then stop", "Tracing only")


def fenced_lines(text: str) -> list[str]:
    lines: list[str] = []
    inside = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            inside = not inside
            continue
        if inside:
            lines.append(line)
    return lines


def section(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1) if match else ""


def gate_problems(text: str) -> list[str]:
    problems = [
        f"skill tells agents to run {line.strip()!r}"
        for line in fenced_lines(text)
        if SETUP_COMMAND.search(line)
    ]
    if re.search(r"^#+ .*onboarding", text, re.M | re.I):
        problems.append("skill still has an onboarding section")
    key = section(text, KEY_SECTION)
    if not key:
        problems.append(f"skill has no {KEY_SECTION} section")
    else:
        # A user may hold a key of another preset from earlier guidance. Any key means they
        # have an account, so the section must let them continue, not send them to the contact.
        required = (
            SETUP_URL,
            "**Read and write**",
            "`HUE_API_KEY`",
            "key of any preset",
            CONTACT_EMAIL,
            BOOKING_URL,
            "paste",
        )
        for phrase in required:
            if phrase not in key:
                problems.append(f"key section is missing {phrase!r}")
        for phrase in FORBIDDEN:
            if phrase.casefold() in key.casefold():
                problems.append(f"key section still says {phrase!r}")
        if text.index(f"## {KEY_SECTION}") > text.index("## Install and configure"):
            problems.append("key section must come before install instructions")
    return problems


def replace_in_key_section(text: str, old: str, new: str) -> str:
    key = section(text, KEY_SECTION)
    assert old in key, old
    return text.replace(key, key.replace(old, new))


class SkillKeyGateTests(unittest.TestCase):
    def test_skill_gets_a_key_before_setup(self):
        self.assertEqual(gate_problems(SKILL.read_text()), [])

    def test_gate_check_rejects_anonymous_setup_guidance(self):
        regressed = SKILL.read_text().replace(
            "## Install and configure\n",
            "## One-command onboarding\n\n```sh\nnpx --yes @hue-run/sdk@latest setup --agent\n"
            "hue claim\n```\n\n## Install and configure\n",
        )
        problems = gate_problems(regressed)
        self.assertIn(
            "skill tells agents to run 'npx --yes @hue-run/sdk@latest setup --agent'", problems
        )
        self.assertIn("skill tells agents to run 'hue claim'", problems)
        self.assertIn("skill still has an onboarding section", problems)

    def test_gate_check_rejects_a_tracing_only_key(self):
        regressed = replace_in_key_section(
            SKILL.read_text(), "**Read and write**", "**Tracing only**"
        )
        problems = gate_problems(regressed)
        self.assertIn("key section is missing '**Read and write**'", problems)
        self.assertIn("key section still says 'Tracing only'", problems)

    def test_gate_check_rejects_a_section_that_only_admits_read_and_write(self):
        regressed = replace_in_key_section(
            SKILL.read_text(), "key of any preset", "**Read and write** key"
        )
        self.assertIn("key section is missing 'key of any preset'", gate_problems(regressed))

    def test_gate_check_requires_the_setup_page_and_contact_line(self):
        text = SKILL.read_text()
        for phrase in (SETUP_URL, CONTACT_EMAIL, BOOKING_URL):
            with self.subTest(phrase=phrase):
                regressed = replace_in_key_section(text, phrase, "")
                self.assertIn(f"key section is missing {phrase!r}", gate_problems(regressed))

    def test_gate_check_requires_the_no_paste_rule(self):
        regressed = replace_in_key_section(
            SKILL.read_text(), "never ask them to paste it into chat", "ask them for it"
        )
        self.assertIn("key section is missing 'paste'", gate_problems(regressed))

    def test_gate_check_rejects_the_retired_invite_only_gate(self):
        regressed = replace_in_key_section(
            SKILL.read_text(),
            "Share this line",
            "Hue Cloud is Invite-only. We're currently seeing heightened demand. Relay the agent "
            "setup page's reply, then stop. Share this line",
        )
        problems = gate_problems(regressed)
        for phrase in ("invite-only", "heightened demand", "then stop"):
            self.assertIn(f"key section still says {phrase!r}", problems)

    def test_gate_check_requires_the_section_before_install(self):
        text = SKILL.read_text()
        key = f"## {KEY_SECTION}\n{section(text, KEY_SECTION)}"
        capture = "## Capture and instrument full traces\n"
        moved = text.replace(key, "").replace(capture, key + capture)
        self.assertEqual(
            gate_problems(moved), ["key section must come before install instructions"]
        )

    def test_gate_check_requires_the_key_section(self):
        without_key = re.sub(
            rf"^## {KEY_SECTION}\n.*?(?=^## )", "", SKILL.read_text(), flags=re.M | re.S
        )
        self.assertIn(f"skill has no {KEY_SECTION} section", gate_problems(without_key))


if __name__ == "__main__":
    unittest.main()
