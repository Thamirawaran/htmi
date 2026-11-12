"""Which GitHub repositories HTMi works with, and which actions wait for the person.

HTMi reaches GitHub only for this repository's own origin remote and the repositories the
person lists in the plugin's `github_repos` setting. Nothing the model writes decides that:
not a `repo` argument, not a document reference, not the repository's `.htmi/config.json`.

Creating an issue, replacing a description and editing a description on GitHub each go
through Hermes's approval gate first (a `pre_tool_call` hook returning `approve`), with a
message that names the repository and what changes. The gate fails closed: an unattended
run without anyone to ask is refused, not carried out.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import publish, review_server, runner

_REPO = re.compile(r"^[\w.-]+/[\w.-]+$")
_FULL_REF = re.compile(r"^github:([\w.-]+/[\w.-]+)#([1-9]\d*)$")
_SHORT_REF = re.compile(r"^github:#([1-9]\d*)$")
_URL_REF = re.compile(r"^https://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/([1-9]\d*)/?(?:[?#].*)?$")

# Set by register(): reads this plugin's settings (plugins.entries.htmi.settings).
_get_config: Callable[[str, Any], Any] | None = None


def configure(get_config: Callable[[str, Any], Any]) -> None:
    global _get_config
    _get_config = get_config


def listed_repos() -> list[str]:
    """The repositories the person listed in the `github_repos` setting, as owner/name."""
    if _get_config is None:
        return []
    try:
        value = _get_config("github_repos", [])
    except (ValueError, KeyError, TypeError):
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [v.strip() for v in value if isinstance(v, str) and _REPO.match(v.strip())]


def allowed_repos(root: Path) -> list[str]:
    origin = publish.origin_repo(root)
    return [*([origin] if origin else []), *listed_repos()]


def is_allowed(root: Path, repo: str) -> bool:
    return repo.lower() in {r.lower() for r in allowed_repos(root)}


def _config_repo(root: Path) -> str | None:
    """`github.repo` from .htmi/config.json: what the engine uses for `github:#7`."""
    try:
        data = json.loads((root / ".htmi" / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    repo = (data.get("github") or {}).get("repo") if isinstance(data, dict) else None
    return repo if isinstance(repo, str) and _REPO.match(repo) else None


def description_target(root: Path, document: str) -> tuple[str, int] | None:
    """The repository and number a document reference names on GitHub, resolved the way the
    engine resolves it; None when the reference is a file, not a description."""
    ref = (document or "").strip()
    match = _FULL_REF.match(ref) or _URL_REF.match(ref)
    if match:
        return match.group(1), int(match.group(2))
    short = _SHORT_REF.match(ref)
    if short:
        repo = _config_repo(root) or publish.origin_repo(root)
        return (repo, int(short.group(1))) if repo else ("(unknown repository)", int(short.group(1)))
    return None


def refusal(root: Path, repo: str) -> str:
    allowed = allowed_repos(root)
    where = ", ".join(allowed) if allowed else "none (this repository has no GitHub origin remote)"
    return (
        f"HTMi works on GitHub only in this repository's origin and the repositories listed in its "
        f"github_repos setting; {repo} is not one of them (allowed: {where}). To allow it, add it to "
        "plugins.entries.htmi.settings.github_repos in Hermes's config.yaml, or in the HTMi plugin's "
        "settings in the Desktop app."
    )


def check_repo(root: Path, repo: str) -> None:
    """Raise EngineError unless `repo` is one HTMi may work with."""
    if not is_allowed(root, repo):
        raise runner.EngineError(refusal(root, repo))


def check_document(root: Path, document: str) -> None:
    """Refuse a GitHub description reference outside the allowed repositories (files pass)."""
    target = description_target(root, document)
    if target:
        check_repo(root, target[0])


def _clip(text: Any, limit: int = 120) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def pre_tool_call(tool_name: str = "", args: dict | None = None, **_kwargs: Any) -> dict | None:
    """Hermes `pre_tool_call` hook: block GitHub writes outside the allowed repositories, and
    send every create, replace or edit of a GitHub description to the person for approval."""
    if tool_name not in ("htmi_publish_description", "htmi_apply_edit"):
        return None
    args = args if isinstance(args, dict) else {}
    try:
        root = review_server.repo_root(runner.session_cwd())
    except Exception:  # noqa: BLE001 - any failure here must refuse, never let the write through
        return {"action": "block", "message": "HTMi could not tell which repository this session works in."}

    if tool_name == "htmi_apply_edit":
        target = description_target(root, str(args.get("document") or ""))
        if target is None or args.get("dry_run"):
            return None  # a file in this repository, or a dry run that writes nothing
        repo, number = target
        if not is_allowed(root, repo):
            return {"action": "block", "message": refusal(root, repo)}
        operation = args.get("operation")
        what = operation.get("op") if isinstance(operation, dict) else "an edit"
        return {
            "action": "approve",
            "message": f"Edit the description of {repo}#{number} on GitHub ({_clip(what, 40)}, a checked edit "
            "that changes only the element it names).",
            "rule_key": f"htmi_apply_edit:{repo.lower()}",
        }

    repo = str(args.get("repo") or "").strip() or publish.origin_repo(root) or ""
    if not repo or not _REPO.match(repo):
        return {
            "action": "block",
            "message": "HTMi publishes to this repository's GitHub origin; it has none, and no allowed repository was named.",
        }
    if not is_allowed(root, repo):
        return {"action": "block", "message": refusal(root, repo)}
    document = _clip(args.get("document"), 80)
    number = args.get("number")
    if number is None:
        message = f'Create a new issue in {repo} titled "{_clip(args.get("title"), 80)}", with the page {document} as its description.'
        rule_key = f"htmi_publish_description:create:{repo.lower()}"
    else:
        message = f"Replace the description of {repo}#{_clip(number, 12)} with the page {document}. The current description is overwritten."
        rule_key = f"htmi_publish_description:replace:{repo.lower()}"
    return {"action": "approve", "message": message, "rule_key": rule_key}
