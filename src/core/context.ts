import { describeRegion, type Thread } from "./annotations.js";
import { shortDigest } from "./digest.js";
import type { DocModel, Target } from "./document.js";
import type { Resolution, ResolvedThread } from "./resolve.js";
import { blockText, readSectionText } from "./reading.js";
import { sectionPlainText, sectionProse } from "./text.js";

/**
 * Builds the context an agent needs for one target or comment: the target's
 * meaning, its neighbours, declared constraints, the surrounding prose and the
 * discussion. Every item says why it was included; everything left out is
 * listed with a command that retrieves it. Nothing is inferred: missing
 * information is reported as unknown.
 */

export interface ContextItem {
  title: string;
  reason: string;
  text: string;
  source?: string;
}

export interface Omission {
  what: string;
  how: string;
}

export interface ContextPacket {
  document: { id: string; path: string; title: string; revision: string; commit: string | null; digest: string };
  focus: {
    kind: string;
    id: string;
    diagramId?: string;
    label: string;
    mapping?: string;
    resolution?: { status: string; note: string };
  };
  comment?: {
    id: string;
    discussion: string;
    kind: string;
    author: string;
    at: string;
    text: string;
    observedRevision: string;
    observedCommit?: string | null;
    replies: { author: string; at: string; text: string; revision?: string }[];
    statuses: { author: string; at: string; discussion: string; note?: string }[];
    evidence: { at: string; claim: string; command: string; result: string; revision: string }[];
  };
  items: ContextItem[];
  unknowns: string[];
  omitted: Omission[];
  budget: { limit: number; used: number; truncated: boolean };
}

export interface ContextRequest {
  doc: DocModel;
  threads: ResolvedThread[];
  /** A target key such as `pipeline/n.resolver`, or a thread id. */
  targetKey?: string;
  threadId?: string;
  /** Soft limit in characters for optional material. Required material is always included. */
  budget?: number;
  /** How the caller names the document in follow-up commands. */
  docRef?: string;
}

export class ContextError extends Error {}

export const DEFAULT_BUDGET = 8000;
/** The target's own content is required material, up to this many characters. */
const CONTENT_LIMIT = 4000;

function authorLabel(author: { name: string; kind: string; verified: boolean; login?: string }): string {
  const who = author.login ? `@${author.login}` : author.name;
  return `${who} (${author.kind}${author.verified ? ", verified by host" : ", unverified local identity"})`;
}

function describeTarget(doc: DocModel, target: Target): string {
  const lines: string[] = [];
  const name = (key: string | undefined) => {
    if (!key) return "(unknown)";
    const t = doc.targets.get(target.diagramId ? `${target.diagramId}/${key}` : key);
    return t ? `${t.label} (${t.id})` : key;
  };
  switch (target.kind) {
    case "node":
      lines.push(`Component: ${target.label} [${target.id}, ${target.shape ?? "node"}]`);
      if (target.groupId) lines.push(`In group: ${name(target.groupId)}`);
      break;
    case "edge":
      lines.push(`Connection: ${name(target.from)} -> ${name(target.to)} [${target.id}]`);
      lines.push(
        target.edgeLabel
          ? `Authored label: ${target.edgeLabel}`
          : "Authored label: none (the source does not say what flows here)",
      );
      if (target.style && target.style !== "solid") lines.push(`Line style: ${target.style}`);
      if (target.tail && target.tail !== "none") lines.push("Direction: both ways");
      break;
    case "group":
      lines.push(`Group: ${target.label} [${target.id}]`);
      lines.push(`Members: ${(target.members ?? []).map((m) => name(`n.${m}`)).join(", ") || "none"}`);
      break;
    case "image":
      lines.push(`Image: ${target.label} [${target.id}]`);
      lines.push(`Alt text: ${target.alt ? target.alt : "none"}`);
      break;
    default:
      if (target.block) {
        lines.push(`Element: <${target.block.tag}> ${target.block.kind} [${target.key}]`);
        const content = blockText(target);
        lines.push(
          content.length > CONTENT_LIMIT
            ? `Content (first ${CONTENT_LIMIT} of ${content.length} characters; htmi read --block ${target.key} gives all of it):\n${content.slice(0, CONTENT_LIMIT)}`
            : `Content:\n${content}`,
        );
      } else lines.push(`${target.kind}: ${target.label} [${target.id}]`);
  }
  if (target.description) lines.push(`Authored description: ${target.description}`);
  const asset = target.icon ?? target.asset;
  if (asset) {
    const where =
      asset.path ??
      (asset.library ? `${asset.library.name}:${asset.library.icon}@${asset.library.version}` : asset.ref);
    const meta = [
      asset.mediaType,
      asset.digest ? `sha256 ${shortDigest(asset.digest)}` : undefined,
      asset.license ? `license ${asset.license.identifier}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `${target.icon ? "Icon" : "File"}: ${where}${meta ? ` (${meta})` : ""}${asset.error ? ` [problem: ${asset.error}]` : ""}`,
    );
  }
  for (const link of target.sources ?? []) {
    const range = link.lines ? `#L${link.lines.start}-L${link.lines.end}` : "";
    lines.push(`Related source: ${link.path ?? link.ref}${range}${link.exists ? "" : " [missing]"}`);
  }
  lines.push(`Source lines: ${at(doc, target.lines.start, target.lines.end)}`);
  return lines.join("\n");
}

function neighbours(doc: DocModel, target: Target): string | undefined {
  if (!target.diagramId) return undefined;
  const diagram = doc.diagrams.find((d) => d.id === target.diagramId);
  if (!diagram) return undefined;
  const parts = diagram.targetKeys.map((k) => doc.targets.get(k)!);
  const label = (id: string | undefined) => parts.find((p) => p.id === id)?.label ?? id ?? "?";
  const edgeLine = (e: Target) =>
    `- ${label(e.from)} -> ${label(e.to)}${e.edgeLabel ? ` (${e.edgeLabel})` : ""} [${e.id}]`;
  if (target.kind === "node") {
    const incoming = parts.filter((p) => p.kind === "edge" && p.to === target.id);
    const outgoing = parts.filter((p) => p.kind === "edge" && p.from === target.id);
    const out: string[] = [];
    out.push(incoming.length ? `Incoming:\n${incoming.map(edgeLine).join("\n")}` : "Incoming: none");
    out.push(outgoing.length ? `Outgoing:\n${outgoing.map(edgeLine).join("\n")}` : "Outgoing: none");
    return out.join("\n");
  }
  if (target.kind === "edge") {
    const ends = [target.from, target.to].map((id) => parts.find((p) => p.id === id)).filter((p): p is Target => !!p);
    const out = ends.map((e) => `- ${e.label} [${e.id}]${e.description ? `: ${e.description}` : ""}`);
    const parallel = parts.filter(
      (p) =>
        p.kind === "edge" &&
        p.id !== target.id &&
        ((p.from === target.from && p.to === target.to) || (p.from === target.to && p.to === target.from)),
    );
    if (parallel.length) out.push(`Other connections between these components:\n${parallel.map(edgeLine).join("\n")}`);
    return `Endpoints:\n${out.join("\n")}`;
  }
  if (target.kind === "group") {
    const members = new Set((target.members ?? []).map((m) => `n.${m}`));
    const crossing = parts.filter((p) => p.kind === "edge" && members.has(p.from!) !== members.has(p.to!));
    return crossing.length
      ? `Connections crossing the group boundary:\n${crossing.map(edgeLine).join("\n")}`
      : undefined;
  }
  return undefined;
}

function diagramSummary(doc: DocModel, diagramId: string): string {
  const diagram = doc.diagrams.find((d) => d.id === diagramId)!;
  const parts = diagram.targetKeys.map((k) => doc.targets.get(k)!);
  const label = (id: string | undefined) => parts.find((p) => p.id === id)?.label ?? id ?? "?";
  const nodes = parts.filter((p) => p.kind === "node");
  const edges = parts.filter((p) => p.kind === "edge");
  const groups = parts.filter((p) => p.kind === "group");
  const out = [
    `Diagram ${diagram.id}: ${nodes.length} components, ${edges.length} connections, ${groups.length} groups`,
  ];
  out.push(...nodes.map((n) => `- ${n.label} [${n.id}]${n.description ? `: ${n.description}` : ""}`));
  out.push(
    ...edges.map((e) => `- ${label(e.from)} -> ${label(e.to)}${e.edgeLabel ? ` (${e.edgeLabel})` : ""} [${e.id}]`),
  );
  out.push(...groups.map((g) => `- group ${g.label} [${g.id}]: ${(g.members ?? []).join(", ")}`));
  return out.join("\n");
}

function threadSummary(t: Thread): string {
  const first = t.comment.body.text.split("\n")[0]!;
  return `${t.id} (${t.discussion}, ${t.comment.body.kind}): ${first.length > 100 ? `${first.slice(0, 97)}...` : first}`;
}

export function buildContext(request: ContextRequest): ContextPacket {
  const { doc } = request;
  const limit = request.budget ?? DEFAULT_BUDGET;
  const docRef = request.docRef ?? (doc.idSource === "declared" ? doc.documentId : doc.path);
  let resolved: ResolvedThread | undefined;
  let target: Target | undefined;
  let resolution: Resolution | undefined;
  let focusKey = request.targetKey;

  if (request.threadId) {
    resolved = request.threads.find((r) => r.thread.id === request.threadId);
    if (!resolved) throw new ContextError(`no comment ${request.threadId} on ${doc.path}`);
    resolution = resolved.resolution;
    target = resolution.target;
    const ref = resolved.thread.target;
    focusKey = ref.diagramId ? `${ref.diagramId}/${ref.targetId}` : ref.targetId;
  } else if (focusKey) {
    target = doc.targets.get(focusKey);
    if (!target && !doc.diagrams.some((d) => d.id === focusKey)) {
      throw new ContextError(`no target "${focusKey}" in ${doc.path}; run \`htmi targets ${docRef}\``);
    }
  } else {
    throw new ContextError("give a target or a comment id");
  }

  const items: ContextItem[] = [];
  const unknowns: string[] = [];
  const omitted: Omission[] = [];
  const ref = resolved?.thread.target;
  const isDiagram = (ref?.kind ?? (target ? target.kind : "diagram")) === "diagram";
  const diagramId = isDiagram ? (ref?.targetId ?? focusKey) : (target?.diagramId ?? ref?.diagramId);
  const sectionId =
    target?.sectionId ??
    doc.diagrams.find((d) => d.id === diagramId)?.sectionId ??
    (ref?.kind === "text" ? ref.targetId.replace(/^t\./, "") : undefined);

  // Required material: the target and its immediate graph neighbourhood.
  if (target) {
    items.push({ title: "Target", reason: "the element the request is about", text: describeTarget(doc, target) });
    const near = neighbours(doc, target);
    if (near) items.push({ title: "Neighbours", reason: "direct connections in the same diagram", text: near });
    if (target.kind === "edge" && !target.edgeLabel && !target.description) {
      unknowns.push("What this connection carries is not written in the source (no label or description).");
    }
    if (doc.format === "markdown" && target.kind !== "text" && target.kind !== "image" && !target.sources?.length) {
      unknowns.push(
        `No implementation files are linked to ${target.id}; add "%% htmi:source ${target.id} <path>" to link them.`,
      );
    }
    if (target.mapping === "derived" && doc.format === "html") {
      unknowns.push(
        `${target.key} has no authored id, so its key is positional; an id on the element keeps comments attached when blocks are added before it.`,
      );
    }
  } else if (isDiagram && diagramId && doc.diagrams.some((d) => d.id === diagramId)) {
    items.push({
      title: "Diagram",
      reason: "the comment is about the whole diagram",
      text: diagramSummary(doc, diagramId),
    });
  } else if (ref?.kind === "text" && ref.selector?.type === "TextQuoteSelector") {
    items.push({ title: "Quoted text", reason: "the passage the reviewer selected", text: ref.selector.exact });
  } else if (ref) {
    const was = [`Kind: ${ref.kind}`, `Id: ${ref.targetId}`, ref.label ? `Label then: ${ref.label}` : undefined];
    if (ref.from || ref.to) was.push(`Endpoints then: ${ref.from ?? "?"} -> ${ref.to ?? "?"}`);
    items.push({
      title: "Original target (not present now)",
      reason: "what the reviewer pointed at when they wrote the comment",
      text: was.filter(Boolean).join("\n"),
    });
  }
  if (ref?.kind === "text" && target && ref.selector?.type === "TextQuoteSelector") {
    items.push({ title: "Quoted text", reason: "the passage the reviewer selected", text: ref.selector.exact });
  }
  if (ref?.selector?.type === "ImageRegionSelector") {
    const sel = ref.selector;
    items.push({
      title: "Marked region",
      reason: "the part of the image the reviewer marked",
      text: `Region of the image ${describeRegion(sel)} (left ${sel.x.toFixed(3)}, top ${sel.y.toFixed(3)}, width ${sel.w.toFixed(3)}, height ${sel.h.toFixed(3)}, as fractions of the image).`,
    });
    unknowns.push(
      "What the marked region shows: image bytes are not included. Open the image file and look at that area before acting.",
    );
  }
  if (resolution && resolution.candidates.length) {
    items.push({
      title: "Possible targets (not chosen)",
      reason: "the original target could not be identified with certainty",
      text: resolution.candidates.map((c) => `- ${c.label} [${c.id}]`).join("\n"),
    });
  }

  // Declared constraints are always included.
  const constraints = doc.alerts.filter((a) => a.kind === "IMPORTANT" || a.kind === "WARNING" || a.kind === "CAUTION");
  for (const alert of constraints) {
    items.push({
      title: `Constraint (${alert.kind.toLowerCase()})`,
      reason: "declared constraints are always included",
      text: alert.text,
      source: at(doc, alert.startLine),
    });
  }

  let comment: ContextPacket["comment"];
  if (resolved) {
    const t = resolved.thread;
    comment = {
      id: t.id,
      discussion: t.discussion,
      kind: t.comment.body.kind,
      author: authorLabel(t.comment.author),
      at: t.comment.at,
      text: t.comment.body.text,
      observedRevision: t.observed.revision,
      observedCommit: t.observed.commit,
      replies: t.replies.map((r) => ({
        author: authorLabel(r.author),
        at: r.at,
        text: r.body.text,
        revision: r.revision,
      })),
      statuses: t.statuses.map((s) => ({
        author: authorLabel(s.author),
        at: s.at,
        discussion: s.discussion,
        note: s.note,
      })),
      evidence: t.evidence.map((e) => ({
        at: e.at,
        claim: e.claim,
        command: e.command,
        result: e.result,
        revision: e.revision,
      })),
    };
  }

  const sameTarget = request.threads.filter((r) => {
    if (resolved && r.thread.id === resolved.thread.id) return false;
    const k = r.thread.target.diagramId
      ? `${r.thread.target.diagramId}/${r.thread.target.targetId}`
      : r.thread.target.targetId;
    return k === focusKey && r.thread.discussion !== "resolved" && r.thread.discussion !== "wontfix";
  });
  if (sameTarget.length) {
    items.push({
      title: "Other open comments on this target",
      reason: "related discussion on the same element",
      text: sameTarget.map((r) => `- ${threadSummary(r.thread)}`).join("\n"),
    });
  }

  // Optional material, within the budget.
  const required = items.reduce((n, i) => n + i.text.length, 0) + (comment?.text.length ?? 0);
  let used = required;
  let truncated = false;
  if (sectionId) {
    const section = doc.sections.find((s) => s.id === sectionId);
    const prose =
      doc.format === "markdown"
        ? sectionProse(doc, sectionId)
        : (readSectionText(doc, sectionId)?.text ?? sectionPlainText(doc, sectionId));
    if (section && prose) {
      const room = Math.max(0, limit - used);
      if (prose.length <= room) {
        items.push({
          title: `Section: ${section.title}`,
          reason: "prose around the target",
          text: prose,
          source: inSection(doc, section.id),
        });
        used += prose.length;
      } else {
        truncated = true;
        const cut = room > 200 ? prose.slice(0, room).replace(/\s+\S*$/, "") : "";
        if (cut) {
          items.push({
            title: `Section: ${section.title} (truncated)`,
            reason: "prose around the target, cut to fit the budget",
            text: `${cut}\n[truncated: ${cut.length} of ${prose.length} characters shown]`,
            source: inSection(doc, section.id),
          });
          used += cut.length;
        }
        omitted.push({
          what: `${prose.length - cut.length} characters of section "${section.title}"`,
          how: `htmi read ${docRef} --section ${section.id}`,
        });
      }
    }
  }
  if (diagramId && !isDiagram && doc.diagrams.some((d) => d.id === diagramId)) {
    const diagram = doc.diagrams.find((d) => d.id === diagramId)!;
    const shownIds = new Set<string>();
    if (target) {
      shownIds.add(target.id);
      for (const k of diagram.targetKeys) {
        const t = doc.targets.get(k)!;
        if (t.kind === "edge" && (t.from === target.id || t.to === target.id)) {
          shownIds.add(t.id);
          shownIds.add(t.from!);
          shownIds.add(t.to!);
        }
        if (target.kind === "edge" && (t.id === target.from || t.id === target.to)) shownIds.add(t.id);
      }
    }
    const rest = diagram.targetKeys.filter((k) => !shownIds.has(doc.targets.get(k)!.id)).length;
    if (rest > 0) {
      omitted.push({
        what: `${rest} other elements of diagram ${diagram.id}`,
        how: `htmi targets ${docRef} --diagram ${diagram.id}`,
      });
    }
    if (diagram.presentationLines.length) {
      const n = diagram.presentationLines.length;
      omitted.push({
        what: `${n} styling line${n === 1 ? "" : "s"} of diagram ${diagram.id}`,
        how: `read ${doc.path}`,
      });
    }
  }
  const otherSections = doc.sections.filter((s) => s.id !== sectionId && s.level > 0);
  if (otherSections.length) {
    omitted.push({
      what: `${otherSections.length} other sections (${otherSections
        .slice(0, 6)
        .map((s) => s.title)
        .join(", ")}${otherSections.length > 6 ? ", ..." : ""})`,
      how: `htmi read ${docRef} --section <id>`,
    });
  }
  const assets = [...doc.targets.values()].filter((t) => t.icon || t.asset).length;
  if (assets)
    omitted.push({
      what: `bytes of ${assets} icons and images (references are included)`,
      how: "open the file paths listed",
    });
  const others = request.threads.filter((r) => r !== resolved && !sameTarget.includes(r)).length;
  if (others) omitted.push({ what: `${others} comments on other targets`, how: `htmi comments ${docRef}` });
  if (resolved && resolution && resolution.status !== "exact" && resolved.thread.observed.commit) {
    omitted.push({
      what: `the document as the reviewer saw it (${resolved.thread.observed.revision})`,
      how: `htmi read ${docRef} --rev ${resolved.thread.observed.commit.slice(0, 12)}`,
    });
  }

  const focusTarget = target;
  return {
    document: {
      id: doc.documentId,
      path: doc.path,
      title: doc.title,
      revision: doc.revision.label,
      commit: doc.revision.commit,
      digest: doc.digest,
    },
    focus: {
      kind: focusTarget?.kind ?? ref?.kind ?? "diagram",
      id: focusTarget?.id ?? ref?.targetId ?? focusKey!,
      diagramId: focusTarget?.diagramId ?? ref?.diagramId,
      label: focusTarget?.label ?? ref?.label ?? focusKey!,
      mapping: focusTarget?.mapping,
      resolution: resolution ? { status: resolution.status, note: resolution.note } : undefined,
    },
    comment,
    items,
    unknowns,
    omitted,
    budget: { limit, used, truncated },
  };
}

export function renderContextText(packet: ContextPacket): string {
  const out: string[] = [];
  const c = packet.comment;
  if (c) {
    out.push(`Comment ${c.id} | ${c.discussion} | ${c.kind} | target ${packet.focus.resolution?.status ?? "unknown"}`);
    if (packet.focus.resolution && packet.focus.resolution.status !== "exact")
      out.push(`Target note: ${packet.focus.resolution.note}`);
  }
  out.push(
    `Document: ${packet.document.title} (${packet.document.id}) at ${packet.document.revision}, sha256 ${shortDigest(packet.document.digest)}`,
  );
  out.push(
    `Target: ${packet.focus.diagramId ? `${packet.focus.diagramId} / ` : ""}${packet.focus.id} (${packet.focus.kind}${packet.focus.mapping ? `, ${packet.focus.mapping} mapping` : ""})`,
  );
  if (c) {
    out.push(`Observed at: ${c.observedRevision}`);
    out.push(`Author: ${c.author}, ${c.at}`);
    out.push("Text (verbatim):");
    out.push(indent(c.text));
    for (const r of c.replies)
      out.push(`Reply by ${r.author}, ${r.at}${r.revision ? `, revision ${r.revision}` : ""}:\n${indent(r.text)}`);
    for (const s of c.statuses)
      out.push(`Status ${s.discussion} by ${s.author}, ${s.at}${s.note ? `: ${s.note}` : ""}`);
    for (const e of c.evidence)
      out.push(`Evidence ${e.result}: ${e.claim} (\`${e.command}\` at ${e.revision}, ${e.at})`);
  }
  for (const item of packet.items) {
    out.push("");
    out.push(`## ${item.title}  [${item.reason}${item.source ? `; ${item.source}` : ""}]`);
    out.push(item.text);
  }
  out.push("");
  out.push("## Unknown");
  out.push(packet.unknowns.length ? packet.unknowns.map((u) => `- ${u}`).join("\n") : "- nothing flagged");
  out.push("");
  out.push("## Omitted");
  out.push(packet.omitted.length ? packet.omitted.map((o) => `- ${o.what}: \`${o.how}\``).join("\n") : "- nothing");
  return out.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/**
 * Where something is in a document. A description's reference already ends in
 * `#7`, so lines and sections are written out instead of appended.
 */
function at(doc: DocModel, start: number, end = start): string {
  // An HTML description's lines count from inside its fence; the reader sees the whole body.
  const offset = doc.host?.wrapper?.lineOffset ?? 0;
  if (offset) {
    start += offset;
    end += offset;
  }
  const range = end !== start ? `${start}-${end}` : `${start}`;
  return doc.host ? `${doc.path}, description line${end !== start ? "s" : ""} ${range}` : `${doc.path}:${range}`;
}

function inSection(doc: DocModel, sectionId: string): string {
  return doc.host ? `${doc.path}, section ${sectionId}` : `${doc.path}#${sectionId}`;
}
