import dagre from "@dagrejs/dagre";
import type { DiagramModel, DocModel, Target } from "../core/document.js";

/**
 * Deterministic layout for a diagram, computed at build time. The same
 * source always produces the same coordinates, so a published snapshot and a
 * local view agree on where things are.
 */

export const FONT_SIZE = 14;
export const LINE_HEIGHT = 18;
const EDGE_FONT_SIZE = 12;
const PAD_X = 16;
const PAD_Y = 10;
const ICON = 20;
const ICON_GAP = 8;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutNode extends Box {
  target: Target;
  lines: string[];
  hasIcon: boolean;
}

export interface LaidOutEdge {
  target: Target;
  points: { x: number; y: number }[];
  label?: Box & { lines: string[] };
  /** Where a comment pin sits: the label centre, or the middle of the path. */
  anchor: { x: number; y: number };
}

export interface LaidOutGroup extends Box {
  target: Target;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  groups: LaidOutGroup[];
}

// Approximate advance widths, in em, for a sans-serif face. Close enough to size boxes without a browser.
const NARROW = new Set("ijlI.,:;'!|`".split(""));
const SEMI = new Set('frt()[]{} -/"'.split(""));
const WIDE = new Set("mwMW@%".split(""));

export function textWidth(text: string, size = FONT_SIZE): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.28;
    else if (SEMI.has(ch)) em += 0.36;
    else if (WIDE.has(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.66;
    else if (ch >= "0" && ch <= "9") em += 0.56;
    else if (ch.charCodeAt(0) > 0x2e80) em += 1;
    else em += 0.54;
  }
  return Math.ceil(em * size);
}

/** Split a label into lines no wider than `max` pixels, keeping authored line breaks. */
export function wrapLabel(label: string, max: number, size = FONT_SIZE): string[] {
  const out: string[] = [];
  for (const paragraph of label.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, size) > max) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}

function nodeSize(target: Target, lines: string[], hasIcon: boolean): { width: number; height: number } {
  const textW = Math.max(...lines.map((l) => textWidth(l)), 24);
  let width = textW + PAD_X * 2 + (hasIcon ? ICON + ICON_GAP : 0);
  let height = Math.max(lines.length * LINE_HEIGHT, hasIcon ? ICON : 0) + PAD_Y * 2;
  switch (target.shape) {
    case "rhombus":
      width = width * 1.4;
      height = height * 1.6;
      break;
    case "circle":
      width = height = Math.max(width, height);
      break;
    case "hexagon":
    case "parallelogram":
    case "parallelogram-alt":
    case "asymmetric":
      width += 24;
      break;
    case "cylinder":
      height += 14;
      break;
    case "stadium":
      width += height / 2;
      break;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

export function layoutDiagram(doc: DocModel, diagram: DiagramModel): DiagramLayout {
  const parts = diagram.targetKeys.map((k) => doc.targets.get(k)!);
  const nodes = parts.filter((t) => t.kind === "node");
  const edges = parts.filter((t) => t.kind === "edge");
  const groups = parts.filter((t) => t.kind === "group");

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: diagram.direction,
    nodesep: 36,
    ranksep: 56,
    edgesep: 18,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const prepared = new Map<string, { lines: string[]; hasIcon: boolean }>();
  for (const node of nodes) {
    const hasIcon = !!node.icon && !node.icon.error;
    const lines = wrapLabel(node.label, 180);
    prepared.set(node.id, { lines, hasIcon });
    g.setNode(node.id, nodeSize(node, lines, hasIcon));
  }
  for (const group of groups) {
    g.setNode(group.id, { label: group.label });
  }
  for (const group of groups) {
    if (group.parentId) g.setParent(group.id, group.parentId);
    for (const member of group.members ?? []) {
      if (g.hasNode(`n.${member}`)) g.setParent(`n.${member}`, group.id);
    }
  }
  const edgeLines = new Map<string, string[]>();
  for (const edge of edges) {
    const lines = edge.edgeLabel ? wrapLabel(edge.edgeLabel, 140, EDGE_FONT_SIZE) : [];
    edgeLines.set(edge.id, lines);
    const width = lines.length ? Math.max(...lines.map((l) => textWidth(l, EDGE_FONT_SIZE))) + 10 : 0;
    const height = lines.length ? lines.length * 16 + 4 : 0;
    g.setEdge(edge.from!, edge.to!, { width, height, labelpos: "c" }, edge.id);
  }

  dagre.layout(g);

  const graph = g.graph();
  const laidNodes: LaidOutNode[] = nodes.map((node) => {
    const n = g.node(node.id);
    const { lines, hasIcon } = prepared.get(node.id)!;
    return { target: node, x: n.x, y: n.y, width: n.width, height: n.height, lines, hasIcon };
  });
  const laidGroups: LaidOutGroup[] = groups.map((group) => {
    const n = g.node(group.id);
    // Room for the title above the members.
    return { target: group, x: n.x, y: n.y - 10, width: n.width + 16, height: n.height + 28 };
  });
  const laidEdges: LaidOutEdge[] = edges.map((edge) => {
    const e = g.edge({ v: edge.from!, w: edge.to!, name: edge.id });
    const points = (e.points ?? []).map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
    const lines = edgeLines.get(edge.id)!;
    const label = lines.length ? { x: e.x!, y: e.y!, width: e.width!, height: e.height!, lines } : undefined;
    return {
      target: edge,
      points,
      label,
      anchor: label ? { x: label.x + label.width / 2, y: label.y - label.height / 2 } : midpoint(points),
    };
  });

  // Group boxes grow upwards for their titles; make sure the canvas contains them.
  let minX = 0;
  let minY = 0;
  let maxX = graph.width ?? 0;
  let maxY = graph.height ?? 0;
  for (const box of [...laidGroups, ...laidNodes]) {
    minX = Math.min(minX, box.x - box.width / 2 - 8);
    minY = Math.min(minY, box.y - box.height / 2 - 8);
    maxX = Math.max(maxX, box.x + box.width / 2 + 8);
    maxY = Math.max(maxY, box.y + box.height / 2 + 8);
  }
  if (minX < 0 || minY < 0) {
    const dx = -minX;
    const dy = -minY;
    for (const box of [...laidGroups, ...laidNodes]) {
      box.x += dx;
      box.y += dy;
    }
    for (const edge of laidEdges) {
      edge.points = edge.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      if (edge.label) {
        edge.label.x += dx;
        edge.label.y += dy;
      }
      edge.anchor = { x: edge.anchor.x + dx, y: edge.anchor.y + dy };
    }
    maxX += dx;
    maxY += dy;
  }
  return { width: Math.ceil(maxX), height: Math.ceil(maxY), nodes: laidNodes, edges: laidEdges, groups: laidGroups };
}

/** The point halfway along a polyline. */
export function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= len && len > 0) {
      const t = remaining / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= len;
  }
  return points[points.length - 1]!;
}
