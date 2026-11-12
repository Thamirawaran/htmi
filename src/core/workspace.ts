import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadAnyDocument } from "./load.js";
import type { DocModel } from "./document.js";
import { confinedPath, findRepoRoot, listRepoFiles } from "./revision.js";

export const ConfigSchema = z.object({
  /** Globs (relative to the repository root) of documents HTMi should list, instead of the default rule. */
  documents: z.array(z.string()).optional(),
  /** Globs of files never to list, for example built sites or application templates. */
  exclude: z.array(z.string()).optional(),
  github: z
    .object({
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface Workspace {
  root: string;
  config: Config;
}

export class WorkspaceError extends Error {}

export function openWorkspace(cwd: string): Workspace {
  const root = findRepoRoot(cwd);
  const file = join(root, ".htmi", "config.json");
  let config: Config = {};
  if (existsSync(file)) {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new WorkspaceError(`.htmi/config.json: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    config = parsed.data;
  }
  return { root, config };
}

export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const GENERATED = /<meta name="generator" content="htmi /;
const MARKDOWN_MARKERS = /```mermaid|~~~mermaid|<!--\s*htmi:document/;
/** Folders that hold dependencies, build output or test output rather than documents. */
const NOT_DOCUMENTS =
  /(^|\/)(\.htmi|\.git|node_modules|vendor|third_party|bower_components|dist|build|out|coverage|test-results|playwright-report)\//;

/**
 * Documents HTMi should list. With `documents` globs in .htmi/config.json,
 * exactly the files they match. Otherwise every HTML file, and every Markdown
 * file that contains a Mermaid block or a HTMi marker, outside dependency,
 * build and test output folders. `exclude` globs apply either way. HTMi's own
 * review pages are views, never documents. Any file can still be opened by path.
 */
export function discoverDocuments(ws: Workspace): string[] {
  // A file that leaves the repository (a symbolic link pointing outside) is never a document.
  const files = listRepoFiles(ws.root, [".md", ".html", ".htm"]).filter((f) => confinedPath(ws.root, f) === f);
  const excluded = (ws.config.exclude ?? []).map(globToRegExp);
  const kept = files.filter((f) => !excluded.some((p) => p.test(f)));
  if (ws.config.documents?.length) {
    const patterns = ws.config.documents.map(globToRegExp);
    return kept.filter((f) => patterns.some((p) => p.test(f)));
  }
  return kept.filter((f) => {
    if (NOT_DOCUMENTS.test(f)) return false;
    try {
      const text = readFileSync(join(ws.root, f), "utf8");
      if (GENERATED.test(text)) return false;
      return /\.html?$/i.test(f) || MARKDOWN_MARKERS.test(text);
    } catch {
      return false;
    }
  });
}

/** Find a document by declared id, derived id, or repository path. */
export function findDocument(ws: Workspace, query: string, rev?: string): DocModel {
  const asPath = query.replace(/^\.\//, "");
  const direct = asPath.startsWith("path:") ? asPath.slice(5) : asPath;
  if (existsSync(join(ws.root, direct)) || rev) {
    try {
      return loadAnyDocument({ repoRoot: ws.root, path: direct, rev });
    } catch (error) {
      if (!rev) throw error;
    }
  }
  const matches: DocModel[] = [];
  for (const path of discoverDocuments(ws)) {
    const doc = loadAnyDocument({ repoRoot: ws.root, path });
    if (doc.documentId === query) matches.push(rev ? loadAnyDocument({ repoRoot: ws.root, path, rev }) : doc);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new WorkspaceError(
      `document id "${query}" is declared by ${matches.map((m) => m.path).join(", ")}; use a path`,
    );
  }
  throw new WorkspaceError(`no document "${query}"; run \`htmi list\` to see documents`);
}
