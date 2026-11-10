"""Put an HTML document up for review on GitHub, as an issue or pull request description.

The description becomes one fenced html block holding the page, which is what HTMi
treats as an HTML document: its preview shows the page as designed, comments come back
through GitHub's comment box, and checked edits stay inside the fence. GitHub is reached
only here, with the person's own `gh` login, and the body travels on stdin.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from .runner import EngineError

_REMOTE = re.compile(r"github\.com[:/]([\w.-]+/[\w.-]+?)(?:\.git)?/?$")
_REPO = re.compile(r"^[\w.-]+/[\w.-]+$")


def fenced(html: str) -> str:
    """The description body: the page in one html fence long enough not to be closed early."""
    fence = "```"
    while f"\n{fence}" in f"\n{html}":
        fence += "`"
    return f"{fence}html\n{html.rstrip(chr(10))}\n{fence}\n"


def is_html_description(body: str) -> bool:
    return bool(re.match(r"^\s*(`{3,}|~{3,})html[ \t]*\r?\n", body or ""))


def origin_repo(root: Path) -> str | None:
    try:
        url = subprocess.run(
            ["git", "remote", "get-url", "origin"], cwd=root, capture_output=True, text=True, timeout=10, check=False
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = _REMOTE.search(url)
    return m.group(1) if m else None


def _gh(args: list[str], payload: dict | None = None) -> dict:
    gh = shutil.which("gh")
    if not gh:
        raise EngineError("the GitHub CLI gh was not found; install it and run gh auth login")
    done = subprocess.run(
        [gh, *args],
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if done.returncode != 0:
        raise EngineError(f"gh {' '.join(args[:3])} failed: {(done.stderr or done.stdout).strip()[:500]}")
    return json.loads(done.stdout or "{}")


def publish(root: Path, document: str, repo: str | None, title: str | None, number: int | None, replace: bool) -> dict:
    path = (root / document).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() not in {".html", ".htm"} or not path.is_file():
        raise EngineError(f"{document} is not an HTML file in this repository")
    repo = repo or origin_repo(root)
    if not repo or not _REPO.match(repo):
        raise EngineError("name the GitHub repository as owner/name (the origin remote is not on GitHub)")
    body = fenced(path.read_text(encoding="utf-8"))
    if number is None:
        if not title:
            raise EngineError("a new issue needs a title")
        made = _gh(["api", "--method", "POST", f"repos/{repo}/issues", "--input", "-"], {"title": title, "body": body})
        return {"document": f"github:{repo}#{made['number']}", "url": made["html_url"], "created": True}
    current = _gh(["api", f"repos/{repo}/issues/{number}"])
    if (current.get("body") or "").strip() and not is_html_description(current["body"]) and not replace:
        raise EngineError(
            f"#{number} already has a description that is not an HTML page; "
            "ask the person before replacing it (replace_existing: true)"
        )
    patch = {"body": body, **({"title": title} if title else {})}
    done = _gh(["api", "--method", "PATCH", f"repos/{repo}/issues/{number}", "--input", "-"], patch)
    return {"document": f"github:{repo}#{number}", "url": done["html_url"], "created": False}
