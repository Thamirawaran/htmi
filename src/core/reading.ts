import type { BlockInfo, DocModel, Target } from "./document.js";
import { normaliseSpace, sectionPlainText, sectionProse } from "./text.js";

/**
 * What an agent reads before any comment exists: an outline, one section,
 * one block, or search hits. These are projections of the source with
 * references back to it (keys, lines, source offsets); the source file stays
 * authoritative. Stylesheets, scripts, SVG geometry and image bytes are left
 * out; captions, alt text, table cells and code are kept exactly.
 */

export interface OutlineBlock {
  key: string;
  kind: string;
  label: string;
  mapping: string;
  lines: [number, number];
  parts?: number;
}

export interface Outline {
  id: string;
  idSource: string;
  path: string;
  format: string;
  title: string;
  revision: DocModel["revision"];
  digest: string;
  dependencyDigest?: string;
  sections: { id: string; title: string; level: number; lines: [number, number]; blocks: OutlineBlock[] }[];
  diagrams: { id: string; section: string; targets: number; supported: boolean }[];
  constraints: string[];
  dependencies: { ref: string; kind: string; path?: string; status: string }[];
  scripts: number;
  coverage: DocModel["coverage"];
  ambiguous: string[];
}

function blockKind(t: Target): string {
  return t.block?.kind ?? t.kind;
}

function childrenOf(doc: DocModel, key: string): Target[] {
  return [...doc.targets.values()].filter((t) => t.parentKey === key);
}

function descendantsCount(doc: DocModel, key: string): number {
  return childrenOf(doc, key).reduce((n, t) => n + 1 + descendantsCount(doc, t.key), 0);
}

export function documentOutline(doc: DocModel): Outline {
  const top = (sectionId: string): Target[] => {
    if (doc.readingOrder) {
      return (doc.readingOrder.get(sectionId) ?? [])
        .filter((i) => i.key !== undefined)
        .map((i) => doc.targets.get(i.key!))
        .filter((t): t is Target => !!t);
    }
    return [...doc.targets.values()].filter((t) => t.sectionId === sectionId && !t.diagramId);
  };
  return {
    id: doc.documentId,
    idSource: doc.idSource,
    path: doc.path,
    format: doc.format,
    title: doc.title,
    revision: doc.revision,
    digest: doc.digest,
    dependencyDigest: doc.dependencyDigest,
    sections: doc.sections.map((s) => ({
      id: s.id,
      title: s.title,
      level: s.level,
      lines: [s.startLine, s.endLine],
      blocks: top(s.id).map((t) => {
        const parts = descendantsCount(doc, t.key);
        return {
          key: t.key,
          kind: blockKind(t),
          label: t.label,
          mapping: t.mapping,
          lines: [t.lines.start, t.lines.end] as [number, number],
          ...(parts ? { parts } : {}),
        };
      }),
    })),
    diagrams: doc.diagrams.map((d) => ({
      id: d.id,
      section: d.sectionId,
      targets: d.targetKeys.length,
      supported: d.supported,
    })),
    constraints: doc.alerts.filter((a) => a.kind !== "NOTE" && a.kind !== "TIP").map((a) => a.text),
    dependencies: (doc.dependencies ?? []).map((d) => ({ ref: d.ref, kind: d.kind, path: d.path, status: d.status })),
    scripts: doc.scripts ?? 0,
    coverage: doc.coverage,
    ambiguous: [
      ...(doc.ambiguousKeys ?? []),
      ...doc.diagrams.flatMap((d) => d.ambiguousIds.map((i) => `${d.id}/${i}`)),
    ],
  };
}

export function outlineText(o: Outline): string {
  const out = [
    `${o.title}  (${o.id}${o.idSource === "derived" ? ", derived id" : ""}, ${o.format})`,
    `${o.path} at ${o.revision.label}`,
    "",
    "Sections:",
  ];
  for (const s of o.sections) {
    const pad = "  ".repeat(Math.max(1, s.level));
    out.push(`${pad}${s.id}  ${s.title}  (lines ${s.lines[0]}-${s.lines[1]})`);
    for (const b of s.blocks) {
      if (b.kind === "heading") continue;
      out.push(
        `${pad}  [${b.key}] ${b.kind}: ${b.label}${b.parts ? ` (+${b.parts} part${b.parts > 1 ? "s" : ""})` : ""}`,
      );
    }
  }
  out.push(
    "Diagrams:",
    ...(o.diagrams.length
      ? o.diagrams.map(
          (d) => `  ${d.id} in ${d.section}: ${d.supported ? `${d.targets} targets` : "not a supported flowchart"}`,
        )
      : ["  none"]),
  );
  if (o.constraints.length) out.push("Constraints:", ...o.constraints.map((c) => `  - ${c}`));
  if (o.dependencies.length) {
    out.push(
      "Files it uses:",
      ...o.dependencies.map(
        (d) => `  ${d.kind.padEnd(10)} ${d.path ?? d.ref}${d.status === "ok" ? "" : `  [${d.status}]`}`,
      ),
    );
  }
  if (o.ambiguous.length) out.push(`Ambiguous ids: ${o.ambiguous.join(", ")}`);
  if (o.coverage.length)
    out.push("Not fully represented:", ...o.coverage.map((c) => `  - ${c.what}: ${c.consequence}`));
  return out.join("\n");
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => (l ? `${by}${l}` : l))
    .join("\n");
}

/** One block as readable text, with its exact content. */
export function blockText(t: Target): string {
  const b: BlockInfo | undefined = t.block;
  if (!b) return t.label;
  switch (b.kind) {
    case "code":
      return `\`\`\`${b.code?.language ?? ""}\n${(b.code?.text ?? b.text).replace(/\n$/, "")}\n\`\`\``;
    case "image":
      return `[image ${t.asset?.path ?? t.asset?.ref ?? ""}: ${t.alt ?? "no alt text"}]`;
    default:
      return b.text;
  }
}

function describeItem(doc: DocModel, t: Target, depth: number): string[] {
  const kind = blockKind(t);
  const head = `${"  ".repeat(depth)}[${t.key}] ${kind}${t.mapping === "derived" ? " (positional key)" : ""}`;
  const lines: string[] = [];
  if (kind === "heading") lines.push(`${"  ".repeat(depth)}[${t.key}] heading: ${t.label}`);
  else {
    const body = blockText(t);
    lines.push(
      body.includes("\n") || body.length > 80
        ? `${head}:\n${indent(body, "  ".repeat(depth + 1))}`
        : `${head}: ${body}`,
    );
  }
  for (const child of childrenOf(doc, t.key)) {
    if (child.kind === "element" && child.block?.kind === "element") {
      lines.push(`${"  ".repeat(depth + 1)}- [${child.key}] ${child.label}`);
      for (const grand of childrenOf(doc, child.key))
        lines.push(`${"  ".repeat(depth + 2)}- [${grand.key}] ${grand.label}`);
    } else lines.push(...describeItem(doc, child, depth + 1));
  }
  return lines;
}

export interface SectionRead {
  id: string;
  title: string;
  lines: { start: number; end: number };
  text: string;
}

/** A section as an agent should read it: Markdown source for Markdown, blocks with keys for HTML. */
export function readSectionText(doc: DocModel, sectionId: string): SectionRead | null {
  const section = doc.sections.find((s) => s.id === sectionId);
  if (!section) return null;
  let text: string;
  if (doc.format === "markdown") text = sectionProse(doc, sectionId);
  else if (doc.readingOrder) {
    const out: string[] = [];
    for (const item of doc.readingOrder.get(sectionId) ?? []) {
      if (item.text !== undefined) out.push(item.text);
      else {
        const t = doc.targets.get(item.key!);
        if (t) out.push(...describeItem(doc, t, 0));
      }
    }
    text = out.join("\n");
  } else text = sectionPlainText(doc, sectionId);
  return { id: section.id, title: section.title, lines: { start: section.startLine, end: section.endLine }, text };
}

export interface BlockRead {
  key: string;
  kind: string;
  tag?: string;
  label: string;
  section: string;
  mapping: string;
  lines: { start: number; end: number };
  span?: { start: number; end: number };
  digest: string;
  text: string;
  table?: BlockInfo["table"];
  code?: BlockInfo["code"];
  math?: BlockInfo["math"];
  parts: { key: string; label: string }[];
  source?: string;
}

export function readBlock(doc: DocModel, key: string, options: { source?: boolean } = {}): BlockRead | null {
  const t = doc.targets.get(key);
  if (!t) return null;
  return {
    key: t.key,
    kind: blockKind(t),
    tag: t.block?.tag,
    label: t.label,
    section: t.sectionId,
    mapping: t.mapping,
    lines: t.lines,
    span: t.span,
    digest: t.digest,
    text: describeItem(doc, t, 0).join("\n"),
    table: t.block?.table,
    code: t.block?.code,
    math: t.block?.math,
    parts: childrenOf(doc, key).map((c) => ({ key: c.key, label: c.label })),
    source: options.source && t.span ? doc.content.slice(t.span.start, t.span.end) : undefined,
  };
}

export interface SearchHit {
  key?: string;
  section: string;
  kind: string;
  lines: { start: number; end: number };
  snippet: string;
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + length + 60);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/** Case-insensitive search. HTML hits name the innermost block that contains the text. */
export function searchDocument(doc: DocModel, query: string, limit = 20): SearchHit[] {
  const needle = normaliseSpace(query).toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  if (doc.format === "html") {
    const matching = [...doc.targets.values()].filter((t) =>
      normaliseSpace(t.block ? t.block.text : t.label)
        .toLowerCase()
        .includes(needle),
    );
    const keys = new Set(matching.map((t) => t.key));
    // Prefer the innermost block: drop a match whose child also matches.
    for (const t of matching) {
      if (childrenOf(doc, t.key).some((c) => keys.has(c.key))) continue;
      const text = normaliseSpace(t.block ? t.block.text : t.label);
      hits.push({
        key: t.key,
        section: t.sectionId,
        kind: blockKind(t),
        lines: t.lines,
        snippet: snippet(text, text.toLowerCase().indexOf(needle), needle.length),
      });
    }
    for (const [sectionId, items] of doc.readingOrder ?? []) {
      for (const item of items) {
        if (item.text === undefined || !item.text.toLowerCase().includes(needle)) continue;
        const s = doc.sections.find((x) => x.id === sectionId);
        hits.push({
          section: sectionId,
          kind: "text",
          lines: { start: s?.startLine ?? 1, end: s?.endLine ?? 1 },
          snippet: snippet(item.text, item.text.toLowerCase().indexOf(needle), needle.length),
        });
      }
    }
  } else {
    doc.lines.forEach((line, i) => {
      const at = line.toLowerCase().indexOf(needle);
      if (at < 0) return;
      const section = [...doc.sections].reverse().find((s) => s.startLine <= i + 1) ?? doc.sections[0]!;
      const target = [...doc.targets.values()].find((t) => t.lines.start <= i + 1 && t.lines.end >= i + 1);
      hits.push({
        key: target?.key,
        section: section.id,
        kind: target ? target.kind : "text",
        lines: { start: i + 1, end: i + 1 },
        snippet: snippet(line.trim(), Math.max(0, line.trim().toLowerCase().indexOf(needle)), needle.length),
      });
    });
  }
  return hits.slice(0, limit);
}
