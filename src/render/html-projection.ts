import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss, { type Root } from "postcss";
import type { CoverageItem, DocModel } from "../core/document.js";
import { childNodes, isElement, SVG_NS } from "../core/html.js";
import { repoRelative } from "../core/revision.js";

/**
 * The review view of an HTML document: its own body, styles, figures and SVG,
 * shown in the passive profile. Nothing the document authored runs: scripts,
 * event handlers, frames, plugins and SVG animation are removed, and the page
 * CSP would block them anyway. Local images, fonts and stylesheets are
 * embedded so the view is one self-contained file; remote ones are left out
 * and listed. Authored CSS is scoped to two wrappers standing in for <html>
 * and <body>, with :where() so the author's specificity is unchanged.
 *
 * Each element HTMi can address carries `data-hm-key="<nonce>:<key>"` and each
 * heading `data-hm-section="<nonce>:<id>"`. The nonce is fresh per build, so
 * attributes an author wrote can never stand in for HTMi's.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export interface Projection {
  html: string;
  css: string;
  notes: CoverageItem[];
}

export interface ProjectionOptions {
  nonce: string;
  /** Where a link to another document in the repository should go, or null to drop the link. */
  documentLink?: (repoPath: string) => string | null;
  /** Largest file embedded as a data URI, in bytes. */
  maxAsset?: number;
}

const DROP = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "portal",
  "style",
  "title",
  "param",
  "fencedframe",
]);
/** SVG <style> is collected and scoped with the other stylesheets; left in place it would style the whole page. */
const SVG_DROP = new Set(["script", "style", "animate", "animatemotion", "animatetransform", "set", "discard"]);
const URL_ATTRS = new Set([
  "href",
  "src",
  "poster",
  "cite",
  "data",
  "action",
  "formaction",
  "background",
  "xlink:href",
]);
const DROP_ATTRS = new Set([
  "srcdoc",
  "formaction",
  "action",
  "ping",
  "background",
  "dynsrc",
  "lowsrc",
  "autofocus",
  "nonce",
]);
const IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};
const FONT_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function attrName(a: { name: string; prefix?: string }): string {
  return a.prefix ? `${a.prefix}:${a.name}` : a.name;
}

function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => attrName(a) === name)?.value;
}

function setAttr(el: Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name === name && !a.prefix);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

export function projectHtml(doc: DocModel, repoRoot: string, options: ProjectionOptions): Projection {
  const notes: CoverageItem[] = [];
  const noted = new Set<string>();
  const note = (what: string, consequence: string) => {
    if (noted.has(what)) return;
    noted.add(what);
    notes.push({ what, consequence });
  };
  const maxAsset = options.maxAsset ?? 4 * 1024 * 1024;
  const docDir = dirname(join(repoRoot, doc.path));
  const tree = parse(doc.content, { sourceCodeLocationInfo: true });

  // Keys by source position, so each element is tagged with exactly the key the model gave it.
  const keyAt = new Map<number, string>();
  const sectionAt = new Map<number, string>();
  for (const t of doc.targets.values()) {
    if (!t.span) continue;
    if (!keyAt.has(t.span.start)) keyAt.set(t.span.start, t.key);
    if (t.block?.kind === "heading") sectionAt.set(t.span.start, t.sectionId);
  }
  for (const d of doc.diagrams) if (d.span && !keyAt.has(d.span.start)) keyAt.set(d.span.start, `diagram:${d.id}`);
  const ambiguous = new Set(doc.ambiguousKeys ?? []);

  const localFile = (ref: string, baseDir: string): string | null => {
    const clean = ref.replace(/[?#].*$/, "");
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return null;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* keep as written */
    }
    const absolute = decoded.startsWith("/") ? join(repoRoot, decoded) : resolve(baseDir, decoded);
    if (!repoRelative(repoRoot, absolute) || !existsSync(absolute)) return null;
    const real = realpathSync(absolute);
    return repoRelative(realpathSync(repoRoot), real) ? real : null;
  };
  let embedded = 0;
  const dataUri = (ref: string, baseDir: string, types: Record<string, string>): string | null => {
    const file = localFile(ref, baseDir);
    if (!file) return null;
    const type = types[extname(file).toLowerCase()];
    if (!type) return null;
    const bytes = readFileSync(file);
    if (bytes.length > maxAsset) {
      note(`${ref} is ${Math.round(bytes.length / 1024)} KB`, "too large to embed in the review view; it is left out");
      return null;
    }
    embedded += bytes.length;
    return `data:${type};base64,${bytes.toString("base64")}`;
  };

  // ---------- CSS ----------
  const sheets: string[] = [];
  const rewriteCss = (css: string, baseDir: string, depth: number): string => {
    let root: Root;
    try {
      root = postcss.parse(css);
    } catch (error) {
      note("a stylesheet that does not parse", `left out (${(error as Error).message.split("\n")[0]})`);
      return "";
    }
    root.walkAtRules((at) => {
      const name = at.name.toLowerCase();
      if (name === "import") {
        const ref = /^(?:url\()?\s*['"]?([^'")\s]+)['"]?\s*\)?/.exec(at.params)?.[1] ?? "";
        const file = depth < 4 ? localFile(ref, baseDir) : null;
        if (file && extname(file).toLowerCase() === ".css") {
          at.replaceWith(postcss.parse(rewriteCss(readFileSync(file, "utf8"), dirname(file), depth + 1)));
        } else {
          note(
            `stylesheet ${ref}`,
            "not loaded in the review view (remote or missing); fonts and styles it adds fall back",
          );
          at.remove();
        }
      } else if (name === "charset" || name === "namespace" || name === "page") at.remove();
    });
    root.walkDecls((decl) => {
      if (!/url\(/i.test(decl.value)) return;
      decl.value = decl.value.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _q: string, ref: string) => {
        if (/^(data:|#)/i.test(ref)) return match;
        const isFont =
          decl.parent?.type === "atrule" && (decl.parent as postcss.AtRule).name.toLowerCase() === "font-face";
        const uri = dataUri(ref, baseDir, isFont ? FONT_TYPES : { ...IMAGE_TYPES, ...FONT_TYPES });
        if (uri) return `url("${uri}")`;
        note(
          `${isFont ? "font" : "image"} ${ref} in a stylesheet`,
          "not embedded in the review view (remote or missing)",
        );
        return "none";
      });
    });
    root.walkRules((rule) => {
      const parent = rule.parent;
      if (parent?.type === "atrule" && /keyframes$/i.test((parent as postcss.AtRule).name)) return;
      rule.selectors = rule.selectors.map(scopeSelector);
    });
    return root.toString();
  };

  let htmlEl: Element | undefined;
  let bodyEl: Element | undefined;
  const findRoots = (n: Node) => {
    if (!isElement(n)) return childNodes(n).forEach(findRoots);
    if (n.tagName === "html") htmlEl = n;
    if (n.tagName === "body") bodyEl = n;
    // Styles in document order, from <head> and <body> alike.
    if (n.tagName === "style") {
      sheets.push(
        rewriteCss(
          childNodes(n)
            .map((c) => (c as DefaultTreeAdapterMap["textNode"]).value ?? "")
            .join(""),
          docDir,
          0,
        ),
      );
      return;
    }
    if (n.tagName === "link" && /\bstylesheet\b/i.test(getAttr(n, "rel") ?? "")) {
      const href = getAttr(n, "href") ?? "";
      const file = localFile(href, docDir);
      if (file) sheets.push(rewriteCss(readFileSync(file, "utf8"), dirname(file), 0));
      else
        note(
          `stylesheet ${href}`,
          "not loaded in the review view (remote or missing); fonts and styles it adds fall back",
        );
      return;
    }
    childNodes(n).forEach(findRoots);
  };
  findRoots(tree as unknown as Node);

  // ---------- body ----------
  let scripts = 0;
  let handlers = 0;
  const clean = (parent: ParentNode) => {
    const kids = [...(parent.childNodes as Node[])];
    for (const node of kids) {
      if (node.nodeName === "#comment") {
        remove(parent, node);
        continue;
      }
      if (!isElement(node)) continue;
      const el = node;
      const tag = el.tagName.toLowerCase();
      const svg = el.namespaceURI === SVG_NS;
      if ((!svg && DROP.has(tag)) || (svg && SVG_DROP.has(tag))) {
        if (tag === "script") scripts++;
        if (svg && tag !== "script" && tag !== "style") note("SVG animation", "not shown in the review view");
        if (tag === "iframe" || tag === "object" || tag === "embed")
          note(`embedded ${tag}`, "not shown in the review view");
        remove(parent, node);
        continue;
      }
      if (tag === "video" || tag === "audio") note(`${tag} element`, "shown without its media in the review view");
      if (tag === "canvas") note("canvas element", "empty in the review view: it is drawn by script");

      const kept: Element["attrs"] = [];
      for (const a of el.attrs) {
        const name = attrName(a).toLowerCase();
        if (name.startsWith("on")) {
          handlers++;
          continue;
        }
        if (DROP_ATTRS.has(name) || name.startsWith("data-hm-")) continue;
        if (name === "id" && a.value.startsWith("hm-")) continue;
        if (name === "class") {
          const value = a.value
            .split(/\s+/)
            .filter((c) => c && !c.startsWith("hm-"))
            .join(" ");
          if (value) kept.push({ ...a, value });
          continue;
        }
        if (name === "srcset" || name === "sizes") {
          note("responsive image variants (srcset)", "the review view shows the plain src");
          continue;
        }
        if (name === "style") {
          kept.push({ ...a, value: rewriteInlineStyle(a.value) });
          continue;
        }
        if (URL_ATTRS.has(name)) {
          const value = rewriteUrl(el, tag, svg, name, a.value);
          if (value !== null) kept.push({ ...a, value });
          continue;
        }
        kept.push(a);
      }
      el.attrs = kept;
      if (tag === "a" && /^https?:/i.test(getAttr(el, "href") ?? "")) {
        setAttr(el, "target", "_blank");
        setAttr(el, "rel", "noopener noreferrer");
      }
      const start = el.sourceCodeLocation?.startOffset;
      if (start !== undefined) {
        const key = keyAt.get(start);
        if (key && !ambiguous.has(key)) el.attrs.push({ name: "data-hm-key", value: `${options.nonce}:${key}` });
        const section = sectionAt.get(start);
        if (section !== undefined) el.attrs.push({ name: "data-hm-section", value: `${options.nonce}:${section}` });
      }
      clean(el as unknown as ParentNode);
    }
  };

  const rewriteInlineStyle = (style: string): string =>
    style.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _q: string, ref: string) => {
      if (/^(data:|#)/i.test(ref)) return match;
      const uri = dataUri(ref, docDir, IMAGE_TYPES);
      return uri ? `url("${uri}")` : "none";
    });

  const rewriteUrl = (el: Element, tag: string, svg: boolean, name: string, value: string): string | null => {
    const v = value.trim();
    if (/^(javascript|vbscript):/i.test(v.replace(/[\s\u0000-\u001f]/g, ""))) return null;
    if (name === "action" || name === "formaction") return null;
    const isImage = (!svg && (tag === "img" || tag === "input") && name === "src") || (svg && tag === "image");
    if (isImage) {
      if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(v)) return v;
      const uri = dataUri(v, docDir, IMAGE_TYPES);
      if (uri) return uri;
      note(`image ${v}`, "not shown in the review view (remote, missing or not an image type)");
      return null;
    }
    if (svg && tag === "use") {
      if (v.startsWith("#")) return v;
      note(`SVG <use> of ${v}`, "external symbols are not shown in the review view");
      return null;
    }
    if (name === "href" || name === "xlink:href") {
      if (v.startsWith("#")) return v;
      if (/^(https?:|mailto:)/i.test(v)) return v;
      if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
      const file = localFile(v, docDir);
      if (file && options.documentLink) {
        const link = options.documentLink(repoRelative(realpathSync(repoRoot), file)!);
        if (link) return link + (v.includes("#") ? v.slice(v.indexOf("#")) : "");
      }
      if (!el.attrs.some((a) => a.name === "title")) el.attrs.push({ name: "title", value: `Repository file ${v}` });
      return null;
    }
    if (tag === "video" || tag === "audio" || tag === "source" || tag === "track" || name === "poster") return null;
    if (name === "cite") return v;
    return null;
  };

  const body = bodyEl ?? (tree as unknown as Element);
  clean(body as unknown as ParentNode);
  // Scripts in <head> are dropped with it; count every script the document has.
  scripts = Math.max(scripts, doc.scripts ?? 0);
  if (scripts) {
    note(
      `${scripts} script${scripts > 1 ? "s" : ""}`,
      "not run in the review view (passive profile); open the original to use what they add",
    );
  }
  if (handlers) note(`${handlers} inline event handler${handlers > 1 ? "s" : ""}`, "removed in the review view");

  const wrapperAttrs = (el: Element | undefined): string => {
    if (!el) return "";
    const parts: string[] = [];
    for (const name of ["lang", "dir", "style"]) {
      const v = getAttr(el, name);
      if (v !== undefined) parts.push(` ${name}="${escapeAttr(name === "style" ? rewriteInlineStyle(v) : v)}"`);
    }
    return parts.join("");
  };
  const wrapperClass = (el: Element | undefined): string =>
    (getAttr(el ?? ({ attrs: [] } as unknown as Element), "class") ?? "")
      .split(/\s+/)
      .filter((c) => c && !c.startsWith("hm-"))
      .map((c) => ` ${escapeAttr(c)}`)
      .join("");

  const inner = serialize(body as unknown as ParentNode);
  const html =
    `<div class="hm-authored${wrapperClass(htmlEl)}"${wrapperAttrs(htmlEl)}>` +
    `<div class="hm-authored-body${wrapperClass(bodyEl)}"${wrapperAttrs(bodyEl)}>${inner}</div></div>`;
  if (embedded > 12 * 1024 * 1024) {
    note(`${Math.round(embedded / 1024 / 1024)} MB of embedded files`, "the review page is large; hosts may refuse it");
  }
  return { html, css: sheets.join("\n"), notes };
}

function remove(parent: ParentNode, node: Node): void {
  const list = parent.childNodes as Node[];
  const i = list.indexOf(node);
  if (i >= 0) list.splice(i, 1);
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const ROOT_TOKEN = /(^|[\s>+~(,])(html|:root)(?=$|[\s>+~.#:[),])/gi;
const BODY_TOKEN = /(^|[\s>+~(,])body(?=$|[\s>+~.#:[),])/gi;

/**
 * Scope one authored selector to the view: html and :root become the outer
 * wrapper, body the inner one, and everything else is limited to descendants
 * of the inner wrapper. :where() adds no specificity.
 */
export function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (!s) return s;
  const replaced = s
    .replace(ROOT_TOKEN, (_m, pre: string) => `${pre}:where(.hm-authored)`)
    .replace(BODY_TOKEN, (_m, pre: string) => `${pre}:where(.hm-authored-body)`);
  if (replaced.startsWith(":where(.hm-authored")) return replaced;
  return `:where(.hm-authored-body) ${replaced}`;
}
