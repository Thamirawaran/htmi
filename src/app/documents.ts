import { AnnotationStore } from "../core/annotations.js";
import type { DocModel } from "../core/document.js";
import { discoverDocuments, findDocument, WorkspaceError, type Workspace } from "../core/workspace.js";
import { descriptionModel, fetchDescription, parseDescriptionRef } from "../github/description.js";

/**
 * Documents as every surface opens them: repository files through the core,
 * and issue or pull request descriptions through the GitHub adapter.
 */

/** Open a document by id, path, or description reference (`github:owner/repo#7`, `github:#7`, an issue or PR URL). */
export function openDocument(ws: Workspace, ref: string, rev?: string): DocModel {
  const host = parseDescriptionRef(ws, ref);
  if (!host) return findDocument(ws, ref, rev);
  if (rev) {
    throw new WorkspaceError(
      "HTMi cannot read past versions of a description; GitHub shows its edit history on the issue page",
    );
  }
  return descriptionModel(fetchDescription(host.repo, host.number), ws.root);
}

/** Descriptions that comments in this workspace point at. */
export function commentedDescriptions(ws: Workspace): string[] {
  const refs = new Set<string>();
  for (const thread of new AnnotationStore(ws.root).threads()) {
    if (thread.target.documentPath.startsWith("github:")) refs.add(thread.target.documentPath);
  }
  return [...refs].sort();
}

export interface Unavailable {
  ref: string;
  error: string;
}

/**
 * Every document HTMi knows here: the files discovery lists, and the
 * descriptions that have comments. A description that cannot be read now
 * (offline, or no access) is returned in `unavailable`, never left out silently.
 */
export function openAll(ws: Workspace): { docs: DocModel[]; unavailable: Unavailable[] } {
  const docs = discoverDocuments(ws).map((path) => findDocument(ws, path));
  const unavailable: Unavailable[] = [];
  for (const ref of commentedDescriptions(ws)) {
    try {
      docs.push(openDocument(ws, ref));
    } catch (error) {
      unavailable.push({ ref, error: (error as Error).message });
    }
  }
  return { docs, unavailable };
}
