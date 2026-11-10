"""The plugin against the real bundled engine in a temporary git repository, as Hermes runs it.

Run with `uv run --no-project --with pytest pytest hermes/tests` from the repository root.
"""

from __future__ import annotations

import json
import urllib.request

from conftest import PLAN, PLUGIN_DIR, call, git, human_comment
from htmi_plugin import commands, notices, review_server, runner, tools


def test_the_engine_runs_here():
    assert runner.node_problem() is None


def test_notice_names_new_comments_without_their_text(repo):
    assert notices.notice_for("s1", repo) is None  # no comments yet, no .htmi folder

    first = human_comment("#latency", "Is 40 ms measured at the client or the server?", "question")
    notice = notices.notice_for("s1", repo)
    assert notice and first in notice and "1 open review comment" in notice
    assert "docs/plan.html" in notice and "#latency" in notice
    assert "40 ms measured" not in notice  # the reviewer's text stays out of the prompt

    assert notices.notice_for("s1", repo) is None  # nothing changed since

    second = human_comment("#risk-table", "Add the cache warm-up risk.", "change-request")
    notice = notices.notice_for("s1", repo)
    assert notice and "1 new review comment" in notice and second in notice and first not in notice

    hook = notices.pre_llm_call(session_id="s2")  # another session hears about both
    assert hook and first in hook["context"] and second in hook["context"]


def test_checked_edit_reply_and_a_refused_stale_edit(repo):
    comment = human_comment("#latency", "Make it 35 ms; 40 is last year's target.", "change-request")
    targets = call(tools.list_targets, document="docs/plan.html")
    latency = next(t for t in targets if t["key"] == "#latency")
    outline_doc, _ = runner.run_json(["read", "docs/plan.html", "--block", "#latency"])
    operation = {
        "op": "set-text",
        "target": "#latency",
        "find": "40 ms",
        "replace": "35 ms",
        "expectedDocumentDigest": outline_doc["documentDigest"],
        "expectedTargetDigest": latency["digest"],
    }

    dry = call(tools.apply_edit, document="docs/plan.html", operation=operation, dry_run=True)
    assert dry["ok"] is True and dry["written"] is False
    assert "40 ms" in (repo / "docs" / "plan.html").read_text()

    done = call(tools.apply_edit, document="docs/plan.html", operation=operation)
    assert done["ok"] is True and done["written"] is True
    after = (repo / "docs" / "plan.html").read_text()
    assert after == PLAN.replace("40 ms", "35 ms")  # nothing else in the file moved

    stale = call(tools.apply_edit, document="docs/plan.html", operation=operation)
    assert stale["ok"] is False and "error" not in stale  # refused with a reason, not a failure

    git(repo, "commit", "-qam", "35 ms")
    head = git(repo, "rev-parse", "--short", "HEAD").strip()
    replied = call(tools.reply, comment=comment, text="Changed to 35 ms.", status="addressed", revision=head)
    assert replied["replyId"]
    rows = call(tools.list_comments, status="all")["comments"]
    assert rows[0]["discussion"] == "addressed" and rows[0]["replies"] == 1


def test_review_page_starts_once_and_serves_the_document(repo):
    opened = call(tools.open_review, document="docs/plan.html")
    assert opened["started"] is True and opened["url"].startswith("http://127.0.0.1:")
    with urllib.request.urlopen(opened["document_url"], timeout=10) as page:
        html = page.read().decode()
    assert "Cache plan" in html and "Stale reads after failover" in html

    again = call(tools.open_review)
    assert again["started"] is False and again["url"] == opened["url"]

    status = commands.handle("status")
    assert opened["url"] in status and "ready" in status

    assert commands.handle("stop") == "Stopped the review page."
    assert review_server.running(repo) is None
    assert commands.handle("stop") == "No review page was running here."


def test_the_dashboard_tab_ships_the_files_its_manifest_names():
    dashboard = PLUGIN_DIR / "dashboard"
    manifest = json.loads((dashboard / "manifest.json").read_text())
    for key in ("entry", "api"):
        assert (dashboard / manifest[key]).is_file(), manifest[key]
