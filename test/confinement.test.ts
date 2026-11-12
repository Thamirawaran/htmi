import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAnyDocument } from "../src/core/load.js";
import { applyOperation } from "../src/core/operations.js";
import { confinedPath } from "../src/core/revision.js";
import { discoverDocuments, openWorkspace } from "../src/core/workspace.js";

const CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const PAGE = `<!doctype html><html><head><title>Plan</title></head><body>
<h1 id="title">Plan</h1>
<p id="decision">Ship it in March.</p>
</body></html>
`;
const SECRET = `<!doctype html><html><body><p id="key">MODEL_API_KEY=not-a-real-key</p></body></html>
`;

/*
 * Documents are read and written only inside the repository: a path such as "../../.env",
 * or a symbolic link pointing outside, is refused by every way in (the core loader, the
 * write itself, the CLI, the MCP server). Real files, a real git repository, real symlinks.
 */
/** A temporary git repository with one committed HTML page. */
class Repo {
  readonly root = mkdtempSync(join(tmpdir(), "htmi-confine-"));
  constructor() {
    this.git("init", "-q");
    this.git("config", "user.name", "Reviewer");
    this.git("config", "user.email", "reviewer@example.invalid");
    this.git("config", "commit.gpgsign", "false");
  }
  git(...args: string[]): void {
    execFileSync("git", args, { cwd: this.root, stdio: "ignore" });
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), content);
  }
  commitAll(message: string): void {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
  }
  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe("documents stay inside the repository", () => {
  let repo: Repo;
  let outside: string;
  beforeEach(() => {
    repo = new Repo();
    repo.write("docs/page.html", PAGE);
    repo.commitAll("page");
    outside = mkdtempSync(join(tmpdir(), "htmi-outside-"));
    writeFileSync(join(outside, "secret.html"), SECRET);
  });
  afterEach(() => {
    repo.remove();
    rmSync(outside, { recursive: true, force: true });
  });

  const toOutside = () => relative(repo.root, join(outside, "secret.html"));

  it("confinedPath accepts paths inside, normalizes them, and refuses escapes", () => {
    expect(confinedPath(repo.root, "docs/page.html")).toBe("docs/page.html");
    expect(confinedPath(repo.root, "./docs/../docs/page.html")).toBe("docs/page.html");
    expect(confinedPath(repo.root, "/docs/page.html")).toBe("docs/page.html");
    expect(confinedPath(repo.root, "docs/new-page.html")).toBe("docs/new-page.html");
    expect(confinedPath(repo.root, toOutside())).toBeNull();
    expect(confinedPath(repo.root, "../../etc/passwd")).toBeNull();
    expect(confinedPath(repo.root, "")).toBeNull();
    symlinkSync(join(outside, "secret.html"), join(repo.root, "docs/leak.html"));
    symlinkSync(outside, join(repo.root, "docs/out"));
    expect(confinedPath(repo.root, "docs/leak.html")).toBeNull();
    expect(confinedPath(repo.root, "docs/out/secret.html")).toBeNull();
    expect(confinedPath(repo.root, "docs/out/not-there.html")).toBeNull();
  });

  it("the loader refuses a path outside the repository and a symlink pointing outside", () => {
    expect(() => loadAnyDocument({ repoRoot: repo.root, path: toOutside() })).toThrow(/outside the repository/);
    symlinkSync(join(outside, "secret.html"), join(repo.root, "docs/leak.html"));
    expect(() => loadAnyDocument({ repoRoot: repo.root, path: "docs/leak.html" })).toThrow(/outside the repository/);
    // A symlink that stays inside the repository is an ordinary document.
    symlinkSync(join(repo.root, "docs/page.html"), join(repo.root, "docs/alias.html"));
    expect(loadAnyDocument({ repoRoot: repo.root, path: "docs/alias.html" }).title).toBe("Plan");
    // The document's path is the normalized one.
    expect(loadAnyDocument({ repoRoot: repo.root, path: "docs/../docs/page.html" }).path).toBe("docs/page.html");
  });

  it("a symlink pointing outside is not listed as a document", () => {
    symlinkSync(join(outside, "secret.html"), join(repo.root, "docs/leak.html"));
    repo.commitAll("symlink");
    const ws = openWorkspace(repo.root);
    expect(discoverDocuments(ws)).toEqual(["docs/page.html"]);
  });

  it("an edit is not written when the file became a symlink to outside after it was read", () => {
    const doc = loadAnyDocument({ repoRoot: repo.root, path: "docs/page.html" });
    // Same bytes outside, so only the confinement check can stop the write.
    writeFileSync(join(outside, "page.html"), PAGE);
    unlinkSync(join(repo.root, "docs/page.html"));
    symlinkSync(join(outside, "page.html"), join(repo.root, "docs/page.html"));
    const result = applyOperation(doc, repo.root, {
      op: "set-text",
      expectedDocumentDigest: doc.digest,
      target: "#decision",
      expectedTargetDigest: doc.targets.get("#decision")!.digest,
      find: "March",
      replace: "April",
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(readFileSync(join(outside, "page.html"), "utf8")).toBe(PAGE);
  });

  it("the CLI refuses to read outside the repository", () => {
    const htmi = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { cwd: repo.root, encoding: "utf8" });
    const escape = htmi("read", toOutside());
    expect(escape.status).not.toBe(0);
    expect(escape.stderr).toMatch(/outside the repository/);
    expect(escape.stdout).not.toContain("not-a-real-key");
    symlinkSync(join(outside, "secret.html"), join(repo.root, "docs/leak.html"));
    const viaLink = htmi("read", "docs/leak.html");
    expect(viaLink.status).not.toBe(0);
    expect(viaLink.stdout + viaLink.stderr).not.toContain("not-a-real-key");
    expect(htmi("read", "docs/page.html").status).toBe(0);
  });

  it("the MCP server refuses to read or edit outside the repository", async () => {
    symlinkSync(join(outside, "secret.html"), join(repo.root, "docs/leak.html"));
    const client = new Client({ name: "htmi-test-agent", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: repo.root, stderr: "pipe" }),
    );
    try {
      for (const document of [toOutside(), "docs/leak.html"]) {
        const read = (await client.callTool({ name: "htmi_read_document", arguments: { document } })) as {
          content: { text: string }[];
          isError?: boolean;
        };
        expect(read.isError).toBe(true);
        expect(read.content[0]!.text).not.toContain("not-a-real-key");
      }
      const edit = (await client.callTool({
        name: "htmi_apply_operation",
        arguments: {
          document: toOutside(),
          operation: {
            op: "set-text",
            expectedDocumentDigest: `sha256:${"0".repeat(64)}`,
            target: "#key",
            expectedTargetDigest: `sha256:${"0".repeat(64)}`,
            find: "MODEL",
            replace: "OTHER",
          },
        },
      })) as { isError?: boolean };
      expect(edit.isError).toBe(true);
      expect(readFileSync(join(outside, "secret.html"), "utf8")).toBe(SECRET);
    } finally {
      await client.close();
    }
  });
});
