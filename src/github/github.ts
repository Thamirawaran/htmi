import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AnnotationStore, nowIso, type Author, type Thread } from "../core/annotations.js";
import { digestOf } from "../core/digest.js";
import type { DocModel } from "../core/document.js";
import { feedbackSections, parseComment, renderFeedback, renderReply } from "../core/feedback.js";
import { resolveThreads } from "../core/resolve.js";
import type { Workspace } from "../core/workspace.js";
import { buildReviewPage } from "../render/review-page.js";

/**
 * GitHub adapter. All calls go through the GitHub CLI (`gh api`), so HTMi
 * never handles a token: authentication is whatever `gh auth login` set up.
 * GitHub comments are the authoritative store for shared feedback; the local
 * store mirrors them idempotently, keyed by GitHub's comment id.
 */

export const API_VERSION = "2026-03-10";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface IssueComment {
  id: number;
  html_url: string;
  body: string;
  user: { login: string; type: string } | null;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: number;
  number: number;
  html_url: string;
  type: string;
  name: string;
  body: string;
  updated_at: string | null;
}

function gh(args: string[], input?: string): string {
  const bin = process.env.HTMI_GH ?? "gh";
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; status?: number; code?: string };
    if (e.code === "ENOENT") throw new GitHubError("the GitHub CLI (gh) is not installed or not on PATH");
    const stderr = (e.stderr ?? "").trim();
    const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || undefined;
    let message = stderr.split("\n")[0] || "gh failed";
    try {
      const body = JSON.parse(e.stdout ?? "") as { message?: string; errors?: { message?: string }[] };
      if (body.message)
        message = `${body.message}${body.errors?.length ? `: ${body.errors.map((x) => x.message).join("; ")}` : ""}`;
    } catch {
      // stdout was not JSON; keep the stderr line
    }
    throw new GitHubError(message, status);
  }
}

export function api<T>(method: string, path: string, body?: unknown): T {
  const args = [
    "api",
    "-X",
    method,
    path,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ];
  if (body !== undefined) args.push("--input", "-");
  const out = gh(args, body === undefined ? undefined : JSON.stringify(body));
  return (out.trim() ? JSON.parse(out) : null) as T;
}

/** All pages of a list endpoint. */
export function apiList<T>(path: string): T[] {
  const out = gh([
    "api",
    "--paginate",
    "--slurp",
    path,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ]);
  return (JSON.parse(out) as T[][]).flat();
}

/** `owner/name` from the origin remote, when it points at github.com. */
export function repoFromGit(root: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

export function resolveRepo(ws: Workspace, explicit?: string): string {
  const repo = explicit ?? ws.config.github?.repo ?? repoFromGit(ws.root);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new GitHubError("cannot tell which GitHub repository to use; pass --repo owner/name");
  }
  return repo;
}

export function getIssue(
  repo: string,
  issue: number,
): { number: number; html_url: string; title: string; state: string; pull_request?: unknown } {
  return api("GET", `repos/${repo}/issues/${issue}`);
}

export function createIssue(repo: string, title: string, body: string): { number: number; html_url: string } {
  return api("POST", `repos/${repo}/issues`, { title, body });
}

export function listIssueComments(repo: string, issue: number): IssueComment[] {
  return apiList<IssueComment>(`repos/${repo}/issues/${issue}/comments?per_page=100`);
}

export function createIssueComment(repo: string, issue: number, body: string): IssueComment {
  return api("POST", `repos/${repo}/issues/${issue}/comments`, { body });
}

/* ---------- publishing a review snapshot as an issue artifact ---------- */

const PublishStateSchema = z.object({
  artifacts: z.record(
    z.string(),
    z.object({
      number: z.number().int(),
      id: z.number().int(),
      url: z.string(),
      bodyDigest: z.string(),
      publishedAt: z.string(),
      sourceRevision: z.string(),
    }),
  ),
});
type PublishState = z.infer<typeof PublishStateSchema>;

function statePath(root: string): string {
  return join(root, ".htmi", "github.json");
}

function readState(root: string): PublishState {
  const file = statePath(root);
  if (!existsSync(file)) return { artifacts: {} };
  return PublishStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function writeState(root: string, state: PublishState): void {
  mkdirSync(dirname(statePath(root)), { recursive: true });
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * GitHub accepts artifact names made of letters, digits, spaces, periods,
 * hyphens and underscores that start and end with a letter or digit.
 */
export function artifactName(text: string): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .slice(0, 100)
    .replace(/[^\p{L}\p{N}]+$/u, "");
  return cleaned || "HTMi review";
}

/** True when a thread is visible on a host: imported from it, or posted to it. */
export function isShared(thread: Thread): boolean {
  return thread.comment.visibility === "shared" || thread.publications.some((p) => p.eventId === thread.id);
}

export interface PublishResult {
  action: "created" | "updated";
  url: string;
  number: number;
  bytes: number;
  threads: number;
  localThreadsLeftOut: number;
}

/**
 * Publish the review page for one document to an issue. HTMi is the only
 * writer of the artifacts it creates: before an update it compares the
 * artifact's current body with what it last wrote and stops on any
 * difference. The API offers no conditional write, so this narrows a race
 * with another writer but does not exclude it.
 */
export function publishReview(
  ws: Workspace,
  doc: DocModel,
  options: { repo: string; issue: number; includeLocal: boolean; newSnapshot: boolean; version: string },
): PublishResult {
  const issue = getIssue(options.repo, options.issue);
  if (issue.pull_request) {
    // The API accepts an artifact on a pull request, but GitHub shows it nowhere (observed 2026-10-30).
    throw new GitHubError(
      `#${options.issue} is a pull request, and GitHub does not show artifacts on pull requests; publish to an issue instead with --issue, for example one that links the pull request`,
    );
  }
  const store = new AnnotationStore(ws.root);
  const all = resolveThreads(doc, store.threads());
  const threads = options.includeLocal ? all : all.filter((r) => isShared(r.thread));
  const html = buildReviewPage({
    doc,
    repoRoot: ws.root,
    threads,
    mode: "snapshot",
    builtAt: nowIso(),
    github: { repo: options.repo, issue: issue.number, issueUrl: issue.html_url },
    includesLocalComments: options.includeLocal,
    version: options.version,
  });
  const key = `${options.repo}#${options.issue}:${doc.documentId}`;
  const state = readState(ws.root);
  const known = state.artifacts[key];
  const name = artifactName(`HTMi review ${doc.title} ${doc.revision.label}`);
  let artifact: Artifact;
  let action: PublishResult["action"];
  if (known && !options.newSnapshot) {
    const current = api<{ artifact: Artifact } | Artifact>(
      "GET",
      `repos/${options.repo}/issues/${options.issue}/artifacts/${known.number}`,
    );
    const body = "artifact" in current ? current.artifact.body : current.body;
    if (digestOf(body) !== known.bodyDigest) {
      throw new GitHubError(
        `artifact #${known.number} was changed on GitHub since HTMi last published it; nothing was overwritten. Review it, then publish with --new to create a separate snapshot`,
      );
    }
    artifact = api<Artifact>("PATCH", `repos/${options.repo}/issues/${options.issue}/artifacts/${known.number}`, {
      name,
      body: html,
    });
    action = "updated";
  } else {
    artifact = api<Artifact>("POST", `repos/${options.repo}/issues/${options.issue}/artifacts`, {
      type: "embedded_html",
      name,
      body: html,
    });
    action = "created";
  }
  state.artifacts[key] = {
    number: artifact.number,
    id: artifact.id,
    url: artifact.html_url,
    bodyDigest: digestOf(artifact.body),
    publishedAt: nowIso(),
    sourceRevision: doc.revision.label,
  };
  writeState(ws.root, state);
  return {
    action,
    url: artifact.html_url,
    number: artifact.number,
    bytes: Buffer.byteLength(html),
    threads: threads.length,
    localThreadsLeftOut: all.length - threads.length,
  };
}

/* ---------- mirroring feedback from issue comments ---------- */

export interface PullResult {
  imported: string[];
  replies: string[];
  alreadyMirrored: number;
  plain: number;
  invalid: { url: string; error: string }[];
  editedOnHost: string[];
}

function hostAuthor(user: IssueComment["user"]): Author {
  const login = user?.login ?? "ghost";
  return { name: login, login, kind: user?.type === "Bot" ? "agent" : "human", source: "github", verified: true };
}

export function pullFeedback(ws: Workspace, options: { repo: string; issue: number }): PullResult {
  const store = new AnnotationStore(ws.root);
  const comments = listIssueComments(options.repo, options.issue);
  const result: PullResult = { imported: [], replies: [], alreadyMirrored: 0, plain: 0, invalid: [], editedOnHost: [] };
  for (const c of comments) {
    const sections = feedbackSections(c.body);
    sections.forEach((section, part) => importSection(c, section, sections.length > 1 ? part : undefined));
  }
  return result;

  function importSection(c: IssueComment, section: string, part: number | undefined): void {
    const parsed = parseComment(section);
    const suffix = part ? `-${part}` : "";
    if (parsed.type === "plain") {
      result.plain++;
      return;
    }
    if (parsed.type === "invalid") {
      result.invalid.push({ url: c.html_url, error: parsed.error });
      return;
    }
    const origin = {
      provider: "github" as const,
      repo: options.repo,
      issue: options.issue,
      recordId: c.id,
      ...(part !== undefined ? { part } : {}),
      url: c.html_url,
    };
    const { events } = store.read();
    const mirrored = events.find(
      (e) =>
        ("origin" in e &&
          e.origin?.recordId === c.id &&
          e.origin.repo === options.repo &&
          (e.origin.part ?? 0) === (part ?? 0)) ||
        (e.type === "publish" && e.origin.recordId === c.id && (e.origin.part ?? 0) === (part ?? 0)),
    );
    if (mirrored) {
      result.alreadyMirrored++;
      const original = mirrored.type === "comment" || mirrored.type === "reply" ? mirrored.body.text : undefined;
      if (original !== undefined && original !== parsed.text) result.editedOnHost.push(c.html_url);
      return;
    }
    if (parsed.type === "feedback") {
      const local = store.thread(parsed.meta.id);
      if (local && local.comment.body.text === parsed.text) {
        // Posted from this repository earlier, but the publish record was lost: record the mapping only.
        store.append({
          type: "publish",
          id: store.freshId("P"),
          threadId: local.id,
          eventId: local.id,
          at: nowIso(),
          author: hostAuthor(c.user),
          origin,
        });
        result.alreadyMirrored++;
        return;
      }
      const id = `C-GH${c.id}${suffix}`;
      store.append({
        type: "comment",
        schemaVersion: 1,
        id,
        at: new Date(c.created_at).toISOString(),
        author: hostAuthor(c.user),
        target: parsed.meta.target,
        observed: parsed.meta.observed,
        body: { kind: parsed.meta.kind, text: parsed.text },
        visibility: "shared",
        origin,
      });
      result.imported.push(id);
      return;
    }
    // A reply: attach it to its thread if the thread is known here.
    const thread = store.thread(parsed.meta.thread);
    if (!thread) {
      result.invalid.push({ url: c.html_url, error: `reply to unknown thread ${parsed.meta.thread}` });
      return;
    }
    if (thread.replies.some((r) => r.id === parsed.meta.id)) {
      store.append({
        type: "publish",
        id: store.freshId("P"),
        threadId: thread.id,
        eventId: parsed.meta.id,
        at: nowIso(),
        author: hostAuthor(c.user),
        origin,
      });
      result.alreadyMirrored++;
      return;
    }
    const poster = hostAuthor(c.user);
    // The host verifies who posted; a declared agent writer is recorded as unverified.
    const author: Author =
      parsed.meta.writer?.kind === "agent"
        ? { name: parsed.meta.writer.name, kind: "agent", source: "github", login: poster.login, verified: false }
        : poster;
    const id = `R-GH${c.id}${suffix}`;
    store.append({
      type: "reply",
      id,
      threadId: thread.id,
      at: new Date(c.created_at).toISOString(),
      author,
      body: { text: parsed.text },
      revision: parsed.meta.revision,
      origin,
    });
    if (parsed.meta.status) {
      store.append({
        type: "status",
        id: `S-GH${c.id}`,
        threadId: thread.id,
        at: new Date(c.created_at).toISOString(),
        author,
        discussion: parsed.meta.status,
        revision: parsed.meta.revision,
      });
    }
    result.replies.push(id);
  }
}

/* ---------- posting local feedback to an issue ---------- */

export interface PostResult {
  posted: { eventId: string; url: string }[];
  alreadyPublished: string[];
}

/**
 * Post a thread's unpublished parts to an issue. Making a local comment
 * visible on GitHub is an explicit visibility change, so this only runs on
 * request. Retries are safe: before posting, existing issue comments are
 * searched for the same HTMi id.
 */
export function postThread(ws: Workspace, threadId: string, options: { repo: string; issue: number }): PostResult {
  const store = new AnnotationStore(ws.root);
  const thread = store.thread(threadId);
  if (!thread) throw new GitHubError(`no thread ${threadId}`);
  const result: PostResult = { posted: [], alreadyPublished: [] };
  const published = (eventId: string) =>
    thread.publications.some((p) => p.eventId === eventId) ||
    (eventId === thread.id && !!thread.comment.origin) ||
    thread.replies.some((r) => r.id === eventId && !!r.origin);

  let existing: IssueComment[] | undefined;
  const findExisting = (eventId: string) => {
    existing ??= listIssueComments(options.repo, options.issue);
    return existing.find((c) =>
      feedbackSections(c.body).some((section) => {
        const parsed = parseComment(section);
        return (
          (parsed.type === "feedback" && parsed.meta.id === eventId) ||
          (parsed.type === "reply" && parsed.meta.id === eventId)
        );
      }),
    );
  };
  const record = (eventId: string, c: IssueComment) =>
    store.append({
      type: "publish",
      id: store.freshId("P"),
      threadId: thread.id,
      eventId,
      at: nowIso(),
      author: hostAuthor(c.user),
      origin: { provider: "github", repo: options.repo, issue: options.issue, recordId: c.id, url: c.html_url },
    });

  const parts: { eventId: string; body: () => string }[] = [
    {
      eventId: thread.id,
      body: () =>
        renderFeedback({
          id: thread.id,
          kind: thread.comment.body.kind,
          text: thread.comment.body.text,
          target: thread.comment.target,
          observed: thread.comment.observed,
          context: `posted by htmi from a local comment written ${thread.comment.at.slice(0, 16).replace("T", " ")} UTC`,
        }),
    },
    ...thread.replies.map((r) => ({
      eventId: r.id,
      body: () => {
        // `htmi reply --status` writes the reply and its status with the same timestamp and author.
        const status = thread.statuses.find((s) => s.at === r.at && s.author.name === r.author.name);
        const carried =
          status?.discussion === "acknowledged" || status?.discussion === "addressed" ? status.discussion : undefined;
        return renderReply(
          {
            v: 1,
            thread: thread.id,
            id: r.id,
            status: carried,
            revision: r.revision,
            writer: { name: r.author.name.slice(0, 100), kind: r.author.kind },
          },
          r.body.text,
        );
      },
    })),
  ];
  for (const part of parts) {
    if (published(part.eventId)) {
      result.alreadyPublished.push(part.eventId);
      continue;
    }
    const found = findExisting(part.eventId);
    if (found) {
      record(part.eventId, found);
      result.alreadyPublished.push(part.eventId);
      continue;
    }
    const created = createIssueComment(options.repo, options.issue, part.body());
    record(part.eventId, created);
    result.posted.push({ eventId: part.eventId, url: created.html_url });
  }
  return result;
}
