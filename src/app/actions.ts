import { spawnSync } from "node:child_process";
import {
  AnnotationStore,
  DISCUSSION,
  nowIso,
  type Author,
  selectorProblem,
  type Discussion,
  type TargetRef,
  type Thread,
} from "../core/annotations.js";
import { buildContext, type ContextPacket } from "../core/context.js";
import type { DiagramModel, DocModel, Target } from "../core/document.js";
import { applyOperation, planOperation, type OperationConflict, type OperationResult } from "../core/operations.js";
import { resolveThreads, type ResolvedThread } from "../core/resolve.js";
import { gitIdentity } from "../core/revision.js";
import { readBlock, readSectionText, searchDocument, type BlockRead, type SearchHit } from "../core/reading.js";
import type { Workspace } from "../core/workspace.js";
import { writeDescription } from "../github/description.js";
import { openAll, openDocument, type Unavailable } from "./documents.js";

/**
 * Operations shared by the CLI and the MCP server, so both surfaces behave
 * the same way. Functions return data; formatting belongs to the caller.
 */

export class ActionError extends Error {}

export function docRef(doc: DocModel): string {
  return doc.idSource === "declared" ? doc.documentId : doc.path;
}

export interface DocumentSummary {
  id: string;
  idSource: string;
  path: string;
  /** Where a description lives on GitHub; files have none. */
  url?: string;
  title: string;
  revision: string;
  diagrams: number;
  targets: number;
  openThreads: number;
  needsAttention: number;
  errors: number;
}

/** Files discovery lists and descriptions with comments here; descriptions that cannot be read now are listed apart. */
export function listDocuments(ws: Workspace): { documents: DocumentSummary[]; unavailable: Unavailable[] } {
  const threads = new AnnotationStore(ws.root).threads();
  const { docs, unavailable } = openAll(ws);
  const documents = docs.map((doc) => {
    const resolved = resolveThreads(doc, threads);
    const open = resolved.filter((r) => r.thread.discussion !== "resolved" && r.thread.discussion !== "wontfix");
    return {
      id: doc.documentId,
      idSource: doc.idSource,
      path: doc.path,
      url: doc.host?.url,
      title: doc.title,
      revision: doc.revision.label,
      diagrams: doc.diagrams.length,
      targets: doc.targets.size,
      openThreads: open.length,
      needsAttention: open.filter((r) => r.resolution.status !== "exact").length,
      errors: doc.diagnostics.filter((d) => d.severity === "error").length,
    };
  });
  return { documents, unavailable };
}

export type TargetArg = { type: "target"; target: Target } | { type: "diagram"; diagram: DiagramModel };

/** Accepts `diagram/id`, a bare id that is unique in the document, or a diagram id. */
export function findTarget(doc: DocModel, arg: string): TargetArg {
  const direct = doc.targets.get(arg);
  if (direct) return { type: "target", target: direct };
  const diagram = doc.diagrams.find((d) => d.id === arg);
  if (diagram) return { type: "diagram", diagram };
  const matches = [...doc.targets.values()].filter((t) => t.id === arg || t.id === `n.${arg}` || t.id === `g.${arg}`);
  if (matches.length === 1) return { type: "target", target: matches[0]! };
  if (matches.length > 1) {
    throw new ActionError(
      `"${arg}" exists in several diagrams: ${matches.map((m) => m.key).join(", ")}; use the full key`,
    );
  }
  throw new ActionError(`no target "${arg}" in ${doc.path}; run \`htmi targets ${docRef(doc)}\``);
}

export function refFor(doc: DocModel, found: TargetArg): TargetRef {
  if (found.type === "diagram") {
    return {
      documentId: doc.documentId,
      documentPath: doc.path,
      kind: "diagram",
      targetId: found.diagram.id,
      label: `Diagram ${found.diagram.id}`,
    };
  }
  const t = found.target;
  return {
    documentId: doc.documentId,
    documentPath: doc.path,
    kind: t.kind,
    diagramId: t.diagramId,
    targetId: t.id,
    label: t.label,
    from: t.from,
    to: t.to,
    tag: t.block?.tag,
  };
}

export function listTargets(doc: DocModel, diagramId?: string): Target[] {
  if (diagramId && !doc.diagrams.some((d) => d.id === diagramId))
    throw new ActionError(`no diagram "${diagramId}" in ${doc.path}`);
  return [...doc.targets.values()].filter((t) => !diagramId || t.diagramId === diagramId);
}

export function readSection(
  doc: DocModel,
  sectionId: string,
): { title: string; text: string; lines: { start: number; end: number } } {
  const read = readSectionText(doc, sectionId);
  if (!read) throw new ActionError(`no section "${sectionId}"; sections: ${doc.sections.map((s) => s.id).join(", ")}`);
  return { title: read.title, text: read.text, lines: read.lines };
}

/** One block or target with its exact content; `source` adds the HTML it spans. */
export function readTarget(doc: DocModel, key: string, source = false): BlockRead {
  const read = readBlock(doc, key, { source });
  if (!read)
    throw new ActionError(`no target "${key}" in ${doc.path}; run \`htmi read ${docRef(doc)}\` for the outline`);
  return read;
}

export function search(doc: DocModel, query: string, limit?: number): SearchHit[] {
  if (!query.trim()) throw new ActionError("give text to search for");
  return searchDocument(doc, query, limit);
}

export function threadsFor(ws: Workspace, doc: DocModel): ResolvedThread[] {
  return resolveThreads(doc, new AnnotationStore(ws.root).threads());
}

export function filterThreads(threads: ResolvedThread[], status: "open" | "attention" | "all"): ResolvedThread[] {
  const open = (r: ResolvedThread) => r.thread.discussion !== "resolved" && r.thread.discussion !== "wontfix";
  if (status === "open") return threads.filter(open);
  if (status === "attention") return threads.filter((r) => open(r) && r.resolution.status !== "exact");
  return threads;
}

export function contextFor(
  ws: Workspace,
  doc: DocModel,
  options: { target?: string; comment?: string; budget?: number },
): ContextPacket {
  const threads = threadsFor(ws, doc);
  if (options.comment)
    return buildContext({ doc, threads, threadId: options.comment, budget: options.budget, docRef: docRef(doc) });
  if (!options.target) throw new ActionError("give --target or --comment");
  const found = findTarget(doc, options.target);
  const key = found.type === "target" ? found.target.key : found.diagram.id;
  return buildContext({ doc, threads, targetKey: key, budget: options.budget, docRef: docRef(doc) });
}

/** The thread's document, located by the path recorded on the comment. */
export function documentOfThread(ws: Workspace, thread: Thread): DocModel {
  try {
    return openDocument(ws, thread.target.documentId);
  } catch {
    return openDocument(ws, thread.target.documentPath);
  }
}

export function localHuman(ws: Workspace, source: Author["source"] = "cli"): Author {
  const id = gitIdentity(ws.root);
  return { name: id?.name ?? "local user", kind: "human", source, verified: false };
}

export function agentAuthor(name: string, source: Author["source"]): Author {
  return { name: name || "agent", kind: "agent", source, verified: false };
}

export function addComment(
  ws: Workspace,
  doc: DocModel,
  options: {
    target: string;
    text: string;
    kind: "comment" | "question" | "change-request";
    author: Author;
    /** A rectangle on an image target, as fractions of its width and height. */
    region?: { x: number; y: number; w: number; h: number };
  },
): string {
  if (doc.revision.state === "commit")
    throw new ActionError("comments are written against the working tree, not a past revision");
  const found = findTarget(doc, options.target);
  const target = refFor(doc, found);
  if (options.region) {
    target.selector = { type: "ImageRegionSelector", ...options.region };
    const problem = selectorProblem(target);
    if (problem) throw new ActionError(problem);
  }
  const store = new AnnotationStore(ws.root);
  const id = store.freshId("C");
  const targetDigest = found.type === "target" ? found.target.digest : found.diagram.digest;
  store.append({
    type: "comment",
    schemaVersion: 1,
    id,
    at: nowIso(),
    author: options.author,
    target,
    observed: { revision: doc.revision.label, commit: doc.revision.commit, documentDigest: doc.digest, targetDigest },
    body: { kind: options.kind, text: options.text },
    visibility: "local",
  });
  return id;
}

export function reply(
  ws: Workspace,
  options: { thread: string; text: string; author: Author; status?: "acknowledged" | "addressed"; revision?: string },
): { replyId: string; statusId?: string } {
  const store = new AnnotationStore(ws.root);
  if (!store.thread(options.thread)) throw new ActionError(`no comment ${options.thread}`);
  const at = nowIso();
  const replyId = store.freshId("R");
  store.append({
    type: "reply",
    id: replyId,
    threadId: options.thread,
    at,
    author: options.author,
    body: { text: options.text },
    revision: options.revision,
  });
  let statusId: string | undefined;
  if (options.status) {
    statusId = store.freshId("S");
    store.append({
      type: "status",
      id: statusId,
      threadId: options.thread,
      at,
      author: options.author,
      discussion: options.status,
      revision: options.revision,
    });
  }
  return { replyId, statusId };
}

export function setStatus(
  ws: Workspace,
  options: { thread: string; discussion: string; author: Author; note?: string },
): string {
  if (!(DISCUSSION as readonly string[]).includes(options.discussion)) {
    throw new ActionError(`status must be one of ${DISCUSSION.join(", ")}`);
  }
  const store = new AnnotationStore(ws.root);
  if (!store.thread(options.thread)) throw new ActionError(`no comment ${options.thread}`);
  const id = store.freshId("S");
  store.append({
    type: "status",
    id,
    threadId: options.thread,
    at: nowIso(),
    author: options.author,
    discussion: options.discussion as Discussion,
    note: options.note,
  });
  return id;
}

export function reattach(
  ws: Workspace,
  options: { thread: string; target: string; author: Author; reason: string },
): string {
  const store = new AnnotationStore(ws.root);
  const thread = store.thread(options.thread);
  if (!thread) throw new ActionError(`no comment ${options.thread}`);
  const doc = documentOfThread(ws, thread);
  const found = findTarget(doc, options.target);
  const id = store.freshId("A");
  store.append({
    type: "reattach",
    id,
    threadId: thread.id,
    at: nowIso(),
    author: options.author,
    target: refFor(doc, found),
    observed: {
      revision: doc.revision.label,
      commit: doc.revision.commit,
      documentDigest: doc.digest,
      targetDigest: found.type === "target" ? found.target.digest : found.diagram.digest,
    },
    reason: options.reason,
  });
  return id;
}

/** Plan an operation and, unless `dryRun`, write it: to the file, or to the description on GitHub. */
export function runOperation(
  ws: Workspace,
  doc: DocModel,
  operation: unknown,
  dryRun: boolean,
): OperationResult | OperationConflict {
  if (dryRun) return planOperation(doc, ws.root, operation);
  if (!doc.host) return applyOperation(doc, ws.root, operation);
  const planned = planOperation(doc, ws.root, operation);
  return planned.ok ? writeDescription(doc, planned) : planned;
}

/** Threads whose target resolution differs after an edit, to report what an operation did to open comments. */
export function affectedThreads(
  before: ResolvedThread[],
  after: ResolvedThread[],
): { id: string; from: string; to: string }[] {
  const was = new Map(before.map((r) => [r.thread.id, r.resolution.status]));
  return after
    .filter((r) => was.get(r.thread.id) !== r.resolution.status)
    .map((r) => ({ id: r.thread.id, from: was.get(r.thread.id) ?? "none", to: r.resolution.status }));
}

export interface EvidenceResult {
  id: string;
  exitCode: number;
  result: "pass" | "fail";
  outputTail: string;
}

/** Run a command and record its outcome. The record says what ran and at which revision; it is not a verdict on the claim. */
export function recordEvidence(
  ws: Workspace,
  options: { thread?: string; claim: string; command: string[]; author: Author; revision: string },
): EvidenceResult {
  const store = new AnnotationStore(ws.root);
  if (options.thread && !store.thread(options.thread)) throw new ActionError(`no comment ${options.thread}`);
  const [bin, ...args] = options.command;
  if (!bin) throw new ActionError("give the command to run after --");
  const run = spawnSync(bin, args, { cwd: ws.root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const exitCode = run.error ? 127 : (run.status ?? 1);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error.message) : ""}`;
  const outputTail = output.slice(-4000);
  const id = store.freshId("E");
  store.append({
    type: "evidence",
    id,
    threadId: options.thread,
    at: nowIso(),
    author: options.author,
    claim: options.claim,
    command: options.command.join(" "),
    exitCode,
    result: exitCode === 0 ? "pass" : "fail",
    revision: options.revision,
    outputTail,
  });
  return { id, exitCode, result: exitCode === 0 ? "pass" : "fail", outputTail };
}
