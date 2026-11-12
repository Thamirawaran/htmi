import { execFileSync } from "node:child_process";
import { childEnv } from "./env.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Where the content of a document came from. */
export interface SourceRevision {
  /** Commit the content was read at, or HEAD for working-tree reads. Null outside git or before the first commit. */
  commit: string | null;
  /**
   * "commit": read from a commit. "clean": working tree equals HEAD. "modified": working tree differs.
   * "untracked": not in git. "host": read from a host such as a GitHub issue description, not from git.
   */
  state: "commit" | "clean" | "modified" | "untracked" | "no-git" | "host";
  /** Short human label, for example `a1b2c3d`, `a1b2c3d+modified`, `untracked`, `body@a1b2c3d`. */
  label: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv(),
    }).trim();
  } catch {
    return null;
  }
}

/** The git top level containing `start`, or null. */
export function gitRoot(start: string): string | null {
  let dir = start;
  try {
    if (statSync(start).isFile()) dir = dirname(start);
  } catch {
    dir = dirname(start);
  }
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

/** The repository root used for a path: git top level, else the nearest folder holding `.htmi`, else `start`. */
export function findRepoRoot(start: string): string {
  const fromGit = gitRoot(start);
  if (fromGit) return realpathSync(fromGit);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, ".htmi"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Repository relative POSIX path, or null if `absolute` lies outside `root`. */
export function repoRelative(root: string, absolute: string): string | null {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The repository relative form of `path` when the file stays inside the repository, both as
 * written and after following symbolic links; null when it would escape. A leading "/" means
 * the repository root. Every document read and every document write goes through this, so a
 * path such as "../../.env", or a symlink pointing outside, is refused rather than followed.
 */
export function confinedPath(root: string, path: string): string | null {
  const absolute = join(root, path);
  const rel = repoRelative(root, absolute);
  if (!rel) return null;
  // The nearest part of the path that exists decides where it really points.
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  const realRoot = realpathSync(root);
  const real = realpathSync(existing);
  if (real !== realRoot && !repoRelative(realRoot, real)) return null;
  return rel;
}

export function headCommit(root: string): string | null {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
}

/** Revision of a working-tree file. */
export function workingRevision(root: string, path: string): SourceRevision {
  if (!gitRoot(root)) return { commit: null, state: "no-git", label: "no-git" };
  const head = headCommit(root);
  const tracked = git(root, ["ls-files", "--error-unmatch", "--", path]) !== null;
  if (!head || !tracked) return { commit: head, state: "untracked", label: "untracked" };
  const short = head.slice(0, 7);
  const status = git(root, ["status", "--porcelain", "--", path]) ?? "";
  if (status.trim() === "") return { commit: head, state: "clean", label: short };
  return { commit: head, state: "modified", label: `${short}+modified` };
}

/** Resolve any commit-ish to a full commit id. */
export function resolveCommit(root: string, rev: string): string | null {
  return git(root, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
}

/** File content at a commit, or null if it does not exist there. */
export function readAtCommit(root: string, commit: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      env: childEnv(),
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The configured git identity, used as an unauthenticated local author. */
export function gitIdentity(root: string): { name: string; email?: string } | null {
  const name = git(root, ["config", "user.name"]);
  if (!name) return null;
  return { name, email: git(root, ["config", "user.email"]) ?? undefined };
}

/** Files tracked by git (plus untracked, not ignored) matching the given suffixes. */
export function listRepoFiles(root: string, suffixes: string[]): string[] {
  const out = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (out === null) return [];
  return out
    .split("\0")
    .filter((p) => p && suffixes.some((s) => p.toLowerCase().endsWith(s)))
    .sort();
}

/** Label for the whole working tree: short HEAD, plus "+modified" when anything differs from it. */
export function repoRevision(root: string): string {
  const head = headCommit(root);
  if (!head) return gitRoot(root) ? "uncommitted" : "no-git";
  const dirty = (git(root, ["status", "--porcelain"]) ?? "").trim() !== "";
  return `${head.slice(0, 7)}${dirty ? "+modified" : ""}`;
}
