import type { DiagramModel, DocModel, Target } from "../core/document.js";
import { iconMarkup } from "./icons.js";
import { LINE_HEIGHT, layoutDiagram, textWidth, type LaidOutEdge, type LaidOutNode } from "./layout.js";

/**
 * Renders a laid-out diagram as inline SVG. Every node, edge and group is a
 * focusable <g> carrying `data-doc-target`, its kind, and a pin anchor in SVG
 * units. Colours come from CSS classes so the page theme applies.
 */

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const KIND_NAMES: Record<string, string> = { node: "Component", edge: "Connection", group: "Group" };

function targetAttrs(target: Target, pin: { x: number; y: number }, ariaLabel: string): string {
  return [
    `class="hm-target hm-${target.kind}"`,
    `data-doc-target="${escapeXml(target.id)}"`,
    `data-doc-kind="${target.kind}"`,
    `data-doc-key="${escapeXml(target.key)}"`,
    `data-pin-x="${pin.x.toFixed(1)}"`,
    `data-pin-y="${pin.y.toFixed(1)}"`,
    `tabindex="0"`,
    `role="button"`,
    `aria-label="${escapeXml(ariaLabel)}"`,
  ].join(" ");
}

function shapePath(n: LaidOutNode): string {
  const { width: w, height: h } = n;
  const x = n.x - w / 2;
  const y = n.y - h / 2;
  const cls = `class="hm-node-shape"`;
  switch (n.target.shape) {
    case "round":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`;
    case "stadium":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
    case "subroutine":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/><path class="hm-node-detail" d="M${x + 8} ${y}v${h}M${x + w - 8} ${y}v${h}"/>`;
    case "cylinder": {
      const ry = 7;
      return `<path ${cls} d="M${x} ${y + ry}a${w / 2} ${ry} 0 0 1 ${w} 0v${h - 2 * ry}a${w / 2} ${ry} 0 0 1 ${-w} 0z"/><path class="hm-node-detail" d="M${x} ${y + ry}a${w / 2} ${ry} 0 0 0 ${w} 0"/>`;
    }
    case "circle":
      return `<circle ${cls} cx="${n.x}" cy="${n.y}" r="${w / 2}"/>`;
    case "rhombus":
      return `<polygon ${cls} points="${n.x},${y} ${x + w},${n.y} ${n.x},${y + h} ${x},${n.y}"/>`;
    case "hexagon": {
      const k = 14;
      return `<polygon ${cls} points="${x + k},${y} ${x + w - k},${y} ${x + w},${n.y} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${n.y}"/>`;
    }
    case "parallelogram":
      return `<polygon ${cls} points="${x + 12},${y} ${x + w},${y} ${x + w - 12},${y + h} ${x},${y + h}"/>`;
    case "parallelogram-alt":
      return `<polygon ${cls} points="${x},${y} ${x + w - 12},${y} ${x + w},${y + h} ${x + 12},${y + h}"/>`;
    case "asymmetric":
      return `<polygon ${cls} points="${x},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h} ${x + 14},${n.y}"/>`;
    default:
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
  }
}

function nodeMarkup(n: LaidOutNode, repoRoot: string): string {
  const t = n.target;
  const iconSize = 20;
  const gap = 8;
  // Centre icon and text together as one block.
  const textW = Math.max(...n.lines.map((l) => textWidth(l)));
  const blockW = textW + (n.hasIcon ? iconSize + gap : 0);
  const left = n.x - blockW / 2;
  const textX = left + (n.hasIcon ? iconSize + gap : 0) + textW / 2;
  const firstY = n.y - ((n.lines.length - 1) * LINE_HEIGHT) / 2;
  const tspans = n.lines
    .map(
      (line, i) =>
        `<tspan x="${textX.toFixed(1)}" y="${(firstY + i * LINE_HEIGHT).toFixed(1)}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const icon =
    n.hasIcon && t.icon
      ? iconMarkup(t.icon, repoRoot, { x: Math.round(left), y: Math.round(n.y - iconSize / 2), size: iconSize })
      : "";
  const pin = { x: n.x + n.width / 2 - 2, y: n.y - n.height / 2 + 2 };
  const aria = `${KIND_NAMES.node}: ${t.label.replace(/\n/g, " ")}`;
  return `<g ${targetAttrs(t, pin, aria)}>${shapePath(n)}${icon}<text class="hm-node-label" text-anchor="middle" dominant-baseline="central">${tspans}</text></g>`;
}

function pathData(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const f = (p: { x: number; y: number }) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  if (points.length === 2) return `M${f(points[0]!)}L${f(points[1]!)}`;
  // Straight segments with rounded corners through the midpoints.
  let d = `M${f(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const next = points[i + 1]!;
    const mid = { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
    d += i === 1 ? `L${f({ x: (points[0]!.x + p.x) / 2, y: (points[0]!.y + p.y) / 2 })}` : "";
    d += `Q${f(p)} ${f(i === points.length - 2 ? next : mid)}`;
  }
  return d;
}

function edgeMarkup(e: LaidOutEdge, diagramKey: string, labels: (id: string | undefined) => string): string {
  const t = e.target;
  const d = pathData(e.points);
  const markerEnd = t.head && t.head !== "none" ? ` marker-end="url(#hm-${t.head}-${diagramKey})"` : "";
  const markerStart = t.tail && t.tail !== "none" ? ` marker-start="url(#hm-${t.tail}-${diagramKey}-start)"` : "";
  const label = e.label
    ? `<g class="hm-edge-label"><rect x="${(e.label.x - e.label.width / 2).toFixed(1)}" y="${(e.label.y - e.label.height / 2).toFixed(1)}" width="${e.label.width}" height="${e.label.height}" rx="4"/><text text-anchor="middle" dominant-baseline="central">${e.label.lines
        .map(
          (line, i) =>
            `<tspan x="${e.label!.x.toFixed(1)}" y="${(e.label!.y - ((e.label!.lines.length - 1) * 16) / 2 + i * 16).toFixed(1)}">${escapeXml(line)}</tspan>`,
        )
        .join("")}</text></g>`
    : "";
  const aria = `${KIND_NAMES.edge}: ${labels(t.from)} to ${labels(t.to)}${t.edgeLabel ? `, ${t.edgeLabel}` : ""}`;
  return `<g ${targetAttrs(t, e.anchor, aria)} data-edge-style="${t.style ?? "solid"}"><path class="hm-edge-hit" d="${d}"/><path class="hm-edge-line hm-line-${t.style ?? "solid"}" d="${d}"${markerEnd}${markerStart}/>${label}</g>`;
}

function markers(key: string): string {
  const arrow = (id: string, reverse: boolean) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="${reverse ? 1 : 9}" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path class="hm-marker" d="M0 0L10 5L0 10z"/></marker>`;
  const circle = (id: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse"><circle class="hm-marker-open" cx="5" cy="5" r="4"/></marker>`;
  const cross = (id: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse"><path class="hm-marker-stroke" d="M1 1L9 9M9 1L1 9"/></marker>`;
  return `<defs>${arrow(`hm-arrow-${key}`, false)}${arrow(`hm-arrow-${key}-start`, true)}${circle(`hm-circle-${key}`)}${circle(`hm-circle-${key}-start`)}${cross(`hm-cross-${key}`)}${cross(`hm-cross-${key}-start`)}</defs>`;
}

export function renderDiagramSvg(doc: DocModel, diagram: DiagramModel, repoRoot: string, index: number): string {
  const layout = layoutDiagram(doc, diagram);
  const key = `d${index}`;
  const labels = (id: string | undefined) => {
    const t = id ? doc.targets.get(`${diagram.id}/${id}`) : undefined;
    return t ? t.label.replace(/\n/g, " ") : (id ?? "?");
  };
  const groups = layout.groups
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .map((g) => {
      const x = g.x - g.width / 2;
      const y = g.y - g.height / 2;
      const pin = { x: x + g.width - 2, y: y + 2 };
      return `<g ${targetAttrs(g.target, pin, `${KIND_NAMES.group}: ${g.target.label}`)}><rect class="hm-group-box" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${g.width.toFixed(1)}" height="${g.height.toFixed(1)}" rx="8"/><text class="hm-group-title" x="${(x + 10).toFixed(1)}" y="${(y + 18).toFixed(1)}">${escapeXml(g.target.label)}</text></g>`;
    })
    .join("");
  const edges = layout.edges.map((e) => edgeMarkup(e, key, labels)).join("");
  const nodes = layout.nodes.map((n) => nodeMarkup(n, repoRoot)).join("");
  return [
    `<svg class="hm-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" data-doc-diagram="${escapeXml(diagram.id)}" data-diagram-width="${layout.width}" role="group" aria-label="Diagram ${escapeXml(diagram.id)}">`,
    markers(key),
    `<rect class="hm-diagram-bg" x="0" y="0" width="${layout.width}" height="${layout.height}"/>`,
    `<g class="hm-groups">${groups}</g>`,
    `<g class="hm-edges">${edges}</g>`,
    `<g class="hm-nodes">${nodes}</g>`,
    `</svg>`,
  ].join("");
}

/** A plain text rendering of a diagram for screen readers, small screens and copying. */
export function renderDiagramTextView(doc: DocModel, diagram: DiagramModel): string {
  const parts = diagram.targetKeys.map((k) => doc.targets.get(k)!);
  const label = (id: string | undefined) => escapeXml(parts.find((p) => p.id === id)?.label ?? id ?? "?");
  const nodes = parts.filter((p) => p.kind === "node");
  const edges = parts.filter((p) => p.kind === "edge");
  const groups = parts.filter((p) => p.kind === "group");
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const code = (s: string) => `<code>${escapeXml(s)}</code>`;
  const tables = [
    `<table><caption>Components</caption><thead><tr><th>Name</th><th>Id</th><th>Description</th></tr></thead><tbody>${nodes
      .map((n) => row([escapeXml(n.label), code(n.id), escapeXml(n.description ?? "")]))
      .join("")}</tbody></table>`,
    `<table><caption>Connections</caption><thead><tr><th>From</th><th>To</th><th>Label</th><th>Id</th></tr></thead><tbody>${edges
      .map((e) => row([label(e.from), label(e.to), escapeXml(e.edgeLabel ?? ""), code(e.id)]))
      .join("")}</tbody></table>`,
  ];
  if (groups.length) {
    tables.push(
      `<table><caption>Groups</caption><thead><tr><th>Name</th><th>Id</th><th>Members</th></tr></thead><tbody>${groups
        .map((g) => row([escapeXml(g.label), code(g.id), (g.members ?? []).map((m) => label(`n.${m}`)).join(", ")]))
        .join("")}</tbody></table>`,
    );
  }
  return tables.join("");
}
