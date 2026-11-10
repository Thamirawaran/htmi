import { descriptionModel, type Description } from "../../src/core/description-model.js";
import type { DocModel } from "../../src/core/document.js";
import { buildAnyModel } from "../../src/core/load.js";
import type { SourceRevision } from "../../src/core/revision.js";
import { buildReviewPage, setClientDir } from "../../src/render/review-page.js";
import client from "./generated/client.json";
import { mount, unmountAll } from "./shims/fs.js";

/**
 * HTMi's core in the browser. The content script on github.com sends the
 * document (a file at a commit, or an issue or pull request description) and
 * the files it uses; this builds the same model and review page the CLI
 * builds, in a sandboxed extension page with an opaque origin, and writes the
 * page into itself. Nothing here can reach GitHub or the extension's APIs.
 */

const ROOT = "/repo";
const VERSION = "0.1.0";

export interface BuildRequest {
  kind: "file" | "description";
  /** Repository path of the file, for kind "file". */
  path?: string;
  /** The file and every file it uses that could be fetched, by repository path. */
  files?: Record<string, ArrayBuffer | Uint8Array | string>;
  /** The commit the file was read at, when known. */
  commit?: string | null;
  /** The ref the file was read at, when no commit is known. */
  ref?: string;
  description?: Description;
  /** Local files the page uses that GitHub does not have; they are reported as missing, not asked for again. */
  unavailable?: string[];
  /** Where prepared comments go, for example "the comment box of pull request #21"; null to copy them. */
  handoffTo: string | null;
  /** Shown inside GitHub's own layout rather than over it. */
  embed?: boolean;
  /** Why comments cannot be prepared, when they cannot. */
  disabled?: string;
  builtAt: string;
}

export interface BuildResult {
  doc: DocModel;
  html: string;
  /** Local files the document uses that were not supplied: fetch them and build again. */
  needs: string[];
}

function mountClient(): void {
  for (const [name, text] of Object.entries(client as Record<string, string>)) mount(`/htmi/client/${name}`, text);
  setClientDir(new URL("file:///htmi/client/"));
}

export function build(request: BuildRequest): BuildResult {
  unmountAll();
  mountClient();
  for (const [path, data] of Object.entries(request.files ?? {})) mount(`${ROOT}/${path}`, data);
  let doc: DocModel;
  if (request.kind === "description") {
    if (!request.description) throw new Error("a description request needs the description");
    doc = descriptionModel(request.description, ROOT);
  } else {
    const path = request.path!;
    const content = new TextDecoder("utf-8").decode(toBytes(request.files![path]!));
    const revision: SourceRevision = request.commit
      ? { commit: request.commit, state: "commit", label: request.commit.slice(0, 7) }
      : { commit: null, state: "host", label: request.ref ?? "unknown revision" };
    doc = buildAnyModel(content, path, ROOT, revision);
  }
  const supplied = new Set([...Object.keys(request.files ?? {}), ...(request.unavailable ?? [])]);
  const needs = (doc.dependencies ?? [])
    .filter((d) => d.status === "missing" && d.path && !supplied.has(d.path))
    .map((d) => d.path!);
  const html = buildReviewPage({
    doc,
    repoRoot: ROOT,
    threads: [],
    mode: "snapshot",
    builtAt: request.builtAt,
    version: VERSION,
    handoff: { to: request.handoffTo, embed: request.embed, disabled: request.disabled },
  });
  return { doc, html, needs: [...new Set(needs)] };
}

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  return typeof data === "string"
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
}

// Tests and the content script reach the same function.
(globalThis as unknown as { HTMi: unknown }).HTMi = { build };

// In the extension's sandbox page: build on request, ask for missing files, then become the review page.
if (typeof window !== "undefined" && window.parent !== window && document.documentElement.dataset.htmiViewer === "1") {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const request = event.data as { type?: string } & BuildRequest;
    if (request?.type !== "htmi:build") return;
    try {
      const result = build(request);
      if (result.needs.length) {
        window.parent.postMessage({ type: "htmi:needs", paths: result.needs }, "*");
        return;
      }
      window.parent.postMessage({ type: "htmi:built", title: result.doc.title, targets: result.doc.targets.size }, "*");
      document.open();
      document.write(result.html);
      document.close();
    } catch (error) {
      window.parent.postMessage({ type: "htmi:error", message: (error as Error).message }, "*");
    }
  });
  window.parent.postMessage({ type: "htmi:viewer-ready" }, "*");
}
