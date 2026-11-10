import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// One CommonJS file for the extension host, with HTMi's core bundled in and the review client beside it.
const here = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(here, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [join(here, "src/extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(here, "dist/extension.cjs"),
  external: ["vscode"],
  // The core finds its client files relative to its own module; in a bundle that is this file.
  define: { "import.meta.url": "__htmi_module_url" },
  banner: { js: 'const __htmi_module_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});
mkdirSync(join(here, "dist/client"), { recursive: true });
for (const file of ["review.js", "review.css", "tokens.css"]) {
  cpSync(join(here, "../src/render/client", file), join(here, "dist/client", file));
}
console.log("built dist/extension.cjs");
