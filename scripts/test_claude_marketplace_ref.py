"""Claude Code must not run a marketplace plugin from a moved git tag.

The project settings in `.claude/settings.json` are the input. Claude Code
2.1.332 clones a github marketplace `ref` with `git clone --branch <ref>` when
the ref is not a full lowercase commit id, then runs the installed plugin's
SessionStart hook. These tests put that ref on a local repository whose tag
moves, and they fail while the hook from the moved tag still runs.
"""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SETTINGS = REPO / ".claude" / "settings.json"
CLAUDE_VERSION = "2.1.332"
MOVED = "moved"
REVIEWED = "reviewed"
RACED = "raced"


def _immutable_commit(ref):
    if ref is None:
        return False
    return len(ref) in (40, 64) and all(c in "0123456789abcdef" for c in ref)


def _marketplaces(settings):
    found = []
    for name, entry in (settings.get("extraKnownMarketplaces") or {}).items():
        source = (entry or {}).get("source") or {}
        kind = source.get("source")
        if kind == "github" and source.get("repo"):
            found.append((name, source))
        elif kind == "git" and source.get("url"):
            found.append((name, source))
    return found


def _enabled_plugins(settings, marketplace):
    names = []
    for key, value in (settings.get("enabledPlugins") or {}).items():
        plugin, sep, market = key.rpartition("@")
        if sep and market == marketplace and value is True and plugin:
            names.append(plugin)
    return names


def _claude_bin():
    override = os.environ.get("CLAUDE_CODE_BIN")
    candidates = []
    if override:
        candidates.append(Path(override))
    candidates.append(Path(f"/tmp/claude-code-{CLAUDE_VERSION}/package/claude"))
    candidates.append(Path("/tmp/claude-bin/package/claude"))
    found = shutil.which("claude")
    if found:
        candidates.append(Path(found))
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            version = subprocess.run(
                [str(path), "--version"],
                check=False,
                capture_output=True,
                text=True,
            ).stdout
            if version.startswith(CLAUDE_VERSION):
                return path
    if os.uname().machine not in ("x86_64", "amd64") or os.uname().sysname != "Linux":
        raise unittest.SkipTest("Claude Code linux-x64 binary is not available here")
    cache = Path(f"/tmp/claude-code-{CLAUDE_VERSION}")
    if not (cache / "package" / "claude").is_file():
        cache.mkdir(parents=True, exist_ok=True)
        pack = subprocess.run(
            ["npm", "pack", f"@anthropic-ai/claude-code-linux-x64@{CLAUDE_VERSION}"],
            cwd=cache,
            check=True,
            capture_output=True,
            text=True,
        )
        archive = cache / pack.stdout.strip().splitlines()[-1]
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(cache)], check=True)
    binary = cache / "package" / "claude"
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
    return binary


def _git(repo, *args, env=None):
    subprocess.run(
        ["/usr/bin/git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )


def _rev(repo, name):
    return subprocess.check_output(
        ["/usr/bin/git", "-C", str(repo), "rev-parse", name],
        text=True,
    ).strip()


def _write_plugin(root, marketplace, plugin_name, word, version, marker):
    plugin = root / "plugins" / "ponytail"
    (root / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (plugin / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (plugin / "hooks").mkdir(parents=True, exist_ok=True)
    (root / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": marketplace,
                "owner": {"name": "fixture"},
                "plugins": [{"name": plugin_name, "source": "./plugins/ponytail"}],
            }
        )
    )
    (plugin / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "ponytail",
                "version": version,
                "hooks": "./hooks/hooks.json",
            }
        )
    )
    command = f'printf {word} > "{marker}"'
    (plugin / "hooks" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "SessionStart": [
                        {
                            "matcher": "startup|resume|clear|compact",
                            "hooks": [{"type": "command", "command": command, "timeout": 5}],
                        }
                    ]
                }
            }
        )
    )


def _commit(repo, message):
    env = os.environ.copy()
    _git(repo, "add", ".", env=env)
    _git(
        repo,
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "user.name=fixture",
        "commit",
        "-q",
        "-m",
        message,
        env=env,
    )


def _init_upstream(root, marketplace, plugin_name, marker):
    """Reviewed commit on main, then a later commit the tag can move to."""
    root.mkdir(parents=True)
    _write_plugin(root, marketplace, plugin_name, REVIEWED, "5.1.0", marker)
    _git(root, "init", "-q")
    _commit(root, "reviewed")
    _git(root, "branch", "-M", "main")
    reviewed = _rev(root, "HEAD")
    _write_plugin(root, marketplace, plugin_name, MOVED, "5.1.1", marker)
    _commit(root, "moved")
    moved = _rev(root, "HEAD")
    _git(root, "checkout", "-q", "-B", "main", reviewed)
    return reviewed, moved


def _point_ref(upstream, ref, sha):
    if _immutable_commit(ref):
        # The id is not this commit. A branch of the same name is the moved tip.
        _git(upstream, "branch", "-f", ref, sha)
    elif ref:
        _git(upstream, "tag", "-f", ref, sha)
    else:
        _git(upstream, "checkout", "-q", "-B", "main", sha)


def _wrapper(path, upstream, ref, moved, arm):
    path.write_text(
        "\n".join(
            [
                "#!/bin/bash",
                f'printf "GIT %s\\n" "$*" >> "{path.parent / "git.log"}"',
                f'if [[ " $* " == *" ls-remote "* && -f "{arm}" ]]; then',
                "  set +e",
                '  /usr/bin/git "$@"',
                "  status=$?",
                "  set -e",
                f'  if [[ ! -f "{arm}.done" ]]; then',
                f'    /usr/bin/git -C "{upstream}" tag -f "{ref}" "{moved}"',
                f'    touch "{arm}.done"',
                "  fi",
                "  exit $status",
                "fi",
                'exec /usr/bin/git "$@"',
                "",
            ]
        )
    )
    path.chmod(0o755)


def _urls(source):
    if source.get("source") == "github":
        repo = source["repo"]
        return [
            f"https://github.com/{repo}.git",
            f"https://github.com/{repo}",
            f"git@github.com:{repo}.git",
            f"git@github.com:{repo}",
        ]
    return [source["url"]]


class ClaudeMarketplaceRefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.claude = _claude_bin()
        cls.settings = json.loads(SETTINGS.read_text())
        cls.marketplaces = _marketplaces(cls.settings)

    def _project(self, home, upstreams):
        project = Path(home) / "project"
        (project / ".claude").mkdir(parents=True)
        (project / ".claude" / "settings.json").write_text(SETTINGS.read_text())
        config = Path(home) / ".claude"
        config.mkdir()
        (config / ".claude.json").write_text(
            json.dumps({"projects": {str(project): {"hasTrustDialogAccepted": True}}})
        )
        for source, upstream in upstreams:
            for url in _urls(source):
                subprocess.run(
                    [
                        "/usr/bin/git",
                        "config",
                        "--global",
                        "--add",
                        f"url.{upstream}/.git.insteadof",
                        url,
                    ],
                    check=True,
                    env={**os.environ, "HOME": home},
                )
        subprocess.run(
            ["/usr/bin/git", "config", "--global", "protocol.https.allow", "never"],
            check=True,
            env={**os.environ, "HOME": home},
        )
        return project

    def _run(self, home, project, bin_dir, *args):
        env = os.environ.copy()
        env["HOME"] = home
        env["CLAUDE_CONFIG_DIR"] = str(Path(home) / ".claude")
        env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
        env.pop("ANTHROPIC_API_KEY", None)
        return subprocess.run(
            [str(self.claude), *args],
            cwd=project,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )

    def _session(self, home, project, bin_dir):
        return self._run(home, project, bin_dir, "-p", "say hi")

    def _install_enabled(self, home, project, bin_dir):
        for name, _source in self.marketplaces:
            for plugin in _enabled_plugins(self.settings, name):
                result = self._run(
                    home,
                    project,
                    bin_dir,
                    "plugin",
                    "install",
                    f"{plugin}@{name}",
                    "--scope",
                    "project",
                    "--json",
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    result.stdout + result.stderr,
                )

    def test_fresh_clone_does_not_run_the_moved_tag(self):
        if not self.marketplaces:
            return
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            home = tmp / "home"
            home.mkdir()
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            marker = tmp / "hook-ran"
            upstreams = []
            moved_ids = set()
            for name, source in self.marketplaces:
                upstream = tmp / f"upstream-{name}"
                plugin = (_enabled_plugins(self.settings, name) or ["ponytail"])[0]
                ref = source.get("ref")
                _reviewed, moved = _init_upstream(upstream, name, plugin, marker)
                _point_ref(upstream, ref, moved)
                moved_ids.add(moved)
                upstreams.append((source, upstream, name))
                _wrapper(bin_dir / "git", upstream, ref or "main", moved, tmp / "arm")
            project = self._project(str(home), [(source, upstream) for source, upstream, _name in upstreams])
            self._session(str(home), project, bin_dir)
            enabled = any(
                _enabled_plugins(self.settings, name) for name, _source in self.marketplaces
            )
            mutable = any(not _immutable_commit(source.get("ref")) for _name, source in self.marketplaces)
            if enabled and mutable:
                self._install_enabled(str(home), project, bin_dir)
                marker.unlink(missing_ok=True)
                self._session(str(home), project, bin_dir)
            text = marker.read_text() if marker.is_file() else ""
            self.assertNotEqual(text, MOVED)
            for _source, _upstream, name in upstreams:
                clone = home / ".claude" / "plugins" / "marketplaces" / name
                if clone.is_dir() and (clone / ".git").exists():
                    self.assertNotIn(_rev(clone, "HEAD"), moved_ids)

    def test_update_does_not_checkout_a_tag_moved_after_ls_remote(self):
        mutable = [
            (name, source)
            for name, source in self.marketplaces
            if not _immutable_commit(source.get("ref")) and _enabled_plugins(self.settings, name)
        ]
        if not mutable:
            return
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            home = tmp / "home"
            home.mkdir()
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            marker = tmp / "hook-ran"
            upstreams = []
            for name, source in mutable:
                upstream = tmp / f"upstream-{name}"
                plugin = _enabled_plugins(self.settings, name)[0]
                ref = source.get("ref") or "main"
                _reviewed, moved = _init_upstream(upstream, name, plugin, marker)
                _git(upstream, "checkout", "-q", "-B", "race", moved)
                _write_plugin(upstream, name, plugin, RACED, "5.1.2", marker)
                _commit(upstream, "raced")
                raced = _rev(upstream, "HEAD")
                _git(upstream, "checkout", "-q", "main")
                _point_ref(upstream, ref, _reviewed)
                upstreams.append((name, upstream, ref, moved, raced))
                _wrapper(bin_dir / "git", upstream, ref, raced, tmp / "arm")
            project = self._project(
                str(home),
                [(source, upstream) for (_name, source), (_name2, upstream, _ref, _moved, _raced) in zip(mutable, upstreams)],
            )
            self._session(str(home), project, bin_dir)
            self._install_enabled(str(home), project, bin_dir)
            marker.unlink(missing_ok=True)
            self._session(str(home), project, bin_dir)
            self.assertEqual(marker.read_text() if marker.is_file() else "", REVIEWED)
            for _name, upstream, ref, moved, _raced in upstreams:
                _point_ref(upstream, ref, moved)
            (tmp / "arm").write_text("1")
            for name, _source in mutable:
                update = self._run(
                    str(home),
                    project,
                    bin_dir,
                    "plugin",
                    "marketplace",
                    "update",
                    name,
                    "--json",
                )
                self.assertEqual(update.returncode, 0, update.stdout + update.stderr)
                for plugin in _enabled_plugins(self.settings, name):
                    self._run(
                        str(home),
                        project,
                        bin_dir,
                        "plugin",
                        "update",
                        f"{plugin}@{name}",
                        "--scope",
                        "project",
                        "--json",
                    )
            marker.unlink(missing_ok=True)
            self._session(str(home), project, bin_dir)
            self.assertNotEqual(marker.read_text() if marker.is_file() else "", RACED)
            for name, _upstream, _ref, _moved, raced in upstreams:
                clone = home / ".claude" / "plugins" / "marketplaces" / name
                if clone.is_dir() and (clone / ".git").exists():
                    self.assertNotEqual(_rev(clone, "HEAD"), raced)


if __name__ == "__main__":
    unittest.main()
