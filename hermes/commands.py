"""The /htmi slash command, for the person rather than the agent."""

from __future__ import annotations

import shlex

from . import review_server, runner

USAGE = """/htmi open [document]   start the review page for this repository and show its address
/htmi comments          open review comments here
/htmi stop              stop this repository's review page
/htmi init              set up .htmi/ in this repository
/htmi status            whether the review page runs, and the engine's version"""


def handle(raw_args: str = "", **_kwargs) -> str:
    try:
        words = shlex.split(raw_args or "")
    except ValueError as error:
        return f"htmi: {error}\n\n{USAGE}"
    command, rest = (words[0], words[1:]) if words else ("open", [])
    try:
        return _run(command, rest)
    except runner.EngineError as error:
        return f"htmi: {error}"


def _run(command: str, rest: list[str]) -> str:
    cwd = runner.session_cwd()
    root = review_server.repo_root(cwd)
    if command == "open":
        server = review_server.start(root)
        lines = [f"Review page for {root}:", f"  {server['url']}/"]
        if rest:
            report, _ = runner.run_json(["validate", rest[0]], cwd=root, accept=(0, 3))
            path = report["documents"][0]["path"]
            lines.append(f"  {review_server.document_url(server['url'], path)}")
        lines.append("Only this computer can reach it. Comments you leave there reach Hermes on its next turn.")
        return "\n".join(lines)
    if command == "comments":
        text, warnings = runner.run_text(["comments", *rest[:1], "--status", "open"], cwd=root)
        return "\n".join([text.rstrip(), *[f"(warning: {w})" for w in warnings]])
    if command == "stop":
        return "Stopped the review page." if review_server.stop(root) else "No review page was running here."
    if command == "init":
        text, _ = runner.run_text(["init"], cwd=root)
        # The engine's init text ends with instructions for agents' AGENTS.md; Hermes gets those from the skill.
        return text.split("\n\nAdd this to AGENTS.md")[0]
    if command == "status":
        problem = runner.node_problem()
        version = (runner.PLUGIN_DIR / "bundle" / "VERSION").read_text().strip()
        server = review_server.running(root)
        return "\n".join(
            [
                f"HTMi engine {version}: {'ready' if not problem else problem}",
                f"Repository: {root}",
                f"Review page: {server['url'] + '/' if server else 'not running (/htmi open starts it)'}",
            ]
        )
    return USAGE
