import { wrapDescription, type Description } from "../core/description-model.js";
import { digestOf, shortDigest } from "../core/digest.js";
import type { DocModel } from "../core/document.js";
import type { OperationConflict, OperationResult } from "../core/operations.js";
import type { Workspace } from "../core/workspace.js";

export { descriptionModel, descriptionRef, type Description } from "../core/description-model.js";
import { api, GitHubError, resolveRepo } from "./github.js";

/**
 * Issue and pull request descriptions as documents. A description is read
 * through `gh api` as GitHub Flavored Markdown (Mermaid blocks included) and
 * addressed as `github:owner/repo#number`. GitHub holds the text: there is no
 * file and no commit, and the edit history GitHub shows on the issue page is
 * not read, so the revision of a description is the digest of the body as
 * read.
 */

const FULL_REF = /^github:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
const SHORT_REF = /^github:#([1-9]\d*)$/;
const URL_REF = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/([1-9]\d*)\/?(?:[?#].*)?$/;

/**
 * The issue or pull request a document reference names: `github:owner/repo#7`,
 * `github:#7` (the configured repository) or an issue or pull request URL.
 * Null when the reference is not a description.
 */
export function parseDescriptionRef(ws: Workspace, ref: string): { repo: string; number: number } | null {
  const full = FULL_REF.exec(ref) ?? URL_REF.exec(ref);
  if (full) return { repo: full[1]!, number: Number(full[2]) };
  const short = SHORT_REF.exec(ref);
  if (short) return { repo: resolveRepo(ws), number: Number(short[1]) };
  return null;
}

interface IssueRecord {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
}

function toDescription(repo: string, issue: IssueRecord): Description {
  return {
    repo,
    number: issue.number,
    kind: issue.pull_request ? "pull" : "issue",
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    updatedAt: issue.updated_at,
  };
}

/** Pull requests are issues to this endpoint, so one call serves both. */
export function fetchDescription(repo: string, number: number): Description {
  return toDescription(repo, api<IssueRecord>("GET", `repos/${repo}/issues/${number}`));
}

/**
 * Write a planned operation to the description. GitHub offers no conditional
 * update of an issue body, so the body is read again just before the write
 * and nothing is written if it moved on. That narrows the race with another
 * editor but cannot remove it: an edit saved between that read and the write
 * is replaced, and GitHub's edit history on the issue page is then the only
 * record of it. What GitHub stores is compared with what was sent.
 */
export function writeDescription(doc: DocModel, planned: OperationResult): OperationResult | OperationConflict {
  const host = doc.host;
  if (!host) throw new GitHubError(`${doc.path} is not a GitHub description`);
  const current = fetchDescription(host.repo, host.number);
  // The body as it was read; for an HTML description, the fence around the page is part of it.
  if (current.body !== wrapDescription(doc, doc.content)) {
    return {
      ok: false,
      reason: "stale-document",
      message: `the description of ${doc.path} changed on GitHub while the edit was prepared; nothing was written. Read it again and retry`,
      current: { documentDigest: digestOf(current.body) },
    };
  }
  const body = wrapDescription(doc, planned.content);
  const stored = toDescription(
    host.repo,
    api<IssueRecord>("PATCH", `repos/${host.repo}/issues/${host.number}`, { body }),
  ).body;
  if (stored !== body) {
    return {
      ok: false,
      reason: "check-failed",
      message: `the description of ${doc.path} was changed, but GitHub stored different text than HTMi sent (${shortDigest(digestOf(stored))} instead of ${shortDigest(digestOf(body))}); read it again before anything else`,
      current: { documentDigest: digestOf(stored) },
    };
  }
  return { ...planned, written: true };
}
