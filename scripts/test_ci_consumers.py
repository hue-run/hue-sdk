"""Exercise CI failure propagation without installing packages or publishing."""

import hashlib
import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text()
JOBS = WORKFLOW.split("\njobs:\n", 1)[1]


def job(name):
    return re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", JOBS)[1]


def step_script(body, name):
    step = next(part for part in re.split(r"(?m)^      - ", body) if name in part)
    return textwrap.dedent(
        re.search(r"(?ms)^        run: \|\n((?:          .*\n|\n)+)", step)[1]
    )


class CiConsumerTests(unittest.TestCase):
    def test_every_job_is_required_and_failure_cancellation_or_skip_refuses(self):
        jobs = set(re.findall(r"(?m)^  ([\w-]+):$", JOBS)) - {"checks-passed"}
        needed = set(
            re.search(r"needs: \[([^]]+)\]", job("checks-passed"))[1]
            .replace(" ", "")
            .split(",")
        )
        self.assertEqual(jobs, needed)
        script = step_script(
            job("checks-passed"), "Fail if any required job did not succeed"
        )
        passing = {name: {"result": "success"} for name in needed}
        for failed_job in needed:
            for result in ("success", "failure", "cancelled", "skipped"):
                results = {**passing, failed_job: {"result": result}}
                run = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={**os.environ, "RESULTS": json.dumps(results)},
                    capture_output=True,
                    check=False,
                    timeout=10,
                )
                self.assertEqual(
                    run.returncode == 0, result == "success", (failed_job, result)
                )

    def test_parallel_python_checks_both_finish_and_either_failure_refuses(self):
        for name, step in (
            ("python", "Installed behavior, packaging boundaries"),
            ("python-lowest-bounds", "Resolve direct dependencies at their floors"),
        ):
            script = step_script(job(name), step)
            for failure in (
                ("none", "packaging", "consumers", "tampered")
                if name == "python"
                else ("none", "packaging", "consumers")
            ):
                with (
                    self.subTest(job=name, failure=failure),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)
                    (root / "packages/sdk-python").mkdir(parents=True)
                    artifacts = root / ".artifacts"
                    artifacts.mkdir()
                    wheel = artifacts / "hue_run-0.13.6-py3-none-any.whl"
                    wheel.write_bytes(b"synthetic wheel")
                    (artifacts / "SHA256SUMS").write_text(
                        f"{hashlib.sha256(wheel.read_bytes()).hexdigest()}  {wheel.name}\n"
                    )
                    if failure == "tampered":
                        wheel.write_bytes(b"different archive")
                    bin_directory = root / "bin"
                    bin_directory.mkdir()
                    uv = bin_directory / "uv"
                    uv.write_text(
                        '#!/bin/sh\ncase "$*" in\n'
                        '*"not installed_wheel"*) target=consumers;;\n'
                        '*" pytest "*|*" pytest") target=packaging;;\n'
                        "*) exit 0;;\nesac\n"
                        'sleep 0.05\ntouch "$GITHUB_WORKSPACE/$target-finished"\n'
                        'test "$FAILURE" != "$target"\n'
                    )
                    python = bin_directory / "python3"
                    python.write_text(
                        '#!/bin/sh\nif [ "$1" = -c ]; then echo 0.13.6; exit 0; fi\n'
                        'sleep 0.05\ntouch "$GITHUB_WORKSPACE/consumers-finished"\n'
                        'test "$FAILURE" != consumers\n'
                    )
                    uv.chmod(0o700)
                    python.chmod(0o700)
                    run = subprocess.run(
                        ["bash", "-e", "-c", script],
                        cwd=root if name == "python" else root / "packages/sdk-python",
                        env={
                            **os.environ,
                            "PATH": f"{bin_directory}:{os.environ['PATH']}",
                            "GITHUB_WORKSPACE": str(root),
                            "RUNNER_TEMP": str(root),
                            "PYTHON_VERSION": "3.14",
                            "FAILURE": failure,
                        },
                        capture_output=True,
                        check=False,
                        timeout=10,
                    )
                    self.assertEqual(run.returncode == 0, failure == "none", run.stderr)
                    self.assertEqual(
                        (root / "packaging-finished").is_file(), failure != "tampered"
                    )
                    self.assertEqual(
                        (root / "consumers-finished").is_file(), failure != "tampered"
                    )

    def test_doc_link_extraction_failure_cannot_pass_with_empty_input(self):
        name = "Own GitHub links resolve to the right Git ref and file kind"
        docs = job("docs")
        step = next(part for part in re.split(r"(?m)^      - ", docs) if name in part)
        self.assertIn("        shell: bash\n", step)
        script = step_script(docs, name)
        for status in (0, 19):
            with (
                self.subTest(status=status),
                tempfile.TemporaryDirectory() as directory,
            ):
                lychee = Path(directory) / "lychee"
                lychee.write_text(
                    "#!/bin/sh\n"
                    + (
                        "echo https://github.com/hue-run/hue-sdk/blob/main/AGENTS.md\n"
                        if status == 0
                        else ""
                    )
                    + f"exit {status}\n"
                )
                lychee.chmod(0o700)
                run = subprocess.run(
                    [
                        "bash",
                        "--noprofile",
                        "--norc",
                        "-e",
                        "-o",
                        "pipefail",
                        "-c",
                        script,
                    ],
                    cwd=ROOT,
                    env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"},
                    capture_output=True,
                    check=False,
                    timeout=10,
                )
                self.assertEqual(run.returncode, status, run.stderr)

    def test_runtime_profile_cannot_produce_an_unchecked_archive(self):
        verifier = ROOT / "packages/sdk-typescript/scripts/verify-package.mjs"
        for arguments in (
            ["--profile", "runtime"],
            ["--profile", "runtime", "--archive", "x.tgz", "--artifacts-dir", "output"],
        ):
            run = subprocess.run(
                ["node", str(verifier), *arguments],
                capture_output=True,
                check=False,
                timeout=10,
            )
            self.assertNotEqual(run.returncode, 0)
            self.assertIn(b"requires an already checked archive", run.stderr)

    def test_pack_profile_requires_source_and_an_output_directory(self):
        verifier = ROOT / "packages/sdk-typescript/scripts/verify-package.mjs"
        for arguments in (
            ["--profile", "pack"],
            ["--profile", "pack", "--archive", "x.tgz", "--artifacts-dir", "output"],
        ):
            run = subprocess.run(
                ["node", str(verifier), *arguments],
                capture_output=True,
                check=False,
                timeout=10,
            )
            self.assertNotEqual(run.returncode, 0)
            self.assertIn(b"Packing requires a source build", run.stderr)

    def test_a_failed_batch_waits_for_siblings_and_cannot_emit_an_archive(self):
        helper = (ROOT / "packages/sdk-typescript/scripts/wait-for-checks.mjs").as_uri()
        program = f"""
import {{ strict as assert }} from 'node:assert';
import {{ waitForChecks }} from {json.dumps(helper)};
let finish;
let complete = false;
let emitted = false;
const pending = waitForChecks([
  Promise.reject(new Error('failed check')),
  new Promise(resolve => {{ finish = resolve; }}),
], 'checks failed').then(() => {{ emitted = true; }});
const refused = assert.rejects(pending, error => {{
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0].message, 'failed check');
  return true;
}}).then(() => {{ complete = true; }});
await Promise.resolve();
await Promise.resolve();
assert.equal(complete, false);
finish();
await refused;
assert.equal(emitted, false);
await waitForChecks([Promise.resolve('ok')], 'unexpected failure');
"""
        subprocess.run(
            ["node", "--input-type=module", "-e", program], check=True, timeout=10
        )


if __name__ == "__main__":
    unittest.main()
