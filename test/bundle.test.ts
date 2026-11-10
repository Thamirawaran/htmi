import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The Hermes plugin ships a bundled engine (hermes/bundle). It must be exactly what the
// source builds today, or the plugin would run code nobody reviewed in src/.
describe("the Hermes plugin's bundled engine", () => {
  const out = mkdtempSync(join(tmpdir(), "htmi-bundle-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("matches a fresh build of src/ (run npm run bundle:engine after changing src/)", () => {
    execFileSync(process.execPath, ["scripts/bundle-engine.mjs", out], { stdio: "pipe" });
    const files = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort();
    expect(files("hermes/bundle")).toEqual(files(out));
    for (const file of files(out)) {
      expect(readFileSync(join("hermes/bundle", file), "utf8"), file).toBe(readFileSync(join(out, file), "utf8"));
    }
  }, 60_000);
});
