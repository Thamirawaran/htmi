import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { newId } from "./digest.js";

/**
 * Feedback is stored as append-only events in `.htmi/annotations.jsonl`.
 * Events are never rewritten; the current state of a thread is folded from
 * them. One line per event keeps git merges simple (the file can use the
 * union merge driver) and keeps every past state reconstructible.
 */

export const TEXT_LIMIT = 20_000;

const IdSchema = z
  .string()
  .regex(/^[A-Za-z][\w.:@/-]*$/)
  .max(200);

export const AuthorSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["human", "agent"]),
  /** Where the identity came from. Only `github` is authenticated by a host. */
  source: z.enum(["git-config", "github", "cli", "mcp", "review-page", "vscode"]),
  login: z.string().max(100).optional(),
  verified: z.boolean(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const SelectorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TextQuoteSelector"),
    exact: z.string().min(1).max(2000),
    prefix: z.string().max(200).default(""),
    suffix: z.string().max(200).default(""),
  }),
  z.object({
    type: z.literal("ImageRegionSelector"),
    /** Normalised 0..1 rectangle on the image as displayed. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("ElementSelector"),
    /** Path from the nearest element with an id, for example `#intro > p:nth-of-type(2)`. */
    path: z.string().min(1).max(500),
    fingerprint: z.string().max(200),
    rx: z.number().min(0).max(1),
    ry: z.number().min(0).max(1),
  }),
]);
export type Selector = z.infer<typeof SelectorSchema>;

/**
 * Target ids: HTMi ids such as `n.parser` or `b.costs.table1`, and authored
 * HTML ids as `#id` (HTML allows any id without whitespace).
 */
const TargetIdSchema = z
  .string()
  .max(200)
  .regex(/^(?:[A-Za-z][\w.:@/-]*|#[^\s\u0000-\u001f\u007f]+|t\.[^\s\u0000-\u001f\u007f]+)$/);

export const TargetRefSchema = z.object({
  documentId: z.string().min(1).max(300),
  documentPath: z.string().min(1).max(500),
  kind: z.enum(["diagram", "node", "edge", "group", "text", "image", "element", "region"]),
  diagramId: IdSchema.optional(),
  targetId: TargetIdSchema,
  /** What the reviewer saw, kept so an orphaned target is still understandable. */
  label: z.string().max(500).optional(),
  /** HTML element name of the target, so an id that moves to a different kind of element is noticed. */
  tag: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/i)
    .max(40)
    .optional(),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  selector: SelectorSchema.optional(),
});
export type TargetRef = z.infer<typeof TargetRefSchema>;

/** Smallest side of a marked region, as a fraction of the image; anything smaller is a stray click. */
export const MIN_REGION = 0.01;

/**
 * Why a target's selector does not fit it, or null. The schema checks each
 * field; this checks them together: a quote belongs to a text target, a
 * region to an image, and a region lies inside the image.
 */
export function selectorProblem(ref: TargetRef): string | null {
  const sel = ref.selector;
  if (!sel) return null;
  if (sel.type === "TextQuoteSelector" && ref.kind !== "text") return "a quoted passage belongs to a text target";
  if (sel.type === "ImageRegionSelector") {
    if (ref.kind !== "image") return "a region can only be marked on an image";
    if (sel.w < MIN_REGION || sel.h < MIN_REGION) return "the region is too small; drag a larger rectangle";
    if (sel.x + sel.w > 1.000001 || sel.y + sel.h > 1.000001) return "the region extends outside the image";
  }
  return null;
}

/** A region in words, for people and agents: "from 10% to 40% across, 20% to 60% down". */
export function describeRegion(sel: { x: number; y: number; w: number; h: number }): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `from ${pct(sel.x)} to ${pct(sel.x + sel.w)} across, ${pct(sel.y)} to ${pct(sel.y + sel.h)} down`;
}

export const ObservedSchema = z.object({
  /** Human label of the source revision, for example `a1b2c3d+modified`. */
  revision: z.string().max(100),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable()
    .optional(),
  documentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  targetDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  artifact: z.object({ url: z.string().max(500), number: z.number().int().optional() }).optional(),
});
export type Observed = z.infer<typeof ObservedSchema>;

export const OriginSchema = z.object({
  provider: z.literal("github"),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issue: z.number().int().positive(),
  recordId: z.number().int().positive(),
  /** Which HTMi section of the host comment, when one comment holds several (0 is the first). */
  part: z.number().int().min(0).max(99).optional(),
  url: z.string().url().max(500),
});
export type Origin = z.infer<typeof OriginSchema>;

const base = {
  id: IdSchema,
  at: z.string().datetime(),
  author: AuthorSchema,
};

export const CommentEventSchema = z.object({
  type: z.literal("comment"),
  schemaVersion: z.literal(1),
  ...base,
  target: TargetRefSchema,
  observed: ObservedSchema,
  body: z.object({
    kind: z.enum(["comment", "question", "change-request"]),
    text: z.string().min(1).max(TEXT_LIMIT),
  }),
  /** local: only in this repository's store. shared: visible on a host such as GitHub. */
  visibility: z.enum(["local", "shared"]),
  origin: OriginSchema.optional(),
});

export const ReplyEventSchema = z.object({
  type: z.literal("reply"),
  ...base,
  threadId: IdSchema,
  body: z.object({ text: z.string().min(1).max(TEXT_LIMIT) }),
  /** Revision the reply refers to, for example the commit an agent made. */
  revision: z.string().max(100).optional(),
  origin: OriginSchema.optional(),
});

export const DISCUSSION = ["open", "acknowledged", "addressed", "resolved", "wontfix"] as const;
export type Discussion = (typeof DISCUSSION)[number];
/** Statuses only a human reviewer may set. */
export const HUMAN_ONLY: Discussion[] = ["resolved", "wontfix"];

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  ...base,
  threadId: IdSchema,
  discussion: z.enum(DISCUSSION),
  note: z.string().max(TEXT_LIMIT).optional(),
  revision: z.string().max(100).optional(),
});

export const ReattachEventSchema = z.object({
  type: z.literal("reattach"),
  ...base,
  threadId: IdSchema,
  target: TargetRefSchema,
  observed: ObservedSchema,
  reason: z.string().max(2000),
});

export const EvidenceEventSchema = z.object({
  type: z.literal("evidence"),
  ...base,
  threadId: IdSchema.optional(),
  claim: z.string().min(1).max(2000),
  command: z.string().min(1).max(2000),
  exitCode: z.number().int(),
  result: z.enum(["pass", "fail"]),
  revision: z.string().max(100),
  outputTail: z.string().max(4000).optional(),
});

export const PublishEventSchema = z.object({
  type: z.literal("publish"),
  ...base,
  threadId: IdSchema,
  /** The event that was published: the comment id or a reply id. */
  eventId: IdSchema,
  origin: OriginSchema,
});

export const EventSchema = z.discriminatedUnion("type", [
  CommentEventSchema,
  ReplyEventSchema,
  StatusEventSchema,
  ReattachEventSchema,
  EvidenceEventSchema,
  PublishEventSchema,
]);
export type AnnotationEvent = z.infer<typeof EventSchema>;
export type CommentEvent = z.infer<typeof CommentEventSchema>;
export type ReplyEvent = z.infer<typeof ReplyEventSchema>;
export type StatusEvent = z.infer<typeof StatusEventSchema>;
export type ReattachEvent = z.infer<typeof ReattachEventSchema>;
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type PublishEvent = z.infer<typeof PublishEventSchema>;

export interface Thread {
  id: string;
  comment: CommentEvent;
  /** Current target: the original, or the latest explicit reattachment. */
  target: TargetRef;
  observed: Observed;
  replies: ReplyEvent[];
  statuses: StatusEvent[];
  discussion: Discussion;
  reattachments: ReattachEvent[];
  evidence: EvidenceEvent[];
  publications: PublishEvent[];
  updatedAt: string;
}

export interface StoreProblem {
  line: number;
  error: string;
}

export class AnnotationError extends Error {}

export function annotationsPath(repoRoot: string): string {
  return join(repoRoot, ".htmi", "annotations.jsonl");
}

export class AnnotationStore {
  readonly file: string;

  constructor(readonly repoRoot: string) {
    this.file = annotationsPath(repoRoot);
  }

  read(): { events: AnnotationEvent[]; problems: StoreProblem[] } {
    if (!existsSync(this.file)) return { events: [], problems: [] };
    const events: AnnotationEvent[] = [];
    const problems: StoreProblem[] = [];
    const lines = readFileSync(this.file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (text.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        problems.push({ line: i + 1, error: "not valid JSON" });
        return;
      }
      const parsed = EventSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push({
          line: i + 1,
          error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
        });
        return;
      }
      events.push(parsed.data);
    });
    return { events, problems };
  }

  /** Validate and append one event. Rejects duplicates and rule violations instead of writing them. */
  append(event: AnnotationEvent): AnnotationEvent {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      throw new AnnotationError(parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
    }
    const { events } = this.read();
    if (events.some((e) => e.id === parsed.data.id))
      throw new AnnotationError(`event ${parsed.data.id} already exists`);
    const checked = parsed.data;
    if (checked.type !== "comment" && checked.type !== "evidence") {
      if (!events.some((e) => e.type === "comment" && e.id === checked.threadId)) {
        throw new AnnotationError(`no comment thread ${checked.threadId}`);
      }
    }
    if (checked.type === "evidence" && checked.threadId) {
      if (!events.some((e) => e.type === "comment" && e.id === checked.threadId)) {
        throw new AnnotationError(`no comment thread ${checked.threadId}`);
      }
    }
    if (checked.type === "status" && checked.author.kind === "agent" && HUMAN_ONLY.includes(checked.discussion)) {
      throw new AnnotationError(`an agent cannot mark a thread ${checked.discussion}; a reviewer has to`);
    }
    if (checked.type === "reattach" && checked.author.kind === "agent") {
      throw new AnnotationError("an agent cannot reattach a comment; a reviewer has to choose the new target");
    }
    mkdirSync(dirname(this.file), { recursive: true });
    // One write per event. O_APPEND keeps concurrent appends from interleaving on local filesystems.
    appendFileSync(this.file, `${JSON.stringify(checked)}\n`, { encoding: "utf8" });
    return checked;
  }

  threads(): Thread[] {
    return foldThreads(this.read().events);
  }

  thread(id: string): Thread | undefined {
    return this.threads().find((t) => t.id === id);
  }

  /** A new event id that is not used yet. */
  freshId(prefix: "C" | "R" | "S" | "A" | "E" | "P"): string {
    const used = new Set(this.read().events.map((e) => e.id));
    for (;;) {
      const id = newId(prefix);
      if (!used.has(id)) return id;
    }
  }
}

export function foldThreads(events: AnnotationEvent[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const event of events) {
    if (event.type === "comment") {
      threads.set(event.id, {
        id: event.id,
        comment: event,
        target: event.target,
        observed: event.observed,
        replies: [],
        statuses: [],
        discussion: "open",
        reattachments: [],
        evidence: [],
        publications: [],
        updatedAt: event.at,
      });
      continue;
    }
    const thread = event.threadId ? threads.get(event.threadId) : undefined;
    if (!thread) continue;
    thread.updatedAt = event.at > thread.updatedAt ? event.at : thread.updatedAt;
    switch (event.type) {
      case "reply":
        thread.replies.push(event);
        break;
      case "status":
        // Rule violations written by hand are ignored rather than trusted.
        if (event.author.kind === "agent" && HUMAN_ONLY.includes(event.discussion)) break;
        thread.statuses.push(event);
        thread.discussion = event.discussion;
        break;
      case "reattach":
        if (event.author.kind === "agent") break;
        thread.reattachments.push(event);
        thread.target = event.target;
        thread.observed = event.observed;
        break;
      case "evidence":
        thread.evidence.push(event);
        break;
      case "publish":
        thread.publications.push(event);
        break;
    }
  }
  return [...threads.values()];
}

export function nowIso(): string {
  return new Date().toISOString();
}
