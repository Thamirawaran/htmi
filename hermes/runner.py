"""Runs the bundled HTMi engine (bundle/htmi.mjs) with Node.js.

Every tool goes through `run_json`: one short `node bundle/htmi.mjs <command> --json`
process in the session's working directory. Nothing here reaches the network; the
engine itself only does when a GitHub description is read or written, through the
user's own `gh` login.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
ENGINE = PLUGIN_DIR / "bundle" / "htmi.mjs"
NODE_MIN = (20, 11)


class EngineError(Exception):
    """The engine refused or failed; the message is what it printed, without the `htmi:` prefix."""


def session_cwd() -> Path:
    """The folder the Hermes session works in, not the gateway's own directory."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
    except ImportError:  # outside Hermes (the plugin's own tests)
        return Path.cwd()
    return Path(resolve_agent_cwd())


def node_executable() -> str | None:
    """The Node.js Hermes manages, else the one on PATH."""
    try:
        from hermes_constants import find_node_executable

        found = find_node_executable("node")
        if found:
            return found
    except ImportError:
        pass
    return shutil.which("node")


# What the engine, and the git and gh it starts, may see of Hermes's environment. Provider
# keys and every other secret Hermes holds stay out: only the system basics, locale,
# temporary folders, where gh and git keep their configuration, network proxies and
# certificate settings, the variables gh and git document themselves, and HTMI_GH (which gh
# to run). The engine applies the same list again to the git and gh it starts.
_ENV_NAMES = frozenset(
    {
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
        "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
        "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "HTMI_GH",
    }
)  # fmt: skip
_ENV_PREFIXES = ("LC_", "GH_", "GIT_")


def child_env() -> dict[str, str]:
    """An explicit, minimal environment for every process HTMi starts."""
    env = {k: v for k, v in os.environ.items() if k in _ENV_NAMES or k.startswith(_ENV_PREFIXES)}
    try:
        from hermes_constants import with_hermes_node_path

        env = with_hermes_node_path(env)
    except ImportError:
        pass
    env["NO_COLOR"] = "1"
    return env


_VERSION_RE = re.compile(r"^v(\d+)\.(\d+)")


def node_problem() -> str | None:
    """Why the engine cannot run here, or None when it can."""
    if not ENGINE.is_file():
        return f"the HTMi engine is missing at {ENGINE}"
    node = node_executable()
    if not node:
        return "Node.js was not found; HTMi needs Node.js 20.11 or newer"
    try:
        out = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=10, check=False, env=child_env()
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"could not run {node}: {error}"
    match = _VERSION_RE.match(out)
    if not match or (int(match.group(1)), int(match.group(2))) < NODE_MIN:
        return f"HTMi needs Node.js 20.11 or newer; {node} is {out or 'unknown'}"
    return None


def run(args: list[str], cwd: Path | None = None, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    node = node_executable()
    if not node:
        raise EngineError("Node.js was not found; HTMi needs Node.js 20.11 or newer")
    try:
        return subprocess.run(
            [node, str(ENGINE), *args],
            cwd=str(cwd or session_cwd()),
            env=child_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise EngineError(f"htmi {args[0] if args else ''} took longer than {timeout:.0f} s") from error


def run_text(
    args: list[str], cwd: Path | None = None, timeout: float = 60, accept: tuple[int, ...] = (0,)
) -> tuple[str, list[str]]:
    """What one engine command printed, and its warnings; EngineError when it failed.

    Warnings are what the engine printed on stderr while succeeding (a description it
    could not read, say), so a caller can pass them on instead of dropping them. `accept`
    lists exit codes that still carry a full answer: `apply` and `validate` exit 3 with a
    JSON report when an edit is refused or a document has errors.
    """
    done = run(args, cwd=cwd, timeout=timeout)
    if done.returncode not in accept:
        message = re.sub(r"^htmi: ", "", (done.stderr or done.stdout).strip())
        raise EngineError(message or f"htmi {args[0]} failed with exit code {done.returncode}")
    warnings = [line.removeprefix("htmi: ") for line in done.stderr.splitlines() if line.strip()]
    return done.stdout, warnings


def run_json(args: list[str], cwd: Path | None = None, timeout: float = 60, accept: tuple[int, ...] = (0,)):
    """The parsed `--json` output of one engine command, and its warnings."""
    out, warnings = run_text([*args, "--json"], cwd=cwd, timeout=timeout, accept=accept)
    try:
        return json.loads(out), warnings
    except json.JSONDecodeError as error:
        raise EngineError(f"htmi {args[0]} printed something other than JSON") from error
