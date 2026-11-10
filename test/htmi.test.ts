import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The built CLI on an ordinary HTML file in a real git repository.
const CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));

const PLAN = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Cache plan</title></head>
<body>
<h1>Cache plan</h1>
<section id="goals">
  <h2>Goals</h2>
  <p id="latency">Cut the p95 read latency to 40 ms.</p>
</section>
<section id="risks">
  <h2>Risks</h2>
  <table id="risk-table">
    <tr><th>Risk</th><th>Owner</th></tr>
    <tr><td>Stale reads after failover</td><td>Platform</td></tr>
  </table>
</section>
</body>
</html>
`;

/** A real git repository in a temporary directory. */
class TempRepo {
  readonly root = mkdtempSync(join(tmpdir(), "htmi-test-"));
  constructor() {
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.name", "Reviewer"],
      ["config", "user.email", "reviewer@example.invalid"],
    ])
      execFileSync("git", args, { cwd: this.root });
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), content);
  }
  read(path: string): string {
    return readFileSync(join(this.root, path), "utf8");
  }
  edit(path: string, from: string, to: string): void {
    const content = this.read(path);
    if (content.split(from).length !== 2) throw new Error(`expected one "${from}" in ${path}`);
    this.write(path, content.replace(from, to));
  }
  commitAll(message: string): void {
    execFileSync("git", ["add", "-A"], { cwd: this.root });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: this.root });
  }
  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe("htmi on an HTML document", () => {
  let repo: TempRepo;
  const htmi = (...args: string[]) =>
    JSON.parse(execFileSync("node", [CLI, ...args, "--json"], { cwd: repo.root, encoding: "utf8" }));
  const status = (id: string) =>
    htmi("comments", "--status", "all").find((c: { id: string }) => c.id === id).resolution;

  beforeEach(() => {
    repo = new TempRepo();
    repo.write("docs/plan.html", PLAN);
    repo.commitAll("plan");
  });
  afterEach(() => repo.remove());

  it("reads the document without a comment: outline, a table, a search", () => {
    expect(htmi("list").documents.map((d: { path: string }) => d.path)).toEqual(["docs/plan.html"]);
    const table = htmi("read", "docs/plan.html", "--block", "#risk-table");
    expect(JSON.stringify(table)).toContain("Stale reads after failover");
    expect(htmi("read", "docs/plan.html", "--search", "40 ms").hits.length).toBe(1);
  });

  it("keeps a comment on its element through an unrelated edit, and says when the element changed or went away", () => {
    const { id } = htmi("comment", "docs/plan.html", "--target", "#latency", "--text", "Client or server side?");
    repo.edit("docs/plan.html", "<h2>Risks</h2>", "<h2>Known risks</h2>");
    expect(status(id)).toBe("exact");

    repo.edit("docs/plan.html", "to 40 ms", "to 35 ms");
    expect(status(id)).toBe("changed");

    repo.edit("docs/plan.html", '<p id="latency">Cut the p95 read latency to 35 ms.</p>', "");
    expect(status(id)).toBe("orphaned");
  });

  it("gives one comment with its context, the reviewer's words verbatim", () => {
    const { id } = htmi(
      "comment",
      "docs/plan.html",
      "--target",
      "#risk-table",
      "--text",
      "Add the cache warm-up risk.",
    );
    const context = execFileSync("node", [CLI, "context", "docs/plan.html", "--comment", id], {
      cwd: repo.root,
      encoding: "utf8",
    });
    expect(context).toContain("Add the cache warm-up risk.");
    expect(context).toContain("Stale reads after failover");
  });

  it("applies a checked edit that changes only what it names, and refuses a stale one", () => {
    const block = htmi("read", "docs/plan.html", "--block", "#latency");
    const target = htmi("targets", "docs/plan.html").find((t: { key: string }) => t.key === "#latency");
    const op = JSON.stringify({
      op: "set-text",
      target: "#latency",
      find: "40 ms",
      replace: "35 ms",
      expectedDocumentDigest: block.documentDigest,
      expectedTargetDigest: target.digest,
    });
    expect(htmi("apply", "docs/plan.html", "--op", op).written).toBe(true);
    expect(repo.read("docs/plan.html")).toBe(PLAN.replace("40 ms", "35 ms"));

    let refused = "";
    try {
      execFileSync("node", [CLI, "apply", "docs/plan.html", "--op", op, "--json"], {
        cwd: repo.root,
        encoding: "utf8",
      });
    } catch (error) {
      refused = (error as { stdout: string }).stdout;
    }
    expect(JSON.parse(refused).ok).toBe(false);
    expect(repo.read("docs/plan.html")).toBe(PLAN.replace("40 ms", "35 ms"));
  });
});
