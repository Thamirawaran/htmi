import { z } from "zod";
import {
  describeRegion,
  ObservedSchema,
  selectorProblem,
  TargetRefSchema,
  TEXT_LIMIT,
  type Observed,
  type TargetRef,
} from "./annotations.js";
import { digestOf, shortDigest } from "./digest.js";

/**
 * The portable feedback record: an ordinary GitHub comment that a person can
 * read without HTMi, plus one hidden metadata line that HTMi parses. The
 * visible text is authoritative; the metadata only carries the target and the
 * revision the reviewer saw. Comment bodies are untrusted input: metadata is
 * schema-checked and authorship always comes from the host, never from here.
 */

export const FEEDBACK_MARKER = "htmi:feedback";
export const REPLY_MARKER = "htmi:reply";

export const FeedbackMetaSchema = z.object({
  v: z.literal(1),
  /** Client-side draft or local comment id. */
  id: z.string().regex(/^[CD]-[0-9A-Z]{4,24}$/),
  kind: z.enum(["comment", "question", "change-request"]),
  target: TargetRefSchema,
  observed: ObservedSchema,
  textDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type FeedbackMeta = z.infer<typeof FeedbackMetaSchema>;

export const ReplyMetaSchema = z.object({
  v: z.literal(1),
  thread: z.string().regex(/^C-[\w-]{1,40}$/),
  id: z.string().regex(/^R-[0-9A-Z]{4,24}$/),
  status: z.enum(["acknowledged", "addressed"]).optional(),
  /** Who wrote the reply locally. Informational: GitHub shows whoever posted it. */
  writer: z.object({ name: z.string().max(100), kind: z.enum(["human", "agent"]) }).optional(),
  revision: z.string().max(100).optional(),
});
export type ReplyMeta = z.infer<typeof ReplyMetaSchema>;

const KIND_TITLES: Record<string, string> = {
  comment: "comment",
  question: "question",
  "change-request": "change request",
};
const TARGET_NAMES: Record<string, string> = {
  diagram: "diagram",
  node: "component",
  edge: "connection",
  group: "group",
  text: "text",
  image: "image",
  element: "element",
  region: "region",
};

/** JSON that cannot end an HTML comment early. */
export function commentSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

export function describeRef(ref: TargetRef): string {
  const name = TARGET_NAMES[ref.kind] ?? ref.kind;
  const where = ref.diagramId ? ` in ${code(ref.diagramId)}` : "";
  const label = ref.label ? `: ${ref.label.replace(/\n/g, " ").replace(/\|/g, "\\|")}` : "";
  if (ref.kind === "text" && ref.selector?.type === "TextQuoteSelector") {
    const excerpt = ref.selector.exact.length > 80 ? `${ref.selector.exact.slice(0, 77)}...` : ref.selector.exact;
    return `text in section ${code(ref.targetId.replace(/^t\./, ""))}: "${excerpt.replace(/\|/g, "\\|")}"`;
  }
  const region = ref.selector?.type === "ImageRegionSelector" ? `; marked region ${describeRegion(ref.selector)}` : "";
  return `${name} ${code(ref.targetId)}${where}${label}${region}`;
}

export interface FeedbackInput {
  id: string;
  kind: FeedbackMeta["kind"];
  text: string;
  target: TargetRef;
  observed: Observed;
  /** Free text such as "snapshot built 2026-10-30 01:40 UTC". */
  context?: string;
}

export function renderFeedback(input: FeedbackInput): string {
  const meta: FeedbackMeta = {
    v: 1,
    id: input.id,
    kind: input.kind,
    target: input.target,
    observed: input.observed,
    textDigest: digestOf(input.text),
  };
  const rows = [
    `| Document | ${code(input.target.documentId)} (${code(input.target.documentPath)}) |`,
    `| Target | ${describeRef(input.target)} |`,
    `| Seen at | ${code(input.observed.revision)} (document sha256 ${code(shortDigest(input.observed.documentDigest))}) |`,
  ];
  if (input.context) rows.push(`| Context | ${input.context.replace(/\|/g, "\\|")} |`);
  return [
    `### HTMi feedback: ${KIND_TITLES[input.kind]} on ${code(input.target.targetId)}`,
    "",
    quote(input.text),
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows,
    "",
    `<!-- ${FEEDBACK_MARKER} ${commentSafeJson(meta)} -->`,
  ].join("\n");
}

export function renderReply(meta: ReplyMeta, text: string): string {
  const status = meta.status ? ` (${meta.status}${meta.revision ? ` in ${code(meta.revision)}` : ""})` : "";
  return [
    `### HTMi reply on ${code(meta.thread)}${meta.writer?.kind === "agent" ? ` from agent ${code(meta.writer.name)}` : ""}${status}`,
    "",
    quote(text),
    "",
    `<!-- ${REPLY_MARKER} ${commentSafeJson(meta)} -->`,
  ].join("\n");
}

export type ParsedComment =
  | { type: "feedback"; meta: FeedbackMeta; text: string; editedAfterCopy: boolean }
  | { type: "reply"; meta: ReplyMeta; text: string }
  | { type: "invalid"; marker: string; error: string }
  | { type: "plain" };

const META_RE = /<!--\s*(htmi:feedback|htmi:reply)\s+(\{[\s\S]*?\})\s*-->/g;

/**
 * The HTMi sections of one host comment. A reviewer can post several prepared
 * comments together (the browser extension puts each into the same comment
 * box); each starts with its own "### HTMi feedback" or "### HTMi reply"
 * heading and is read on its own. A comment with one section, or none, is
 * returned whole.
 */
export function feedbackSections(body: string): string[] {
  const starts = [...body.matchAll(/^### HTMi (?:feedback|reply)\b/gm)].map((m) => m.index!);
  if (starts.length < 2) return [body];
  return starts.map((start, i) => body.slice(start, starts[i + 1] ?? body.length).replace(/\s+$/, "\n"));
}

/** The first blockquote after the heading line: the reviewer's words, as currently shown on the host. */
function visibleQuote(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^\s{0,3}>/.test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++)
    out.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
  return out.join("\n").trim();
}

export function parseComment(body: string): ParsedComment {
  const matches = [...body.matchAll(META_RE)];
  if (matches.length === 0) return { type: "plain" };
  if (matches.length > 1)
    return { type: "invalid", marker: matches[0]![1]!, error: "more than one HTMi metadata block" };
  const [, marker, json] = matches[0]!;
  let raw: unknown;
  try {
    raw = JSON.parse(json!);
  } catch {
    return { type: "invalid", marker: marker!, error: "metadata is not valid JSON" };
  }
  const text = visibleQuote(body);
  if (!text) return { type: "invalid", marker: marker!, error: "no quoted text" };
  if (text.length > TEXT_LIMIT) return { type: "invalid", marker: marker!, error: "text is too long" };
  if (marker === FEEDBACK_MARKER) {
    const meta = FeedbackMetaSchema.safeParse(raw);
    if (!meta.success) return { type: "invalid", marker: marker!, error: issues(meta.error) };
    const problem = selectorProblem(meta.data.target);
    if (problem) return { type: "invalid", marker: marker!, error: `target.selector: ${problem}` };
    return { type: "feedback", meta: meta.data, text, editedAfterCopy: digestOf(text) !== meta.data.textDigest };
  }
  const meta = ReplyMetaSchema.safeParse(raw);
  if (!meta.success) return { type: "invalid", marker: marker!, error: issues(meta.error) };
  return { type: "reply", meta: meta.data, text };
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "metadata"}: ${i.message}`)
    .join("; ");
}
