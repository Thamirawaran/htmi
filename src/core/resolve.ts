import type { Observed, TargetRef, Thread } from "./annotations.js";
import { targetKey, type DocModel, type Target } from "./document.js";
import { normaliseSpace, occurrences, sectionPlainText } from "./text.js";

/**
 * Target resolution status (research report, section 10.3). It is kept apart
 * from the discussion status: a resolved discussion can have an orphaned
 * target, and a precisely placed comment can still be open.
 *
 * exact: the identified target is present and unchanged.
 * changed: same identity, different content since the comment was written.
 * heuristic: a likely candidate exists but identity was not preserved; ask the reviewer.
 * ambiguous: several candidates; none is chosen.
 * orphaned: the target is gone; the comment and its original revision remain.
 * unverified: same identity, but the comment's recorded digest cannot prove the
 *   content is unchanged (it was written before full-content digests).
 * snapshot-only: a spatial note with no editable target.
 */
export type ResolutionStatus =
  | "exact"
  | "changed"
  | "heuristic"
  | "ambiguous"
  | "orphaned"
  | "unverified"
  | "snapshot-only";

export interface Resolution {
  status: ResolutionStatus;
  /** The target the comment points at, when status is exact or changed. */
  target?: Target;
  /** Candidates for heuristic and ambiguous results. Never auto-selected. */
  candidates: Target[];
  note: string;
}

export function resolveTarget(doc: DocModel, ref: TargetRef, observed: Observed): Resolution {
  if (ref.documentId !== doc.documentId) {
    return { status: "orphaned", candidates: [], note: `comment belongs to document ${ref.documentId}` };
  }
  switch (ref.kind) {
    case "diagram":
      return resolveDiagram(doc, ref, observed);
    case "node":
    case "group":
    case "edge":
      return resolveDiagramPart(doc, ref, observed);
    case "text":
      return resolveText(doc, ref);
    case "image":
      return resolveImage(doc, ref, observed);
    case "element":
      return resolveById(doc, ref, observed);
    case "region":
      return {
        status: "snapshot-only",
        candidates: [],
        note: "spatial note; open the original revision to see where it was placed",
      };
  }
}

function compare(target: Target, observed: Observed, what: string): Resolution {
  // A comment written before full-content digests recorded the label-based digest; a match there proves too little.
  if (target.legacyDigest && observed.targetDigest && observed.targetDigest !== target.digest) {
    if (observed.targetDigest !== target.legacyDigest) {
      return { status: "changed", target, candidates: [], note: `${what} changed since the comment was written` };
    }
    return {
      status: "unverified",
      target,
      candidates: [],
      note: `${what} still has the label it had, but the comment predates full-content digests, so a change inside it cannot be ruled out`,
    };
  }
  if (!observed.targetDigest || observed.targetDigest === target.digest) {
    return { status: "exact", target, candidates: [], note: `${what} is unchanged` };
  }
  return { status: "changed", target, candidates: [], note: `${what} changed since the comment was written` };
}

function fromCandidates(candidates: Target[], why: string, goneNote: string): Resolution {
  if (candidates.length === 1) {
    return { status: "heuristic", candidates, note: `${why}; reattach the comment if it is the same element` };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates,
      note: `${candidates.length} elements could match (${why}); none was chosen`,
    };
  }
  return { status: "orphaned", candidates: [], note: goneNote };
}

function resolveDiagram(doc: DocModel, ref: TargetRef, observed: Observed): Resolution {
  const diagram = doc.diagrams.find((d) => d.id === ref.targetId);
  if (!diagram) return { status: "orphaned", candidates: [], note: `diagram ${ref.targetId} no longer exists` };
  if (!observed.targetDigest || observed.targetDigest === diagram.digest) {
    return { status: "exact", candidates: [], note: "diagram is unchanged" };
  }
  return { status: "changed", candidates: [], note: "diagram changed since the comment was written" };
}

function resolveDiagramPart(doc: DocModel, ref: TargetRef, observed: Observed): Resolution {
  const diagram = doc.diagrams.find((d) => d.id === ref.diagramId);
  if (!diagram)
    return { status: "orphaned", candidates: [], note: `diagram ${ref.diagramId ?? "(none)"} no longer exists` };
  if (diagram.ambiguousIds.includes(ref.targetId)) {
    return { status: "ambiguous", candidates: [], note: `id ${ref.targetId} is now claimed by more than one element` };
  }
  const parts = diagram.targetKeys.map((k) => doc.targets.get(k)!);
  const target = doc.targets.get(targetKey(ref.diagramId, ref.targetId));

  if (target && target.kind !== ref.kind) {
    return {
      status: "ambiguous",
      candidates: [target],
      note: `id ${ref.targetId} now names a ${target.kind}, not a ${ref.kind}; reattach explicitly`,
    };
  }

  if (ref.kind === "edge") {
    const sameEnds = parts.filter((t) => t.kind === "edge" && t.from === ref.from && t.to === ref.to);
    if (target && target.mapping === "derived") {
      // A derived edge id is only trustworthy while it is the sole edge between its endpoints.
      if (target.from !== ref.from || target.to !== ref.to) {
        return fromCandidates(sameEnds, "the derived id now joins different nodes", "the connection no longer exists");
      }
      if (sameEnds.length > 1) {
        const sameDigest = sameEnds.filter((t) => t.digest === observed.targetDigest);
        if (sameDigest.length === 1) {
          return {
            status: "heuristic",
            candidates: sameDigest,
            note: `${sameEnds.length} edges now join these nodes and the edge has no declared id; one matches the original`,
          };
        }
        return {
          status: "ambiguous",
          candidates: sameEnds,
          note: `${sameEnds.length} edges now join these nodes and the edge has no declared id`,
        };
      }
    }
    if (target) return compare(target, observed, "connection");
    return fromCandidates(
      sameEnds,
      `an edge between the same nodes exists under another id`,
      `connection ${ref.targetId} no longer exists`,
    );
  }

  if (target) return compare(target, observed, ref.kind === "node" ? "component" : "group");
  const sameLabel = ref.label
    ? parts.filter((t) => t.kind === ref.kind && normaliseSpace(t.label) === normaliseSpace(ref.label!))
    : [];
  return fromCandidates(
    sameLabel,
    `a ${ref.kind} with the same label has another id`,
    `${ref.kind} ${ref.targetId} no longer exists`,
  );
}

function resolveText(doc: DocModel, ref: TargetRef): Resolution {
  const selector = ref.selector;
  if (!selector || selector.type !== "TextQuoteSelector") {
    return { status: "orphaned", candidates: [], note: "text comment has no quote selector" };
  }
  const exact = normaliseSpace(selector.exact);
  const prefix = normaliseSpace(selector.prefix);
  const suffix = normaliseSpace(selector.suffix);
  const sectionId = ref.targetId.replace(/^t\./, "");
  const pseudo = (id: string): Target => {
    const section = doc.sections.find((s) => s.id === id)!;
    return {
      key: `t.${id}`,
      id: `t.${id}`,
      kind: "text",
      sectionId: id,
      label: `"${exact.length > 60 ? `${exact.slice(0, 57)}...` : exact}" in ${section.title}`,
      mapping: "heuristic",
      idSource: "derived",
      lines: { start: section.startLine, end: section.endLine },
      digest: "",
    };
  };

  const matchIn = (id: string) => {
    const text = sectionPlainText(doc, id);
    const hits = occurrences(text, exact);
    const withContext = hits.filter((i) => {
      const before = normaliseSpace(text.slice(Math.max(0, i - prefix.length - 1), i));
      const after = normaliseSpace(text.slice(i + exact.length, i + exact.length + suffix.length + 1));
      return before.endsWith(prefix) && after.startsWith(suffix);
    });
    return { hits, withContext };
  };

  if (doc.sections.some((s) => s.id === sectionId)) {
    const { hits, withContext } = matchIn(sectionId);
    if (withContext.length === 1) {
      return { status: "exact", target: pseudo(sectionId), candidates: [], note: "quoted text found with its context" };
    }
    if (hits.length === 1) {
      return {
        status: "changed",
        target: pseudo(sectionId),
        candidates: [],
        note: "quoted text found; the text around it changed",
      };
    }
    if (hits.length > 1) {
      return {
        status: "ambiguous",
        candidates: [pseudo(sectionId)],
        note: `quoted text appears ${hits.length} times in the section and its context does not single one out`,
      };
    }
  }
  const elsewhere = doc.sections
    .filter((s) => s.id !== sectionId && matchIn(s.id).hits.length > 0)
    .map((s) => pseudo(s.id));
  return fromCandidates(
    elsewhere,
    "the quoted text appears in another section",
    "the quoted text no longer appears in the document",
  );
}

function resolveImage(doc: DocModel, ref: TargetRef, observed: Observed): Resolution {
  const target = doc.targets.get(ref.targetId);
  if (target && target.kind === "image") {
    const result = compare(target, observed, "image");
    if (result.status === "changed" && ref.selector?.type === "ImageRegionSelector") {
      result.note = "image changed since the comment was written; the marked region may no longer match";
    }
    return result;
  }
  const images = [...doc.targets.values()].filter((t) => t.kind === "image");
  // An unchanged image that moved keeps its digest; a relabelled one may keep its alt text.
  const same = images.filter(
    (t) => t.digest === observed.targetDigest || (ref.label !== undefined && t.label === ref.label),
  );
  return fromCandidates(same, "the same image or alt text appears elsewhere", "the image no longer exists");
}

function resolveById(doc: DocModel, ref: TargetRef, observed: Observed): Resolution {
  const key = targetKey(ref.diagramId, ref.targetId);
  if (doc.ambiguousKeys?.includes(key)) {
    return { status: "ambiguous", candidates: [], note: `${ref.targetId} is now claimed by more than one element` };
  }
  const target = doc.targets.get(key);
  const sameContent = (t: Target) =>
    !!observed.targetDigest && t.digest === observed.targetDigest && (!ref.tag || t.block?.tag === ref.tag);
  if (target && ref.tag && target.block && target.block.tag !== ref.tag) {
    return {
      status: "ambiguous",
      candidates: [target],
      note: `${ref.targetId} now names a <${target.block.tag}>, not a <${ref.tag}>; reattach explicitly`,
    };
  }
  if (target && target.mapping !== "derived") return compare(target, observed, "element");
  if (target) {
    // A derived key names a position, so it is trusted only while the content there is the same.
    if (!observed.targetDigest || observed.targetDigest === target.digest) {
      return { status: "exact", target, candidates: [], note: "block is unchanged" };
    }
    const moved = [...doc.targets.values()].filter((t) => t !== target && sameContent(t));
    if (moved.length) return fromCandidates(moved, "the same content is now at another position", "");
    return {
      status: "heuristic",
      candidates: [target],
      note: "a block sits at this position but its content differs; reattach the comment if it is the same block",
    };
  }
  return fromCandidates(
    [...doc.targets.values()].filter(sameContent),
    "an element with the same content exists under another key",
    `element ${ref.targetId} no longer exists`,
  );
}

export interface ResolvedThread {
  thread: Thread;
  resolution: Resolution;
}

export function resolveThreads(doc: DocModel, threads: Thread[]): ResolvedThread[] {
  return threads
    .filter((t) => t.target.documentId === doc.documentId)
    .map((thread) => ({ thread, resolution: resolveTarget(doc, thread.target, thread.observed) }));
}
