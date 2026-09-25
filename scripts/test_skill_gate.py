"""The public skill must not send agents into anonymous setup while Hue Cloud is invite-only.

`npx skills add hue-run/hue-sdk --skill hue` installs skills/hue/SKILL.md from main, so its
guidance is live as soon as it merges. The invite-only gate lives on docs.hue.run.
"""

import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills/hue/SKILL.md"
GATE_URL = "https://docs.hue.run/guides/agent-setup.md"
# Commands that start or continue anonymous setup or account linkage.
SETUP_COMMAND = re.compile(r"(@hue-run/sdk\S*|\bhue)\s+(setup|resume|claim)\b")


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
    gate = section(text, "Invite-only access")
    if not gate:
        problems.append("skill has no Invite-only access section")
    else:
        # An invited user may hold a key of another preset from earlier guidance; only the
        # recommendation changed, so the gate must not stop them.
        required = (
            "invite-only",
            GATE_URL,
            "**Read and write**",
            "`HUE_API_KEY`",
            "key of any preset",
            "then stop",
        )
        for phrase in required:
            if phrase not in gate:
                problems.append(f"invite-only section is missing {phrase!r}")
        if "Tracing only" in gate:
            problems.append("invite-only section still asks for a Tracing only key")
        if text.index("## Invite-only access") > text.index("## Install and configure"):
            problems.append("invite-only section must come before install instructions")
    return problems


class SkillInviteOnlyGateTests(unittest.TestCase):
    def test_skill_gates_setup_behind_invitation(self):
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
        text = SKILL.read_text()
        gate = section(text, "Invite-only access")
        regressed = text.replace(gate, gate.replace("**Read and write**", "**Tracing only**"))
        problems = gate_problems(regressed)
        self.assertIn("invite-only section is missing '**Read and write**'", problems)
        self.assertIn("invite-only section still asks for a Tracing only key", problems)

    def test_gate_check_rejects_a_gate_that_only_admits_read_and_write(self):
        text = SKILL.read_text()
        gate = section(text, "Invite-only access")
        regressed = text.replace(gate, gate.replace("key of any preset", "**Read and write** key"))
        self.assertIn(
            "invite-only section is missing 'key of any preset'", gate_problems(regressed)
        )

    def test_gate_check_requires_the_gate_section(self):
        without_gate = re.sub(
            r"^## Invite-only access\n.*?(?=^## )", "", SKILL.read_text(), flags=re.M | re.S
        )
        self.assertIn("skill has no Invite-only access section", gate_problems(without_gate))


if __name__ == "__main__":
    unittest.main()
