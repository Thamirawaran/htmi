import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { dirname, join } from "node:path";
import { assetDataUri, readAsset, resolveAsset } from "../core/assets.js";
import { imageTargetId, type DocModel } from "../core/document.js";
import type { ResolvedThread } from "../core/resolve.js";
import { projectHtml } from "./html-projection.js";
import { escapeXml, renderDiagramSvg, renderDiagramTextView } from "./svg.js";

/**
 * Builds the review page for a document: prose, diagrams with addressable
 * targets, the comment threads, and the client script. One self-contained
 * HTML file; a Content-Security-Policy with script and style hashes means
 * only the bundled code runs, and in snapshot mode no request can leave the
 * page. Thread bodies are inserted by the client with textContent only.
 */

export interface ReviewPageOptions {
  doc: DocModel;
  repoRoot: string;
  threads: ResolvedThread[];
  mode: "snapshot" | "live";
  builtAt: string;
  /** Live mode: a per-server secret the client sends with every write. */
  liveToken?: string;
  github?: { repo: string; issue: number; issueUrl: string };
  /** True when local, unpublished comments are included in a snapshot. */
  includesLocalComments?: boolean;
  version: string;
  /** Live mode: where links to other documents in the repository point. */
  documentLink?: (repoPath: string) => string | null;
  /** Live mode, HTML: where the document can be opened as written, scripts and all. */
  originalUrl?: string;
  /** Host mode (an editor webview): how the page talks to its host instead of HTTP. */
  host?: { name: string; canSave: boolean; reason?: string };
  /**
   * Snapshot shown by the browser extension on github.com: a prepared comment is
   * handed to the extension, which puts it in GitHub's own comment box (`to` names
   * it). The reviewer posts it there; nothing is sent from the page.
   */
  handoff?: {
    to: string | null;
    /** Shown inside a host page's own layout: no header, full width, the panel as a card by the selection. */
    embed?: boolean;
    /** Why comments cannot be prepared here, when they cannot (the text is not exact, for example). */
    disabled?: string;
  };
}

let clientDir: URL = new URL("./client/", import.meta.url);

/** Where the client script and styles are read from; a bundled host (the VS Code extension) sets its own. */
export function setClientDir(dir: URL): void {
  clientDir = dir;
}

function clientFile(name: string): string {
  return readFileSync(new URL(name, clientDir), "utf8");
}

function cspHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** JSON safe to embed in a <script type="application/json"> block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "details",
    "summary",
    "del",
    "ins",
    "sup",
    "sub",
    "kbd",
    "input",
  ],
  allowedAttributes: {
    a: ["href", "title", "id", "rel", "target"],
    img: [
      "src",
      "alt",
      "title",
      "width",
      "height",
      "class",
      "data-doc-target",
      "data-doc-kind",
      "data-doc-key",
      "loading",
    ],
    code: ["class"],
    th: ["align"],
    td: ["align"],
    input: ["type", "checked", "disabled"],
    "*": ["id"],
  },
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: { img: ["data"] },
  allowedClasses: { img: ["hm-unsized"] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        ...(attribs.href && /^https?:/i.test(attribs.href) ? { rel: "noopener noreferrer", target: "_blank" } : {}),
      },
    }),
  },
};

function renderProse(doc: DocModel, repoRoot: string, sectionId: string, markdown: string, notes: string[]): string {
  const docDir = dirname(join(repoRoot, doc.path));
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      image(token: Tokens.Image) {
        const occurrence = (seen.get(token.href) ?? 0) + 1;
        seen.set(token.href, occurrence);
        const id = imageTargetId(sectionId, token.href, occurrence);
        const alt = escapeXml(token.text ?? "");
        if (/^https?:/i.test(token.href)) {
          notes.push(`remote image ${token.href} is linked, not embedded`);
          return `<a href="${escapeXml(token.href)}">${alt || escapeXml(token.href)} (remote image)</a>`;
        }
        const asset = resolveAsset(token.href, repoRoot, docDir);
        const uri = asset.error ? null : assetDataUri(asset, repoRoot);
        if (!uri)
          return `<span class="hm-missing">[image ${escapeXml(token.href)}: ${escapeXml(asset.error ?? "unavailable")}]</span>`;
        // An SVG with only a viewBox has no size of its own and would stretch to the full column.
        const unsized =
          asset.mediaType === "image/svg+xml" &&
          !/<svg\b[^>]*\swidth\s*=/i.test(readAsset(asset, repoRoot)?.toString("utf8") ?? "");
        return `<img src="${uri}" alt="${alt}"${unsized ? ' class="hm-unsized"' : ""} data-doc-target="${escapeXml(id)}" data-doc-kind="image" data-doc-key="${escapeXml(id)}" loading="lazy">`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false }) as string;
  // Authored ids are kept for links, except in the page's own hm- namespace.
  return renderAlerts(sanitizeHtml(html, SANITIZE)).replace(/\sid="hm-[^"]*"/g, "");
}

const ALERT_TITLES: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/** GitHub alert blocks (`> [!IMPORTANT]`), drawn the way GitHub draws them. Runs on sanitised HTML. */
function renderAlerts(html: string): string {
  return html.replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g,
    (_m, kind: string) =>
      `<blockquote class="hm-alert" data-alert="${kind.toLowerCase()}"><p class="hm-alert-title">${ALERT_TITLES[kind]}</p><p>`,
  );
}

export function buildReviewPage(options: ReviewPageOptions): string {
  const { doc, repoRoot } = options;
  const notes: string[] = [];
  const body: string[] = [];
  const nonce = randomBytes(9).toString("base64url");
  let authoredCss = "";
  const viewNotes: { what: string; consequence: string }[] = [];

  if (doc.format === "html") {
    const projection = projectHtml(doc, repoRoot, { nonce, documentLink: options.documentLink });
    authoredCss = projection.css;
    viewNotes.push(...projection.notes);
    body.push(`<div class="hm-authored-frame">${projection.html}</div>`);
  }

  if (doc.format === "markdown") {
    let diagramIndex = 0;
    for (const section of doc.sections) {
      // Prose and diagrams interleave in source order.
      const chunks: string[] = [];
      let buffer: string[] = [];
      const flush = () => {
        const text = buffer.join("\n").trim();
        if (text) chunks.push(renderProse(doc, repoRoot, section.id, text, notes));
        buffer = [];
      };
      const first = section.level > 0 ? section.startLine + 1 : section.startLine;
      for (let line = first; line <= section.endLine; line++) {
        const diagram = doc.diagrams.find((d) => d.lines.start === line);
        if (diagram) {
          flush();
          chunks.push(renderFigure(doc, repoRoot, diagram, diagramIndex++));
          line = diagram.lines.end;
          continue;
        }
        if (/^\s*<!--\s*htmi:document/.test(doc.lines[line - 1] ?? "")) continue;
        buffer.push(doc.lines[line - 1] ?? "");
      }
      flush();
      const heading =
        section.level > 0
          ? `<h${section.level} id="${escapeXml(section.id)}" class="hm-heading">${escapeXml(section.title)}</h${section.level}>`
          : "";
      body.push(
        `<section class="hm-section" data-section-id="${escapeXml(section.id)}">${heading}<div class="hm-section-body" data-section-id="${escapeXml(section.id)}">${chunks.join("")}</div></section>`,
      );
    }
  }

  const data = {
    version: 1,
    generator: `htmi ${options.version}`,
    mode: options.mode,
    builtAt: options.builtAt,
    format: doc.format,
    nonce,
    document: {
      id: doc.documentId,
      idSource: doc.idSource,
      path: doc.path,
      title: doc.title,
      digest: doc.digest,
      dependencyDigest: doc.dependencyDigest ?? null,
      revision: doc.revision,
    },
    targets: Object.fromEntries(
      [...doc.targets.values()].map((t) => [
        t.key,
        {
          key: t.key,
          id: t.id,
          kind: t.kind,
          diagramId: t.diagramId,
          label: t.label,
          digest: t.digest,
          mapping: t.mapping,
          from: t.from,
          to: t.to,
          sectionId: t.sectionId,
          tag: t.block?.tag,
          blockKind: t.block?.kind,
          lines: t.lines,
        },
      ]),
    ),
    diagrams: Object.fromEntries(
      doc.diagrams.map((d) => [
        d.id,
        { id: d.id, digest: d.digest, title: d.title, sectionId: d.sectionId, supported: d.supported },
      ]),
    ),
    sections: doc.sections.map((s) => ({ id: s.id, title: s.title })),
    threads: options.threads.map(threadView),
    coverage: [
      ...doc.coverage.filter((c) => !(doc.format === "html" && /script/.test(c.what))),
      ...viewNotes,
      ...notes.map((n) => ({ what: n, consequence: "" })),
    ],
    errors: doc.diagnostics.filter((d) => d.severity === "error").length,
    live: options.mode === "live" ? { token: options.liveToken } : null,
    host: options.host ?? null,
    github: options.github ?? null,
    handoff: options.handoff ?? null,
    includesLocalComments: !!options.includesLocalComments,
  };

  const css = `${clientFile("tokens.css")}\n${clientFile("review.css")}`;
  // The client starts from an image error handler rather than a <script> element. GitHub's
  // issue artifact preview leaves <script> elements inert but runs inline event handlers
  // (observed 2026-10-30). 'unsafe-hashes' with the exact hash still
  // allows only this one handler.
  const boot = `if(!window.__htmiStarted){window.__htmiStarted=1;\n${clientFile("review.js")}\n}`;
  // Authored HTML keeps its inline style attributes, so its pages allow inline styles. Styles
  // cannot run script, and with default-src 'none' they cannot load anything either.
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-hashes' ${cspHash(boot)}`,
    doc.format === "html" ? "style-src 'unsafe-inline'" : `style-src ${cspHash(css)}`,
    "img-src data:",
    ...(doc.format === "html" ? ["font-src data:"] : []),
    options.mode === "live" ? "connect-src 'self'" : "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const revision = doc.revision.label;
  const modeLabel = options.host
    ? options.host.canSave
      ? `${options.host.name}: comments are saved to this repository`
      : `${options.host.name}: ${options.host.reason ?? "read only"}`
    : options.mode === "live"
      ? doc.host
        ? "Live: comments are saved to this repository. Edits to the description on GitHub show after a reload"
        : "Live: comments are saved to this repository"
      : options.handoff
        ? "On GitHub: comments you write here go to GitHub's comment box, and you post them there"
        : `Snapshot built ${options.builtAt.replace("T", " ").slice(0, 16)} UTC. Comments are as of that time.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="generator" content="htmi ${escapeXml(options.version)}">
<title>${escapeXml(doc.title)} (HTMi review)</title>
<style>${css}</style>${authoredCss ? `\n<style class="hm-authored-css">${authoredCss.replace(/<\/style/gi, "<\\/style")}</style>` : ""}
</head>
<body class="hm-mode-${options.mode} hm-format-${doc.format}${options.handoff?.embed ? " hm-embed" : ""}">
<a class="hm-skip" href="#hm-panel">Skip to comments</a>
<header class="hm-bar">
  <div class="hm-bar-main">
    <span class="hm-title">${escapeXml(doc.title)}</span>
    <span class="hm-meta">${
      doc.host
        ? `<a href="${escapeXml(doc.host.url)}" target="_blank" rel="noopener"><code>${escapeXml(doc.path)}</code></a> ${doc.host.kind === "pull" ? "pull request" : "issue"} description`
        : `<code>${escapeXml(doc.path)}</code>`
    } at <code title="${escapeXml(doc.revision.commit ?? "")}">${escapeXml(revision)}</code></span>
  </div>
  ${options.originalUrl ? `<a class="hm-original" href="${escapeXml(options.originalUrl)}" target="_blank" rel="noopener">Open original (its scripts run, read only)</a>` : ""}
  <span class="hm-mode" data-mode="${options.mode}">${escapeXml(modeLabel)}</span>
</header>
<div class="hm-banner" id="hm-banner" hidden></div>
<div class="hm-layout">
  <main class="hm-doc${doc.format === "html" ? " hm-html" : ""}" id="hm-doc">
    <div class="hm-pins" id="hm-pins" aria-hidden="true"></div>
    ${body.join("\n")}
  </main>
  <aside class="hm-panel" id="hm-panel" aria-label="Comments" tabindex="-1">
    <noscript><p>Comments need JavaScript. The threads are listed in the JSON data block of this page.</p></noscript>
  </aside>
</div>
<div class="hm-live" id="hm-live" role="status" aria-live="polite"></div>
<script type="application/json" class="hm-data">${embedJson(data)}</script>
<img class="hm-boot" alt="" src="data:," onerror="${escapeXml(boot)}">
</body>
</html>
`;
}

function renderFigure(doc: DocModel, repoRoot: string, diagram: DocModel["diagrams"][number], index: number): string {
  if (!diagram.supported) {
    const source = doc.lines.slice(diagram.lines.start, diagram.lines.end - 1).join("\n");
    return `<figure class="hm-figure hm-unsupported"><pre><code>${escapeXml(source)}</code></pre><figcaption>This Mermaid diagram type is shown as source; its parts cannot be commented on individually.</figcaption></figure>`;
  }
  const svg = renderDiagramSvg(doc, diagram, repoRoot, index);
  return `<figure class="hm-figure" data-doc-diagram="${escapeXml(diagram.id)}">
<div class="hm-figure-bar"><span class="hm-figure-id">${escapeXml(diagram.id)}</span><button type="button" class="hm-btn hm-btn-small" data-action="comment-diagram" data-diagram="${escapeXml(diagram.id)}">Comment on diagram</button></div>
<div class="hm-figure-canvas">${svg}</div>
<details class="hm-textview"><summary>Text view</summary>${renderDiagramTextView(doc, diagram)}</details>
</figure>`;
}

export function threadView(r: ResolvedThread) {
  const t = r.thread;
  const author = (a: { name: string; kind: string; verified: boolean; login?: string }) => ({
    name: a.login ? `@${a.login}` : a.name,
    kind: a.kind,
    verified: a.verified,
  });
  const published = t.publications.find((p) => p.eventId === t.id)?.origin ?? t.comment.origin;
  return {
    id: t.id,
    discussion: t.discussion,
    kind: t.comment.body.kind,
    text: t.comment.body.text,
    at: t.comment.at,
    author: author(t.comment.author),
    visibility: t.comment.visibility,
    url: published?.url ?? null,
    target: t.target,
    observed: t.observed,
    resolution: {
      status: r.resolution.status,
      note: r.resolution.note,
      key: r.resolution.target?.key ?? null,
      candidates: r.resolution.candidates.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
    },
    replies: t.replies.map((x) => ({
      id: x.id,
      at: x.at,
      text: x.body.text,
      author: author(x.author),
      revision: x.revision ?? null,
    })),
    statuses: t.statuses.map((s) => ({
      at: s.at,
      discussion: s.discussion,
      note: s.note ?? null,
      author: author(s.author),
    })),
    evidence: t.evidence.map((e) => ({ at: e.at, claim: e.claim, result: e.result, revision: e.revision })),
  };
}

export type ThreadView = ReturnType<typeof threadView>;
