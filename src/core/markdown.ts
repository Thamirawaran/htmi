/**
 * A line based scanner for the parts of Markdown that HTMi needs to address:
 * headings (sections), fenced blocks, GitHub alert blocks and the document
 * identity comment. It records 1-based line spans so that every target can
 * point back at its source. Prose rendering is left to `marked`.
 */

export interface Section {
  /** GitHub compatible heading anchor, unique within the document. */
  id: string;
  title: string;
  /** Heading level 1-6, or 0 for text before the first heading. */
  level: number;
  /** Line of the heading itself (or 1 for the preamble). */
  startLine: number;
  /** Last line before the next heading of any level. */
  endLine: number;
}

export interface FencedBlock {
  lang: string;
  info: string;
  /** Line of the opening fence. */
  startLine: number;
  /** Line of the closing fence, or the last line if the fence is unclosed. */
  endLine: number;
  closed: boolean;
  /** Lines between the fences, with their 1-based line numbers. */
  body: { line: number; text: string }[];
  sectionId: string;
}

export type AlertKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

export interface Alert {
  kind: AlertKind;
  text: string;
  startLine: number;
  endLine: number;
  sectionId: string;
}

export interface MarkdownScan {
  lines: string[];
  declaredId?: { id: string; line: number };
  title?: string;
  sections: Section[];
  fences: FencedBlock[];
  alerts: Alert[];
}

export const PREAMBLE_SECTION_ID = "_top";

const DOC_ID_RE = /<!--\s*htmi:document\s+([A-Za-z][\w.-]*)\s*-->/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ALERT_RE = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;

export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Plain text of a heading: inline code, links and emphasis reduced to text. */
export function headingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** GitHub's heading anchor rule, without the duplicate suffix. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function scanMarkdown(content: string): MarkdownScan {
  const lines = splitLines(content);
  const sections: Section[] = [];
  const fences: FencedBlock[] = [];
  const alerts: Alert[] = [];
  const slugCounts = new Map<string, number>();
  let declaredId: MarkdownScan["declaredId"];

  const preamble: Section = {
    id: PREAMBLE_SECTION_ID,
    title: "(before the first heading)",
    level: 0,
    startLine: 1,
    endLine: lines.length,
  };
  sections.push(preamble);
  const current = (): Section => sections[sections.length - 1]!;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const lineNo = i + 1;

    const open = FENCE_OPEN_RE.exec(text);
    if (open && !(open[2]!.startsWith("`") && open[3]!.includes("`"))) {
      const marker = open[2]!;
      const info = open[3]!.trim();
      const closeRe = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: FencedBlock["body"] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (closeRe.test(lines[j]!)) {
          closed = true;
          break;
        }
        body.push({ line: j + 1, text: lines[j]! });
      }
      const endIndex = closed ? j : lines.length - 1;
      fences.push({
        lang: (info.split(/\s+/)[0] ?? "").toLowerCase(),
        info,
        startLine: lineNo,
        endLine: endIndex + 1,
        closed,
        body,
        sectionId: current().id,
      });
      i = endIndex;
      continue;
    }

    if (!declaredId) {
      const m = DOC_ID_RE.exec(text);
      if (m) declaredId = { id: m[1]!, line: lineNo };
    }

    const atx = ATX_RE.exec(text);
    if (atx) {
      const title = headingText(atx[2] ?? "");
      const base = slugify(title) || "section";
      const seen = slugCounts.get(base) ?? 0;
      slugCounts.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen}`;
      current().endLine = lineNo - 1;
      sections.push({ id, title, level: atx[1]!.length, startLine: lineNo, endLine: lines.length });
      continue;
    }

    const alert = ALERT_RE.exec(text);
    if (alert) {
      const parts: string[] = [];
      let j = i + 1;
      for (; j < lines.length && /^ {0,3}>/.test(lines[j]!); j++) {
        parts.push(lines[j]!.replace(/^ {0,3}>\s?/, ""));
      }
      alerts.push({
        kind: alert[1] as AlertKind,
        text: parts.join("\n").trim(),
        startLine: lineNo,
        endLine: j,
        sectionId: current().id,
      });
      i = j - 1;
    }
  }

  // Drop an empty preamble so the first real section is not shadowed.
  if (sections.length > 1 && sections[0]!.endLine < 1) sections.shift();
  else if (
    sections.length > 1 &&
    lines.slice(0, sections[0]!.endLine).every((l) => l.trim() === "" || DOC_ID_RE.test(l))
  ) {
    sections.shift();
  }

  const h1 = sections.find((s) => s.level === 1);
  return { lines, declaredId, title: h1?.title, sections, fences, alerts };
}

/** The innermost section containing a line. */
export function sectionAt(scan: MarkdownScan, line: number): Section | undefined {
  let found: Section | undefined;
  for (const section of scan.sections) {
    if (section.startLine <= line && line <= section.endLine) found = section;
  }
  return found;
}
