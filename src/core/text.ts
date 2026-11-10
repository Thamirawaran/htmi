import { marked } from "marked";
import type { DocModel } from "./document.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Collapse runs of whitespace, as a browser does when the text is selected. */
export function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Visible text of a Markdown fragment, close to what a reader can select in a rendered page. */
export function markdownPlainText(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|pre|blockquote|tr|div)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name]!;
      if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
      if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
      return m;
    });
  return normaliseSpace(text);
}

/** Prose of a section with diagram blocks removed, as plain text. */
export function sectionPlainText(doc: DocModel, sectionId: string): string {
  const known = doc.sectionText?.get(sectionId);
  if (known !== undefined) return known;
  return markdownPlainText(sectionProse(doc, sectionId));
}

/** Markdown source of a section without its heading line and without Mermaid blocks. */
export function sectionProse(doc: DocModel, sectionId: string): string {
  const section = doc.sections.find((s) => s.id === sectionId);
  if (!section) return "";
  const skip = new Set<number>();
  for (const diagram of doc.diagrams) {
    for (let l = diagram.lines.start; l <= diagram.lines.end; l++) skip.add(l);
  }
  const out: string[] = [];
  const first = section.level > 0 ? section.startLine + 1 : section.startLine;
  for (let l = first; l <= section.endLine; l++) {
    if (!skip.has(l)) out.push(doc.lines[l - 1] ?? "");
  }
  // Removing a diagram leaves the blank lines around it; keep one.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every start index of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}
