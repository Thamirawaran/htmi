"""Dashboard backend for HTMi, mounted at /api/plugins/htmi/.

Lists the review pages that are running, read from the record the plugin's tools and
the /htmi command keep in the plugin's data folder. It starts nothing and changes
nothing; a page is started by Hermes (htmi_open_review) or by `/htmi open`.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from fastapi import APIRouter
from plugins.plugin_storage import plugin_data_dir

router = APIRouter()


def _alive(pid: int, url: str) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    try:
        with urllib.request.urlopen(url + "/", timeout=2) as response:
            return response.status == 200 and b"HTMi" in response.read(4096)
    except (urllib.error.URLError, OSError, ValueError):
        return False


@router.get("/servers")
def servers() -> dict:
    """Running review pages, newest first. A plain def, so FastAPI runs it off the event loop."""
    try:
        state = json.loads((plugin_data_dir("htmi") / "servers.json").read_text())
    except (OSError, ValueError):
        state = {}
    live = [
        {"root": root, "name": os.path.basename(root), "url": r["url"], "since": r.get("since")}
        for root, r in (state.items() if isinstance(state, dict) else [])
        if isinstance(r, dict) and _alive(int(r.get("pid", 0)), str(r.get("url", "")))
    ]
    live.sort(key=lambda s: s.get("since") or "", reverse=True)
    return {"servers": live}
