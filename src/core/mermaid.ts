/**
 * Parser for the supported subset of Mermaid flowcharts.
 *
 * It keeps authored identity: Mermaid node ids are the native model ids, and
 * `%% htmi:` comment directives (invisible to every Mermaid renderer) declare
 * diagram ids, edge ids, icons, descriptions and source links. Anything outside
 * the subset is reported as a diagnostic instead of being silently dropped.
 */

export type Direction = "TB" | "BT" | "LR" | "RL";

export type Shape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "rhombus"
  | "hexagon"
  | "parallelogram"
  | "parallelogram-alt"
  | "asymmetric";

export type LineStyle = "solid" | "dotted" | "thick";
export type ArrowHead = "arrow" | "circle" | "cross" | "none";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  line: number;
  message: string;
}

export interface MermaidNode {
  id: string;
  label: string;
  shape: Shape;
  /** True when some statement gave the node an explicit label or shape. */
  defined: boolean;
  /** Lines where the node appears, in order. */
  lines: number[];
  /** Every place the node id is written, with character offsets in the raw line. */
  occurrences: NodeSpan[];
  /** The occurrences that carry a label or shape. */
  definitions: NodeSpan[];
  groupId?: string;
}

/** Character offsets (0-based, end exclusive) within one raw source line. */
export interface NodeSpan {
  line: number;
  idStart: number;
  idEnd: number;
  /** End of the whole token including any shape and class suffix. */
  end: number;
  labelStart?: number;
  labelEnd?: number;
}

export interface MermaidEdge {
  /** Position in the edge list, in source order. */
  index: number;
  from: string;
  to: string;
  label?: string;
  style: LineStyle;
  head: ArrowHead;
  tail: ArrowHead;
  line: number;
  /** Number of edges the source statement produced (chains and `&`). */
  statementEdgeCount: number;
  /** Number of edges produced by this edge's link token (more than one with `&`). */
  linkEdgeCount: number;
  /** Offsets of the link token, label included, in the raw line. */
  linkSpan: { start: number; end: number };
  declaredId?: string;
  directiveLine?: number;
}

export interface MermaidGroup {
  id: string;
  title: string;
  idDeclared: boolean;
  startLine: number;
  endLine: number;
  parentId?: string;
  members: string[];
}

export interface Directive {
  name: string;
  args: string[];
  /** Everything after the directive name, trimmed. */
  rest: string;
  line: number;
}

export interface MermaidParse {
  supported: boolean;
  direction: Direction;
  headerLine?: number;
  nodes: Map<string, MermaidNode>;
  edges: MermaidEdge[];
  groups: Map<string, MermaidGroup>;
  directives: Directive[];
  diagnostics: Diagnostic[];
  /** Presentation-only statements (style, classDef, ...) that were kept but carry no semantics. */
  presentationLines: number[];
}

export interface SourceLine {
  line: number;
  text: string;
}

export const ID_PATTERN = "[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*";
const ID_RE = new RegExp(`^${ID_PATTERN}`);
const HEADER_RE = /^(flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?\s*;?\s*$/i;
const DIRECTIVE_RE = /^%%\s*htmi:([a-z-]+)\s*(.*)$/;
const PRESENTATION_RE = /^(classDef|class|style|linkStyle|click|accTitle|accDescr)\b/;

interface Shaped {
  open: string;
  close: string;
  shape: Shape;
}

// Longest opening delimiters first so that `([` wins over `(`.
const SHAPES: Shaped[] = [
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram-alt" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "rhombus" },
  { open: ">", close: "]", shape: "asymmetric" },
];

interface NodeRef {
  id: string;
  label?: string;
  shape?: Shape;
  idStart: number;
  end: number;
  labelStart?: number;
  labelEnd?: number;
}

interface EdgeToken {
  style: LineStyle;
  head: ArrowHead;
  tail: ArrowHead;
  label?: string;
  start: number;
  end: number;
}

class Cursor {
  constructor(
    readonly text: string,
    public pos = 0,
  ) {}
  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }
  done(): boolean {
    this.skipSpace();
    return this.pos >= this.text.length;
  }
  rest(): string {
    return this.text.slice(this.pos);
  }
}

export function parseMermaid(source: SourceLine[]): MermaidParse {
  const result: MermaidParse = {
    supported: false,
    direction: "TB",
    nodes: new Map(),
    edges: [],
    groups: new Map(),
    directives: [],
    diagnostics: [],
    presentationLines: [],
  };
  const groupStack: MermaidGroup[] = [];
  let pendingEdgeId: Directive | undefined;

  const touchNode = (ref: NodeRef, line: number, base: number): void => {
    let node = result.nodes.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: ref.id, shape: "rect", defined: false, lines: [], occurrences: [], definitions: [] };
      result.nodes.set(ref.id, node);
    }
    node.lines.push(line);
    const span: NodeSpan = {
      line,
      idStart: base + ref.idStart,
      idEnd: base + ref.idStart + ref.id.length,
      end: base + ref.end,
      labelStart: ref.labelStart === undefined ? undefined : base + ref.labelStart,
      labelEnd: ref.labelEnd === undefined ? undefined : base + ref.labelEnd,
    };
    node.occurrences.push(span);
    if (ref.label !== undefined || ref.shape !== undefined) {
      if (node.defined && ref.label !== undefined && ref.label !== node.label) {
        result.diagnostics.push({
          severity: "warning",
          line,
          message: `node "${ref.id}" is labelled "${node.label}" earlier and "${ref.label}" here; the last label is used`,
        });
      }
      node.defined = true;
      if (ref.label !== undefined) node.label = ref.label;
      if (ref.shape !== undefined) node.shape = ref.shape;
      node.definitions.push(span);
    }
    const group = groupStack[groupStack.length - 1];
    if (group && node.groupId === undefined) {
      node.groupId = group.id;
      group.members.push(node.id);
    }
  };

  for (const { line, text: rawText } of source) {
    const text = rawText.trim();
    const lead = rawText.length - rawText.trimStart().length;
    if (text === "") continue;

    if (text.startsWith("%%")) {
      const m = DIRECTIVE_RE.exec(text);
      if (m) {
        const rest = m[2]!.trim();
        const directive: Directive = { name: m[1]!, args: rest ? rest.split(/\s+/) : [], rest, line };
        result.directives.push(directive);
        if (directive.name === "edge") {
          if (pendingEdgeId) {
            result.diagnostics.push({
              severity: "error",
              line: pendingEdgeId.line,
              message: "htmi:edge directive is not followed by an edge statement",
            });
          }
          pendingEdgeId = directive;
        }
      }
      continue;
    }

    if (result.headerLine === undefined) {
      const header = HEADER_RE.exec(text);
      if (!header) {
        result.diagnostics.push({
          severity: "error",
          line,
          message: `only flowchart diagrams are supported; found "${text.split(/\s+/)[0]}"`,
        });
        return result;
      }
      result.supported = true;
      result.headerLine = line;
      const dir = (header[2] ?? "TB").toUpperCase();
      result.direction = (dir === "TD" ? "TB" : dir) as Direction;
      continue;
    }

    for (const statement of statementsWithOffsets(text)) {
      parseStatement(statement.text, line, lead + statement.offset);
    }
  }

  if (pendingEdgeId) {
    result.diagnostics.push({
      severity: "error",
      line: pendingEdgeId.line,
      message: "htmi:edge directive is not followed by an edge statement",
    });
  }
  for (const group of groupStack) {
    result.diagnostics.push({
      severity: "error",
      line: group.startLine,
      message: `subgraph "${group.id}" has no matching end`,
    });
  }
  if (result.headerLine === undefined) {
    result.diagnostics.push({ severity: "error", line: source[0]?.line ?? 0, message: "empty diagram" });
  }
  return result;

  /** `base` is the offset of the statement within the raw line. */
  function parseStatement(statement: string, line: number, base: number): void {
    if (/^subgraph\b/.test(statement)) {
      const group = parseSubgraph(statement.slice("subgraph".length).trim(), line);
      if (!group) return;
      if (result.groups.has(group.id)) {
        result.diagnostics.push({ severity: "error", line, message: `duplicate subgraph id "${group.id}"` });
        return;
      }
      group.parentId = groupStack[groupStack.length - 1]?.id;
      result.groups.set(group.id, group);
      groupStack.push(group);
      return;
    }
    if (statement === "end") {
      const group = groupStack.pop();
      if (!group) result.diagnostics.push({ severity: "error", line, message: "end without subgraph" });
      else group.endLine = line;
      return;
    }
    if (/^direction\s+/.test(statement)) {
      result.presentationLines.push(line);
      result.diagnostics.push({
        severity: "info",
        line,
        message: "subgraph direction is not applied by the HTMi renderer",
      });
      return;
    }
    if (PRESENTATION_RE.test(statement)) {
      result.presentationLines.push(line);
      return;
    }

    const cursor = new Cursor(statement);
    const groups: NodeRef[][] = [];
    // null marks an invisible (~~~) link, which only affects layout.
    const links: (EdgeToken | null)[] = [];
    const first = readNodeGroup(cursor, line);
    if (!first) return;
    groups.push(first);
    while (!cursor.done()) {
      const link = readLink(cursor);
      if (!link) {
        result.diagnostics.push({
          severity: "error",
          line,
          message: `unsupported syntax near "${cursor.rest().slice(0, 30)}"`,
        });
        return;
      }
      if (link === "invisible") {
        result.diagnostics.push({
          severity: "info",
          line,
          message: "invisible link (~~~) is layout only and is not a target",
        });
      }
      const next = readNodeGroup(cursor, line);
      if (!next) return;
      groups.push(next);
      links.push(link === "invisible" ? null : link);
    }

    for (const group of groups) for (const ref of group) touchNode(ref, line, base);

    const created: MermaidEdge[] = [];
    for (let k = 0; k < links.length; k++) {
      const link = links[k];
      if (!link) continue;
      const linkEdgeCount = groups[k]!.length * groups[k + 1]!.length;
      for (const from of groups[k]!) {
        for (const to of groups[k + 1]!) {
          created.push({
            linkEdgeCount,
            linkSpan: { start: base + link.start, end: base + link.end },
            index: result.edges.length + created.length,
            from: from.id,
            to: to.id,
            label: link.label,
            style: link.style,
            head: link.head,
            tail: link.tail,
            line,
            statementEdgeCount: 0,
          });
        }
      }
    }
    for (const edge of created) edge.statementEdgeCount = created.length;

    if (created.length > 0 && pendingEdgeId) {
      if (created.length === 1) {
        created[0]!.declaredId = pendingEdgeId.args[0];
        created[0]!.directiveLine = pendingEdgeId.line;
      } else {
        result.diagnostics.push({
          severity: "error",
          line: pendingEdgeId.line,
          message: `htmi:edge needs a statement with exactly one edge; line ${line} creates ${created.length}`,
        });
      }
      pendingEdgeId = undefined;
    }
    result.edges.push(...created);
  }

  function parseSubgraph(rest: string, line: number): MermaidGroup | undefined {
    const m = new RegExp(`^(${ID_PATTERN})\\s*(?:\\[\\s*(?:"([^"]*)"|([^\\]]*))\\s*\\])?\\s*$`).exec(rest);
    if (m) {
      return {
        id: m[1]!,
        title: (m[2] ?? m[3] ?? m[1]!).trim(),
        idDeclared: true,
        startLine: line,
        endLine: line,
        members: [],
      };
    }
    const quoted = /^"([^"]*)"\s*$/.exec(rest);
    const title = (quoted ? quoted[1]! : rest).trim();
    if (!title) {
      result.diagnostics.push({ severity: "error", line, message: "subgraph without a name" });
      return undefined;
    }
    const id =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "group";
    result.diagnostics.push({
      severity: "warning",
      line,
      message: `subgraph "${title}" has no id; using derived id "${id}". Write "subgraph ${id} [${title}]" to fix it`,
    });
    return { id, title, idDeclared: false, startLine: line, endLine: line, members: [] };
  }

  function readNodeGroup(cursor: Cursor, line: number): NodeRef[] | undefined {
    const refs: NodeRef[] = [];
    for (;;) {
      const ref = readNode(cursor, line);
      if (!ref) return undefined;
      refs.push(ref);
      cursor.skipSpace();
      if (cursor.text[cursor.pos] === "&") {
        cursor.pos++;
        continue;
      }
      return refs;
    }
  }

  function readNode(cursor: Cursor, line: number): NodeRef | undefined {
    cursor.skipSpace();
    const idMatch = ID_RE.exec(cursor.rest());
    if (!idMatch) {
      result.diagnostics.push({
        severity: "error",
        line,
        message: `expected a node id near "${cursor.rest().slice(0, 30)}"`,
      });
      return undefined;
    }
    const id = idMatch[0];
    if (id === "end" || id === "subgraph") {
      result.diagnostics.push({ severity: "error", line, message: `"${id}" cannot be used as a node id` });
      return undefined;
    }
    const idStart = cursor.pos;
    cursor.pos += id.length;
    const ref: NodeRef = { id, idStart, end: cursor.pos };
    const rest = cursor.rest();
    if (rest.startsWith("@{")) {
      result.diagnostics.push({
        severity: "error",
        line,
        message: `node "${id}" uses @{ } shape syntax, which is not supported`,
      });
      return undefined;
    }
    const shaped = SHAPES.find((s) => rest.startsWith(s.open));
    if (shaped) {
      cursor.pos += shaped.open.length;
      ref.labelStart = cursor.pos;
      const label = readLabel(cursor, shaped.close, line, id);
      if (label === undefined) return undefined;
      ref.labelEnd = cursor.pos - shaped.close.length;
      ref.label = label;
      ref.shape = shaped.shape;
    }
    const cls = /^:::[\w-]+/.exec(cursor.rest());
    if (cls) cursor.pos += cls[0].length;
    ref.end = cursor.pos;
    return ref;
  }

  function readLabel(cursor: Cursor, close: string, line: number, id: string): string | undefined {
    const rest = cursor.rest();
    const quoted = /^\s*"([^"]*)"\s*/.exec(rest);
    if (quoted && rest.slice(quoted[0].length).startsWith(close)) {
      cursor.pos += quoted[0].length + close.length;
      return normaliseLabel(quoted[1]!);
    }
    const end = rest.indexOf(close);
    if (end < 0) {
      result.diagnostics.push({
        severity: "error",
        line,
        message: `label of node "${id}" is not closed with "${close}"`,
      });
      return undefined;
    }
    cursor.pos += end + close.length;
    return normaliseLabel(rest.slice(0, end));
  }

  function readLink(cursor: Cursor): EdgeToken | "invisible" | undefined {
    cursor.skipSpace();
    const start = cursor.pos;
    const rest = cursor.rest();
    if (/^~{3,}/.test(rest)) {
      cursor.pos += /^~{3,}/.exec(rest)![0].length;
      return "invisible";
    }

    // Text-in-the-middle form: A -- text --> B, A -. text .-> B, A == text ==> B
    const middle = /^([<ox])?(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.-+)([>ox])?(?=\s|[A-Za-z_"])/.exec(rest);
    if (middle) {
      const opener = middle[2]!;
      const finish = middle[4]!;
      const style: LineStyle = opener === "==" ? "thick" : opener === "-." ? "dotted" : "solid";
      const finishStyle: LineStyle = finish.startsWith("=") ? "thick" : finish.startsWith(".") ? "dotted" : "solid";
      if (style === finishStyle) {
        cursor.pos += middle[0].length;
        return {
          style,
          head: headOf(middle[5]),
          tail: middle[1] ? headOf(middle[1] === "<" ? ">" : middle[1]) : "none",
          label: normaliseLabel(middle[3]!),
          start,
          end: cursor.pos,
        };
      }
    }

    const plain = /^([<ox])?(-{2,}|={2,}|-\.+-)([>ox])?/.exec(rest);
    if (!plain) return undefined;
    // `--o` / `--x` only mean a head when followed by a space or a node start.
    let headChar = plain[3];
    let length = plain[0].length;
    if (headChar && headChar !== ">" && /[A-Za-z0-9_]/.test(rest[length] ?? "")) {
      headChar = undefined;
      length -= 1;
    }
    cursor.pos += length;
    const body = plain[2]!;
    const token: EdgeToken = {
      style: body.startsWith("=") ? "thick" : body.includes(".") ? "dotted" : "solid",
      head: headOf(headChar),
      tail: plain[1] ? headOf(plain[1] === "<" ? ">" : plain[1]) : "none",
      start,
      end: cursor.pos,
    };
    const pipe = /^\s*\|\s*(?:"([^"]*)"|([^|]*))\|/.exec(cursor.rest());
    if (pipe) {
      cursor.pos += pipe[0].length;
      token.label = normaliseLabel(pipe[1] ?? pipe[2] ?? "");
      token.end = cursor.pos;
    }
    return token;
  }
}

function headOf(char: string | undefined): ArrowHead {
  if (char === ">") return "arrow";
  if (char === "o") return "circle";
  if (char === "x") return "cross";
  return "none";
}

function normaliseLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#amp;/g, "&")
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">")
    .split("\n")
    .map((part) => part.trim())
    .join("\n")
    .trim();
}

/** Split a line on `;` that are outside quotes and brackets, keeping each statement's offset. */
export function statementsWithOffsets(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, offset: from + (raw.length - raw.trimStart().length) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && "[({".includes(ch)) depth++;
    else if (!quoted && "])}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && ch === ";") {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;
}

/** Mermaid source text for a label, quoting when the label needs it. */
export function formatLabel(label: string): string {
  const escaped = label.replace(/"/g, "#quot;").replace(/\n/g, "<br>");
  return /^[\w ]+$/.test(label) ? escaped : `"${escaped}"`;
}
