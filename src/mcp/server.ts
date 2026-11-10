import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  affectedThreads,
  agentAuthor,
  contextFor,
  docRef,
  filterThreads,
  listDocuments,
  listTargets,
  readSection,
  readTarget,
  reply,
  runOperation,
  search,
  threadsFor,
} from "../app/actions.js";
import { renderContextText } from "../core/context.js";
import { documentOutline, outlineText } from "../core/reading.js";
import type { Workspace } from "../core/workspace.js";
import { openAll, openDocument } from "../app/documents.js";

/**
 * A small MCP surface over the same actions as the CLI: seven tools, chosen so
 * an agent can find and read documents (with or without feedback), read
 * exactly the context a comment needs, change a document through a checked
 * operation, and reply. There is deliberately no tool to resolve a comment;
 * only a reviewer can do that.
 */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

const DOCUMENT =
  "document id, repository path, or GitHub issue or pull request description: github:owner/repo#7, github:#7 or its URL";

function guard(run: () => ToolResult): ToolResult {
  try {
    return run();
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error).message }], isError: true };
  }
}

export function createMcpServer(ws: Workspace, version: string): McpServer {
  const server = new McpServer({ name: "htmi", version });
  const agentName = () => server.server.getClientVersion()?.name ?? "mcp-agent";

  server.registerTool(
    "htmi_list_documents",
    {
      title: "List documents",
      description:
        "HTML documents, and Markdown documents with Mermaid diagrams or HTMi markers, in this repository, plus GitHub issue and pull request descriptions that have comments here, with counts of open comments and of comments whose target needs attention. Descriptions that cannot be read now are listed under unavailable. Any other file can still be read by path, and any description by reference.",
      inputSchema: {},
    },
    () => guard(() => json(listDocuments(ws))),
  );

  server.registerTool(
    "htmi_read_document",
    {
      title: "Read a document",
      description:
        "Read an HTML or Markdown document without needing any comment. With only `document`: an outline of sections and blocks with their keys, the files it uses and what HTMi cannot represent. With `section`: that section in reading order, every block (paragraphs, tables as rows, code exactly, figures with captions and alt text) labelled with its key. With `block`: one block exactly, plus its HTML when `source` is true. With `search`: where text occurs, by block key. Stylesheets, scripts, SVG geometry and image bytes are left out.",
      inputSchema: {
        document: z.string().describe(DOCUMENT),
        section: z.string().optional().describe("section id from the outline"),
        block: z.string().optional().describe("block or target key such as #costs or b.eviction.code1"),
        search: z.string().max(500).optional().describe("text to find"),
        source: z.boolean().default(false).describe("with block: include the block's source"),
      },
    },
    ({ document, section, block, search: query, source }) =>
      guard(() => {
        const doc = openDocument(ws, document);
        const at = {
          document: doc.documentId,
          path: doc.path,
          revision: doc.revision.label,
          documentDigest: doc.digest,
        };
        if (block) return json({ ...at, ...readTarget(doc, block, source) });
        if (section) return json({ ...at, section, ...readSection(doc, section) });
        if (query) return json({ ...at, query, hits: search(doc, query) });
        return text(outlineText(documentOutline(doc)));
      }),
  );

  server.registerTool(
    "htmi_list_targets",
    {
      title: "List commentable targets",
      description:
        "Components, connections, groups and images of a document with their stable ids. Use a key from here when asking for context.",
      inputSchema: { document: z.string().describe(DOCUMENT), diagram: z.string().optional() },
    },
    ({ document, diagram }) =>
      guard(() => {
        const doc = openDocument(ws, document);
        return json(
          listTargets(doc, diagram).map((t) => ({
            key: t.key,
            kind: t.kind,
            label: t.label,
            mapping: t.mapping,
            from: t.from,
            to: t.to,
          })),
        );
      }),
  );

  server.registerTool(
    "htmi_list_comments",
    {
      title: "List review comments",
      description:
        "Review comments with their discussion status and whether their target is still exactly where it was (exact, changed, heuristic, ambiguous, orphaned).",
      inputSchema: {
        document: z.string().optional().describe(`${DOCUMENT}; all documents when omitted`),
        status: z.enum(["open", "attention", "all"]).default("open"),
      },
    },
    ({ document, status }) =>
      guard(() => {
        const { docs, unavailable } = document ? { docs: [openDocument(ws, document)], unavailable: [] } : openAll(ws);
        const listed = json(
          docs.flatMap((doc) =>
            filterThreads(threadsFor(ws, doc), status).map((r) => ({
              id: r.thread.id,
              document: docRef(doc),
              discussion: r.thread.discussion,
              kind: r.thread.comment.body.kind,
              target: r.thread.target.diagramId
                ? `${r.thread.target.diagramId}/${r.thread.target.targetId}`
                : r.thread.target.targetId,
              targetStatus: r.resolution.status,
              text: r.thread.comment.body.text,
            })),
          ),
        );
        // Comments on a description that cannot be read now are not listed; say so rather than omit them silently.
        for (const u of unavailable) {
          listed.content.push({
            type: "text",
            text: `Could not read ${u.ref}, so its comments are not listed: ${u.error}`,
          });
        }
        return listed;
      }),
  );

  server.registerTool(
    "htmi_get_context",
    {
      title: "Get context for a comment or target",
      description:
        "The context needed to act on one comment or target: the target and its neighbours, declared constraints, nearby prose, the thread verbatim, what the source does not say, and what was left out with commands to fetch it.",
      inputSchema: {
        document: z.string().describe(DOCUMENT),
        comment: z.string().optional().describe("comment id such as C-7KQ2XM"),
        target: z.string().optional().describe("target key such as pipeline/n.parser, or a diagram id"),
        budget: z
          .number()
          .int()
          .positive()
          .max(200_000)
          .optional()
          .describe("soft limit in characters for optional prose"),
      },
    },
    ({ document, comment, target, budget }) =>
      guard(() => text(renderContextText(contextFor(ws, openDocument(ws, document), { comment, target, budget })))),
  );

  server.registerTool(
    "htmi_apply_operation",
    {
      title: "Apply a checked document edit",
      description:
        "Apply one operation with expectedDocumentDigest and, for existing targets, expectedTargetDigest. HTML: set-text {target, find, replace} (visible text, escaped for you), set-attribute {target, name, value}, replace-source {target, find, replace} (raw HTML inside the target), replace-text {sectionId, find, replace}, replace-in-file {path, expectedFileDigest, find, replace} for a stylesheet, script or data file the document uses. Markdown with Mermaid: set-node-label, set-edge-label, add-node, add-edge, remove-edge, set-description, replace-text. Edits splice the source; the rest of the file stays byte for byte. The edit is refused if a digest is stale or if anything it did not name would change. A GitHub description is Markdown and is written on GitHub after its body is read again; an edit someone saves in the moment between that read and the write would be replaced.",
      inputSchema: {
        document: z.string().describe(DOCUMENT),
        operation: z
          .record(z.string(), z.unknown())
          .describe("the operation object, including op and expected digests"),
        dryRun: z.boolean().default(false),
      },
    },
    ({ document, operation, dryRun }) =>
      guard(() => {
        const doc = openDocument(ws, document);
        const before = threadsFor(ws, doc);
        const result = runOperation(ws, doc, operation, dryRun);
        if (!result.ok) return { ...json(result), isError: true };
        const after = result.written ? threadsFor(ws, openDocument(ws, doc.path)) : before;
        const { content: _content, ...summary } = result;
        void _content;
        return json({ ...summary, affectedComments: affectedThreads(before, after) });
      }),
  );

  server.registerTool(
    "htmi_reply",
    {
      title: "Reply to a comment",
      description:
        "Add a reply to a comment, optionally marking it acknowledged or addressed with the revision that addresses it. Agents cannot resolve comments; the reviewer decides that.",
      inputSchema: {
        comment: z.string(),
        text: z.string().min(1).max(20_000),
        status: z.enum(["acknowledged", "addressed"]).optional(),
        revision: z.string().max(100).optional().describe("commit that contains the change"),
      },
    },
    ({ comment, text: body, status, revision }) =>
      guard(() =>
        json(reply(ws, { thread: comment, text: body, status, revision, author: agentAuthor(agentName(), "mcp") })),
      ),
  );

  return server;
}

export async function runMcpServer(ws: Workspace, version: string): Promise<void> {
  const server = createMcpServer(ws, version);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}
