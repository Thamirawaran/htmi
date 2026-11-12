"""The local review page: one `htmi serve` process per repository, started on request.

The process listens on 127.0.0.1 only, on a port the system picks. Its address, process
id and repository are kept in the plugin's data folder (servers.json), so the agent's
tools, the /htmi command and the dashboard tab all find the same page. It keeps running
until `/htmi stop` (or the computer restarts), so a person can keep commenting while
the agent works.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

from . import runner

STATE_FILE = "servers.json"
# The Hermes dashboard shows the page in its Review tab; no other origin may frame it.
LOCAL_FRAMES = "http://127.0.0.1:* http://localhost:*"
_URL_RE = re.compile(r"^(http://127\.0\.0\.1:\d+)/\s*$", re.MULTILINE)


def data_dir() -> Path:
    """<HERMES_HOME>/plugin-data/htmi inside Hermes; HTMI_PLUGIN_DATA (or ~/.cache) outside it."""
    try:
        from plugins.plugin_storage import plugin_data_dir

        path = Path(plugin_data_dir("htmi"))
    except ImportError:
        path = Path(os.environ.get("HTMI_PLUGIN_DATA") or Path.home() / ".cache" / "htmi-hermes")
    path.mkdir(parents=True, exist_ok=True)
    return path


def repo_root(start: Path) -> Path:
    """The repository HTMi works in, found the way the engine finds it: git, else a .htmi folder."""
    try:
        done = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(start),
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
            env=runner.child_env(),
            check=False,
        )
        if done.returncode == 0 and done.stdout.strip():
            return Path(done.stdout.strip()).resolve()
    except (OSError, subprocess.TimeoutExpired):
        pass
    here = start.resolve()
    for folder in (here, *here.parents):
        if (folder / ".htmi").is_dir():
            return folder
    return here


def _load() -> dict[str, dict]:
    file = data_dir() / STATE_FILE
    try:
        state = json.loads(file.read_text())
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(state: dict[str, dict]) -> None:
    file = data_dir() / STATE_FILE
    tmp = file.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(file)


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def responds(url: str, timeout: float = 2) -> bool:
    """True when an HTMi review server answers at this address."""
    try:
        with urllib.request.urlopen(url + "/", timeout=timeout) as response:
            return response.status == 200 and b"HTMi" in response.read(4096)
    except (urllib.error.URLError, OSError, ValueError):
        return False


def running(root: Path) -> dict | None:
    """The live server for this repository, or None (a stale record is dropped)."""
    state = _load()
    record = state.get(str(root))
    if not record:
        return None
    if _process_alive(int(record.get("pid", 0))) and responds(record.get("url", "")):
        return record
    state.pop(str(root), None)
    _save(state)
    return None


def all_running() -> list[dict]:
    """Every live server, for the dashboard; stale records are dropped."""
    state = _load()
    live = {root: r for root, r in state.items() if _process_alive(int(r.get("pid", 0))) and responds(r.get("url", ""))}
    if live.keys() != state.keys():
        _save(live)
    return [{"root": root, **r} for root, r in live.items()]


def start(root: Path, wait: float = 15) -> dict:
    """The live server for `root`, started now if there is none."""
    current = running(root)
    if current:
        return {**current, "started": False}
    problem = runner.node_problem()
    if problem:
        raise runner.EngineError(problem)
    log = data_dir() / f"serve-{hashlib.sha256(str(root).encode()).hexdigest()[:12]}.log"
    with open(log, "w") as out:
        process = subprocess.Popen(
            [runner.node_executable() or "node", str(runner.ENGINE), "serve", "--frame-ancestors", LOCAL_FRAMES],
            cwd=str(root),
            env=runner.child_env(),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    deadline = time.monotonic() + wait
    url = None
    while time.monotonic() < deadline:
        match = _URL_RE.search(log.read_text(errors="replace"))
        if match:
            url = match.group(1)
            break
        if process.poll() is not None:
            break
        time.sleep(0.1)
    if not url or not responds(url):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        detail = log.read_text(errors="replace").strip().splitlines()[-3:]
        raise runner.EngineError("the review page did not start" + (f": {' '.join(detail)}" if detail else ""))
    record = {"pid": process.pid, "url": url, "log": str(log), "since": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    state = _load()
    state[str(root)] = record
    _save(state)
    return {**record, "started": True}


def stop(root: Path) -> bool:
    """Stop this repository's server; False when none was running."""
    state = _load()
    record = state.pop(str(root), None)
    _save(state)
    # A recorded process id can be reused after a restart; only signal it while our page still answers.
    if not record or not _process_alive(int(record["pid"])) or not responds(record.get("url", "")):
        return False
    try:
        os.killpg(int(record["pid"]), signal.SIGTERM)
    except ProcessLookupError:
        return False
    return True


def document_url(server_url: str, ref: str) -> str:
    return f"{server_url}/doc/{quote(ref, safe='')}"


def show(root: Path, ref: str) -> str:
    """The address of a document on this repository's running page, remembered as the
    page the dashboard's Review tab shows for it."""
    state = _load()
    record = state.get(str(root))
    if not record:
        raise runner.EngineError("no review page is running for this repository")
    record["page"] = document_url(record["url"], ref)
    _save(state)
    return record["page"]
