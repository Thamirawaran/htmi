import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { marked, type Token } from "marked";
import { resolveAsset, type AssetRef } from "./assets.js";
import { digestOf, digestValue } from "./digest.js";
import { scanMarkdown, slugify, type Alert, type Section } from "./markdown.js";
import {
  parseMermaid,
  type ArrowHead,
  type Diagnostic,
  type Direction,
  type LineStyle,
  type MermaidParse,
  type Shape,
} from "./mermaid.js";
import { readAtCommit, repoRelative, resolveCommit, workingRevision, type SourceRevision } from "./revision.js";

export type TargetKind = "diagram" | "node" | "edge" | "group" | "text" | "image" | "element";

/**
 * How a target maps back to its source (research report, section 7.5).
 * exact: an authored or declared id. derived: a deterministic rule over the
 * source. heuristic: selector, text or geometry matching. unmapped: a visual
 * region with no editable meaning.
 */
export type Mapping = "exact" | "derived" | "heuristic" | "unmapped";

export interface SourceLink {
  ref: string;
  path?: string;
  lines?: { start: number; end: number };
  exists: boolean;
  error?: string;
}

/** A UTF-16 code unit range in the document's text, as decoded from UTF-8. */
export interface Span {
  start: number;
  end: number;
}

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "definition-list"
  | "table"
  | "code"
  | "figure"
  | "image"
  | "quote"
  | "svg"
  | "math"
  | "container"
  | "element";

/** Readable content of an HTML block. Derived from the source; never a second source of truth. */
export interface BlockInfo {
  kind: BlockKind;
  tag: string;
  /** Exact readable text; tables as rows, lists as items, code with its whitespace. */
  text: string;
  table?: { caption?: string; rows: string[][]; headerRows: number[] };
  code?: { language?: string; text: string };
  caption?: string;
  items?: string[];
  labels?: string[];
  math?: { source?: string; text: string };
}

/** One step of a section in reading order: a block by key, or text that belongs to no block. */
export type ReadingItem = { key: string; text?: undefined } | { key?: undefined; text: string };

/** A file the document refers to: a stylesheet, image, font, script or media file. */
export interface Dependency {
  ref: string;
  kind: "stylesheet" | "image" | "font" | "script" | "media";
  /** Repository relative path, when the file is local. */
  path?: string;
  status: "ok" | "missing" | "outside" | "remote" | "unsupported";
  digest?: string;
  size?: number;
  line?: number;
}

export interface Target {
  /** Unique key within the document: `<diagramId>/<id>` for diagram parts, `<id>` otherwise. */
  key: string;
  id: string;
  kind: TargetKind;
  diagramId?: string;
  sectionId: string;
  label: string;
  mapping: Mapping;
  idSource: "authored" | "declared" | "derived";
  lines: { start: number; end: number };
  /** Where the element starts and ends in the source; HTML targets only. */
  span?: Span;
  /** The enclosing target, when the element sits inside another target. */
  parentKey?: string;
  digest: string;
  /** A digest computed the way comments written before version 2 digests computed it. */
  legacyDigest?: string;
  block?: BlockInfo;
  shape?: Shape;
  groupId?: string;
  from?: string;
  to?: string;
  style?: LineStyle;
  head?: ArrowHead;
  tail?: ArrowHead;
  edgeLabel?: string;
  members?: string[];
  parentId?: string;
  description?: string;
  icon?: AssetRef;
  sources?: SourceLink[];
  asset?: AssetRef;
  alt?: string;
}

export interface DiagramModel {
  id: string;
  idSource: "declared" | "derived";
  sectionId: string;
  title: string;
  lines: { start: number; end: number };
  direction: Direction;
  supported: boolean;
  targetKeys: string[];
  /** Ids that more than one element claims; comments on them resolve as ambiguous. */
  ambiguousIds: string[];
  presentationLines: number[];
  digest: string;
  span?: Span;
}

export interface DocDiagnostic extends Diagnostic {
  diagramId?: string;
}

/** Something in the document that HTMi cannot represent faithfully. */
export interface CoverageItem {
  what: string;
  lines?: { start: number; end: number };
  consequence: string;
}

export interface DocModel {
  schemaVersion: 1;
  documentId: string;
  idSource: "declared" | "derived";
  path: string;
  format: "markdown" | "html";
  title: string;
  content: string;
  lines: string[];
  digest: string;
  revision: SourceRevision;
  sections: Section[];
  /** Plain text per section, for formats where it cannot be derived from source lines. */
  sectionText?: Map<string, string>;
  diagrams: DiagramModel[];
  targets: Map<string, Target>;
  /** HTML: each section's blocks and loose text in reading order. */
  readingOrder?: Map<string, ReadingItem[]>;
  /** Keys that more than one element claims outside diagrams; comments on them resolve as ambiguous. */
  ambiguousKeys?: string[];
  alerts: Alert[];
  diagnostics: DocDiagnostic[];
  coverage: CoverageItem[];
  /** Local and remote files the document refers to (HTML). */
  dependencies?: Dependency[];
  /** Digest of the source and every local dependency: changes when anything the page shows changes. */
  dependencyDigest?: string;
  /** Number of script elements, none of which HTMi runs. */
  scripts?: number;
  /** Set when the document is a description on a host (a GitHub issue or pull request), not a file. */
  host?: HostDocument;
}

/** Where a host-held document lives. Its documentPath is `github:owner/repo#number`. */
export interface HostDocument {
  provider: "github";
  repo: string;
  number: number;
  kind: "issue" | "pull";
  url: string;
  /** The issue or pull request title, which is not part of the description. */
  title: string;
  /** When GitHub last changed anything on the issue (comments and labels included): not a version of the description. */
  updatedAt: string;
  /** For a description that is one fenced html block: the fence around the page, and how many lines it adds before it. */
  wrapper?: { before: string; after: string; lineOffset: number };
}

export interface LoadOptions {
  repoRoot: string;
  /** Repository relative POSIX path. */
  path: string;
  /** Read the document as it was at this commit instead of the working tree. */
  rev?: string;
}

export class DocumentError extends Error {}

/** Read a document's content and revision, from the working tree or a commit. */
export function readDocumentSource(options: LoadOptions): { content: string; revision: SourceRevision } {
  const { repoRoot, path } = options;
  let content: string;
  let revision: SourceRevision;
  if (options.rev) {
    const commit = resolveCommit(repoRoot, options.rev);
    if (!commit) throw new DocumentError(`unknown revision "${options.rev}"`);
    const atCommit = readAtCommit(repoRoot, commit, path);
    if (atCommit === null) throw new DocumentError(`${path} does not exist at ${commit.slice(0, 7)}`);
    content = atCommit;
    revision = { commit, state: "commit", label: commit.slice(0, 7) };
  } else {
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) throw new DocumentError(`${path} not found`);
    content = readFileSync(absolute, "utf8");
    revision = workingRevision(repoRoot, path);
  }
  return { content, revision };
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

export function derivedDocumentId(path: string): string {
  return `path:${path}`;
}

export function targetKey(diagramId: string | undefined, id: string): string {
  return diagramId ? `${diagramId}/${id}` : id;
}

export function imageTargetId(sectionId: string, src: string, occurrence: number): string {
  const stem = slugify(basename(src, extname(src))) || "image";
  return `img.${sectionId}.${stem}${occurrence > 1 ? `.${occurrence}` : ""}`;
}

const TARGET_ID_RE = /^[A-Za-z][\w.-]*$/;

export function buildMarkdownModel(
  content: string,
  path: string,
  repoRoot: string,
  revision: SourceRevision,
): DocModel {
  const scan = scanMarkdown(content);
  const docDir = dirname(join(repoRoot, path));
  const model: DocModel = {
    schemaVersion: 1,
    documentId: scan.declaredId?.id ?? derivedDocumentId(path),
    idSource: scan.declaredId ? "declared" : "derived",
    path,
    format: "markdown",
    title: scan.title ?? basename(path),
    content,
    lines: scan.lines,
    digest: digestOf(content),
    revision,
    sections: scan.sections,
    diagrams: [],
    targets: new Map(),
    alerts: scan.alerts,
    diagnostics: [],
    coverage: [],
  };

  const diagramIds = new Set<string>();
  const derivedPerSection = new Map<string, number>();

  for (const fence of scan.fences) {
    if (fence.lang !== "mermaid") continue;
    const section = scan.sections.find((s) => s.id === fence.sectionId);
    const parse = parseMermaid(fence.body);
    const declared = parse.directives.filter((d) => d.name === "diagram");
    let id: string;
    let idSource: DiagramModel["idSource"];
    if (declared.length > 0 && declared[0]!.args[0] && TARGET_ID_RE.test(declared[0]!.args[0])) {
      id = declared[0]!.args[0];
      idSource = "declared";
      if (declared.length > 1) {
        model.diagnostics.push({
          severity: "error",
          line: declared[1]!.line,
          message: "more than one htmi:diagram directive in a block",
        });
      }
    } else {
      if (declared.length > 0) {
        model.diagnostics.push({
          severity: "error",
          line: declared[0]!.line,
          message: "htmi:diagram needs an id such as compilation-pipeline",
        });
      }
      const n = (derivedPerSection.get(fence.sectionId) ?? 0) + 1;
      derivedPerSection.set(fence.sectionId, n);
      id = `${fence.sectionId}.diagram${n > 1 ? `.${n}` : ""}`;
      idSource = "derived";
    }
    if (diagramIds.has(id)) {
      model.diagnostics.push({
        severity: "error",
        line: fence.startLine,
        message: `diagram id "${id}" is used twice in this document`,
      });
      id = `${id}@L${fence.startLine}`;
      idSource = "derived";
    }
    diagramIds.add(id);

    for (const d of parse.diagnostics) model.diagnostics.push({ ...d, diagramId: id });
    if (idSource === "derived" && parse.supported) {
      model.diagnostics.push({
        severity: "warning",
        line: fence.startLine,
        diagramId: id,
        message: `diagram has no declared id; add "%% htmi:diagram <id>" so comments survive moving it`,
      });
    }

    const diagram: DiagramModel = {
      id,
      idSource,
      sectionId: fence.sectionId,
      title: section?.title ?? model.title,
      lines: { start: fence.startLine, end: fence.endLine },
      direction: parse.direction,
      supported: parse.supported,
      targetKeys: [],
      ambiguousIds: [],
      presentationLines: parse.presentationLines,
      digest: "",
    };
    if (!parse.supported) {
      model.coverage.push({
        what: `Mermaid block "${id}" is not a flowchart`,
        lines: diagram.lines,
        consequence: "kept as source; its parts cannot be commented on individually",
      });
    } else {
      addDiagramTargets(model, diagram, parse, repoRoot, docDir);
    }
    diagram.digest = digestValue({
      direction: diagram.direction,
      supported: diagram.supported,
      targets: diagram.targetKeys.map((k) => model.targets.get(k)!.digest),
    });
    model.diagrams.push(diagram);
  }

  addImageTargets(model, scan.lines, repoRoot, docDir);
  return model;
}

function addDiagramTargets(
  model: DocModel,
  diagram: DiagramModel,
  parse: MermaidParse,
  repoRoot: string,
  docDir: string,
): void {
  const descriptions = new Map<string, string>();
  const icons = new Map<string, AssetRef>();
  const sources = new Map<string, SourceLink[]>();
  const local = new Map<string, Target>();
  const claimed = new Map<string, number>();

  const diag = (severity: Diagnostic["severity"], line: number, message: string) =>
    model.diagnostics.push({ severity, line, message, diagramId: diagram.id });

  // Digests are filled in once descriptions and icons are known.
  const register = (target: Omit<Target, "key" | "digest">) => {
    const full: Target = { ...target, key: targetKey(diagram.id, target.id), digest: "" };
    claimed.set(target.id, (claimed.get(target.id) ?? 0) + 1);
    local.set(target.id, full);
    return full;
  };

  const groupTargets: Target[] = [];
  for (const group of parse.groups.values()) {
    groupTargets.push(
      register({
        id: `g.${group.id}`,
        kind: "group",
        diagramId: diagram.id,
        sectionId: diagram.sectionId,
        label: group.title,
        mapping: group.idDeclared ? "exact" : "derived",
        idSource: group.idDeclared ? "authored" : "derived",
        lines: { start: group.startLine, end: group.endLine },
        members: [...group.members],
        parentId: group.parentId ? `g.${group.parentId}` : undefined,
      }),
    );
  }

  const nodeTargets: Target[] = [];
  for (const node of parse.nodes.values()) {
    nodeTargets.push(
      register({
        id: `n.${node.id}`,
        kind: "node",
        diagramId: diagram.id,
        sectionId: diagram.sectionId,
        label: node.label,
        mapping: "exact",
        idSource: "authored",
        lines: { start: node.lines[0]!, end: node.lines[node.lines.length - 1]! },
        shape: node.shape,
        groupId: node.groupId ? `g.${node.groupId}` : undefined,
      }),
    );
  }

  // Derived edge ids count edges per endpoint pair so that repeats are visible.
  const pairCount = new Map<string, number>();
  for (const edge of parse.edges) {
    const pair = `${edge.from}.${edge.to}`;
    pairCount.set(pair, (pairCount.get(pair) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();
  const edgeTargets: Target[] = [];
  for (const edge of parse.edges) {
    const pair = `${edge.from}.${edge.to}`;
    const ordinal = (pairSeen.get(pair) ?? 0) + 1;
    pairSeen.set(pair, ordinal);
    let id = `e.${pair}${ordinal > 1 ? `.${ordinal}` : ""}`;
    let idSource: Target["idSource"] = "derived";
    if (edge.declaredId !== undefined) {
      if (!TARGET_ID_RE.test(edge.declaredId) || /^(n|g)\./.test(edge.declaredId)) {
        diag(
          "error",
          edge.directiveLine ?? edge.line,
          `invalid edge id "${edge.declaredId}"; use letters, digits, ".", "-" or "_" and do not start with n. or g.`,
        );
      } else {
        id = edge.declaredId;
        idSource = "declared";
      }
    } else if (ordinal === 2) {
      diag(
        "warning",
        edge.line,
        `${pairCount.get(pair)} edges join "${edge.from}" and "${edge.to}"; declare ids with "%% htmi:edge <id>" so comments cannot move between them`,
      );
    }
    const fromLabel = parse.nodes.get(edge.from)?.label ?? edge.from;
    const toLabel = parse.nodes.get(edge.to)?.label ?? edge.to;
    edgeTargets.push(
      register({
        id,
        kind: "edge",
        diagramId: diagram.id,
        sectionId: diagram.sectionId,
        label: edge.label ? `${fromLabel} -> ${toLabel} (${edge.label})` : `${fromLabel} -> ${toLabel}`,
        mapping: idSource === "declared" ? "exact" : "derived",
        idSource,
        lines: { start: edge.directiveLine ?? edge.line, end: edge.line },
        from: `n.${edge.from}`,
        to: `n.${edge.to}`,
        style: edge.style,
        head: edge.head,
        tail: edge.tail,
        edgeLabel: edge.label,
      }),
    );
  }

  for (const [id, count] of claimed) {
    if (count > 1) {
      diagram.ambiguousIds.push(id);
      diag(
        "error",
        diagram.lines.start,
        `target id "${id}" is claimed by ${count} elements; comments on it are treated as ambiguous`,
      );
    }
  }

  const resolveRef = (raw: string | undefined, line: number, directive: string): Target | undefined => {
    if (!raw) {
      diag("error", line, `htmi:${directive} needs a target`);
      return undefined;
    }
    const target = local.get(raw) ?? local.get(`n.${raw}`) ?? local.get(`g.${raw}`);
    if (!target) diag("error", line, `htmi:${directive} refers to unknown target "${raw}"`);
    return target;
  };

  for (const directive of parse.directives) {
    switch (directive.name) {
      case "diagram":
      case "edge":
        break;
      case "describe": {
        const target = resolveRef(directive.args[0], directive.line, "describe");
        const text = directive.rest.slice((directive.args[0] ?? "").length).trim();
        if (target && text) descriptions.set(target.id, text);
        else if (target) diag("error", directive.line, "htmi:describe needs a description after the target");
        break;
      }
      case "icon": {
        const target = resolveRef(directive.args[0], directive.line, "icon");
        const ref = directive.args[1];
        if (!target) break;
        if (!ref) {
          diag("error", directive.line, "htmi:icon needs an image path or lucide:<name>");
          break;
        }
        const asset = resolveAsset(ref, repoRoot, docDir);
        if (asset.error) diag("error", directive.line, `icon "${ref}": ${asset.error}`);
        icons.set(target.id, asset);
        break;
      }
      case "source": {
        const target = resolveRef(directive.args[0], directive.line, "source");
        const ref = directive.args[1];
        if (!target) break;
        if (!ref) {
          diag("error", directive.line, "htmi:source needs a repository path");
          break;
        }
        const link = resolveSourceLink(ref, repoRoot, docDir);
        if (link.error) diag("error", directive.line, `source "${ref}": ${link.error}`);
        sources.set(target.id, [...(sources.get(target.id) ?? []), link]);
        break;
      }
      default:
        diag("warning", directive.line, `unknown directive htmi:${directive.name}`);
    }
  }

  // Digests cover the properties that give a target its meaning, not layout or source links.
  for (const target of [...groupTargets, ...nodeTargets, ...edgeTargets]) {
    target.description = descriptions.get(target.id);
    target.icon = icons.get(target.id);
    target.sources = sources.get(target.id);
    if (target.kind === "node") {
      target.digest = digestValue({
        kind: "node",
        label: target.label,
        shape: target.shape,
        group: target.groupId,
        description: target.description,
        icon: target.icon?.digest ?? target.icon?.ref,
      });
    } else if (target.kind === "edge") {
      target.digest = digestValue({
        kind: "edge",
        from: target.from,
        to: target.to,
        label: target.edgeLabel,
        style: target.style,
        head: target.head,
        tail: target.tail,
        description: target.description,
      });
    } else {
      target.digest = digestValue({
        kind: "group",
        label: target.label,
        members: [...(target.members ?? [])].sort(),
        parent: target.parentId,
        description: target.description,
        icon: target.icon?.digest ?? target.icon?.ref,
      });
    }
    if (diagram.ambiguousIds.includes(target.id)) continue;
    model.targets.set(target.key, target);
    diagram.targetKeys.push(target.key);
  }
}

const SOURCE_REF_RE = /^([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/;

function resolveSourceLink(ref: string, repoRoot: string, docDir: string): SourceLink {
  const m = SOURCE_REF_RE.exec(ref);
  if (!m) return { ref, exists: false, error: "expected path or path#L10-L20" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(m[1]!))
    return { ref, exists: false, error: "URLs are not source links; use a repository path" };
  const absolute = m[1]!.startsWith("/") ? join(repoRoot, m[1]!) : join(docDir, m[1]!);
  const rel = repoRelative(repoRoot, absolute);
  if (!rel) return { ref, exists: false, error: "path is outside the repository" };
  const lines = m[2] ? { start: Number(m[2]), end: Number(m[3] ?? m[2]) } : undefined;
  return {
    ref,
    path: rel,
    lines,
    exists: existsSync(absolute),
    error: existsSync(absolute) ? undefined : "file not found",
  };
}

function addImageTargets(model: DocModel, lines: string[], repoRoot: string, docDir: string): void {
  for (const section of model.sections) {
    const text = lines.slice(section.startLine - 1, section.endLine).join("\n");
    const seen = new Map<string, number>();
    let searchFrom = 0;
    walkTokens(marked.lexer(text), (token) => {
      if (token.type !== "image") return;
      const src = (token as Token & { href: string }).href;
      const occurrence = (seen.get(src) ?? 0) + 1;
      seen.set(src, occurrence);
      const id = imageTargetId(section.id, src, occurrence);
      const at = text.indexOf(token.raw, searchFrom);
      if (at >= 0) searchFrom = at + token.raw.length;
      const line = section.startLine + (at >= 0 ? text.slice(0, at).split("\n").length - 1 : 0);
      const asset = resolveAsset(src, repoRoot, docDir);
      const alt = (token as Token & { text: string }).text ?? "";
      if (asset.error && !/^https?:/i.test(src)) {
        model.diagnostics.push({ severity: "warning", line, message: `image "${src}": ${asset.error}` });
      }
      if (/^https?:/i.test(src)) {
        model.coverage.push({
          what: `remote image ${src}`,
          lines: { start: line, end: line },
          consequence: "not embedded in review snapshots; shown as a link",
        });
      }
      model.targets.set(id, {
        key: id,
        id,
        kind: "image",
        sectionId: section.id,
        label: alt || basename(src),
        mapping: "derived",
        idSource: "derived",
        lines: { start: line, end: line },
        asset,
        alt,
        digest: digestValue({ kind: "image", src, alt, asset: asset.digest ?? null }),
      });
    });
  }
}

function walkTokens(tokens: Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    const nested = token as Token & { tokens?: Token[]; items?: Token[] };
    if (nested.tokens) walkTokens(nested.tokens, visit);
    if (nested.items) walkTokens(nested.items, visit);
  }
}
