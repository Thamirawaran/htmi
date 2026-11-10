import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { resolveAsset } from "./assets.js";
import { digestOf, digestValue } from "./digest.js";
import {
  derivedDocumentId,
  imageTargetId,
  targetKey,
  type BlockInfo,
  type BlockKind,
  type CoverageItem,
  type Dependency,
  type DiagramModel,
  type DocDiagnostic,
  type DocModel,
  type ReadingItem,
  type Target,
} from "./document.js";
import { PREAMBLE_SECTION_ID, slugify, splitLines, type Alert, type Section } from "./markdown.js";
import { repoRelative, type SourceRevision } from "./revision.js";
import { normaliseSpace } from "./text.js";

/**
 * Adapter for HTML documents. The page is parsed, never executed, and needs
 * nothing added to it: headings make sections, ordinary content (paragraphs,
 * lists, tables, code, figures, images, SVG, math, cards) becomes readable
 * blocks, and every element with an authored `id` is a commentable target
 * (`#id`). Blocks without an id get a derived key such as `b.costs.table1`,
 * which is honest about being positional.
 *
 * Optional attributes add meaning where an author wants it:
 *
 *   <meta name="htmi:document" content="id">   a stable document id
 *   data-doc-diagram="pipeline"                  a diagram container (often an <svg>)
 *   data-doc-target="n.resolver"                 a diagram part or named element
 *   data-doc-kind="node|edge|group"              optional; inferred otherwise
 *   data-doc-from / data-doc-to                  endpoints of an edge
 *   data-doc-description="..."                   authored meaning
 *   data-doc-constraint                          a block that context must always include
 *
 * Target digests cover an element's full content (text, structure and
 * meaningful attributes), never a shortened label. Layout and paint
 * attributes are left out, so moving a box is not a content change.
 * Everything the adapter cannot represent is listed in `coverage`.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATH_NS = "http://www.w3.org/1998/Math/MathML";

const KINDS = new Set(["node", "edge", "group", "element"]);
const TARGET_ID_RE = /^[A-Za-z][\w.-]*$/;
/** Authored ids HTMi can carry as a target key (`#id`). HTML allows any id without whitespace. */
const HTML_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,190}$/;

/** Text in these elements is not prose a reader can select. MathML annotations hold source, not rendered text. */
const NO_PROSE = new Set(["script", "style", "template", "noscript", "title", "annotation", "annotation-xml"]);
/** Elements whose subtree is a single readable block; blocks are not derived inside them. */
const LEAF_BLOCKS: Record<string, BlockKind> = {
  p: "paragraph",
  ul: "list",
  ol: "list",
  menu: "list",
  dl: "definition-list",
  table: "table",
  pre: "code",
  figure: "figure",
  blockquote: "quote",
  address: "paragraph",
};
const CONTAINERS = new Set([
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "details",
  "fieldset",
  "form",
  "hgroup",
  "search",
  "center",
]);
const PHRASING = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "mark",
  "meter",
  "output",
  "progress",
  "q",
  "s",
  "samp",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "svg",
  "math",
  "textarea",
  "time",
  "u",
  "var",
  "wbr",
]);
const KEY_PREFIX: Record<string, string> = {
  paragraph: "p",
  list: "list",
  "definition-list": "dl",
  table: "table",
  code: "code",
  figure: "figure",
  quote: "quote",
  svg: "svg",
  math: "math",
};
/** SVG elements that are definitions, not drawn content. */
const SVG_NOT_DRAWN = new Set([
  "defs",
  "marker",
  "lineargradient",
  "radialgradient",
  "pattern",
  "clippath",
  "mask",
  "filter",
  "symbol",
  "style",
  "script",
  "title",
  "desc",
  "metadata",
]);
/** Attributes that change appearance, state or identity rather than content; left out of digests. */
const HTML_PRESENTATION = new Set([
  "class",
  "style",
  "id",
  "width",
  "height",
  "loading",
  "decoding",
  "tabindex",
  "nonce",
  "contenteditable",
  "draggable",
  "spellcheck",
  "translate",
  "open",
  "fetchpriority",
]);

export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function isElement(node: Node): node is Element {
  return "tagName" in node;
}

export function childNodes(node: Node): Node[] {
  if ("content" in node && node.nodeName === "template") return [];
  return "childNodes" in node ? (node.childNodes as Node[]) : [];
}

function isHtml(el: Element): boolean {
  return el.namespaceURI === HTML_NS;
}

/** Elements whose children a reader sees as separate pieces of text. */
const SEPARATED =
  /^(p|div|li|h[1-6]|tr|td|th|section|article|figure|figcaption|br|dt|dd|caption|ul|ol|dl|table|thead|tbody|tfoot|select|optgroup|option|label)$/;

/** Text of a subtree, with block boundaries kept as spaces, for labels and readable output. */
export function textOf(node: Node, skip = NO_PROSE): string {
  if (node.nodeName === "#text") return (node as TextNode).value;
  if (isElement(node) && skip.has(node.tagName)) return "";
  return childNodes(node)
    .map((c) => textOf(c, skip))
    .join(isElement(node) && SEPARATED.test(node.tagName) ? " " : "");
}

/** Exact text content, whitespace kept (for code). */
function rawText(node: Node): string {
  if (node.nodeName === "#text") return (node as TextNode).value;
  if (isElement(node) && (node.tagName === "script" || node.tagName === "style")) return "";
  return childNodes(node).map(rawText).join("");
}

function short(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function lineOf(node: Node): { start: number; end: number } {
  const loc = (node as Element).sourceCodeLocation;
  return { start: loc?.startLine ?? 1, end: loc?.endLine ?? loc?.startLine ?? 1 };
}

function spanOf(node: Node): { start: number; end: number } | undefined {
  const loc = (node as Element).sourceCodeLocation;
  return loc ? { start: loc.startOffset, end: loc.endOffset } : undefined;
}

/** Visible label of an element: aria-label, an SVG <title>, then its text. Display only. */
function labelOf(el: Element): string {
  const aria = attr(el, "aria-label");
  if (aria) return normaliseSpace(aria);
  const title = childNodes(el).find((c) => isElement(c) && c.tagName === "title");
  if (title) return normaliseSpace(textOf(title, new Set()));
  return short(normaliseSpace(textOf(el, new Set([...NO_PROSE, "desc"]))));
}

function descriptionOf(el: Element): string | undefined {
  const explicit = attr(el, "data-doc-description");
  if (explicit) return normaliseSpace(explicit);
  const desc = childNodes(el).find((c) => isElement(c) && c.tagName === "desc");
  return desc ? normaliseSpace(textOf(desc, new Set())) || undefined : undefined;
}

/** Attributes that carry content, for the digest. SVG keeps only links, accessibility and data attributes. */
function meaningfulAttrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of el.attrs) {
    const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
    if (name.startsWith("data-hm-")) continue;
    if (isHtml(el)) {
      if (HTML_PRESENTATION.has(name)) continue;
    } else if (!/^(href|xlink:href|role|aria-.*|data-.*|alttext|encoding)$/.test(name)) continue;
    out[name] = a.value;
  }
  return out;
}

export function buildHtmlModel(content: string, path: string, repoRoot: string, revision: SourceRevision): DocModel {
  const tree = parse(content, { sourceCodeLocationInfo: true });
  const lines = splitLines(content);
  const docDir = dirname(join(repoRoot, path));
  const diagnostics: DocDiagnostic[] = [];
  const coverage: CoverageItem[] = [];
  const sections: Section[] = [];
  const quoteParts = new Map<string, string[]>();
  const alerts: Alert[] = [];
  const targets = new Map<string, Target>();
  const order: string[] = [];
  const diagrams: DiagramModel[] = [];
  const slugCounts = new Map<string, number>();
  const sectionIds = new Set<string>();
  const dependencies = new Map<string, Dependency>();
  let declaredId: string | undefined;
  let title: string | undefined;
  let svgWithoutTargets = 0;
  let scripts = 0;

  sections.push({
    id: PREAMBLE_SECTION_ID,
    title: "(before the first heading)",
    level: 0,
    startLine: 1,
    endLine: lines.length,
  });
  const currentSection = () => sections[sections.length - 1]!;

  // Authored ids are counted first so a duplicate is never treated as an identity.
  const idCount = new Map<string, number>();
  const countIds = (node: Node) => {
    if (isElement(node)) {
      const id = attr(node, "id");
      if (id !== undefined) idCount.set(id, (idCount.get(id) ?? 0) + 1);
    }
    childNodes(node).forEach(countIds);
  };
  countIds(tree as unknown as Node);
  const ambiguousKeys: string[] = [];
  for (const [id, n] of idCount) {
    if (n > 1 && HTML_ID_RE.test(id)) {
      ambiguousKeys.push(`#${id}`);
      diagnostics.push({
        severity: "warning",
        line: 1,
        message: `id "${id}" is used by ${n} elements; comments on #${id} are treated as ambiguous`,
      });
    }
  }

  const addDependency = (ref: string, kind: Dependency["kind"], baseDir: string, line?: number) => {
    const dep = resolveDependency(ref, kind, repoRoot, baseDir);
    if (!dep) return;
    const key = `${dep.kind}:${dep.path ?? dep.ref}`;
    if (!dependencies.has(key)) dependencies.set(key, { ...dep, line });
    if (dep.status === "ok" && dep.kind === "stylesheet" && dep.path) {
      const css = readFileSync(join(repoRoot, dep.path), "utf8");
      for (const url of cssUrls(css))
        addDependency(url, /\.(woff2?|ttf|otf)$/i.test(url) ? "font" : "image", dirname(join(repoRoot, dep.path)));
    }
  };

  // Content digests are Merkle style: an element's digest covers its tag, meaningful attributes and children.
  const memo = new Map<Node, unknown>();
  const canonical = (node: Node): unknown => {
    if (memo.has(node)) return memo.get(node);
    let value: unknown;
    if (node.nodeName === "#text") {
      const text = (node as TextNode).value.replace(/\s+/g, " ");
      value = text === "" ? null : text;
    } else if (!isElement(node)) {
      value = null;
    } else if (node.tagName === "script" || node.tagName === "style" || node.tagName === "template") {
      value = null;
    } else {
      const el = node;
      const extra: Record<string, unknown> = {};
      if (el.tagName === "img") {
        const src = attr(el, "src") ?? "";
        extra.asset = src ? (resolveAsset(src, repoRoot, docDir).digest ?? null) : null;
      }
      const kids = childNodes(el)
        .map(canonical)
        .filter((c) => c !== null);
      value = [el.tagName, meaningfulAttrs(el), extra, kids];
    }
    memo.set(node, value);
    return value;
  };
  const contentDigest = (el: Element) => digestValue(canonical(el));

  const derivedCounts = new Map<string, number>();
  const derivedKey = (sectionId: string, prefix: string) => {
    const slug = /^[A-Za-z0-9][\w-]*$/.test(sectionId) ? sectionId : slugify(sectionId) || "s";
    const base = `b.${slug}.${prefix}`;
    const n = (derivedCounts.get(base) ?? 0) + 1;
    derivedCounts.set(base, n);
    return `${base}${n}`;
  };

  const register = (target: Target) => {
    targets.set(target.key, target);
    order.push(target.key);
  };

  // Elements claimed per diagram, so duplicate ids can be rejected rather than guessed.
  const claimed = new Map<string, Target[]>();
  const diagramStack: DiagramModel[] = [];
  const imageSeen = new Map<string, Map<string, number>>();

  interface Ctx {
    inHead: boolean;
    inSvg: boolean;
    inMath: boolean;
    /** Inside a leaf block or an element that was itself made a block: no further derived blocks. */
    inBlock: boolean;
    inDefs: boolean;
    parentKey?: string;
  }

  const addQuoteText = (ctx: Ctx, text: string) => {
    if (ctx.inSvg || ctx.inMath || ctx.inHead) return;
    const id = currentSection().id;
    quoteParts.set(id, [...(quoteParts.get(id) ?? []), text]);
    if (!ctx.inBlock) loose.push(text);
  };

  // What a reader meets in each section, in order: blocks by key, and text that is in no block.
  const readingOrder = new Map<string, ReadingItem[]>();
  let loose: string[] = [];
  const flushLoose = () => {
    const text = normaliseSpace(loose.join(""));
    loose = [];
    if (!text) return;
    const id = currentSection().id;
    readingOrder.set(id, [...(readingOrder.get(id) ?? []), { text }]);
  };
  const readItem = (key: string) => {
    flushLoose();
    const id = currentSection().id;
    readingOrder.set(id, [...(readingOrder.get(id) ?? []), { key }]);
  };

  const visit = (node: Node, ctx: Ctx): void => {
    if (node.nodeName === "#text") {
      addQuoteText(ctx, (node as TextNode).value);
      return;
    }
    if (!isElement(node)) {
      childNodes(node).forEach((c) => visit(c, ctx));
      return;
    }
    const el = node;
    const tag = el.tagName;
    const html = isHtml(el);
    const line = lineOf(el);

    if (tag === "meta" && attr(el, "name") === "htmi:document") {
      const value = attr(el, "content") ?? "";
      if (TARGET_ID_RE.test(value)) declaredId = value;
      else diagnostics.push({ severity: "error", line: line.start, message: "htmi:document meta needs an id" });
    }
    if (tag === "title" && html && !title) title = normaliseSpace(textOf(el, new Set()));
    if (tag === "link" && /\bstylesheet\b/i.test(attr(el, "rel") ?? "") && attr(el, "href")) {
      addDependency(attr(el, "href")!, "stylesheet", docDir, line.start);
    }
    if (tag === "style") {
      for (const url of cssUrls(rawText(el)))
        addDependency(url, /\.(woff2?|ttf|otf)$/i.test(url) ? "font" : "image", docDir, line.start);
      return;
    }
    if (tag === "script") {
      scripts++;
      const src = attr(el, "src");
      if (src) addDependency(src, "script", docDir, line.start);
      coverage.push({
        what: src ? `script ${src}` : "inline script",
        lines: line,
        consequence: "not run when HTMi reads or shows the document; behaviour it adds is not represented",
      });
      return;
    }
    // Text the review view cannot show: templates, noscript, a stray <title> and embedded content.
    if (/^(template|noscript|title|iframe|frame|object|embed|applet|noembed|noframes)$/.test(tag)) {
      if (tag === "iframe" || tag === "object" || tag === "embed") {
        coverage.push({
          what: `${tag} ${attr(el, "src") ?? attr(el, "data") ?? ""}`.trim(),
          lines: line,
          consequence: "embedded content is not read",
        });
      }
      return;
    }

    const isHeading = html && /^h[1-6]$/.test(tag) && !ctx.inSvg;
    if (isHeading) {
      const text = normaliseSpace(textOf(el));
      if (!title && tag === "h1") title = text;
      const explicit = attr(el, "id");
      let id: string;
      if (explicit && !sectionIds.has(explicit)) id = explicit;
      else {
        if (explicit) {
          diagnostics.push({
            severity: "warning",
            line: line.start,
            message: `heading id "${explicit}" is used twice; the second section gets a derived id`,
          });
        }
        const base = slugify(text) || "section";
        let seen = slugCounts.get(base) ?? 0;
        id = seen === 0 ? base : `${base}-${seen}`;
        while (sectionIds.has(id)) id = `${base}-${++seen}`;
        slugCounts.set(base, seen + 1);
      }
      sectionIds.add(id);
      flushLoose();
      currentSection().endLine = line.start - 1;
      sections.push({ id, title: text, level: Number(tag[1]), startLine: line.start, endLine: lines.length });
      const key = usableId(explicit) ?? derivedKeyForHeading(id);
      register(blockTarget(el, key, explicit && usableId(explicit) ? "authored" : "derived", "heading", id, ctx));
      readItem(key);
      return;
    }

    if (tag === "canvas") {
      coverage.push({
        what: "canvas element",
        lines: line,
        consequence: "drawn at runtime; its contents cannot be addressed",
      });
    }
    if (html && tag.includes("-")) {
      coverage.push({
        what: `custom element <${tag}>`,
        lines: line,
        consequence: "defined by script; what it draws is not represented and it may show empty",
      });
    }
    if (tag === "video" || tag === "audio") {
      coverage.push({ what: `${tag} element`, lines: line, consequence: "media content is not transcribed" });
    }
    if (el.attrs.some((a) => a.name === "data-doc-constraint")) {
      alerts.push({
        kind: "IMPORTANT",
        text: normaliseSpace(textOf(el)),
        startLine: line.start,
        endLine: line.end,
        sectionId: currentSection().id,
      });
    }

    const next: Ctx = { ...ctx };
    if (tag === "svg") next.inSvg = true;
    if (tag === "math") next.inMath = true;
    if (!html && SVG_NOT_DRAWN.has(tag.toLowerCase())) next.inDefs = true;
    if (tag === "head") next.inHead = true;

    // Images: the asset is part of the target, so new bytes behind the same path are a change.
    if (tag === "img" && html) {
      const src = attr(el, "src") ?? "";
      const section = currentSection().id;
      const perSection = imageSeen.get(section) ?? new Map<string, number>();
      imageSeen.set(section, perSection);
      const occurrence = (perSection.get(src) ?? 0) + 1;
      perSection.set(src, occurrence);
      const authored = usableId(attr(el, "id"));
      const id = authored ?? imageTargetId(section, src, occurrence);
      const alt = attr(el, "alt");
      const asset = src ? resolveAsset(src, repoRoot, docDir) : { ref: src, kind: "file" as const, error: "no src" };
      if (src) addDependency(src, "image", docDir, line.start);
      if (alt === undefined) {
        coverage.push({
          what: `image ${src} without alt text`,
          lines: line,
          consequence: "its meaning is unknown to agents",
        });
      }
      const block: BlockInfo = { kind: "image", tag, text: alt ?? "", caption: undefined };
      if (!ctx.inBlock) readItem(id);
      register({
        key: id,
        id,
        kind: "image",
        sectionId: section,
        label: alt || src,
        mapping: authored ? "exact" : "derived",
        idSource: authored ? "authored" : "derived",
        lines: line,
        span: spanOf(el),
        parentKey: ctx.parentKey,
        asset,
        alt,
        block,
        digest: digestValue({ kind: "image", src, alt: alt ?? "", asset: asset.digest ?? null }),
      });
      return;
    }
    if (!html && (tag === "image" || tag === "use")) {
      const href = attr(el, "href") ?? el.attrs.find((a) => a.name === "href" && a.prefix === "xlink")?.value;
      if (href && !href.startsWith("#")) addDependency(href.replace(/#.*$/, ""), "image", docDir, line.start);
    }
    for (const name of ["src", "poster"] as const) {
      const value = attr(el, name);
      if (value && html && /^(video|audio|source|track|embed|iframe)$/.test(tag))
        addDependency(value, "media", docDir, line.start);
      if (value && name === "poster") addDependency(value, "image", docDir, line.start);
    }

    const diagramId = attr(el, "data-doc-diagram");
    let opened: DiagramModel | undefined;
    if (diagramId !== undefined) {
      if (!TARGET_ID_RE.test(diagramId) || diagrams.some((d) => d.id === diagramId)) {
        diagnostics.push({
          severity: "error",
          line: line.start,
          message: `diagram id "${diagramId}" is invalid or used twice`,
        });
      } else {
        opened = {
          id: diagramId,
          idSource: "declared",
          sectionId: currentSection().id,
          title: attr(el, "aria-label") ?? currentSection().title,
          lines: line,
          direction: "TB",
          supported: true,
          targetKeys: [],
          ambiguousIds: [],
          presentationLines: [],
          digest: "",
          span: spanOf(el),
        };
        diagrams.push(opened);
        diagramStack.push(opened);
      }
    }

    const declaredTarget = attr(el, "data-doc-target");
    if (declaredTarget !== undefined) {
      if (!TARGET_ID_RE.test(declaredTarget)) {
        diagnostics.push({
          severity: "error",
          line: line.start,
          message: `invalid data-doc-target "${declaredTarget}"`,
        });
      } else {
        const diagram = diagramStack[diagramStack.length - 1];
        const declaredKind = attr(el, "data-doc-kind");
        const from = attr(el, "data-doc-from");
        const to = attr(el, "data-doc-to");
        let kind: Target["kind"];
        if (declaredKind && KINDS.has(declaredKind)) kind = declaredKind as Target["kind"];
        else if (from && to) kind = "edge";
        else if (diagram) kind = "node";
        else kind = "element";
        if (declaredKind && !KINDS.has(declaredKind)) {
          diagnostics.push({
            severity: "warning",
            line: line.start,
            message: `unknown data-doc-kind "${declaredKind}"`,
          });
        }
        if (kind === "edge" && (!from || !to)) {
          diagnostics.push({
            severity: "error",
            line: line.start,
            message: `edge "${declaredTarget}" needs data-doc-from and data-doc-to`,
          });
        }
        const label = labelOf(el) || declaredTarget;
        const description = descriptionOf(el);
        const target: Target = {
          key: targetKey(diagram?.id, declaredTarget),
          id: declaredTarget,
          kind,
          diagramId: diagram?.id,
          sectionId: currentSection().id,
          label,
          mapping: "exact",
          idSource: "declared",
          lines: line,
          span: spanOf(el),
          parentKey: ctx.parentKey,
          from,
          to,
          description,
          block: kind === "element" ? blockInfo(el, "element") : undefined,
          digest: contentDigest(el),
          // The digest used before full-content digests, kept to read comments written then.
          legacyDigest: digestValue({ kind, label, from, to, description }),
        };
        const list = claimed.get(target.key) ?? [];
        list.push(target);
        claimed.set(target.key, list);
        next.parentKey = target.key;
        if (kind === "element") next.inBlock = true;
      }
    }

    // Any other element with a unique authored id is a target in its own right.
    const authoredKey =
      declaredTarget === undefined && !ctx.inHead && !next.inDefs ? usableId(attr(el, "id")) : undefined;
    const leaf = html && !ctx.inSvg && !ctx.inMath ? LEAF_BLOCKS[tag] : undefined;
    let kind: BlockKind | undefined = leaf;
    if (!kind && tag === "svg" && !ctx.inSvg) kind = "svg";
    if (!kind && tag === "math" && !ctx.inMath && !ctx.inSvg) kind = "math";
    if (!kind && html && CONTAINERS.has(tag) && !ctx.inSvg && isInlineOnly(el)) kind = "container";
    if (authoredKey && tag !== "html" && tag !== "body" && tag !== "head") {
      const k = kind ?? "element";
      if (kind && !ctx.inBlock) readItem(authoredKey);
      register(blockTarget(el, authoredKey, "authored", k, currentSection().id, ctx));
      next.parentKey = authoredKey;
      if (kind) next.inBlock = true;
    } else if (kind && !ctx.inBlock && declaredTarget === undefined && !(kind === "svg" && diagramId !== undefined)) {
      const prefix = kind === "container" ? tag : KEY_PREFIX[kind]!;
      const key = derivedKey(currentSection().id, prefix);
      readItem(key);
      register(blockTarget(el, key, "derived", kind, currentSection().id, ctx));
      next.parentKey = key;
      next.inBlock = true;
    } else if (kind) {
      next.inBlock = true;
    }

    if (tag === "svg" && diagramId === undefined && !hasTarget(el)) svgWithoutTargets++;

    childNodes(el).forEach((c) => visit(c, next));
    // Loose text keeps a space where the browser would show a break between cells, options or items.
    if (!next.inBlock && SEPARATED.test(tag)) loose.push(" ");
    if (opened) diagramStack.pop();
  };

  function usableId(id: string | undefined): string | undefined {
    if (id === undefined || !HTML_ID_RE.test(id) || (idCount.get(id) ?? 0) > 1) return undefined;
    return `#${id}`;
  }

  function derivedKeyForHeading(sectionId: string): string {
    const slug = /^[A-Za-z0-9][\w-]*$/.test(sectionId) ? sectionId : slugify(sectionId) || "s";
    return `b.${slug}.heading`;
  }

  function blockTarget(
    el: Element,
    key: string,
    idSource: "authored" | "derived",
    kind: BlockKind,
    sectionId: string,
    ctx: Ctx,
  ): Target {
    const info = blockInfo(el, kind);
    const label = blockLabel(el, info);
    return {
      key,
      id: key,
      kind: "element",
      sectionId,
      label,
      mapping: idSource === "authored" ? "exact" : "derived",
      idSource,
      lines: lineOf(el),
      span: spanOf(el),
      parentKey: ctx.parentKey,
      description: attr(el, "data-doc-description") ? normaliseSpace(attr(el, "data-doc-description")!) : undefined,
      block: info,
      digest: contentDigest(el),
    };
  }

  visit(tree as unknown as Node, { inHead: false, inSvg: false, inMath: false, inBlock: false, inDefs: false });
  flushLoose();

  for (const [key, list] of claimed) {
    if (list.length > 1) {
      const diagram = diagrams.find((d) => d.id === list[0]!.diagramId);
      if (diagram) diagram.ambiguousIds.push(list[0]!.id);
      else ambiguousKeys.push(key);
      diagnostics.push({
        severity: "error",
        line: list[1]!.lines.start,
        message: `data-doc-target "${list[0]!.id}" is used by ${list.length} elements; comments on it are treated as ambiguous`,
      });
      continue;
    }
    const target = list[0]!;
    targets.set(key, target);
    order.push(key);
    diagrams.find((d) => d.id === target.diagramId)?.targetKeys.push(key);
  }
  for (const diagram of diagrams) {
    diagram.digest = digestValue({ targets: diagram.targetKeys.map((k) => targets.get(k)!.digest) });
  }
  if (svgWithoutTargets > 0) {
    coverage.push({
      what: `${svgWithoutTargets} SVG graphic${svgWithoutTargets > 1 ? "s" : ""} without data-doc-target or ids`,
      consequence: "comments attach to the whole graphic; parts with an id can be commented on individually",
    });
  }

  const sectionText = new Map<string, string>();
  for (const [id, parts] of quoteParts) sectionText.set(id, normaliseSpace(parts.join("")));
  if (sections.length > 1 && !sectionText.get(PREAMBLE_SECTION_ID)) sections.shift();

  // Keep targets in document order: declared targets were added after the walk.
  const position = (t: Target) => t.span?.start ?? Number.MAX_SAFE_INTEGER;
  const ordered = new Map([...targets.entries()].sort((a, b) => position(a[1]) - position(b[1])));

  const deps = [...dependencies.values()];
  const digest = digestOf(content);
  return {
    schemaVersion: 1,
    documentId: declaredId ?? derivedDocumentId(path),
    idSource: declaredId ? "declared" : "derived",
    path,
    format: "html",
    title: title ?? path,
    content,
    lines,
    digest,
    revision,
    sections,
    sectionText,
    diagrams,
    targets: ordered,
    readingOrder,
    ambiguousKeys,
    alerts,
    diagnostics,
    coverage,
    dependencies: deps,
    dependencyDigest: digestValue({
      document: digest,
      dependencies: deps
        .filter((d) => d.path)
        .map((d) => [d.path, d.digest ?? null])
        .sort(),
    }),
    scripts,
  };
}

function hasTarget(el: Element): boolean {
  if (el.attrs.some((a) => a.name === "data-doc-target" || a.name === "id")) return true;
  return childNodes(el).some((c) => isElement(c) && hasTarget(c));
}

/** A container whose children are only text and inline elements, with some text: a card, callout or note. */
function isInlineOnly(el: Element): boolean {
  let text = false;
  for (const c of childNodes(el)) {
    if (c.nodeName === "#text") {
      if ((c as TextNode).value.trim()) text = true;
    } else if (isElement(c)) {
      if (!PHRASING.has(c.tagName)) return false;
      if (normaliseSpace(textOf(c))) text = true;
    }
  }
  return text;
}

function blockLabel(el: Element, info: BlockInfo): string {
  const aria = attr(el, "aria-label") ?? attr(el, "title");
  if (aria) return short(normaliseSpace(aria));
  if (info.kind === "table") return short(info.table?.caption ?? info.table?.rows[0]?.join(", ") ?? "(empty table)");
  if (info.kind === "figure") return short(info.caption ?? (normaliseSpace(info.text) || "(figure)"));
  if (info.kind === "svg") return short(info.labels?.join(", ") || "(graphic without text)");
  return short(normaliseSpace(info.text)) || `<${el.tagName}>`;
}

/** Readable content of a block: exact text, table cells, code with whitespace, captions and labels. */
export function blockInfo(el: Element, kind: BlockKind): BlockInfo {
  const info: BlockInfo = { kind, tag: el.tagName, text: "" };
  switch (kind) {
    case "table": {
      const rows: string[][] = [];
      const headerRows: number[] = [];
      let caption: string | undefined;
      const walk = (n: Node) => {
        if (!isElement(n)) return;
        if (n.tagName === "caption") caption = normaliseSpace(textOf(n));
        if (n.tagName === "tr") {
          const cells = childNodes(n).filter(
            (c): c is Element => isElement(c) && (c.tagName === "td" || c.tagName === "th"),
          );
          if (cells.length && cells.every((c) => c.tagName === "th")) headerRows.push(rows.length);
          rows.push(cells.map((c) => normaliseSpace(textOf(c))));
          return;
        }
        if (n.tagName === "table" && n !== el) return;
        childNodes(n).forEach(walk);
      };
      walk(el);
      info.table = { caption, rows, headerRows };
      info.text = [caption ? `Caption: ${caption}` : "", ...rows.map((r) => `| ${r.join(" | ")} |`)]
        .filter(Boolean)
        .join("\n");
      break;
    }
    case "code": {
      const code = childNodes(el).find((c): c is Element => isElement(c) && c.tagName === "code") ?? el;
      const cls = `${attr(code, "class") ?? ""} ${attr(el, "class") ?? ""}`;
      const language = /\b(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? attr(el, "data-lang") ?? undefined;
      const text = rawText(code).replace(/^\n/, "");
      info.code = { language, text };
      info.text = text;
      break;
    }
    case "list": {
      const items: string[] = [];
      const walk = (list: Element, depth: number) => {
        for (const li of childNodes(list)) {
          if (!isElement(li) || li.tagName !== "li") continue;
          const own = childNodes(li)
            .filter((c) => !(isElement(c) && (c.tagName === "ul" || c.tagName === "ol")))
            .map((c) => textOf(c))
            .join("");
          items.push(`${"  ".repeat(depth)}- ${normaliseSpace(own)}`);
          for (const sub of childNodes(li))
            if (isElement(sub) && (sub.tagName === "ul" || sub.tagName === "ol")) walk(sub, depth + 1);
        }
      };
      walk(el, 0);
      info.items = items;
      info.text = items.join("\n");
      break;
    }
    case "definition-list": {
      info.text = childNodes(el)
        .filter((c): c is Element => isElement(c) && (c.tagName === "dt" || c.tagName === "dd"))
        .map((c) => `${c.tagName === "dt" ? "" : "  "}${normaliseSpace(textOf(c))}`)
        .join("\n");
      break;
    }
    case "figure": {
      const cap = findFirst(el, (n) => n.tagName === "figcaption");
      info.caption = cap ? normaliseSpace(textOf(cap)) : undefined;
      const images = findAll(el, (n) => n.tagName === "img").map(
        (i) => `[image ${attr(i, "src") ?? ""}: ${attr(i, "alt") ?? "no alt text"}]`,
      );
      const svgLabels = findAll(el, (n) => n.tagName === "svg").flatMap((s) => svgLabelsOf(s));
      const body = normaliseSpace(textOf(el, new Set([...NO_PROSE, "figcaption", "svg", "math"])));
      info.labels = svgLabels.length ? svgLabels : undefined;
      info.text = [
        body,
        ...images,
        svgLabels.length ? `[graphic: ${svgLabels.join(", ")}]` : "",
        info.caption ? `Caption: ${info.caption}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      break;
    }
    case "svg": {
      info.labels = svgLabelsOf(el);
      info.text = info.labels.join(", ");
      break;
    }
    case "math": {
      const tex = findFirst(el, (n) => n.tagName === "annotation" && /tex/i.test(attr(n, "encoding") ?? ""));
      const source = tex ? rawText(tex).trim() : (attr(el, "alttext") ?? undefined);
      const text = normaliseSpace(textOf(el));
      info.math = { source, text };
      info.text = source ? `${text} [TeX: ${source}]` : text;
      break;
    }
    default:
      info.text = normaliseSpace(textOf(el, new Set([...NO_PROSE, "svg"])));
  }
  return info;
}

function svgLabelsOf(svg: Element): string[] {
  const labels: string[] = [];
  const title = childNodes(svg).find((c): c is Element => isElement(c) && c.tagName === "title");
  if (title) labels.push(normaliseSpace(textOf(title, new Set())));
  if (attr(svg, "aria-label")) labels.push(normaliseSpace(attr(svg, "aria-label")!));
  for (const t of findAll(svg, (n) => n.tagName === "text")) {
    const s = normaliseSpace(textOf(t, new Set()));
    if (s) labels.push(s);
  }
  return [...new Set(labels)];
}

function findAll(el: Element, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const walk = (n: Node) => {
    if (isElement(n) && n !== el && test(n)) out.push(n);
    childNodes(n).forEach(walk);
  };
  walk(el);
  return out;
}

function findFirst(el: Element, test: (e: Element) => boolean): Element | undefined {
  return findAll(el, test)[0];
}

/** url(...) and @import references in a stylesheet. */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g)) out.push(m[2]!);
  for (const m of clean.matchAll(/@import\s+(['"])([^'"]+)\1/g)) out.push(m[2]!);
  return out.filter((u) => !u.startsWith("data:") && !u.startsWith("#"));
}

/** A file the document needs to look and work as written. Paths are bounded to the repository. */
export function resolveDependency(
  ref: string,
  kind: Dependency["kind"],
  repoRoot: string,
  baseDir: string,
): Dependency | null {
  const clean = ref.trim();
  if (!clean || clean.startsWith("#") || /^(data|javascript|mailto|tel|about|blob):/i.test(clean)) return null;
  if (/^(https?:)?\/\//i.test(clean)) return { ref: clean, kind, status: "remote" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return { ref: clean, kind, status: "unsupported" };
  const pathPart = decodeURIComponentSafe(clean.replace(/[?#].*$/, ""));
  const absolute = pathPart.startsWith("/") ? join(repoRoot, pathPart) : resolve(baseDir, pathPart);
  const lexical = repoRelative(repoRoot, absolute);
  if (!lexical) return { ref: clean, kind, status: "outside" };
  if (!existsSync(absolute)) return { ref: clean, kind, path: lexical, status: "missing" };
  const real = repoRelative(realpathSync(repoRoot), realpathSync(absolute));
  if (!real) return { ref: clean, kind, status: "outside" };
  const bytes = readFileSync(absolute);
  return { ref: clean, kind, path: real, status: "ok", digest: digestOf(bytes), size: bytes.length };
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
