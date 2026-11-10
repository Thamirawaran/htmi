import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { commentedDescriptions, openDocument } from "../app/documents.js";
import { reviewApi, ReviewApiError } from "../app/review-api.js";
import { AnnotationError, AnnotationStore, annotationsPath, nowIso } from "../core/annotations.js";
import type { DocModel } from "../core/document.js";
import { resolveThreads } from "../core/resolve.js";
import { repoRelative } from "../core/revision.js";
import { discoverDocuments, type Workspace } from "../core/workspace.js";
import { loadAnyDocument } from "../core/load.js";
import { buildReviewPage } from "../render/review-page.js";
import { escapeXml } from "../render/svg.js";

/**
 * The local live review server. It binds to 127.0.0.1 only, rejects requests
 * whose Host header is not its own (DNS rebinding), and requires a per-run
 * token on every write (cross-site requests cannot set it). It can write
 * comments to `.htmi/annotations.jsonl`; it never edits documents.
 *
 * `/original/<path>` serves an HTML document as written, with its scripts,
 * under `Content-Security-Policy: sandbox allow-scripts`: the page runs in an
 * opaque origin, so it cannot read HTMi's pages, send the write token or
 * pass the Origin check. Only the document's folder and files it uses are
 * served there, never `.git` or `.htmi`.
 */

export interface ServeOptions {
  ws: Workspace;
  port?: number;
  version: string;
  /**
   * Origins that may show the pages in a frame, as CSP sources (a host that embeds the
   * review page, such as the Hermes dashboard). Without it no page may frame them.
   */
  frameAncestors?: string[];
}

export interface RunningServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const { ws } = options;
  const token = randomBytes(24).toString("base64url");
  const store = new AnnotationStore(ws.root);
  const watched = new Set<string>();
  const subscribers = new Set<{ res: ServerResponse; docPath: string }>();
  let origin = "";

  const api = reviewApi(ws, { source: "review-page" });
  const frameAncestors = checkFrameAncestors(options.frameAncestors);

  const watch = (file: string, event: string, docPath?: string) => {
    if (watched.has(file)) return;
    watched.add(file);
    watchFile(file, { interval: 400 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      for (const sub of subscribers) {
        if (docPath && sub.docPath !== docPath) continue;
        sub.res.write(`event: ${event}\ndata: {}\n\n`);
      }
    });
  };

  const loadDoc = (ref: string): DocModel => {
    try {
      return openDocument(ws, ref);
    } catch (error) {
      throw new HttpError(404, (error as Error).message);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const allowedHosts = [`127.0.0.1:${port()}`, `localhost:${port()}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(421, "unexpected Host header");
    const url = new URL(req.url ?? "/", origin);

    if (req.method === "GET" && url.pathname === "/")
      return sendHtml(res, indexPage(ws, options.version), frameAncestors);
    if (req.method === "GET" && url.pathname.startsWith("/doc/")) {
      let ref: string;
      try {
        ref = decodeURIComponent(url.pathname.slice(5));
      } catch {
        throw new HttpError(400, "malformed document reference");
      }
      const doc = loadDoc(ref);
      // A description lives on GitHub, which cannot be watched from here; the page says edits show after a reload.
      if (!doc.host) watch(join(ws.root, doc.path), "document", doc.path);
      // A changed stylesheet or image changes what the page shows, so it counts as a document change.
      for (const dep of doc.dependencies ?? []) {
        if (dep.path && dep.status === "ok") watch(join(ws.root, dep.path), "document", doc.path);
      }
      watch(annotationsPath(ws.root), "annotations");
      const page = buildReviewPage({
        doc,
        repoRoot: ws.root,
        threads: resolveThreads(doc, store.threads()),
        mode: "live",
        builtAt: nowIso(),
        liveToken: token,
        version: options.version,
        documentLink: (path) => `/doc/${encodeURIComponent(path)}`,
        originalUrl:
          doc.format === "html" ? `/original/${doc.path.split("/").map(encodeURIComponent).join("/")}` : undefined,
      });
      return sendHtml(res, page, frameAncestors);
    }
    if (req.method === "GET" && url.pathname.startsWith("/original/")) return sendOriginal(res, url.pathname);
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, api.state(url.searchParams.get("doc") ?? ""));
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      const doc = loadDoc(url.searchParams.get("doc") ?? "");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const sub = { res, docPath: doc.path };
      subscribers.add(sub);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        subscribers.delete(sub);
      });
      return;
    }

    if (req.method !== "POST") throw new HttpError(404, "not found");
    checkWrite(req, token, origin);
    const body = await readJson(req);

    const result = api.write(url.pathname, body);
    return sendJson(res, result.status, result.json);
  };

  /** The document as written, or a file beside it or used by it, in a sandboxed opaque origin. */
  const sendOriginal = (res: ServerResponse, pathname: string) => {
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname.slice("/original/".length))).replace(/\\/g, "/");
    } catch {
      throw new HttpError(400, "malformed path");
    }
    const absolute = join(ws.root, rel);
    const lexical = repoRelative(ws.root, absolute);
    if (!lexical || lexical.split("/").some((part) => part.startsWith(".")) || !existsSync(absolute))
      throw new HttpError(404, "not found");
    const real = repoRelative(realpathSync(ws.root), realpathSync(absolute));
    if (!real || !statSync(absolute).isFile()) throw new HttpError(404, "not found");
    if (!servable(real)) throw new HttpError(404, "not found");
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
      "Content-Security-Policy": "sandbox allow-scripts allow-popups; form-action 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(readFileSync(absolute));
  };

  /** A file in the folder of a document HTMi lists, or a file such a document uses. */
  const servable = (rel: string): boolean => {
    for (const path of discoverDocuments(ws)) {
      if (!/\.html?$/i.test(path)) continue;
      const dir = dirname(path);
      if (rel === path || dir === "." || rel.startsWith(`${dir}/`)) return true;
      const doc = loadAnyDocument({ repoRoot: ws.root, path });
      if (doc.dependencies?.some((d) => d.path === rel)) return true;
    }
    return false;
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof ReviewApiError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof AnnotationError) return sendJson(res, 422, { error: error.message });
      sendJson(res, 500, { error: "internal error" });
      process.stderr.write(`htmi serve: ${(error as Error).stack ?? String(error)}\n`);
    });
  });
  const port = () => (server.address() as AddressInfo).port;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  origin = `http://127.0.0.1:${port()}`;

  return {
    url: origin,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const file of watched) unwatchFile(file);
        for (const sub of subscribers) sub.res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function checkWrite(req: IncomingMessage, token: string, origin: string): void {
  const given = Buffer.from(String(req.headers["x-htmi-token"] ?? ""));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new HttpError(403, "missing or wrong token");
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.startsWith("application/json")) throw new HttpError(415, "expected application/json");
  const requestOrigin = req.headers.origin;
  const port = origin.split(":").pop();
  if (requestOrigin && requestOrigin !== origin && requestOrigin !== `http://localhost:${port}`) {
    throw new HttpError(403, "cross-origin write refused");
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining so the client receives the 413 instead of a reset connection.
      if (size > MAX_BODY) {
        if (!tooLarge) reject(new HttpError(413, "request too large"));
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** Only local origins may embed the review page: it carries the server's write token. */
const LOCAL_SOURCE = /^http:\/\/(127\.0\.0\.1|localhost)(:(\d{1,5}|\*))?$/;

function checkFrameAncestors(sources: string[] | undefined): string[] {
  for (const source of sources ?? []) {
    if (!LOCAL_SOURCE.test(source)) throw new Error(`frame ancestor must be a local http origin, not ${source}`);
  }
  return sources ?? [];
}

function sendHtml(res: ServerResponse, html: string, frameAncestors: string[] = []): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(frameAncestors.length
      ? { "Content-Security-Policy": `frame-ancestors ${frameAncestors.join(" ")}` }
      : { "X-Frame-Options": "DENY" }),
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

function indexPage(ws: Workspace, version: string): string {
  const rows = discoverDocuments(ws).map((path) => {
    const doc = loadAnyDocument({ repoRoot: ws.root, path });
    const ref = doc.idSource === "declared" ? doc.documentId : doc.path;
    const what =
      doc.format === "html" ? "HTML" : `${doc.diagrams.length} diagram${doc.diagrams.length === 1 ? "" : "s"}`;
    return `<li><a href="/doc/${encodeURIComponent(ref)}">${escapeXml(doc.title)}</a> <code>${escapeXml(doc.path)}</code> (${what})</li>`;
  });
  // Listed without reading them, so the index never waits on GitHub.
  for (const ref of commentedDescriptions(ws)) {
    rows.push(
      `<li><a href="/doc/${encodeURIComponent(ref)}"><code>${escapeXml(ref)}</code></a> (description on GitHub)</li>`,
    );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>HTMi documents</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1b1f24;background:#fff}@media (prefers-color-scheme:dark){body{color:#e7eaee;background:#111418}a{color:#7aa2ff}}code{color:#59636f}</style></head><body><h1>Documents</h1><ul>${rows.join("") || "<li>No documents were found. HTMi lists HTML files, and Markdown files with a Mermaid block or a HTMi marker.</li>"}</ul><p><small>htmi ${escapeXml(version)}, serving ${escapeXml(ws.root)}</small></p></body></html>`;
}
