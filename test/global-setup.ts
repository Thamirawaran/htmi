import { execFileSync } from "node:child_process";

/** Subprocess tests (CLI, MCP) run the compiled package, so build it once first. */
export default function setup(): void {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
