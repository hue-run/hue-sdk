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
        for phrase in ("invite-only", GATE_URL, "Tracing only", "then stop"):
            if phrase not in gate:
                problems.append(f"invite-only section is missing {phrase!r}")
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

    def test_gate_check_requires_the_gate_section(self):
        without_gate = re.sub(
            r"^## Invite-only access\n.*?(?=^## )", "", SKILL.read_text(), flags=re.M | re.S
        )
        self.assertIn("skill has no Invite-only access section", gate_problems(without_gate))


if __name__ == "__main__":
    unittest.main()
