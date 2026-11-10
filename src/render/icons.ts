import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { assetDataUri, readAsset, type AssetRef } from "../core/assets.js";

/**
 * Icons are drawn inline when they consist only of plain geometry, so they
 * can follow the page's colour scheme through `currentColor`. Anything else
 * (scripts, styles, links, filters, text, embedded images, unknown elements
 * or attributes) is refused for inline use and the icon is embedded through
 * <image> instead, where browsers never run script or fetch resources.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ATTRIBUTES = new Set([
  "viewBox",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
]);
// Ignored on the root element: they carry no geometry and are replaced by the renderer.
const ROOT_IGNORED = new Set(["xmlns", "class", "version", "xmlns:xlink", "aria-hidden", "focusable", "role"]);
const SAFE_VALUE = /^[\w\s.,#%()+-]*$/;
const SAFE_PAINT = /^(none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/;

export interface InlineIcon {
  viewBox: string;
  body: string;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Plain geometry from an SVG file, or null if it contains anything else. */
export function sanitizeIcon(svgText: string): InlineIcon | null {
  const fragment = parseFragment(svgText.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/, ""));
  const roots = fragment.childNodes.filter(
    (n) => isElement(n) || (n.nodeName === "#text" && (n as { value: string }).value.trim()),
  );
  if (roots.length !== 1 || !isElement(roots[0]!) || roots[0]!.tagName !== "svg") return null;
  const root = roots[0];
  const viewBox = root.attrs.find((a) => a.name === "viewbox" || a.name === "viewBox")?.value;
  if (!viewBox || !/^[\d.\s,-]+$/.test(viewBox)) return null;
  const rootPaint: string[] = [];
  for (const a of root.attrs) {
    const name = a.name === "viewbox" ? "viewBox" : a.name;
    if (name === "viewBox" || name === "width" || name === "height" || ROOT_IGNORED.has(name)) continue;
    if (!ATTRIBUTES.has(name) || !safeValue(name, a.value)) return null;
    rootPaint.push(`${name}="${escapeAttr(a.value)}"`);
  }
  const parts: string[] = [];
  for (const child of root.childNodes) {
    const out = serialise(child);
    if (out === null) return null;
    parts.push(out);
  }
  const body = parts.join("");
  return { viewBox, body: rootPaint.length ? `<g ${rootPaint.join(" ")}>${body}</g>` : body };
}

function safeValue(name: string, value: string): boolean {
  if (/url\s*\(|javascript:|expression/i.test(value)) return false;
  if (name === "fill" || name === "stroke") return SAFE_PAINT.test(value.trim());
  return SAFE_VALUE.test(value);
}

function serialise(node: Node): string | null {
  if (node.nodeName === "#text") return (node as { value: string }).value.trim() ? null : "";
  if (node.nodeName === "#comment") return "";
  if (!isElement(node) || !ELEMENTS.has(node.tagName) || node.tagName === "svg") return null;
  const attrs: string[] = [];
  for (const a of node.attrs) {
    if (!ATTRIBUTES.has(a.name) || !safeValue(a.name, a.value)) return null;
    attrs.push(`${a.name}="${escapeAttr(a.value)}"`);
  }
  const children: string[] = [];
  for (const child of node.childNodes) {
    const out = serialise(child);
    if (out === null) return null;
    children.push(out);
  }
  const open = `<${node.tagName}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
  return children.length ? `${open}>${children.join("")}</${node.tagName}>` : `${open}/>`;
}

/** SVG markup for an icon placed in a box, inline when safe, otherwise as an image. */
export function iconMarkup(asset: AssetRef, repoRoot: string, box: { x: number; y: number; size: number }): string {
  if (asset.mediaType === "image/svg+xml") {
    const bytes = readAsset(asset, repoRoot);
    const inline = bytes ? sanitizeIcon(bytes.toString("utf8")) : null;
    if (inline) {
      return `<svg class="hm-icon" x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" viewBox="${inline.viewBox}" aria-hidden="true">${inline.body}</svg>`;
    }
  }
  const uri = assetDataUri(asset, repoRoot);
  if (!uri) return "";
  return `<image class="hm-icon" x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" href="${uri}" aria-hidden="true"/>`;
}
