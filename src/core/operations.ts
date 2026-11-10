import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { digestOf } from "./digest.js";
import { targetKey, type DiagramModel, type DocModel, type Target } from "./document.js";
import {
  applyEdits,
  editableDependency,
  EditConflict,
  fileDigest,
  planHtmlEdit,
  rebuildHtml,
  verifyHtmlEdit,
  type SourceEdit,
} from "./html-edit.js";
import { buildAnyModel } from "./load.js";
import {
  ID_PATTERN,
  formatLabel,
  parseMermaid,
  statementsWithOffsets,
  type MermaidParse,
  type Shape,
} from "./mermaid.js";
import { occurrences } from "./text.js";

/**
 * Targeted changes to documents. Markdown documents with Mermaid diagrams get
 * diagram operations and replace-text; HTML documents get source-span edits
 * (replace-text, set-text, set-attribute, replace-source) and replace-in-file
 * for a stylesheet, script or data file they use. Every operation states the
 * digests it expects, edits only what it must, and is checked after the edit:
 * the document is parsed again and every target the operation did not mean
 * to touch must be unchanged. A failed precondition or check returns a
 * conflict and writes nothing.
 */

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const TargetId = z.string().regex(/^[A-Za-z][\w.-]*$/);
const NodeId = z.string().regex(new RegExp(`^${ID_PATTERN}$`));
const Value = z.string().max(500);
const SHAPE_NAMES = [
  "rect",
  "round",
  "stadium",
  "subroutine",
  "cylinder",
  "circle",
  "rhombus",
  "hexagon",
  "parallelogram",
  "parallelogram-alt",
  "asymmetric",
] as const;

const common = { expectedDocumentDigest: Digest };
/** A target key as `htmi targets` prints it: `#id`, `b.section.table1`, `diagram/n.id`. */
const TargetKey = z.string().min(1).max(250);

export const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set-node-label"),
    ...common,
    diagramId: TargetId,
    nodeId: TargetId,
    expectedTargetDigest: Digest,
    value: Value.min(1),
  }),
  z.object({
    op: z.literal("set-edge-label"),
    ...common,
    diagramId: TargetId,
    edgeId: TargetId,
    expectedTargetDigest: Digest,
    /** An empty value removes the label. */
    value: Value,
  }),
  z.object({
    op: z.literal("add-node"),
    ...common,
    diagramId: TargetId,
    nodeId: NodeId,
    label: Value.min(1),
    shape: z.enum(SHAPE_NAMES).default("rect"),
    /** Subgraph to place the node in, as `g.<id>`. */
    groupId: TargetId.optional(),
  }),
  z.object({
    op: z.literal("add-edge"),
    ...common,
    diagramId: TargetId,
    /** New edges always get a declared id, so comments on them can never move. */
    edgeId: TargetId,
    from: TargetId,
    to: TargetId,
    label: Value.optional(),
  }),
  z.object({
    op: z.literal("remove-edge"),
    ...common,
    diagramId: TargetId,
    edgeId: TargetId,
    expectedTargetDigest: Digest,
  }),
  z.object({
    op: z.literal("set-description"),
    ...common,
    diagramId: TargetId,
    targetId: TargetId,
    expectedTargetDigest: Digest,
    /** An empty value removes the description. */
    value: Value,
  }),
  z.object({
    op: z.literal("replace-text"),
    ...common,
    sectionId: z.string().min(1).max(200),
    /** Markdown: exact source text. HTML: visible text (whitespace flexible). It must occur once in the section. */
    find: z.string().min(1).max(5000),
    replace: z.string().max(5000),
  }),
  z.object({
    op: z.literal("set-text"),
    ...common,
    target: TargetKey,
    expectedTargetDigest: Digest,
    /** Visible text inside the target, whitespace flexible; it must occur once, inside one text run. */
    find: z.string().min(1).max(5000),
    /** Plain text; it is escaped for HTML. */
    replace: z.string().max(5000),
  }),
  z.object({
    op: z.literal("set-attribute"),
    ...common,
    target: TargetKey,
    expectedTargetDigest: Digest,
    name: z.string().min(1).max(80),
    value: z.string().max(5000),
  }),
  z.object({
    op: z.literal("replace-source"),
    ...common,
    target: TargetKey,
    expectedTargetDigest: Digest,
    /** Exact source text inside the target's source range; it must occur once there. */
    find: z.string().min(1).max(20_000),
    /** Raw HTML, inserted as written. */
    replace: z.string().max(50_000),
  }),
  z.object({
    op: z.literal("replace-in-file"),
    ...common,
    /** A stylesheet, script, SVG or data file the document uses or that sits in its folder. */
    path: z.string().min(1).max(500),
    expectedFileDigest: Digest,
    find: z.string().min(1).max(20_000),
    replace: z.string().max(50_000),
  }),
]);
export type Operation = z.infer<typeof OperationSchema>;
export type OperationInput = z.input<typeof OperationSchema>;

export interface TargetChange {
  key: string;
  /** moved: a derived (positional) key whose unchanged content now has the key in `to`. */
  change: "added" | "removed" | "changed" | "moved";
  to?: string;
}

export interface OperationResult {
  ok: true;
  /** The file that changes: the document, or a file it uses (replace-in-file). */
  path: string;
  beforeDigest: string;
  afterDigest: string;
  content: string;
  /** The change as replacements of ranges in the old text (UTF-16 offsets), for editors. */
  edits: SourceEdit[];
  changedLines: { line: number; before?: string; after?: string }[];
  targets: TargetChange[];
  written: boolean;
}

export interface OperationConflict {
  ok: false;
  reason: "stale-document" | "stale-target" | "not-found" | "unsupported" | "invalid" | "check-failed";
  message: string;
  current?: { documentDigest: string; target?: Pick<Target, "key" | "label" | "digest"> };
}

export function parseOperation(input: unknown): Operation | OperationConflict {
  const parsed = OperationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  return {
    ok: false,
    reason: "invalid",
    message: parsed.error.issues.map((i) => `${i.path.join(".") || "operation"}: ${i.message}`).join("; "),
  };
}

class Conflict extends Error {
  constructor(readonly conflict: OperationConflict) {
    super(conflict.message);
  }
}

function fail(reason: OperationConflict["reason"], message: string, current?: OperationConflict["current"]): never {
  throw new Conflict({ ok: false, reason, message, current });
}

/** Compute the edit without writing it. */
export function planOperation(doc: DocModel, repoRoot: string, input: unknown): OperationResult | OperationConflict {
  const op = parseOperation(input);
  if ("ok" in op) return op;
  try {
    if (op.op === "replace-in-file") return planFileEdit(doc, repoRoot, op);
    return doc.format === "html" ? planHtml(doc, repoRoot, op) : plan(doc, repoRoot, op);
  } catch (error) {
    if (error instanceof Conflict) return error.conflict;
    if (error instanceof EditConflict) {
      return {
        ok: false,
        reason: error.reason,
        message: error.message,
        current: { documentDigest: doc.digest, target: error.target },
      };
    }
    throw error;
  }
}

/**
 * Plan, then write atomically. The file is re-read immediately before the
 * write and the write is abandoned if its content moved on. This narrows the
 * race with other writers; it cannot remove it for writers that do not take
 * part in this check.
 */
export function applyOperation(doc: DocModel, repoRoot: string, input: unknown): OperationResult | OperationConflict {
  const result = planOperation(doc, repoRoot, input);
  if (!result.ok) return result;
  if (doc.revision.state === "commit") {
    return { ok: false, reason: "unsupported", message: "cannot write to a document loaded from a past commit" };
  }
  if (doc.host) {
    return {
      ok: false,
      reason: "unsupported",
      message: `${doc.path} is a description on GitHub, not a file; it is written through the GitHub adapter`,
    };
  }
  const file = join(repoRoot, result.path);
  const onDisk = digestOf(readFileSync(file, "utf8"));
  if (onDisk !== result.beforeDigest) {
    return {
      ok: false,
      reason: "stale-document",
      message: "the file changed on disk while the edit was prepared; reload and try again",
      current: { documentDigest: onDisk },
    };
  }
  const temp = `${file}.htmi-${process.pid}.tmp`;
  writeFileSync(temp, result.content, "utf8");
  renameSync(temp, file);
  return { ...result, written: true };
}

const HTML_OPS = new Set(["replace-text", "set-text", "set-attribute", "replace-source"]);

function planHtml(doc: DocModel, repoRoot: string, op: Operation): OperationResult {
  if (!HTML_OPS.has(op.op)) {
    fail(
      "unsupported",
      `${op.op} is a Mermaid diagram operation; in HTML use set-text, set-attribute or replace-source on the element`,
    );
  }
  if (op.expectedDocumentDigest !== doc.digest) {
    fail("stale-document", "the document changed since the operation was prepared", { documentDigest: doc.digest });
  }
  const planned = planHtmlEdit(doc, repoRoot, op as Parameters<typeof planHtmlEdit>[2]);
  const content = applyEdits(doc.content, planned.edits);
  const after = rebuildHtml(doc, repoRoot, content);
  const { changes, problems } = verifyHtmlEdit(doc, after, planned.edits, planned.named);
  const readBack = planned.check?.(after);
  if (readBack) problems.push(readBack);
  if (content === doc.content) problems.push("the edit changes nothing");
  if (problems.length)
    fail("check-failed", `the edit was not applied because it would have side effects: ${problems.join("; ")}`);
  return {
    ok: true,
    path: doc.path,
    beforeDigest: doc.digest,
    afterDigest: digestOf(content),
    content,
    edits: planned.edits,
    changedLines: changedLineRange(doc.content, content),
    targets: changes,
    written: false,
  };
}

function planFileEdit(
  doc: DocModel,
  repoRoot: string,
  op: Extract<Operation, { op: "replace-in-file" }>,
): OperationResult {
  if (doc.format !== "html") fail("unsupported", "replace-in-file edits files that an HTML document uses");
  if (op.expectedDocumentDigest !== doc.digest) {
    fail("stale-document", "the document changed since the operation was prepared", { documentDigest: doc.digest });
  }
  let path: string;
  try {
    path = editableDependency(doc, repoRoot, op.path);
  } catch (error) {
    if (error instanceof EditConflict) fail(error.reason, error.message);
    throw error;
  }
  const before = readFileSync(join(repoRoot, path), "utf8");
  const digest = fileDigest(repoRoot, path);
  if (digest !== op.expectedFileDigest) {
    fail("stale-document", `${path} changed since the operation was prepared`, { documentDigest: doc.digest });
  }
  const hits = occurrences(before, op.find);
  if (hits.length === 0) fail("not-found", `the text was not found in ${path}`);
  if (hits.length > 1) fail("invalid", `the text appears ${hits.length} times in ${path}; include more of it`);
  const edit = { start: hits[0]!, end: hits[0]! + op.find.length, text: op.replace };
  const content = applyEdits(before, [edit]);
  // Images drawn from this file change with it; nothing else in the document can.
  const targets: TargetChange[] = [...doc.targets.values()]
    .filter((t) => t.asset?.path === path)
    .map((t) => ({ key: t.key, change: "changed" as const }));
  return {
    ok: true,
    path,
    beforeDigest: digest,
    afterDigest: digestOf(content),
    content,
    edits: [edit],
    changedLines: changedLineRange(before, content),
    targets,
    written: false,
  };
}

function plan(doc: DocModel, repoRoot: string, op: Operation): OperationResult {
  if (op.op === "set-text" || op.op === "set-attribute" || op.op === "replace-source" || op.op === "replace-in-file") {
    fail("unsupported", `${op.op} applies to HTML documents; in Markdown use replace-text or a diagram operation`);
  }
  if (op.expectedDocumentDigest !== doc.digest) {
    fail("stale-document", "the document changed since the operation was prepared", { documentDigest: doc.digest });
  }
  const lines = [...doc.lines];
  const trailingNewline = doc.content.endsWith("\n");
  let allowed: { changed: string[]; added: string[]; removed: string[] };

  if (op.op === "replace-text") {
    allowed = replaceText(doc, lines, op);
  } else {
    const diagram = doc.diagrams.find((d) => d.id === op.diagramId);
    if (!diagram) fail("not-found", `no diagram "${op.diagramId}"`);
    if (!diagram.supported) fail("unsupported", `diagram "${diagram.id}" is not a supported flowchart`);
    const body = doc.lines
      .slice(diagram.lines.start, diagram.lines.end - 1)
      .map((text, i) => ({ line: diagram.lines.start + 1 + i, text }));
    const parse = parseMermaid(body);
    const ctx: DiagramContext = { doc, diagram, parse, lines };
    switch (op.op) {
      case "set-node-label":
        allowed = setNodeLabel(ctx, op);
        break;
      case "set-edge-label":
        allowed = setEdgeLabel(ctx, op);
        break;
      case "add-node":
        allowed = addNode(ctx, op);
        break;
      case "add-edge":
        allowed = addEdge(ctx, op);
        break;
      case "remove-edge":
        allowed = removeEdge(ctx, op);
        break;
      case "set-description":
        allowed = setDescription(ctx, op);
        break;
    }
  }

  const planned = lines.filter((l): l is string => l !== REMOVED).join("\n") + (trailingNewline ? "\n" : "");
  const { content, edit: change } = onOriginal(doc.content, planned);
  const after = buildAnyModel(content, doc.path, repoRoot, doc.revision);
  const targets = verify(doc, after, allowed, op);
  return {
    ok: true,
    path: doc.path,
    beforeDigest: doc.digest,
    afterDigest: digestOf(content),
    content,
    edits: [change],
    changedLines: diffLines(doc.lines, lines),
    targets,
    written: false,
  };
}

/** The smallest single replacement that turns `before` into `after`. */
function singleEdit(before: string, after: string): SourceEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return { start, end: before.length - end, text: after.slice(start, after.length - end) };
}

/**
 * Markdown is planned on text whose line breaks were read as LF. Carry the
 * change back into the original as one replacement, writing new line breaks
 * the way most of the file does, so every byte outside the change is kept.
 */
function onOriginal(original: string, planned: string): { content: string; edit: SourceEdit } {
  const change = singleEdit(original.replace(/\r\n?/g, "\n"), planned);
  const toOriginal = (offset: number): number => {
    let i = 0;
    for (let n = 0; n < offset; n++) i += original[i] === "\r" && original[i + 1] === "\n" ? 2 : 1;
    return i;
  };
  const crlf = original.split("\r\n").length - 1;
  const eol = crlf > original.split("\n").length - 1 - crlf ? "\r\n" : "\n";
  const start = toOriginal(change.start);
  const end = toOriginal(change.end);
  const text = change.text.replace(/\n/g, eol);
  return { content: original.slice(0, start) + text + original.slice(end), edit: { start, end, text } };
}

/** Marker for a deleted line, so that line numbers stay aligned until the end. */
const REMOVED = "\u0000removed";

interface DiagramContext {
  doc: DocModel;
  diagram: DiagramModel;
  parse: MermaidParse;
  lines: (string | typeof REMOVED)[];
}

function requireTarget(ctx: DiagramContext, id: string, kind: Target["kind"], expected: string): Target {
  const key = targetKey(ctx.diagram.id, id);
  if (ctx.diagram.ambiguousIds.includes(id))
    fail("unsupported", `"${id}" is claimed by more than one element; fix the duplicate first`);
  const target = ctx.doc.targets.get(key);
  if (!target || target.kind !== kind) fail("not-found", `no ${kind} "${id}" in diagram "${ctx.diagram.id}"`);
  if (target.digest !== expected) {
    fail("stale-target", `${kind} "${id}" changed since the operation was prepared`, {
      documentDigest: ctx.doc.digest,
      target: { key: target.key, label: target.label, digest: target.digest },
    });
  }
  return target;
}

function edit(ctx: DiagramContext, line: number, start: number, end: number, text: string): void {
  const current = ctx.lines[line - 1]!;
  ctx.lines[line - 1] = current.slice(0, start) + text + current.slice(end);
}

function indentOf(ctx: DiagramContext): string {
  const statement = ctx.doc.lines
    .slice(ctx.diagram.lines.start, ctx.diagram.lines.end - 1)
    .find((l) => /^\s+\S/.test(l) && !/^\s*%%/.test(l));
  return statement ? statement.match(/^\s+/)![0] : "  ";
}

/** Insert lines just before the closing fence of the diagram. */
function insertAtEnd(ctx: DiagramContext, newLines: string[]): void {
  const closing = ctx.diagram.lines.end;
  const at = closing - 1;
  const previous = ctx.lines[at - 1] ?? "";
  ctx.lines[at - 1] = [previous, ...newLines].join("\n");
}

function setNodeLabel(ctx: DiagramContext, op: Extract<Operation, { op: "set-node-label" }>) {
  const id = op.nodeId.replace(/^n\./, "");
  requireTarget(ctx, `n.${id}`, "node", op.expectedTargetDigest);
  const node = ctx.parse.nodes.get(id)!;
  const label = formatLabel(op.value);
  if (node.definitions.length === 0) {
    const first = node.occurrences[0]!;
    edit(ctx, first.line, first.idStart, first.idEnd, `${id}[${label}]`);
  } else {
    // Later spans first so earlier offsets on the same line stay valid.
    for (const def of [...node.definitions].reverse()) {
      if (def.labelStart === undefined || def.labelEnd === undefined) continue;
      edit(ctx, def.line, def.labelStart, def.labelEnd, label);
    }
  }
  return { changed: [`n.${id}`], added: [], removed: [] };
}

const HEAD_CHARS: Record<string, string> = { arrow: ">", circle: "o", cross: "x", none: "" };
const TAIL_CHARS: Record<string, string> = { arrow: "<", circle: "o", cross: "x", none: "" };
/** Link bodies without a head, so that `-->` and `---` both come out right. */
const BODIES: Record<string, { headed: string; open: string }> = {
  solid: { headed: "--", open: "---" },
  dotted: { headed: "-.-", open: "-.-" },
  thick: { headed: "==", open: "===" },
};

/** Canonical Mermaid link text with an optional pipe label. */
function linkText(style: string, head: string, tail: string, label: string): string {
  const body = BODIES[style]!;
  const arrow = `${TAIL_CHARS[tail]}${head === "none" ? body.open : body.headed}${HEAD_CHARS[head]}`;
  return label ? `${arrow}|${label.replace(/\|/g, "#124;")}|` : arrow;
}

function findEdge(ctx: DiagramContext, edgeId: string) {
  const target = ctx.doc.targets.get(targetKey(ctx.diagram.id, edgeId))!;
  const edge = ctx.parse.edges.find(
    (e) =>
      (e.declaredId ?? null) === (target.idSource === "declared" ? edgeId : null) &&
      `n.${e.from}` === target.from &&
      `n.${e.to}` === target.to &&
      e.line === target.lines.end,
  );
  if (!edge) fail("not-found", `could not locate edge "${edgeId}" in the source`);
  return { target, edge };
}

function setEdgeLabel(ctx: DiagramContext, op: Extract<Operation, { op: "set-edge-label" }>) {
  requireTarget(ctx, op.edgeId, "edge", op.expectedTargetDigest);
  const { edge } = findEdge(ctx, op.edgeId);
  if (edge.linkEdgeCount > 1)
    fail("unsupported", `edge "${op.edgeId}" shares its arrow with other edges (&); edit it by hand`);
  edit(
    ctx,
    edge.line,
    edge.linkSpan.start,
    edge.linkSpan.end,
    linkText(edge.style, edge.head, edge.tail, op.value.trim()),
  );
  return { changed: [op.edgeId], added: [], removed: [] };
}

const SHAPE_DELIMS: Record<Shape, [string, string]> = {
  rect: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
  circle: ["((", "))"],
  rhombus: ["{", "}"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
  "parallelogram-alt": ["[\\", "\\]"],
  asymmetric: [">", "]"],
};

function addNode(ctx: DiagramContext, op: Extract<Operation, { op: "add-node" }>) {
  if (ctx.parse.nodes.has(op.nodeId)) fail("invalid", `node "${op.nodeId}" already exists`);
  const [open, close] = SHAPE_DELIMS[op.shape];
  const statement = `${op.nodeId}${open}${formatLabel(op.label)}${close}`;
  if (op.groupId) {
    const group = ctx.parse.groups.get(op.groupId.replace(/^g\./, ""));
    if (!group) fail("not-found", `no group "${op.groupId}" in diagram "${ctx.diagram.id}"`);
    const endLine = ctx.doc.lines[group.endLine - 1]!;
    const indent = `${endLine.match(/^\s*/)![0]}  `;
    ctx.lines[group.endLine - 1] = `${indent}${statement}\n${ctx.lines[group.endLine - 1]}`;
    return { changed: [`g.${group.id}`], added: [`n.${op.nodeId}`], removed: [] };
  }
  insertAtEnd(ctx, [`${indentOf(ctx)}${statement}`]);
  return { changed: [], added: [`n.${op.nodeId}`], removed: [] };
}

function addEdge(ctx: DiagramContext, op: Extract<Operation, { op: "add-edge" }>) {
  if (/^(n|g)\./.test(op.edgeId) || /^e\./.test(op.edgeId)) {
    fail("invalid", `edge id "${op.edgeId}" uses a reserved prefix; choose an id such as r.parser-to-resolver`);
  }
  if (ctx.doc.targets.has(targetKey(ctx.diagram.id, op.edgeId)) || ctx.diagram.ambiguousIds.includes(op.edgeId)) {
    fail("invalid", `id "${op.edgeId}" is already used in diagram "${ctx.diagram.id}"`);
  }
  const from = op.from.replace(/^n\./, "");
  const to = op.to.replace(/^n\./, "");
  for (const id of [from, to]) if (!ctx.parse.nodes.has(id)) fail("not-found", `no node "${id}"; add it first`);
  const indent = indentOf(ctx);
  insertAtEnd(ctx, [
    `${indent}%% htmi:edge ${op.edgeId}`,
    `${indent}${from} ${linkText("solid", "arrow", "none", op.label?.trim() ?? "")} ${to}`,
  ]);
  return { changed: [], added: [op.edgeId], removed: [] };
}

function removeEdge(ctx: DiagramContext, op: Extract<Operation, { op: "remove-edge" }>) {
  requireTarget(ctx, op.edgeId, "edge", op.expectedTargetDigest);
  const { edge } = findEdge(ctx, op.edgeId);
  const statementCount = statementsWithOffsets(ctx.doc.lines[edge.line - 1]!.trim()).length;
  if (edge.statementEdgeCount > 1 || statementCount > 1) {
    fail("unsupported", `edge "${op.edgeId}" shares its line with other statements; edit it by hand`);
  }
  // Removing the line must not remove a node that is only mentioned there.
  const onlyHere = [edge.from, edge.to].filter((id) => ctx.parse.nodes.get(id)!.lines.every((l) => l === edge.line));
  if (onlyHere.length)
    fail("unsupported", `removing the line would also remove node ${onlyHere.join(", ")}; edit it by hand`);
  // A node whose label is written only on this line keeps it by moving the label to its next mention.
  const raw = ctx.doc.lines[edge.line - 1]!;
  for (const id of new Set([edge.from, edge.to])) {
    const node = ctx.parse.nodes.get(id)!;
    const definition = node.definitions.find((d) => d.line === edge.line);
    if (!definition || node.definitions.some((d) => d.line !== edge.line)) continue;
    const next = node.occurrences.find((o) => o.line !== edge.line)!;
    edit(ctx, next.line, next.idStart, next.idEnd, raw.slice(definition.idStart, definition.end));
  }
  ctx.lines[edge.line - 1] = REMOVED;
  if (edge.directiveLine) ctx.lines[edge.directiveLine - 1] = REMOVED;
  for (const directive of ctx.parse.directives) {
    if (
      (directive.name === "describe" || directive.name === "source" || directive.name === "icon") &&
      directive.args[0] === op.edgeId
    ) {
      ctx.lines[directive.line - 1] = REMOVED;
    }
  }
  return { changed: [], added: [], removed: [op.edgeId] };
}

function setDescription(ctx: DiagramContext, op: Extract<Operation, { op: "set-description" }>) {
  const target = ctx.doc.targets.get(targetKey(ctx.diagram.id, op.targetId));
  if (!target) fail("not-found", `no target "${op.targetId}" in diagram "${ctx.diagram.id}"`);
  requireTarget(ctx, target.id, target.kind, op.expectedTargetDigest);
  const bare = target.id.replace(/^(n|g)\./, "");
  const existing = ctx.parse.directives.filter(
    (d) => d.name === "describe" && (d.args[0] === target.id || d.args[0] === bare),
  );
  const value = op.value.replace(/\s+/g, " ").trim();
  if (existing.length > 1)
    fail("unsupported", `"${target.id}" has ${existing.length} describe directives; keep one by hand first`);
  if (existing.length === 1) {
    const line = existing[0]!.line;
    const indent = ctx.doc.lines[line - 1]!.match(/^\s*/)![0];
    ctx.lines[line - 1] = value ? `${indent}%% htmi:describe ${existing[0]!.args[0]} ${value}` : REMOVED;
  } else if (value) {
    insertAtEnd(ctx, [`${indentOf(ctx)}%% htmi:describe ${target.id} ${value}`]);
  }
  return { changed: [target.id], added: [], removed: [] };
}

function replaceText(
  doc: DocModel,
  lines: (string | typeof REMOVED)[],
  op: Extract<Operation, { op: "replace-text" }>,
) {
  const section = doc.sections.find((s) => s.id === op.sectionId);
  if (!section) fail("not-found", `no section "${op.sectionId}"`);
  const inDiagram = (line: number) => doc.diagrams.some((d) => line >= d.lines.start && line <= d.lines.end);
  // Search prose lines only, keeping the mapping back to line numbers.
  const proseLines: number[] = [];
  for (let l = section.startLine; l <= section.endLine; l++) if (!inDiagram(l)) proseLines.push(l);
  const text = proseLines.map((l) => doc.lines[l - 1]).join("\n");
  const hits = occurrences(text, op.find);
  if (hits.length === 0) fail("not-found", `the text was not found in section "${section.title}"`);
  if (hits.length > 1)
    fail("invalid", `the text appears ${hits.length} times in section "${section.title}"; include more of it`);
  // Map the match back to (line, column) at both ends.
  const at = (offset: number) => {
    const before = text.slice(0, offset).split("\n");
    return { index: before.length - 1, column: before[before.length - 1]!.length };
  };
  const start = at(hits[0]!);
  const end = at(hits[0]! + op.find.length);
  const startLine = proseLines[start.index]!;
  const endLine = proseLines[end.index]!;
  if (endLine - startLine !== end.index - start.index)
    fail("unsupported", "the text spans a diagram block; replace it in two steps");
  const head = doc.lines[startLine - 1]!.slice(0, start.column);
  const tail = doc.lines[endLine - 1]!.slice(end.column);
  lines[startLine - 1] = head + op.replace + tail;
  for (let l = startLine + 1; l <= endLine; l++) lines[l - 1] = REMOVED;
  return { changed: [], added: [], removed: [] };
}

function verify(
  before: DocModel,
  after: DocModel,
  allowed: { changed: string[]; added: string[]; removed: string[] },
  op: Operation,
): TargetChange[] {
  const diagramId = "diagramId" in op ? op.diagramId : undefined;
  const key = (id: string) => targetKey(diagramId, id);
  const changes: TargetChange[] = [];
  const problems: string[] = [];
  for (const [k, t] of before.targets) {
    const now = after.targets.get(k);
    if (!now) changes.push({ key: k, change: "removed" });
    else if (now.digest !== t.digest) changes.push({ key: k, change: "changed" });
  }
  for (const k of after.targets.keys()) if (!before.targets.has(k)) changes.push({ key: k, change: "added" });

  const expected = new Map<string, TargetChange["change"]>();
  for (const id of allowed.changed) expected.set(key(id), "changed");
  for (const id of allowed.added) expected.set(key(id), "added");
  for (const id of allowed.removed) expected.set(key(id), "removed");
  for (const change of changes) {
    if (expected.get(change.key) !== change.change) problems.push(`${change.key} would be ${change.change}`);
  }
  for (const [k, change] of expected) {
    if (change !== "changed" && !changes.some((c) => c.key === k && c.change === change))
      problems.push(`${k} was not ${change}`);
  }
  const errorsBefore = before.diagnostics.filter((d) => d.severity === "error").length;
  const errorsAfter = after.diagnostics.filter((d) => d.severity === "error");
  if (errorsAfter.length > errorsBefore) problems.push(`new errors: ${errorsAfter.map((d) => d.message).join("; ")}`);
  for (const d of before.diagrams) {
    if (d.id !== diagramId && after.diagrams.find((x) => x.id === d.id)?.digest !== d.digest)
      problems.push(`diagram ${d.id} would change`);
  }
  if (op.op === "set-node-label") {
    const label = after.targets.get(key(`n.${op.nodeId.replace(/^n\./, "")}`))?.label;
    if (label !== op.value.trim()) problems.push(`label reads back as "${label}"`);
  }
  if (op.op === "set-edge-label") {
    const label = after.targets.get(key(op.edgeId))?.edgeLabel ?? "";
    if (label !== op.value.trim()) problems.push(`edge label reads back as "${label}"`);
  }
  if (problems.length)
    fail("check-failed", `the edit was not applied because it would have side effects: ${problems.join("; ")}`);
  return changes;
}

/** Changed lines between two texts that differ in one region: the lines between the common head and tail. */
function changedLineRange(before: string, after: string): OperationResult["changedLines"] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: OperationResult["changedLines"] = [];
  const count = Math.max(a.length - head - tail, b.length - head - tail);
  for (let i = 0; i < count; i++) {
    const was = head + i < a.length - tail ? a[head + i] : undefined;
    const now = head + i < b.length - tail ? b[head + i] : undefined;
    out.push({ line: head + i + 1, before: was, after: now });
  }
  return out;
}

function diffLines(before: string[], after: (string | typeof REMOVED)[]): OperationResult["changedLines"] {
  const out: OperationResult["changedLines"] = [];
  for (let i = 0; i < before.length; i++) {
    const a = after[i];
    if (a === REMOVED) out.push({ line: i + 1, before: before[i] });
    else if (a !== before[i]) out.push({ line: i + 1, before: before[i], after: a });
  }
  return out;
}
