// Bundles the CLI into one readable ES module for hosts that ship HTMi inside
// their own package (the Hermes plugin). The output is not minified, so it can
// be read and scanned like the source. Usage: node scripts/bundle-engine.mjs [outDir]
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "hermes/bundle");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: join(out, "htmi.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "eof",
  // Name dependencies as node_modules/... even when node_modules is a link, so the bundle
  // is the same wherever it is built and carries no local paths.
  preserveSymlinks: true,
  define: { __HTMI_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS dependencies call require(); give the module one.
  banner: {
    js: [
      `// HTMi engine ${version}, bundled from https://github.com/Thamirawaran/htmi (src/). Do not edit; run npm run bundle:engine.`,
      'import { createRequire as __htmiCreateRequire } from "node:module";',
      "const require = __htmiCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

// The review page reads its client script and styles from ./client next to the module.
cpSync("src/render/client", join(out, "client"), { recursive: true });
writeFileSync(join(out, "VERSION"), `${version}\n`);
console.log(`bundled HTMi ${version} into ${out}`);
