"""What the plugin keeps from the engine and from GitHub: secrets in Hermes's environment,
repositories other than the person's own, and GitHub writes nobody approved.

Real engine, real git repository. Where the test must see what `gh` would receive, HTMI_GH
points the engine at a small probe program that records its environment and arguments and
answers like an empty issue, instead of reaching GitHub.
"""

from __future__ import annotations

import json
import stat
import sys

import pytest
from conftest import call, git
from htmi_plugin import policy, runner, tools

SECRETS = {
    "OPENROUTER_API_KEY": "sk-or-not-real",
    "ANTHROPIC_API_KEY": "sk-ant-not-real",
    "MODEL_API_KEY": "model-not-real",
    "AWS_SECRET_ACCESS_KEY": "aws-not-real",
}
KEPT = {
    "GH_TOKEN": "gh-token-for-gh",
    "GH_HOST": "github.com",
    "GIT_AUTHOR_NAME": "Reviewer",
    "LC_ALL": "C.UTF-8",
    "HTTPS_PROXY": "http://proxy.invalid:3128",
}


@pytest.fixture()
def gh_probe(tmp_path, monkeypatch):
    """HTMI_GH pointing at a probe that writes its environment and arguments to a file."""
    record = tmp_path / "gh-calls.jsonl"
    probe = tmp_path / "gh-probe"
    probe.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"with open({str(record)!r}, 'a') as f:\n"
        "    f.write(json.dumps({'argv': sys.argv[1:], 'env': dict(os.environ)}) + '\\n')\n"
        "print(json.dumps({'number': 1, 'title': 'x', 'body': '', 'html_url': 'https://github.com/x', "
        "'updated_at': '2026-01-01T00:00:00Z'}) if '--paginate' not in sys.argv else '[[]]')\n"
    )
    probe.chmod(probe.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("HTMI_GH", str(probe))
    return record


@pytest.fixture()
def origin(repo):
    git(repo, "remote", "add", "origin", "https://github.com/owner/name.git")
    yield "owner/name"
    policy.configure(lambda key, default=None: default)


def calls(record):
    return [json.loads(line) for line in record.read_text().splitlines()] if record.exists() else []


def test_child_env_keeps_what_git_and_gh_need_and_nothing_else(monkeypatch):
    for name, value in {**SECRETS, **KEPT}.items():
        monkeypatch.setenv(name, value)
    env = runner.child_env()
    for name in SECRETS:
        assert name not in env
    for name, value in KEPT.items():
        assert env[name] == value
    assert env["NO_COLOR"] == "1" and env["PATH"]


def test_the_engine_and_the_gh_it_starts_never_see_provider_keys(repo, origin, gh_probe, monkeypatch):
    for name, value in {**SECRETS, **KEPT}.items():
        monkeypatch.setenv(name, value)
    call(tools.read_document, document="github:owner/name#1")
    seen = calls(gh_probe)
    assert seen, "the engine did not start gh"
    for record in seen:
        for name in SECRETS:
            assert name not in record["env"]
        assert record["env"]["GH_TOKEN"] == KEPT["GH_TOKEN"]


def test_references_resolve_the_way_the_engine_resolves_them(repo, origin):
    assert policy.description_target(repo, "github:owner/name#7") == ("owner/name", 7)
    assert policy.description_target(repo, "https://github.com/a/b/pull/3") == ("a/b", 3)
    assert policy.description_target(repo, "github:#9") == ("owner/name", 9)
    assert policy.description_target(repo, "docs/plan.html") is None
    assert policy.allowed_repos(repo) == ["owner/name"]
    policy.configure(lambda key, default=None: ["team/docs", "not a repo"] if key == "github_repos" else default)
    assert policy.allowed_repos(repo) == ["owner/name", "team/docs"]
    assert policy.is_allowed(repo, "Team/Docs")


def test_the_repositorys_own_config_cannot_widen_what_is_allowed(repo, origin):
    (repo / ".htmi").mkdir(exist_ok=True)
    (repo / ".htmi" / "config.json").write_text(json.dumps({"github": {"repo": "someone/else"}}))
    assert policy.description_target(repo, "github:#3") == ("someone/else", 3)
    with pytest.raises(runner.EngineError, match="someone/else is not one of them"):
        policy.check_document(repo, "github:#3")


def test_every_tool_refuses_other_repositories_before_reaching_github(repo, origin, gh_probe):
    other = "github:other/repo#1"
    refusals = [
        call(tools.read_document, document=other),
        call(tools.list_targets, document=other),
        call(tools.comment_context, document=other, target="#x"),
        call(tools.list_comments, document=other),
        call(tools.validate, documents=[other]),
        call(tools.pull_comments, document="https://github.com/other/repo/issues/1"),
        call(tools.apply_edit, document=other, operation={"op": "set-text"}),
        call(tools.open_review, document=other),
        call(tools.publish_description, document="docs/plan.html", repo="other/repo", title="x"),
    ]
    for result in refusals:
        assert "other/repo is not one of them" in result["error"], result
    assert calls(gh_probe) == []


def test_publishing_needs_an_origin_and_an_html_file_here(repo):
    assert "no GitHub origin" in call(tools.publish_description, document="docs/plan.html", title="x")["error"]
    git(repo, "remote", "add", "origin", "https://github.com/owner/name.git")
    (repo / "notes.md").write_text("# Notes\n")
    assert "not an HTML file" in call(tools.publish_description, document="notes.md", title="x")["error"]
    assert "not an HTML file" in call(tools.publish_description, document="../outside.html", title="x")["error"]
    assert "positive whole number" in call(tools.publish_description, document="docs/plan.html", number=-3)["error"]


def test_hermes_asks_the_person_before_every_create_replace_or_edit_on_github(repo, origin):
    create = policy.pre_tool_call("htmi_publish_description", {"document": "docs/plan.html", "title": "Plan"})
    assert create["action"] == "approve"
    assert "Create a new issue in owner/name" in create["message"] and "docs/plan.html" in create["message"]
    replace = policy.pre_tool_call("htmi_publish_description", {"document": "docs/plan.html", "number": 7})
    assert replace["action"] == "approve" and "owner/name#7" in replace["message"]
    assert replace["rule_key"] != create["rule_key"]
    edit = policy.pre_tool_call("htmi_apply_edit", {"document": "github:owner/name#7", "operation": {"op": "set-text"}})
    assert edit["action"] == "approve" and "owner/name#7" in edit["message"]

    blocked = policy.pre_tool_call("htmi_publish_description", {"document": "docs/plan.html", "repo": "other/repo"})
    assert blocked["action"] == "block" and "other/repo" in blocked["message"]
    assert policy.pre_tool_call("htmi_apply_edit", {"document": "github:other/repo#1"})["action"] == "block"

    # Nothing to ask about: a file in this repository, a dry run, a tool that only reads.
    assert policy.pre_tool_call("htmi_apply_edit", {"document": "docs/plan.html"}) is None
    assert policy.pre_tool_call("htmi_apply_edit", {"document": "github:owner/name#7", "dry_run": True}) is None
    assert policy.pre_tool_call("htmi_read_document", {"document": "github:other/repo#1"}) is None


def test_without_an_origin_publishing_is_blocked_at_the_hook(repo):
    result = policy.pre_tool_call("htmi_publish_description", {"document": "docs/plan.html", "title": "Plan"})
    assert result["action"] == "block"


def test_a_document_path_outside_the_repository_is_refused(repo, tmp_path):
    (tmp_path / "secret.html").write_text("<p id='k'>MODEL_API_KEY=not-real</p>")
    result = call(tools.read_document, document="../secret.html")
    assert "outside the repository" in result["error"]
    assert "not-real" not in json.dumps(result)
