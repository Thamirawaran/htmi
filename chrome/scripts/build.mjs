import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The extension: content.js on github.com, and viewer.js, which is HTMi's core
// bundled for the browser with small stand-ins for the Node modules it imports.
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(here, "src/generated"), { recursive: true });

const clientDir = join(here, "../src/render/client");
const client = Object.fromEntries(
  ["review.js", "review.css", "tokens.css"].map((name) => [name, readFileSync(join(clientDir, name), "utf8")]),
);
writeFileSync(join(here, "src/generated/client.json"), JSON.stringify(client));

const shim = (name) => join(here, "src/shims", name);
const alias = {
  "node:fs": shim("fs.ts"),
  fs: shim("fs.ts"),
  "node:path": shim("path.ts"),
  path: shim("path.ts"),
  "node:crypto": shim("crypto.ts"),
  "node:url": shim("url.ts"),
  url: shim("url.ts"),
  "node:module": shim("unavailable.ts"),
  "node:child_process": shim("unavailable.ts"),
  "source-map-js": shim("unavailable.ts"),
};

await build({
  entryPoints: [join(here, "src/viewer.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  outfile: join(dist, "viewer.js"),
  alias,
  define: {
    "import.meta.url": '"file:///htmi/render/review-page.js"',
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "warning",
});
await build({
  entryPoints: [join(here, "src/content.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  outfile: join(dist, "content.js"),
  logLevel: "warning",
});
cpSync(join(here, "src/manifest.json"), join(dist, "manifest.json"));
cpSync(join(here, "src/viewer.html"), join(dist, "viewer.html"));
console.log("built chrome/dist: load it with chrome://extensions, Developer mode, Load unpacked");
