import { z } from "zod";
import {
  AnnotationStore,
  nowIso,
  ObservedSchema,
  selectorProblem,
  TargetRefSchema,
  TEXT_LIMIT,
  type Author,
  type TargetRef,
} from "../core/annotations.js";
import type { DocModel } from "../core/document.js";
import { resolveTarget, resolveThreads } from "../core/resolve.js";
import { gitIdentity } from "../core/revision.js";
import type { Workspace } from "../core/workspace.js";
import { threadView } from "../render/review-page.js";
import { openDocument } from "./documents.js";

/**
 * What a review page may ask of its host: read the current threads, and
 * write a comment, reply, status or reattachment. The live HTTP server and
 * the VS Code extension both answer through this, so the checks are the
 * same everywhere: the request is schema-checked, a comment must be on the
 * revision now on disk and resolve exactly, and the author is the local git
 * identity, marked unverified.
 */

export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CommentBody = z.object({
  documentId: z.string(),
  target: TargetRefSchema,
  observed: ObservedSchema,
  kind: z.enum(["comment", "question", "change-request"]),
  text: z.string().trim().min(1).max(TEXT_LIMIT),
});
const ReplyBody = z.object({
  documentId: z.string(),
  threadId: z.string(),
  text: z.string().trim().min(1).max(TEXT_LIMIT),
});
const StatusBody = z.object({
  documentId: z.string(),
  threadId: z.string(),
  discussion: z.enum(["open", "resolved", "wontfix"]),
});
const ReattachBody = z.object({ documentId: z.string(), threadId: z.string(), key: z.string() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ReviewApiError(
      400,
      result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

export interface ReviewApi {
  state(docRef: string): { document: { digest: string; revision: DocModel["revision"] }; threads: unknown[] };
  write(path: string, body: unknown): { status: number; json: { id: string } };
}

export function reviewApi(ws: Workspace, options: { source: Author["source"] }): ReviewApi {
  const store = new AnnotationStore(ws.root);
  const reviewer = (): Author => {
    const id = gitIdentity(ws.root);
    return { name: id?.name ?? "local reviewer", kind: "human", source: options.source, verified: false };
  };
  const loadDoc = (ref: string): DocModel => {
    try {
      return openDocument(ws, ref);
    } catch (error) {
      throw new ReviewApiError(404, (error as Error).message);
    }
  };

  return {
    state(docRef) {
      const doc = loadDoc(docRef);
      return {
        document: { digest: doc.digest, revision: doc.revision },
        threads: resolveThreads(doc, store.threads()).map(threadView),
      };
    },

    write(path, body) {
      if (path === "/api/comments") {
        const input = parse(CommentBody, body);
        const doc = loadDoc(input.documentId);
        if (input.target.documentId !== doc.documentId)
          throw new ReviewApiError(422, "target belongs to another document");
        const problem = selectorProblem(input.target);
        if (problem) throw new ReviewApiError(422, problem);
        if (input.observed.documentDigest !== doc.digest) {
          throw new ReviewApiError(409, "the document changed since this page was loaded; reload it");
        }
        const resolution = resolveTarget(doc, input.target, input.observed);
        if (resolution.status !== "exact") {
          throw new ReviewApiError(
            422,
            input.target.kind === "text" ? "the selected text is not unique; select a longer passage" : resolution.note,
          );
        }
        const id = store.freshId("C");
        store.append({
          type: "comment",
          schemaVersion: 1,
          id,
          at: nowIso(),
          author: reviewer(),
          target: { ...input.target, documentPath: doc.path },
          observed: { ...input.observed, revision: doc.revision.label, commit: doc.revision.commit },
          body: { kind: input.kind, text: input.text },
          visibility: "local",
        });
        return { status: 201, json: { id } };
      }
      if (path === "/api/replies") {
        const input = parse(ReplyBody, body);
        const id = store.freshId("R");
        store.append({
          type: "reply",
          id,
          threadId: input.threadId,
          at: nowIso(),
          author: reviewer(),
          body: { text: input.text },
        });
        return { status: 201, json: { id } };
      }
      if (path === "/api/status") {
        const input = parse(StatusBody, body);
        const id = store.freshId("S");
        store.append({
          type: "status",
          id,
          threadId: input.threadId,
          at: nowIso(),
          author: reviewer(),
          discussion: input.discussion,
        });
        return { status: 201, json: { id } };
      }
      if (path === "/api/reattach") {
        const input = parse(ReattachBody, body);
        const doc = loadDoc(input.documentId);
        const target = doc.targets.get(input.key);
        if (!target) throw new ReviewApiError(422, `no target ${input.key}`);
        const ref: TargetRef = {
          documentId: doc.documentId,
          documentPath: doc.path,
          kind: target.kind,
          diagramId: target.diagramId,
          targetId: target.id,
          label: target.label,
          from: target.from,
          to: target.to,
          tag: target.block?.tag,
        };
        const id = store.freshId("A");
        store.append({
          type: "reattach",
          id,
          threadId: input.threadId,
          at: nowIso(),
          author: reviewer(),
          target: ref,
          observed: {
            revision: doc.revision.label,
            commit: doc.revision.commit,
            documentDigest: doc.digest,
            targetDigest: target.digest,
          },
          reason: "reattached by the reviewer in the review page",
        });
        return { status: 201, json: { id } };
      }
      throw new ReviewApiError(404, "not found");
    },
  };
}
