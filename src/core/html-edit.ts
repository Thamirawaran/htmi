import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeHTML } from "entities";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { resolveAsset } from "./assets.js";
import { digestOf } from "./digest.js";
import type { DocModel, Target } from "./document.js";
import { buildHtmlModel, childNodes, isElement } from "./html.js";
import { repoRelative } from "./revision.js";
import { normaliseSpace, occurrences } from "./text.js";

/**
 * Source-preserving edits to HTML documents. Every edit is a splice of the
 * original text at offsets parse5 reports; the parsed tree is never
 * serialised back, so quoting, whitespace, comments, scripts and styles
 * outside the edit stay byte for byte. After the splice the document is
 * parsed again and every target the edit could not touch must keep its
 * digest. Offsets are UTF-16 code units of the file decoded as UTF-8.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export class EditConflict extends Error {
  constructor(
    readonly reason: "stale-document" | "stale-target" | "not-found" | "unsupported" | "invalid" | "check-failed",
    message: string,
    readonly target?: Pick<Target, "key" | "label" | "digest">,
  ) {
    super(message);
  }
}

function fail(reason: EditConflict["reason"], message: string, target?: Target): never {
  throw new EditConflict(
    reason,
    message,
    target ? { key: target.key, label: target.label, digest: target.digest } : undefined,
  );
}

/** Map from each decoded character of a text node to its range in the raw source. */
export function decodeWithMap(raw: string): { decoded: string; from: number[]; to: number[] } {
  let decoded = "";
  const from: number[] = [];
  const to: number[] = [];
  const push = (text: string, start: number, end: number) => {
    for (const ch of text) {
      for (let k = 0; k < ch.length; k++) {
        decoded += ch[k];
        from.push(start);
        to.push(end);
      }
    }
  };
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i]!;
    if (ch === "\r") {
      const end = raw[i + 1] === "\n" ? i + 2 : i + 1;
      push("\n", i, end);
      i = end;
      continue;
    }
    if (ch === "&") {
      const m = /^&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)/.exec(raw.slice(i, i + 40));
      if (m) {
        const value = decodeHTML(m[0]);
        if (value !== m[0]) {
          push(value, i, i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
    }
    push(ch, i, i + 1);
    i++;
  }
  return { decoded, from, to };
}

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Collapse whitespace like normaliseSpace, keeping where each character came from. */
function normaliseWithMap(text: string): { text: string; index: number[] } {
  let out = "";
  const index: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]!);
    if (isSpace && space) continue;
    out += isSpace ? " " : text[i];
    index.push(i);
    space = isSpace;
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    index.pop();
  }
  return { text: out, index };
}

interface MappedText {
  node: TextNode;
  /** Absolute offset of the raw text in the document. */
  base: number;
  map: ReturnType<typeof decodeWithMap>;
}

/** Text nodes under an element whose decoded value can be mapped back to the source exactly. */
function mappedTextNodes(
  content: string,
  root: Node,
  accept: (n: TextNode) => boolean,
): {
  nodes: MappedText[];
  unmapped: number;
} {
  const nodes: MappedText[] = [];
  let unmapped = 0;
  const walk = (n: Node, parent: Element | null) => {
    if (n.nodeName === "#text") {
      const t = n as TextNode;
      if (!accept(t)) return;
      const loc = t.sourceCodeLocation;
      if (!loc) {
        unmapped++;
        return;
      }
      let base = loc.startOffset;
      let raw = content.slice(loc.startOffset, loc.endOffset);
      // The parser drops one newline right after <pre>, <textarea> and <listing>.
      if (parent && /^(pre|textarea|listing)$/.test(parent.tagName) && parent.childNodes[0] === n) {
        const lead = /^(\r\n|\r|\n)/.exec(raw);
        if (lead && !t.value.startsWith("\n")) {
          base += lead[0].length;
          raw = raw.slice(lead[0].length);
        }
      }
      const map = decodeWithMap(raw);
      if (map.decoded !== t.value) {
        unmapped++;
        return;
      }
      nodes.push({ node: t, base, map });
      return;
    }
    if (isElement(n) && /^(script|style|template|noscript)$/.test(n.tagName)) return;
    for (const c of childNodes(n)) walk(c, isElement(n) ? n : parent);
  };
  walk(root, null);
  return { nodes, unmapped };
}

/** Find `find` (whitespace flexible) in exactly one text node and return the source edit that replaces it. */
function textEdit(nodes: MappedText[], find: string, replace: string, where: string): SourceEdit {
  const needle = normaliseSpace(find);
  if (!needle) fail("invalid", "find is empty");
  const combined = normaliseSpace(nodes.map((n) => n.node.value).join(""));
  const total = occurrences(combined, needle).length;
  if (total === 0) fail("not-found", `the text was not found in ${where}`);
  if (total > 1) fail("invalid", `the text appears ${total} times in ${where}; include more of it`);
  const hits: { node: MappedText; start: number; end: number }[] = [];
  for (const node of nodes) {
    const norm = normaliseWithMap(node.node.value);
    for (const at of occurrences(norm.text, needle)) {
      const start = norm.index[at]!;
      const end = norm.index[at + needle.length - 1]! + 1;
      hits.push({ node, start, end });
    }
  }
  if (hits.length !== 1) {
    fail(
      "unsupported",
      `the text in ${where} crosses inline markup (for example <em> or <a>); edit the markup deliberately with replace-source`,
    );
  }
  const hit = hits[0]!;
  const rawStart = hit.node.map.from[hit.start]!;
  const rawEnd = hit.node.map.to[hit.end - 1]!;
  return { start: hit.node.base + rawStart, end: hit.node.base + rawEnd, text: escapeText(replace) };
}

function elementAt(content: string, start: number): Element | undefined {
  const tree = parse(content, { sourceCodeLocationInfo: true });
  let found: Element | undefined;
  const walk = (n: Node) => {
    if (found) return;
    if (isElement(n) && n.sourceCodeLocation?.startOffset === start) {
      found = n;
      return;
    }
    childNodes(n).forEach(walk);
  };
  walk(tree as unknown as Node);
  return found;
}

function requireTarget(doc: DocModel, key: string, expected: string): { target: Target; el: Element } {
  if (doc.ambiguousKeys?.includes(key))
    fail("unsupported", `${key} is claimed by more than one element; fix the duplicate first`);
  const target = doc.targets.get(key);
  if (!target) fail("not-found", `no target "${key}" in ${doc.path}; run \`htmi targets ${doc.path}\``);
  if (target.digest !== expected) fail("stale-target", `${key} changed since the operation was prepared`, target);
  if (!target.span) fail("unsupported", `${key} has no source position`);
  const el = elementAt(doc.content, target.span.start);
  if (!el) fail("unsupported", `${key} could not be located in the source`);
  return { target, el };
}

const SETTABLE =
  /^(alt|title|href|src|cite|lang|datetime|value|colspan|rowspan|aria-[a-z-]+|data-(?!hm-)[a-z0-9_.-]+)$/;

export type HtmlOp =
  | { op: "replace-text"; sectionId: string; find: string; replace: string }
  | { op: "set-text"; target: string; expectedTargetDigest: string; find: string; replace: string }
  | { op: "set-attribute"; target: string; expectedTargetDigest: string; name: string; value: string }
  | { op: "replace-source"; target: string; expectedTargetDigest: string; find: string; replace: string };

export interface HtmlPlan {
  edits: SourceEdit[];
  /** Keys the operation means to change. */
  named: string[];
  check?: (after: DocModel) => string | null;
}

export function planHtmlEdit(doc: DocModel, repoRoot: string, op: HtmlOp): HtmlPlan {
  const content = doc.content;
  switch (op.op) {
    case "replace-text": {
      const section = doc.sections.find((s) => s.id === op.sectionId);
      if (!section) fail("not-found", `no section "${op.sectionId}"`);
      const headings = new Set<Node>();
      const tree = parse(content, { sourceCodeLocationInfo: true });
      const inSection = (n: TextNode) => {
        const line = n.sourceCodeLocation?.startLine ?? 0;
        return line >= section.startLine && line <= section.endLine;
      };
      // Section prose, as for comments: not headings, SVG, math or anything in <head>.
      const { nodes } = mappedTextNodes(content, tree as unknown as Node, (t) => {
        for (let p: Node | null = t.parentNode as Node | null; p; p = (p as Element).parentNode as Node | null) {
          if (headings.has(p)) return false;
          if (
            isElement(p) &&
            (/^h[1-6]$/.test(p.tagName) || p.tagName === "svg" || p.tagName === "math" || p.tagName === "head")
          ) {
            headings.add(p);
            return false;
          }
        }
        return inSection(t);
      });
      return { edits: [textEdit(nodes, op.find, op.replace, `section "${section.title}"`)], named: [] };
    }
    case "set-text": {
      const { target, el } = requireTarget(doc, op.target, op.expectedTargetDigest);
      const { nodes } = mappedTextNodes(content, el, () => true);
      const edit = textEdit(nodes, op.find, op.replace, target.key);
      const before = plainText(el);
      return {
        edits: [edit],
        named: [target.key],
        check: (after) => {
          const now = after.targets.get(target.key);
          if (!now?.span) return `${target.key} is missing after the edit`;
          const el2 = elementAt(after.content, now.span.start);
          const expected = normaliseSpace(before.replace(normaliseSpace(op.find), normaliseSpace(op.replace)));
          const got = el2 ? plainText(el2) : "";
          return got === expected ? null : `${target.key} reads back as "${got.slice(0, 120)}"`;
        },
      };
    }
    case "set-attribute": {
      const { target, el } = requireTarget(doc, op.target, op.expectedTargetDigest);
      const name = op.name.toLowerCase();
      if (!SETTABLE.test(name)) {
        fail(
          "unsupported",
          `attribute "${op.name}" cannot be set this way; allowed: alt, title, href, src, cite, lang, datetime, value, colspan, rowspan, aria-*, data-*`,
        );
      }
      if ((name === "href" || name === "src" || name === "cite") && /^\s*(javascript|vbscript|data):/i.test(op.value)) {
        fail("invalid", `${name} cannot use a javascript:, vbscript: or data: URL`);
      }
      if (name === "src" && el.tagName === "img" && !/^https?:/i.test(op.value)) {
        const asset = resolveAsset(op.value, repoRoot, dirname(join(repoRoot, doc.path)));
        if (asset.error) fail("invalid", `src "${op.value}": ${asset.error}`);
      }
      const loc = el.sourceCodeLocation!;
      const existing = loc.attrs?.[name];
      const text = `${name}="${escapeAttr(op.value)}"`;
      let edit: SourceEdit;
      if (existing) edit = { start: existing.startOffset, end: existing.endOffset, text };
      else {
        const tagName = /^<([^\s/>]+)/.exec(content.slice(loc.startOffset, loc.startOffset + 64));
        if (!tagName) fail("unsupported", `could not read the start tag of ${target.key}`);
        const at = loc.startOffset + 1 + tagName[1]!.length;
        edit = { start: at, end: at, text: ` ${text}` };
      }
      return {
        edits: [edit],
        named: [target.key],
        check: (after) => {
          const el2 = elementAt(after.content, loc.startOffset);
          const value = el2?.attrs.find((a) => a.name === name)?.value;
          return value === op.value ? null : `${name} reads back as ${value === undefined ? "missing" : `"${value}"`}`;
        },
      };
    }
    case "replace-source": {
      const { target } = requireTarget(doc, op.target, op.expectedTargetDigest);
      const span = target.span!;
      const region = content.slice(span.start, span.end);
      const hits = occurrences(region, op.find);
      if (hits.length === 0) fail("not-found", `the source text was not found inside ${target.key}`);
      if (hits.length > 1)
        fail("invalid", `the source text appears ${hits.length} times inside ${target.key}; include more of it`);
      const start = span.start + hits[0]!;
      return { edits: [{ start, end: start + op.find.length, text: op.replace }], named: [target.key] };
    }
  }
}

/** Selectable text of an element: text nodes joined as a browser shows them, whitespace collapsed. */
export function plainText(el: Node): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeName === "#text") parts.push((n as TextNode).value);
    else if (isElement(n) && /^(script|style|template|noscript)$/.test(n.tagName)) return;
    else childNodes(n).forEach(walk);
  };
  walk(el);
  return normaliseSpace(parts.join(""));
}

export function applyEdits(content: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.end > sorted[i - 1]!.start) fail("invalid", "edits overlap");
  }
  let out = content;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export type TargetChangeKind = "added" | "removed" | "changed" | "moved";

/**
 * Every target outside the edited ranges must be unchanged. Targets that
 * contain an edit, or sit inside one, may change. Derived keys name positions,
 * so a derived block whose content is unchanged may get a new key; that is
 * reported as moved rather than refused.
 */
export function verifyHtmlEdit(
  before: DocModel,
  after: DocModel,
  edits: SourceEdit[],
  named: string[],
): { changes: { key: string; change: TargetChangeKind; to?: string }[]; problems: string[] } {
  const touches = (span: { start: number; end: number } | undefined, ranges: { start: number; end: number }[]) =>
    !!span && ranges.some((r) => span.start <= r.end && r.start <= span.end);
  const beforeRanges = edits.map((e) => ({ start: e.start, end: e.end }));
  // Edit ranges in the new text: each later edit is shifted by the length change of earlier ones.
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let shift = 0;
  const afterRanges = sorted.map((e) => {
    const r = { start: e.start + shift, end: e.start + shift + e.text.length };
    shift += e.text.length - (e.end - e.start);
    return r;
  });

  const changes: { key: string; change: TargetChangeKind; to?: string }[] = [];
  const problems: string[] = [];
  const unmatchedAfter = new Map([...after.targets].filter(([, t]) => !touches(t.span, afterRanges)));

  for (const [key, t] of before.targets) {
    const now = after.targets.get(key);
    const affected = touches(t.span, beforeRanges) || named.includes(key);
    if (affected) {
      if (!now) changes.push({ key, change: "removed" });
      else if (now.digest !== t.digest) changes.push({ key, change: "changed" });
      unmatchedAfter.delete(key);
      continue;
    }
    if (now && now.digest === t.digest && unmatchedAfter.has(key)) {
      unmatchedAfter.delete(key);
      continue;
    }
    if (t.idSource === "derived") {
      const same = [...unmatchedAfter.values()].find(
        (x) => x.idSource === "derived" && x.digest === t.digest && x.block?.tag === t.block?.tag,
      );
      if (same) {
        unmatchedAfter.delete(same.key);
        changes.push({ key, change: "moved", to: same.key });
        continue;
      }
    }
    problems.push(`${key} would ${now ? "change" : "disappear"}`);
  }
  for (const [key, t] of after.targets) {
    if (before.targets.has(key) && !unmatchedAfter.has(key)) continue;
    if (touches(t.span, afterRanges)) {
      if (!before.targets.has(key)) changes.push({ key, change: "added" });
      continue;
    }
    if (unmatchedAfter.has(key) && !changes.some((c) => c.to === key))
      problems.push(`${key} would appear outside the edit`);
  }
  const errorsBefore = before.diagnostics.filter((d) => d.severity === "error").length;
  const errorsAfter = after.diagnostics.filter((d) => d.severity === "error");
  if (errorsAfter.length > errorsBefore) problems.push(`new errors: ${errorsAfter.map((d) => d.message).join("; ")}`);
  return { changes, problems };
}

/** Rebuild the model of edited HTML content with the same path and revision. */
export function rebuildHtml(doc: DocModel, repoRoot: string, content: string): DocModel {
  return buildHtmlModel(content, doc.path, repoRoot, doc.revision);
}

const TEXT_FILE = /\.(css|js|mjs|cjs|json|svg|csv|tsv|txt|xml|yaml|yml)$/i;

/**
 * A text file the document depends on (a stylesheet, script, SVG image or
 * data file in the document's folder). Returns its repository path.
 */
export function editableDependency(doc: DocModel, repoRoot: string, path: string): string {
  const clean = path.replace(/^\.\//, "");
  const absolute = resolve(repoRoot, clean);
  const rel = repoRelative(repoRoot, absolute);
  if (!rel) fail("invalid", `${path} is outside the repository`);
  if (!TEXT_FILE.test(rel))
    fail("unsupported", `${rel} is not a text file HTMi edits (css, js, json, svg, csv, txt, xml, yaml)`);
  if (!existsSync(absolute)) fail("not-found", `${rel} does not exist`);
  const real = repoRelative(realpathSync(repoRoot), realpathSync(absolute));
  if (!real) fail("invalid", `${path} resolves outside the repository`);
  const docDir = dirname(doc.path);
  const isDependency = doc.dependencies?.some((d) => d.path === real && d.status === "ok");
  const besideDocument = docDir === "." || real.startsWith(`${docDir}/`);
  if (!isDependency && !besideDocument) {
    fail("unsupported", `${real} is neither referenced by ${doc.path} nor in its folder`);
  }
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) fail("unsupported", `${real} is not a text file`);
  return real;
}

export function fileDigest(repoRoot: string, path: string): string {
  return digestOf(readFileSync(join(repoRoot, path)));
}
