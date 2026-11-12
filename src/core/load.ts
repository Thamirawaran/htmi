import { buildMarkdownModel, isHtmlPath, readDocumentSource, type DocModel, type LoadOptions } from "./document.js";
import { buildHtmlModel } from "./html.js";
import type { SourceRevision } from "./revision.js";

/** Load a Markdown or HTML document from the working tree or from a commit. */
export function loadAnyDocument(options: LoadOptions): DocModel {
  const { content, revision, path } = readDocumentSource(options);
  return buildAnyModel(content, path, options.repoRoot, revision);
}

export function buildAnyModel(content: string, path: string, repoRoot: string, revision: SourceRevision): DocModel {
  return isHtmlPath(path)
    ? buildHtmlModel(content, path, repoRoot, revision)
    : buildMarkdownModel(content, path, repoRoot, revision);
}
