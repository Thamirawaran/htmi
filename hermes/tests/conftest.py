"""Shared setup: the plugin loaded as Hermes loads it, and a temporary git repository."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "htmi_plugin", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["htmi_plugin"] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()
from htmi_plugin import notices, review_server, runner

PLAN = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Cache plan</title></head>
<body>
<h1>Cache plan</h1>
<section id="goals">
  <h2>Goals</h2>
  <p id="latency">Cut the p95 read latency to 40 ms.</p>
</section>
<section id="risks">
  <h2>Risks</h2>
  <table id="risk-table">
    <tr><th>Risk</th><th>Owner</th></tr>
    <tr><td>Stale reads after failover</td><td>Platform</td></tr>
  </table>
</section>
</body>
</html>
"""

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Reviewer",
    "GIT_AUTHOR_EMAIL": "reviewer@example.invalid",
    "GIT_COMMITTER_NAME": "Reviewer",
    "GIT_COMMITTER_EMAIL": "reviewer@example.invalid",
}


def git(repo: Path, *args: str) -> str:
    import os

    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, env={**os.environ, **GIT_ENV}
    ).stdout


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    root = tmp_path / "project"
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "plan.html").write_text(PLAN)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "Reviewer")
    git(root, "config", "user.email", "reviewer@example.invalid")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "plan")
    monkeypatch.chdir(root)
    monkeypatch.setenv("HTMI_PLUGIN_DATA", str(tmp_path / "plugin-data"))
    notices._sessions.clear()
    yield root.resolve()
    review_server.stop(root.resolve())


def call(handler, **args):
    return json.loads(handler(args, task_id="t1"))


def human_comment(target: str, text: str, kind: str = "comment") -> str:
    data, _ = runner.run_json(["comment", "docs/plan.html", "--target", target, "--text", text, "--kind", kind])
    return data["id"]
