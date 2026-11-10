// Copies the browser client assets next to the compiled review page builder.
import { chmodSync, cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/render/client", { recursive: true });
cpSync("src/render/client", "dist/render/client", { recursive: true });

chmodSync("dist/cli/main.js", 0o755);
