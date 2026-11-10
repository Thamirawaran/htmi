import { digestOf, shortDigest } from "./digest.js";
import { buildMarkdownModel, type DocModel } from "./document.js";
import { buildHtmlModel } from "./html.js";
import type { SourceRevision } from "./revision.js";

/**
 * The document model of an issue or pull request description, without any
 * I/O: the GitHub adapter fetches and writes the body, and the browser
 * extension reads it from the page. Both build the model here, so a comment
 * made in either place points at the same targets.
 *
 * A description is Markdown, unless it is exactly one fenced `html` block:
 * then the page inside the fence is the document. GitHub shows such a
 * description as source; HTMi shows the page.
 */

export interface Description {
  repo: string;
  number: number;
  kind: "issue" | "pull";
  title: string;
  /** The description exactly as GitHub returns it; an empty description is "". */
  body: string;
  url: string;
  updatedAt: string;
}

export function descriptionRef(repo: string, number: number): string {
  return `github:${repo}#${number}`;
}

/** An opening ```html (or ~~~html) line, the page, and the matching closing fence, with nothing else but blank space. */
const HTML_FENCE = /^(\s*(`{3,}|~{3,})html[ \t]*\r?\n)([\s\S]*?)(\r?\n\2[ \t]*(?:\r?\n\s*)?)$/;

/** The page inside a description that is one fenced html block, with the text around it; null for any other description. */
export function htmlInDescription(body: string): { before: string; html: string; after: string } | null {
  const m = HTML_FENCE.exec(body);
  if (!m || m[3]!.includes(`\n${m[2]}`)) return null;
  return { before: m[1]!, html: m[3]!, after: m[4]! };
}

/** The description body that holds `content` as this document's text. */
export function wrapDescription(doc: DocModel, content: string): string {
  const w = doc.host?.wrapper;
  return w ? `${w.before}${content}${w.after}` : content;
}

/** The document model of a description. Comments on it live in the workspace at `repoRoot`. */
export function descriptionModel(description: Description, repoRoot: string): DocModel {
  const ref = descriptionRef(description.repo, description.number);
  const revision: SourceRevision = {
    commit: null,
    state: "host",
    label: `body@${shortDigest(digestOf(description.body), 7)}`,
  };
  const page = htmlInDescription(description.body);
  const model = page
    ? buildHtmlModel(page.html, ref, repoRoot, revision)
    : buildMarkdownModel(description.body, ref, repoRoot, revision);
  if (model.idSource === "derived") model.documentId = ref;
  model.title = description.title;
  model.host = {
    provider: "github",
    repo: description.repo,
    number: description.number,
    kind: description.kind,
    url: description.url,
    title: description.title,
    updatedAt: description.updatedAt,
    ...(page
      ? { wrapper: { before: page.before, after: page.after, lineOffset: page.before.split("\n").length - 1 } }
      : {}),
  };
  return model;
}
