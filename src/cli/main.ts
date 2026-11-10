#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ActionError,
  addComment,
  affectedThreads,
  agentAuthor,
  contextFor,
  docRef,
  filterThreads,
  listDocuments,
  listTargets,
  localHuman,
  readSection,
  readTarget,
  search,
  reattach,
  recordEvidence,
  reply,
  runOperation,
  setStatus,
  threadsFor,
} from "../app/actions.js";
import { AnnotationError, AnnotationStore, describeRegion, nowIso } from "../core/annotations.js";
import { ContextError, renderContextText } from "../core/context.js";
import { DocumentError, type DocModel } from "../core/document.js";
import { documentOutline, outlineText } from "../core/reading.js";
import { resolveThreads } from "../core/resolve.js";
import { repoRevision } from "../core/revision.js";
import { openWorkspace, WorkspaceError, type Workspace } from "../core/workspace.js";
import { parseDescriptionRef } from "../github/description.js";
import { GitHubError, isShared, postThread, publishReview, pullFeedback, resolveRepo } from "../github/github.js";
import { buildReviewPage } from "../render/review-page.js";
import { openAll, openDocument, type Unavailable } from "../app/documents.js";
import { agentInstructions } from "./instructions.js";

/** Set at bundle time for the single-file engine (scripts/bundle-engine.mjs); read from package.json otherwise. */
declare const __HTMI_VERSION__: string | undefined;
const VERSION =
  typeof __HTMI_VERSION__ === "string"
    ? __HTMI_VERSION__
    : (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `htmi ${VERSION}: review diagrams and documents, and hand pinned feedback to your coding agent.

Reading
  htmi list                                  documents, and descriptions that have comments here
  htmi targets <doc> [--diagram <id>]        commentable targets and their ids
  htmi read <doc>                            outline: sections, blocks with their keys, files it uses
  htmi read <doc> --section <id>             a section in reading order, every block with its key
  htmi read <doc> --block <key> [--source]   one block exactly (table cells, code); --source adds its HTML
  htmi read <doc> --search <text>            where text occurs, by block key
  htmi read <doc> --target <key>             a target with its diagram neighbours
       (all read forms take --rev <commit>, except on descriptions)
  htmi comments [<doc>] [--status open|attention|all]
  htmi context <doc> (--comment <id> | --target <key>) [--budget <chars>]

Feedback
  htmi comment <doc> --target <key> --text <text> [--kind comment|question|change-request]
       [--region x,y,w,h]                     part of an image, as fractions of its width and height
  htmi reply <comment> --text <text> [--status acknowledged|addressed] [--revision <rev>] [--agent <name>]
  htmi status <comment> <open|acknowledged|addressed|resolved|wontfix> [--note <text>] [--agent <name>]
  htmi reattach <comment> --target <key> [--reason <text>]
  htmi evidence [--comment <id>] --claim <text> -- <command> [args...]

Changes
  htmi apply <doc> (--op <json> | --op-file <path>) [--dry-run]
  htmi validate [<doc>...]

Views
  htmi build <doc> [--out <file>] [--rev <commit>] [--include-local]
  htmi serve [--port <n>] [--frame-ancestors <origins>]

GitHub (uses your gh login; nothing is sent unless you run these)
  htmi github publish <doc> [--issue <n>] [--repo owner/name] [--include-local] [--new]
  htmi github pull [<description>] [--issue <n>] [--repo owner/name]
  htmi github post <comment> [--issue <n>] [--repo owner/name]
       (for a description, the issue defaults to the description's own issue or pull request)

Agents
  htmi mcp                                   MCP server on stdio
  htmi init                                  set up .htmi/ and print agent instructions
  htmi agents                                print agent instructions

Add --json to reading commands for machine output. <doc> is a document id, a path, or an issue or
pull request description: github:owner/repo#7, github:#7 (the configured repository) or its URL.
A description is read and written through gh; GitHub keeps the text.`;

class UsageError extends Error {}

type Flags = Record<string, string | boolean | string[] | undefined>;

function args(
  argv: string[],
  options: Record<string, { type: "string" | "boolean" }>,
): { values: Flags; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { json: { type: "boolean" }, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: parsed.values as Flags, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

function int(value: string | undefined, what: string): number {
  const n = Number(need(value, what));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${what} must be a positive whole number`);
  return n;
}

function out(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text()}\n`);
}

function load(ws: Workspace, ref: string | undefined, rev?: string): DocModel {
  return openDocument(ws, need(ref, "document"), rev);
}

/** Documents named on the command line, or every document HTMi knows when none is named. */
function loadMany(ws: Workspace, refs: string[]): { docs: DocModel[]; unavailable: Unavailable[] } {
  return refs.length ? { docs: refs.map((r) => load(ws, r)), unavailable: [] } : openAll(ws);
}

/** Descriptions that could not be read are named on stderr, so their absence is never silent. */
function warnUnavailable(unavailable: Unavailable[], what: string): void {
  for (const u of unavailable) process.stderr.write(`htmi: could not read ${u.ref}, ${what} not shown: ${u.error}\n`);
}

/** The issue to use: --issue and --repo, else the description's own issue or pull request. */
function issueFor(ws: Workspace, values: Flags, description?: { repo: string; number: number } | null) {
  const issue = str(values, "issue");
  if (!issue && !description) throw new UsageError("missing --issue");
  return {
    repo: str(values, "repo") ? resolveRepo(ws, str(values, "repo")) : (description?.repo ?? resolveRepo(ws)),
    issue: issue ? int(issue, "--issue") : description!.number,
  };
}

function author(ws: Workspace, flags: Flags) {
  const agent = str(flags, "agent");
  return agent ? agentAuthor(agent, "cli") : localHuman(ws);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const ws = openWorkspace(process.cwd());

  switch (command) {
    case "list": {
      const { values } = args(rest, {});
      const listing = listDocuments(ws);
      const docs = listing.documents;
      out(!!values.json, listing, () =>
        [
          ...(docs.length
            ? docs.map(
                (d) =>
                  `${d.idSource === "declared" ? d.id : d.path}  ${d.title}\n  ${d.url ?? d.path} at ${d.revision}; ${d.diagrams} diagram(s), ${d.targets} targets, ${d.openThreads} open comment(s)${d.needsAttention ? `, ${d.needsAttention} need attention` : ""}${d.errors ? `, ${d.errors} source error(s)` : ""}`,
              )
            : [
                "No documents found. HTMi lists HTML files, Markdown files that contain a Mermaid block or a HTMi marker, and descriptions that have comments here.",
              ]),
          ...listing.unavailable.map((u) => `${u.ref}  could not be read: ${u.error}`),
        ].join("\n"),
      );
      return 0;
    }

    case "targets": {
      const { values, positionals } = args(rest, { diagram: { type: "string" } });
      const doc = load(ws, positionals[0]);
      const targets = listTargets(doc, str(values, "diagram"));
      out(
        !!values.json,
        targets.map((t) => ({
          key: t.key,
          id: t.id,
          kind: t.kind,
          diagramId: t.diagramId,
          label: t.label,
          mapping: t.mapping,
          from: t.from,
          to: t.to,
          digest: t.digest,
        })),
        () => {
          const rows = targets.map(
            (t) => `${t.key.padEnd(44)} ${t.kind.padEnd(6)} ${t.mapping.padEnd(8)} ${t.label.replace(/\n/g, " ")}`,
          );
          const diagrams = doc.diagrams.map(
            (d) =>
              `${d.id.padEnd(44)} diagram ${d.idSource === "declared" ? "exact   " : "derived "} ${d.targetKeys.length} parts`,
          );
          return [...diagrams, ...rows].join("\n") || "No targets.";
        },
      );
      return 0;
    }

    case "read": {
      const { values, positionals } = args(rest, {
        section: { type: "string" },
        target: { type: "string" },
        block: { type: "string" },
        search: { type: "string" },
        source: { type: "boolean" },
        rev: { type: "string" },
      });
      const doc = load(ws, positionals[0], str(values, "rev"));
      const section = str(values, "section");
      const target = str(values, "target");
      const block = str(values, "block");
      const query = str(values, "search");
      if (block) {
        const b = readTarget(doc, block, !!values.source);
        out(
          !!values.json,
          { document: doc.documentId, revision: doc.revision.label, documentDigest: doc.digest, ...b },
          () =>
            [
              `${b.text}`,
              `(${sourceLines(doc, b.lines.start, b.lines.end)} at ${doc.revision.label}; ${b.mapping} key; digest ${b.digest.slice(7, 19)})`,
              ...(b.source !== undefined ? ["", "Source:", b.source] : []),
            ].join("\n"),
        );
        return 0;
      }
      if (query) {
        const hits = search(doc, query);
        out(!!values.json, { document: doc.documentId, revision: doc.revision.label, query, hits }, () =>
          hits.length
            ? hits
                .map(
                  (h) =>
                    `${h.key ? `[${h.key}]` : `(section ${h.section})`} ${h.kind}, line ${h.lines.start}: ${h.snippet}`,
                )
                .join("\n")
            : `No matches for "${query}".`,
        );
        return 0;
      }
      if (section) {
        const s = readSection(doc, section);
        out(
          !!values.json,
          { document: doc.documentId, revision: doc.revision.label, section, ...s },
          () => `# ${s.title}  (${doc.path}:${s.lines.start}-${s.lines.end} at ${doc.revision.label})\n\n${s.text}`,
        );
        return 0;
      }
      if (target) {
        const packet = contextFor(ws, doc, { target, budget: 0 });
        const items = packet.items.filter(
          (i) => i.title === "Target" || i.title === "Neighbours" || i.title === "Diagram",
        );
        out(!!values.json, { document: packet.document, focus: packet.focus, items, unknowns: packet.unknowns }, () =>
          [...items.map((i) => i.text), ...packet.unknowns.map((u) => `Unknown: ${u}`)].join("\n\n"),
        );
        return 0;
      }
      const outline = documentOutline(doc);
      out(!!values.json, outline, () => outlineText(outline));
      return 0;
    }

    case "comments": {
      const { values, positionals } = args(rest, { status: { type: "string" } });
      const status = (str(values, "status") ?? "open") as "open" | "attention" | "all";
      if (!["open", "attention", "all"].includes(status))
        throw new UsageError("--status must be open, attention or all");
      const { docs, unavailable } = loadMany(ws, positionals.slice(0, 1));
      warnUnavailable(unavailable, "its comments are");
      const rows = docs.flatMap((doc) =>
        filterThreads(threadsFor(ws, doc), status).map((r) => ({
          id: r.thread.id,
          document: docRef(doc),
          discussion: r.thread.discussion,
          kind: r.thread.comment.body.kind,
          target: r.thread.target.diagramId
            ? `${r.thread.target.diagramId}/${r.thread.target.targetId}`
            : r.thread.target.targetId,
          ...(r.thread.target.selector?.type === "ImageRegionSelector"
            ? { region: describeRegion(r.thread.target.selector) }
            : {}),
          resolution: r.resolution.status,
          author: r.thread.comment.author.login ? `@${r.thread.comment.author.login}` : r.thread.comment.author.name,
          text: r.thread.comment.body.text,
          replies: r.thread.replies.length,
        })),
      );
      out(!!values.json, rows, () =>
        rows.length
          ? rows
              .map(
                (r) =>
                  `${r.id}  ${r.discussion}  ${r.kind}  ${r.document} ${r.target}${r.region ? ` (region ${r.region})` : ""}  [target ${r.resolution}]\n  ${r.author}: ${r.text.split("\n")[0]}${r.replies ? `  (${r.replies} repl${r.replies === 1 ? "y" : "ies"})` : ""}`,
              )
              .join("\n")
          : `No ${status === "all" ? "" : `${status} `}comments.`,
      );
      return 0;
    }

    case "context": {
      const { values, positionals } = args(rest, {
        comment: { type: "string" },
        target: { type: "string" },
        budget: { type: "string" },
      });
      const doc = load(ws, positionals[0]);
      const budget = str(values, "budget") ? int(str(values, "budget"), "--budget") : undefined;
      const packet = contextFor(ws, doc, { comment: str(values, "comment"), target: str(values, "target"), budget });
      out(!!values.json, packet, () => renderContextText(packet));
      return 0;
    }

    case "comment": {
      const { values, positionals } = args(rest, {
        target: { type: "string" },
        text: { type: "string" },
        kind: { type: "string" },
        region: { type: "string" },
      });
      const doc = load(ws, positionals[0]);
      const kind = (str(values, "kind") ?? "comment") as "comment" | "question" | "change-request";
      if (!["comment", "question", "change-request"].includes(kind))
        throw new UsageError("--kind must be comment, question or change-request");
      const id = addComment(ws, doc, {
        target: need(str(values, "target"), "--target"),
        text: need(str(values, "text"), "--text"),
        kind,
        author: localHuman(ws),
        region: parseRegion(str(values, "region")),
      });
      out(
        !!values.json,
        { id },
        () => `${id} saved to .htmi/annotations.jsonl (local; use \`htmi github post ${id}\` to share it)`,
      );
      return 0;
    }

    case "reply": {
      const { values, positionals } = args(rest, {
        text: { type: "string" },
        status: { type: "string" },
        revision: { type: "string" },
        agent: { type: "string" },
      });
      const status = str(values, "status");
      if (status && status !== "acknowledged" && status !== "addressed") {
        throw new UsageError("--status on a reply must be acknowledged or addressed; use `htmi status` for the rest");
      }
      const result = reply(ws, {
        thread: need(positionals[0], "comment id"),
        text: need(str(values, "text"), "--text"),
        author: author(ws, values),
        status: status as "acknowledged" | "addressed" | undefined,
        revision: str(values, "revision"),
      });
      out(!!values.json, result, () => `${result.replyId} saved${result.statusId ? `; thread marked ${status}` : ""}`);
      return 0;
    }

    case "status": {
      const { values, positionals } = args(rest, { note: { type: "string" }, agent: { type: "string" } });
      const id = setStatus(ws, {
        thread: need(positionals[0], "comment id"),
        discussion: need(positionals[1], "status"),
        author: author(ws, values),
        note: str(values, "note"),
      });
      out(!!values.json, { id }, () => `${positionals[0]} marked ${positionals[1]}`);
      return 0;
    }

    case "reattach": {
      const { values, positionals } = args(rest, { target: { type: "string" }, reason: { type: "string" } });
      const id = reattach(ws, {
        thread: need(positionals[0], "comment id"),
        target: need(str(values, "target"), "--target"),
        author: localHuman(ws),
        reason: str(values, "reason") ?? "reattached by the reviewer",
      });
      out(!!values.json, { id }, () => `${positionals[0]} now points at ${str(values, "target")}`);
      return 0;
    }

    case "evidence": {
      const split = rest.indexOf("--");
      if (split < 0)
        throw new UsageError("give the command after --, for example: htmi evidence --claim 'tests pass' -- npm test");
      const { values } = args(rest.slice(0, split), {
        comment: { type: "string" },
        claim: { type: "string" },
        agent: { type: "string" },
      });
      const revision = repoRevision(ws.root);
      const result = recordEvidence(ws, {
        thread: str(values, "comment"),
        claim: need(str(values, "claim"), "--claim"),
        command: rest.slice(split + 1),
        author: author(ws, values),
        revision,
      });
      out(
        !!values.json,
        result,
        () =>
          `${result.id}: ${result.result} (exit ${result.exitCode}) at ${revision}\n${result.outputTail.split("\n").slice(-8).join("\n")}`,
      );
      return result.exitCode === 0 ? 0 : 1;
    }

    case "apply": {
      const { values, positionals } = args(rest, {
        op: { type: "string" },
        "op-file": { type: "string" },
        "dry-run": { type: "boolean" },
      });
      const doc = load(ws, positionals[0]);
      const raw =
        str(values, "op") ??
        (str(values, "op-file") ? readFileSync(resolve(str(values, "op-file")!), "utf8") : undefined);
      let op: unknown;
      try {
        op = JSON.parse(need(raw, "--op or --op-file"));
      } catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError("the operation is not valid JSON");
      }
      const before = threadsFor(ws, doc);
      const result = runOperation(ws, doc, op, !!values["dry-run"]);
      if (!result.ok) {
        out(!!values.json, result, () => `Not applied (${result.reason}): ${result.message}`);
        return 3;
      }
      const after = result.written ? threadsFor(ws, load(ws, doc.path)) : before;
      const affected = affectedThreads(before, after);
      const { content: _content, ...summary } = result;
      void _content;
      out(!!values.json, { ...summary, affectedComments: affected }, () =>
        [
          `${result.written ? "Applied" : "Dry run"}: ${doc.path} ${result.beforeDigest.slice(7, 19)} -> ${result.afterDigest.slice(7, 19)}`,
          ...result.changedLines.map(
            (l) =>
              `  ${l.line}: ${l.before === undefined ? "" : `- ${l.before}`}${l.after !== undefined ? `${l.before !== undefined ? "\n  " + " ".repeat(String(l.line).length + 2) : ""}+ ${l.after}` : ""}`,
          ),
          ...result.targets.map((t) => `  target ${t.change}: ${t.key}`),
          ...affected.map((a) => `  comment ${a.id}: target ${a.from} -> ${a.to}`),
        ].join("\n"),
      );
      return 0;
    }

    case "validate": {
      const { values, positionals } = args(rest, {});
      const { docs, unavailable } = loadMany(ws, positionals);
      warnUnavailable(unavailable, "it is");
      const { problems } = new AnnotationStore(ws.root).read();
      const report = docs.map((doc) => ({
        path: doc.path,
        id: doc.documentId,
        diagnostics: doc.diagnostics,
        coverage: doc.coverage,
      }));
      const errors =
        report.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === "error").length, 0) + problems.length;
      out(!!values.json, { documents: report, annotationProblems: problems, errors }, () =>
        [
          ...report.flatMap((r) => [
            `${r.path} (${r.id})`,
            ...(r.diagnostics.length
              ? r.diagnostics.map(
                  (d) =>
                    `  ${d.severity.padEnd(7)} line ${d.line}${d.diagramId ? ` [${d.diagramId}]` : ""}: ${d.message}`,
                )
              : ["  ok"]),
            ...r.coverage.map((c) => `  note    ${c.what}: ${c.consequence}`),
          ]),
          ...problems.map((p) => `.htmi/annotations.jsonl line ${p.line}: ${p.error}`),
          errors ? `${errors} error(s)` : "No errors.",
        ].join("\n"),
      );
      return errors ? 3 : 0;
    }

    case "build": {
      const { values, positionals } = args(rest, {
        out: { type: "string" },
        rev: { type: "string" },
        "include-local": { type: "boolean" },
      });
      const doc = load(ws, positionals[0], str(values, "rev"));
      const all = resolveThreads(doc, new AnnotationStore(ws.root).threads());
      const threads = values["include-local"] ? all : all.filter((r) => isShared(r.thread));
      const html = buildReviewPage({
        doc,
        repoRoot: ws.root,
        threads,
        mode: "snapshot",
        builtAt: nowIso(),
        includesLocalComments: !!values["include-local"],
        version: VERSION,
      });
      const file = resolve(
        str(values, "out") ?? join(ws.root, ".htmi", "build", `${doc.documentId.replace(/[^\w.-]+/g, "_")}.html`),
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, html);
      out(
        !!values.json,
        { file, bytes: Buffer.byteLength(html), threads: threads.length, leftOut: all.length - threads.length },
        () =>
          `Wrote ${file} (${Math.round(Buffer.byteLength(html) / 1024)} KB, ${threads.length} comment(s)${all.length - threads.length ? `; ${all.length - threads.length} local comment(s) left out, add --include-local to include them` : ""})`,
      );
      return 0;
    }

    case "serve": {
      const { values } = args(rest, { port: { type: "string" }, "frame-ancestors": { type: "string" } });
      const { startServer } = await import("../server/serve.js");
      const server = await startServer({
        ws,
        port: str(values, "port") ? int(str(values, "port"), "--port") : 0,
        version: VERSION,
        frameAncestors: str(values, "frame-ancestors")?.split(/\s+/).filter(Boolean),
      });
      process.stdout.write(
        `HTMi review server for ${ws.root}\n${server.url}/\nOnly this computer can reach it. Press Ctrl+C to stop.\n`,
      );
      await new Promise<void>((resolveStop) => {
        const stop = () => server.close().then(resolveStop);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }

    case "github": {
      const [sub, ...subRest] = rest;
      if (sub === "publish") {
        const { values, positionals } = args(subRest, {
          issue: { type: "string" },
          repo: { type: "string" },
          "include-local": { type: "boolean" },
          new: { type: "boolean" },
        });
        const doc = load(ws, positionals[0]);
        const result = publishReview(ws, doc, {
          ...issueFor(ws, values, doc.host),
          includeLocal: !!values["include-local"],
          newSnapshot: !!values.new,
          version: VERSION,
        });
        out(
          !!values.json,
          result,
          () =>
            `${result.action === "created" ? "Created" : "Updated"} artifact #${result.number}: ${result.url}\n${Math.round(result.bytes / 1024)} KB, ${result.threads} comment(s)${result.localThreadsLeftOut ? `; ${result.localThreadsLeftOut} local comment(s) left out` : ""}`,
        );
        return 0;
      }
      if (sub === "pull") {
        const { values, positionals } = args(subRest, { issue: { type: "string" }, repo: { type: "string" } });
        const description = positionals[0] ? parseDescriptionRef(ws, positionals[0]) : null;
        if (positionals[0] && !description) throw new UsageError(`${positionals[0]} is not a description reference`);
        const result = pullFeedback(ws, issueFor(ws, values, description));
        out(!!values.json, result, () =>
          [
            `Imported ${result.imported.length} comment(s) and ${result.replies.length} repl${result.replies.length === 1 ? "y" : "ies"}; ${result.alreadyMirrored} already mirrored; ${result.plain} ordinary comment(s) without HTMi metadata.`,
            ...result.imported.map((id) => `  new ${id}`),
            ...result.editedOnHost.map((u) => `  edited on GitHub after import (local copy kept as first seen): ${u}`),
            ...result.invalid.map((i) => `  skipped ${i.url}: ${i.error}`),
          ].join("\n"),
        );
        return 0;
      }
      if (sub === "post") {
        const { values, positionals } = args(subRest, { issue: { type: "string" }, repo: { type: "string" } });
        const threadId = need(positionals[0], "comment id");
        const thread = new AnnotationStore(ws.root).thread(threadId);
        const description = thread ? parseDescriptionRef(ws, thread.target.documentPath) : null;
        const result = postThread(ws, threadId, issueFor(ws, values, description));
        out(
          !!values.json,
          result,
          () =>
            [
              ...result.posted.map((p) => `Posted ${p.eventId}: ${p.url}`),
              ...result.alreadyPublished.map((id) => `${id} was already on GitHub`),
            ].join("\n") || "Nothing to post.",
        );
        return 0;
      }
      throw new UsageError("use: htmi github publish|pull|post");
    }

    case "mcp": {
      const { runMcpServer } = await import("../mcp/server.js");
      await runMcpServer(ws, VERSION);
      return 0;
    }

    case "init": {
      const { values } = args(rest, {});
      mkdirSync(join(ws.root, ".htmi"), { recursive: true });
      const config = join(ws.root, ".htmi", "config.json");
      if (!existsSync(config)) writeFileSync(config, "{}\n");
      const attributes = join(ws.root, ".gitattributes");
      const line = ".htmi/annotations.jsonl merge=union";
      const current = existsSync(attributes) ? readFileSync(attributes, "utf8") : "";
      if (!current.split("\n").includes(line))
        appendFileSync(attributes, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
      out(
        !!values.json,
        { root: ws.root, config, attributes },
        () =>
          `Set up ${join(ws.root, ".htmi")}.\nComments are stored in .htmi/annotations.jsonl; .gitattributes now merges it line by line.\n\nAdd this to AGENTS.md or CLAUDE.md so your coding agent knows how to read feedback:\n\n${agentInstructions()}`,
      );
      return 0;
    }

    case "agents":
      process.stdout.write(`${agentInstructions()}\n`);
      return 0;

    default:
      throw new UsageError(`unknown command "${command}"; run htmi help`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`htmi: ${error.message}\nRun htmi help for usage.\n`);
      process.exitCode = 2;
      return;
    }
    const known = [ActionError, AnnotationError, ContextError, DocumentError, WorkspaceError, GitHubError];
    if (known.some((k) => error instanceof k)) {
      process.stderr.write(`htmi: ${(error as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`htmi: unexpected error\n${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);

/** `--region 0.1,0.2,0.3,0.4`: left, top, width and height as fractions of the image. */
function parseRegion(value: string | undefined): { x: number; y: number; w: number; h: number } | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new UsageError("--region needs four numbers from 0 to 1: left,top,width,height");
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

/** Where lines are, as a reader finds them: `docs/a.html:3-9`, or for a description, its body lines in words. */
function sourceLines(doc: DocModel, start: number, end: number): string {
  const offset = doc.host?.wrapper?.lineOffset ?? 0;
  const range = end !== start ? `${start + offset}-${end + offset}` : `${start + offset}`;
  return doc.host ? `${doc.path}, description line${end !== start ? "s" : ""} ${range}` : `${doc.path}:${range}`;
}
