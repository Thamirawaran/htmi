"""HTMi for Hermes Agent: review rich documents with your agent.

People read an HTML or Markdown document as authored and comment on the exact element,
passage, diagram part or image region. Hermes is told about new comments, reads one with
exactly the context it needs, changes the source through checked edits, and replies.
The work is done by the bundled HTMi engine (bundle/htmi.mjs) under Node.js.
"""

from __future__ import annotations

from pathlib import Path

from . import commands, notices, schemas, tools

TOOLSET = "htmi"

_HANDLERS = {
    "htmi_list_documents": tools.list_documents,
    "htmi_read_document": tools.read_document,
    "htmi_list_targets": tools.list_targets,
    "htmi_list_comments": tools.list_comments,
    "htmi_comment_context": tools.comment_context,
    "htmi_apply_edit": tools.apply_edit,
    "htmi_reply": tools.reply,
    "htmi_validate": tools.validate,
    "htmi_pull_comments": tools.pull_comments,
    "htmi_publish_description": tools.publish_description,
    "htmi_open_review": tools.open_review,
}


def register(ctx) -> None:
    for schema in schemas.ALL:
        ctx.register_tool(
            name=schema["name"],
            toolset=TOOLSET,
            schema=schema,
            handler=_HANDLERS[schema["name"]],
            description=schema["description"],
        )
    ctx.register_hook("pre_llm_call", notices.pre_llm_call)
    ctx.register_command(
        "htmi",
        commands.handle,
        description="Open the HTMi review page, list review comments, or stop the page",
        args_hint="[open [document] | comments | stop | init | status]",
    )
    ctx.register_skill("document-review", Path(__file__).parent / "skills" / "document-review" / "SKILL.md")
